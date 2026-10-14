// Real-Softeria integration tier: the pinned ms-365-mcp-server runs on loopback
// behind the gate in --obo mode, with the tool surface and consent scopes set
// exactly as start.sh sets them (MS365_MCP_ALLOWED_SCOPES / _EXTRA_SCOPES env,
// --enabled-tools excluding the policy's excluded tools). Exercised for real:
// Softeria's scope-derived surface, hidden and excluded tools, read-mail-text
// in tools/list, instructions, notifications, batch refusal, /register,
// /authorize scope under --obo, discovery, health.
// OAuth code/refresh, the OBO exchange, Graph and attachment tickets need Entra
// and are covered by the live tests against a real tenant.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { POLICY, CLIENT_ID, makeSigner, startGate, call, freePort } = require('./helpers');

const RPC = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const H = (tok) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
const SCOPES = POLICY.scopes.join(' ');
const EXCLUDE = `^(?!(?:${POLICY.excludedTools.join('|')})$)`; // what start.sh passes
const BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'ms-365-mcp-server');
// Default seven scopes, personal mode, Softeria 0.166.0, as a client sees it:
// Softeria registers 142 (download-bytes and get-mail-attachment-content
// excluded, download-bytes-to-file is stdio-only), minus the 5 hidden tools,
// plus read-mail-text = 138. Re-check on every Softeria bump.
const EXPECTED_TOOLS = 138;

let signer, gate, softeria, gateObo, softeriaObo;
let UP_PORT, OBO_PORT;

// MCP calls under --obo need a real Entra exchange, so the MCP surface runs on a
// plain --http instance with the same scopes and exclusions (the surface is the
// same computation); a second, --obo instance serves /authorize.
function startSofteria(port, extraArgs) {
  const child = spawn(BIN, ['--http', `127.0.0.1:${port}`, ...extraArgs, '--enabled-tools', EXCLUDE], {
    env: {
      PATH: process.env.PATH, HOME: '/tmp', MS365_MCP_LOG_DIR: `/tmp/ms365-it-${port}`,
      MS365_MCP_CLIENT_ID: CLIENT_ID, MS365_MCP_CLIENT_SECRET: 'not-a-real-secret', MS365_MCP_TENANT_ID: 'consumers',
      MS365_MCP_ALLOWED_SCOPES: SCOPES, MS365_MCP_EXTRA_SCOPES: SCOPES,
      MS365_MCP_PUBLIC_URL: 'https://relay.example', MS365_MCP_DISABLE_DCR: 'true',
      MS365_MCP_ALLOWED_REDIRECT_URIS: 'https://claude.ai/api/mcp/auth_callback', MS365_MCP_TRUST_PROXY_HOPS: '2',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return child;
}
async function waitUp(port) {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status === 200) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`softeria on ${port} did not start`);
}

test.before(async () => {
  if (!fs.existsSync(BIN)) throw new Error('run npm ci first');
  signer = makeSigner();
  UP_PORT = await freePort();
  OBO_PORT = await freePort();
  softeria = startSofteria(UP_PORT, []);
  softeriaObo = startSofteria(OBO_PORT, ['--obo']);
  await waitUp(UP_PORT); await waitUp(OBO_PORT);
  const env = { MS365_MCP_ALLOWED_SCOPES: SCOPES, MS365_MCP_EXTRA_SCOPES: SCOPES };
  gate = await startGate({ ...env, UPSTREAM_PORT: String(UP_PORT) }, { policy: { rejectToolNotifications: false } });
  gateObo = await startGate({ ...env, UPSTREAM_PORT: String(OBO_PORT) });
});
test.after(() => {
  gate.close(); gateObo.close(); softeria.kill(); softeriaObo.kill();
  for (const p of [UP_PORT, OBO_PORT]) fs.rmSync(`/tmp/ms365-it-${p}`, { recursive: true, force: true });
});

let listed = null;
test('real Softeria: tools/list = Softeria\'s scope-derived surface minus excluded and hidden, plus read-mail-text', async () => {
  const r = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: RPC('tools/list', {}) });
  assert.equal(r.status, 200);
  const names = r.json.result.tools.map((t) => t.name);
  listed = names;
  for (const t of ['list-mail-messages', 'get-download-url', 'get-upload-url', 'read-mail-text', 'get-current-user', 'list-mail-rules', 'create-my-calendar-permission', 'share-drive-item', 'list-excel-worksheets']) {
    assert.ok(names.includes(t), `${t} must be exposed (covered by the policy scopes)`);
  }
  // Nothing is withheld for a "no use case" reason: the webhook-subscription
  // tools (no scope required) are exposed and governed by Claude's permissions.
  for (const t of ['list-subscriptions', 'create-subscription', 'get-subscription', 'update-subscription', 'delete-subscription', 'reauthorize-subscription']) {
    assert.ok(names.includes(t), `${t} must be exposed (webhook tools are not excluded)`);
  }
  // The only exclusions are tools the relay replaces with a better one.
  assert.deepEqual([...POLICY.excludedTools].sort(), ['download-bytes', 'download-bytes-to-file', 'get-mail-attachment-content']);
  for (const t of ['add-mail-attachment', 'create-mail-attachment-upload-session', 'add-calendar-event-attachment', 'create-calendar-event-attachment-upload-session', 'graph-batch', 'get-attachment-upload-link']) assert.ok(!names.includes(t), `${t} is hidden/gone`);
  for (const t of POLICY.excludedTools) assert.ok(!names.includes(t), `${t} is excluded`);
  // Needs a scope the policy does not grant, or a work tenant: never present.
  for (const t of ['list-todo-lists', 'list-onenote-notebooks', 'list-users', 'list-shared-mailbox-messages', 'list-chats', 'get-sharepoint-site']) {
    assert.ok(!names.includes(t), `${t} must not be exposed`);
  }
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  assert.equal(names.length, EXPECTED_TOOLS, 'surface size for the default scopes on the pinned Softeria');
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
  const auth = await call(gateObo.port, '/authorize?response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=abcdefghij&code_challenge=x&code_challenge_method=S256&scope=evil', { method: 'GET' });
  assert.equal(auth.status, 302);
  const loc = new URL(auth.headers.get('location'));
  assert.equal(loc.hostname, 'login.microsoftonline.com');
  const scope = loc.searchParams.get('scope').split(' ');
  // Under --obo with --allowed-scopes the relay scope stays (Softeria#697/#703),
  // the configured Graph scopes are added for consent, the caller's are dropped.
  assert.ok(scope.includes(`${CLIENT_ID}/access_as_user`), scope.join(' '));
  for (const sc of POLICY.scopes) assert.ok(scope.includes(sc) || scope.includes(`https://graph.microsoft.com/${sc}`), `${sc} in ${scope.join(' ')}`);
  assert.ok(!scope.includes('evil'));
  const bad = await call(gateObo.port, '/authorize?response_type=code&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&state=s', { method: 'GET' });
  assert.equal(bad.status, 400, 'redirect allowlist enforced upstream');
  assert.equal((await call(gate.port, '/register', { body: '{}' })).status, 404);
  const h = await call(gate.port, '/health', { method: 'GET' });
  assert.equal(h.status, 200);
  assert.equal(h.json.tools, listed.length);
});
