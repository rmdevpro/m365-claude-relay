// Composition: the real entrypoint (start.sh) with a runtime scope override,
// the real pinned Softeria in --obo mode and the real gate. A recorder in place
// of the Softeria binary logs the argv and scope environment it was started with.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { freePort } = require('./helpers');

const OBO_ENV = (port, up) => ({
  PATH: process.env.PATH, HOME: '/tmp', PORT: String(port), HOST: '127.0.0.1', UPSTREAM_PORT: String(up),
  MS365_MCP_LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'compose-')),
  MS365_MCP_CLIENT_ID: '11111111-2222-3333-4444-555555555555', MS365_MCP_CLIENT_SECRET: 'not-a-real-secret',
  MS365_MCP_TENANT_ID: 'consumers', MS365_MCP_PUBLIC_URL: 'https://relay.example', MS365_MCP_DISABLE_DCR: 'true',
  MS365_MCP_ALLOWED_REDIRECT_URIS: 'https://claude.ai/api/mcp/auth_callback', MS365_MCP_TRUST_PROXY_HOPS: '2',
  MS365_MCP_ATTACHMENT_URL_BASE: 'https://relay.example', MS365_MCP_ATTACHMENT_URL_KEY: '0123456789abcdef0123456789abcdef',
});

function appCopyWithRecorder() {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'));
  const log = path.join(app, 'argv.log');
  const src = path.join(__dirname, '..');
  for (const f of ['start.sh', 'gate.js', 'mail-text.js', 'policy.json', 'package.json']) fs.copyFileSync(path.join(src, f), path.join(app, f));
  fs.mkdirSync(path.join(app, 'node_modules', '.bin'), { recursive: true });
  const real = fs.realpathSync(path.join(src, 'node_modules', '.bin', 'ms-365-mcp-server'));
  const rec = path.join(app, 'node_modules', '.bin', 'ms-365-mcp-server');
  fs.writeFileSync(rec, `#!/usr/bin/env node
const e = process.env;
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), allowed: e.MS365_MCP_ALLOWED_SCOPES, extra: e.MS365_MCP_EXTRA_SCOPES, tenants: e.MS365_MCP_OBO_ALLOWED_TENANTS, users: e.MS365_MCP_OBO_ALLOWED_USERS || null, tokenScope: e.MS365_MCP_TOKEN_SCOPE || null }) + '\\n');
const c = require('child_process').spawn(process.execPath, [${JSON.stringify(real)}, ...process.argv.slice(2)], { stdio: 'inherit' });
c.on('exit', (code) => process.exit(code ?? 1));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => c.kill(sig));
`);
  fs.chmodSync(rec, 0o755);
  return { app, log };
}

test('composition: start.sh starts Softeria --obo with the scopes in the environment and only the exclusions as --enabled-tools', async () => {
  const port = await freePort(); const up = await freePort();
  const { app, log } = appCopyWithRecorder();
  const env = { ...OBO_ENV(port, up), MS365_MCP_ALLOWED_SCOPES: 'User.Read Mail.ReadWrite Mail.Send' };
  const child = spawn('bash', [path.join(app, 'start.sh')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    let health = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status === 200) { health = await r.json(); break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(health, `no health within 60 s:\n${out.slice(-1500)}`);
    assert.deepEqual(health.scopes, ['User.Read', 'Mail.ReadWrite', 'Mail.Send']);
    const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(runs.length, 1, 'one Softeria process: no derivation pass');
    const [run] = runs;
    assert.deepEqual(run.argv, ['--http', `127.0.0.1:${up}`, '--obo', '--enabled-tools', '^(?!(?:download-bytes|download-bytes-to-file|get-mail-attachment-content)$)', '--enable-attachment-urls']);
    assert.equal(run.allowed, 'User.Read Mail.ReadWrite Mail.Send');
    assert.equal(run.extra, 'User.Read Mail.ReadWrite Mail.Send');
    assert.equal(run.tokenScope, null, 'no patch-era token scope variable');
    assert.equal(run.tenants, '9188040d-6c67-4c5b-b112-36a304b66dad', 'default allowlist: the configured (consumer) tenant, enforced by Softeria');
    assert.equal(run.users, null);
    const re = new RegExp(run.argv[4], 'i');
    assert.ok(re.test('send-mail') && re.test('get-upload-url') && !re.test('download-bytes') && !re.test('download-bytes-to-file') && !re.test('get-mail-attachment-content'));
    // The real --obo server, through the gate: the relay scope plus the configured Graph scopes.
    const a = await fetch(`http://127.0.0.1:${port}/authorize?response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=abcdefghij&code_challenge=x&code_challenge_method=S256&scope=evil`, { redirect: 'manual' });
    assert.equal(a.status, 302);
    const scope = new URL(a.headers.get('location')).searchParams.get('scope').split(' ');
    assert.ok(scope.includes('11111111-2222-3333-4444-555555555555/access_as_user'), scope.join(' '));
    for (const sc of ['Mail.Send', 'Mail.ReadWrite']) assert.ok(scope.includes(sc) || scope.includes(`https://graph.microsoft.com/${sc}`), `${sc} in ${scope.join(' ')}`);
    assert.ok(!scope.includes('evil'));
    const m = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(m.status, 401);
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => setTimeout(r, 800));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    fs.rmSync(env.MS365_MCP_LOG_DIR, { recursive: true, force: true }); fs.rmSync(app, { recursive: true, force: true });
  }
});

test('composition: ENABLED_TOOLS in the environment is refused before any server starts', () => {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const env = { ...OBO_ENV(port, port + 1), ENABLED_TOOLS: '.*' };
  const r = spawnSync('bash', [path.join(__dirname, '..', 'start.sh')], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /ENABLED_TOOLS is not supported/);
  assert.doesNotMatch(r.stdout, /\[start\] tenant=/);
  fs.rmSync(env.MS365_MCP_LOG_DIR, { recursive: true, force: true });
});

test('composition: a scope list without Mail.ReadWrite stops the container', () => {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const env = { ...OBO_ENV(port, port + 1), MS365_MCP_ALLOWED_SCOPES: 'User.Read Mail.Read' };
  const { app } = appCopyWithRecorder();
  const r = spawnSync('bash', [path.join(app, 'start.sh')], { cwd: app, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /must include Mail\.ReadWrite/);
  fs.rmSync(env.MS365_MCP_LOG_DIR, { recursive: true, force: true }); fs.rmSync(app, { recursive: true, force: true });
});
