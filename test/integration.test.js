// Real-Softeria integration tier: the pinned ms-365-mcp-server runs on loopback
// behind the gate. Softeria is started in plain --http (no --obo) so the gate's
// synthetic bearer is used as-is and no Entra exchange is needed; everything
// that does not touch Graph is exercised for real: --enabled-tools filtering,
// hidden tools, the upload tool in tools/list, instructions, notifications,
// batch refusal, /register, /authorize scope, discovery, health.
// OAuth code/refresh, OBO exchange and attachment tickets need Entra and are
// covered by the staged/live tests against a real tenant.
// The tool surface is derived at start from the scopes (derive-tools.js =
// Softeria's own --allowed-scopes logic), passed as --enabled-tools exactly as
// start.sh does.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { POLICY, makeSigner, startJwks, startGate, call } = require('./helpers');
const { spawnSync } = require('child_process');
const os = require('os');

const RPC = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const H = (tok) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
// Derive the surface exactly as start.sh does at container start.
const DERIVED = (() => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'derive-it-')), 'tools.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'derive-tools.js'), '--out', out], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`derive failed: ${r.stderr}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
})();
const ENABLED = DERIVED.enabledToolsRegex; // exactly what start.sh passes
const BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'ms-365-mcp-server');

let signer, jwks, gate, softeria;
const UP_PORT = 30000 + Math.floor(Math.random() * 10000);

test.before(async () => {
  if (!fs.existsSync(BIN)) throw new Error('run npm ci first');
  signer = makeSigner();
  jwks = await startJwks(signer.jwk);
  softeria = spawn(BIN, ['--http', `127.0.0.1:${UP_PORT}`, '--enabled-tools', ENABLED], {
    env: {
      PATH: process.env.PATH, HOME: '/tmp', MS365_MCP_LOG_DIR: `/tmp/ms365-it-${UP_PORT}`,
      MS365_MCP_CLIENT_ID: '11111111-2222-3333-4444-555555555555', MS365_MCP_TENANT_ID: 'consumers',
      MS365_MCP_PUBLIC_URL: 'https://relay.example', MS365_MCP_DISABLE_DCR: 'true',
      MS365_MCP_ALLOWED_REDIRECT_URIS: 'https://claude.ai/api/mcp/auth_callback', MS365_MCP_TRUST_PROXY_HOPS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // wait for the upstream root to answer
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { const r = await fetch(`http://127.0.0.1:${UP_PORT}/`); if (r.status === 200) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  gate = await startGate({ UPSTREAM_PORT: String(UP_PORT), GATE_JWKS_URI: `http://127.0.0.1:${jwks.port}/`, RELAY_TOOL_COUNT: String(DERIVED.tools.length) }, { policy: { rejectToolNotifications: false } });
});
test.after(() => { gate.close(); softeria.kill(); jwks.close(); fs.rmSync(`/tmp/ms365-it-${UP_PORT}`, { recursive: true, force: true }); });

test('real Softeria: tools/list = start-time scope-derived set minus excluded and hidden, plus the upload tool', async () => {
  const r = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: RPC('tools/list', {}) });
  assert.equal(r.status, 200);
  const names = r.json.result.tools.map((t) => t.name);
  for (const t of ['list-mail-messages', 'get-download-url', 'get-attachment-upload-link', 'get-current-user', 'list-mail-rules', 'create-my-calendar-permission', 'share-drive-item', 'list-excel-worksheets']) {
    assert.ok(names.includes(t), `${t} must be exposed (covered by the policy scopes)`);
  }
  // Nothing is withheld for a "no use case" reason: all six webhook-subscription
  // tools (no scope required) are exposed and governed by Claude's permissions.
  for (const t of ['list-subscriptions', 'create-subscription', 'get-subscription', 'update-subscription', 'delete-subscription', 'reauthorize-subscription']) {
    assert.ok(names.includes(t), `${t} must be exposed (webhook tools are not excluded)`);
    assert.ok(DERIVED.tools.includes(t), `${t} must be in the derived surface`);
  }
  // The only exclusions are tools the relay replaces with a better one.
  assert.deepEqual([...POLICY.excludedTools].sort(), ['download-bytes', 'download-bytes-to-file']);
  for (const t of ['add-mail-attachment', 'create-mail-attachment-upload-session', 'graph-batch']) assert.ok(!names.includes(t), `${t} is hidden`);
  for (const t of POLICY.excludedTools) assert.ok(!names.includes(t), `${t} is excluded`);
  // Needs a scope the policy does not grant, or a work tenant: never present.
  for (const t of ['list-todo-lists', 'list-onenote-notebooks', 'list-users', 'list-shared-mailbox-messages', 'list-chats', 'get-sharepoint-site']) {
    assert.ok(!names.includes(t), `${t} must not be exposed`);
  }
  // Everything derived (139 for the default seven scopes in 0.157.0, personal
  // mode: 134 + 6 subscription tools - download-bytes), minus the 3 hidden
  // ones, plus the gate's upload tool.
  assert.equal(DERIVED.tools.length, 139);
  assert.equal(names.length, DERIVED.tools.length - 3 + 1);
});

test('real Softeria: initialize carries the relay instructions', async () => {
  const r = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: RPC('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }) });
  assert.equal(r.status, 200);
  assert.match(r.json.result.instructions, /^Microsoft 365 relay/);
  assert.doesNotMatch(r.json.result.instructions, /download-bytes/);
});

test('real Softeria: notification passes, batch is refused at the gate', async () => {
  const n = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.ok([200, 202].includes(n.status), String(n.status));
  const b = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: JSON.stringify([JSON.parse(RPC('tools/list', {}))]) });
  assert.equal(b.status, 400);
});

test('real Softeria: hidden tool called directly is refused by the gate before upstream', async () => {
  const r = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: RPC('tools/call', { name: 'graph-batch', arguments: { body: { requests: [] } } }) });
  assert.equal(r.json.result.isError, true);
  assert.equal(JSON.parse(r.json.result.content[0].text).error, 'tool_not_available');
});

test('real Softeria: OAuth discovery, /authorize scope, /register off, health', async () => {
  const prm = await call(gate.port, '/.well-known/oauth-protected-resource', { method: 'GET' });
  assert.equal(prm.status, 200);
  assert.ok(prm.json.scopes_supported.length >= 1);
  const auth = await call(gate.port, '/authorize?response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=abcdefghij&code_challenge=x&code_challenge_method=S256&scope=evil', { method: 'GET' });
  assert.equal(auth.status, 302);
  const loc = new URL(auth.headers.get('location'));
  assert.equal(loc.hostname, 'login.microsoftonline.com');
  const scope = loc.searchParams.get('scope').split(' ');
  assert.ok(scope.includes('11111111-2222-3333-4444-555555555555/access_as_user'));
  assert.ok(scope.includes('https://graph.microsoft.com/Mail.Send'));
  assert.ok(!scope.includes('evil'));
  const bad = await call(gate.port, '/authorize?response_type=code&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&state=s', { method: 'GET' });
  assert.equal(bad.status, 400, 'redirect allowlist enforced upstream');
  assert.equal((await call(gate.port, '/register', { body: '{}' })).status, 404);
  const h = await call(gate.port, '/health', { method: 'GET' });
  assert.equal(h.status, 200);
  assert.equal(h.json.tools, DERIVED.tools.length);
});
