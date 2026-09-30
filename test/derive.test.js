// derive-tools.js boundary tests: the loopback tools/list response is untrusted
// input. A fake "server" stands in for Softeria (--bin) to inject bad output
// and stalls; the real pinned server is exercised by integration.test.js and
// the composition test below.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const DERIVE = path.join(__dirname, '..', 'derive-tools.js');
const FAKE = path.join(__dirname, 'fake-softeria.js');

// Fake server: honours --http host:port; behaviour selected by FAKE_MODE.
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const http = require('http');
const [host, port] = process.argv[process.argv.indexOf('--http') + 1].split(':');
const mode = process.env.FAKE_MODE || 'ok';
const tools = JSON.parse(process.env.FAKE_TOOLS || '[]');
http.createServer((q, r) => {
  if (mode === 'hold') return; // accept, never answer
  if (mode === 'flood') return; // never answer; stderr flood below
  if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/plain' }); return r.end('Microsoft 365 MCP Server is running'); }
  if (mode === 'huge') { r.writeHead(200, { 'content-type': 'application/json' }); r.write('{"a":"' + 'x'.repeat(5 * 1024 * 1024) + '"}'); return r.end(); }
  r.writeHead(200, { 'content-type': 'application/json' });
  r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: tools.map((name) => ({ name })) } }));
}).listen(Number(port), host);
if (mode === 'flood') { const chunk = Buffer.alloc(1024 * 1024, 0x41); (function pump() { process.stderr.write(chunk, () => setImmediate(pump)); })(); }
`);
fs.chmodSync(FAKE, 0o755);
test.after(() => { try { fs.unlinkSync(FAKE); } catch { /* gone */ } });

const GOOD = ['add-mail-attachment', 'create-mail-attachment-upload-session', 'graph-batch', 'list-mail-messages', 'get-mail-message', 'send-mail'];
function run(tools, mode = 'ok', extra = []) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'derive-t-')), 'tools.json');
  const r = spawnSync(process.execPath, [DERIVE, '--bin', FAKE, '--scopes', 'User.Read Mail.ReadWrite', '--out', out, '--deadline-ms', '4000', ...extra], {
    env: { ...process.env, FAKE_MODE: mode, FAKE_TOOLS: JSON.stringify(tools) }, encoding: 'utf8', timeout: 20000,
  });
  return { ...r, out, doc: r.status === 0 ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}

test('derive: a well-formed response yields a sorted unique list and an anchored, escaped regex', () => {
  const r = run(GOOD);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.doc.tools, [...GOOD].sort());
  assert.equal(r.doc.enabledToolsRegex, `^(${[...GOOD].sort().join('|')})$`);
  assert.ok(new RegExp(r.doc.enabledToolsRegex).test('send-mail'));
  assert.ok(!new RegExp(r.doc.enabledToolsRegex).test('list-users'));
});

test('derive: a returned fixed excluded tool fails the derivation (no output file)', () => {
  const r = run([...GOOD, 'download-bytes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fixed excluded tool: download-bytes/);
  assert.ok(!fs.existsSync(r.out));
});

test('derive: regex-meta, malformed, non-string and duplicate names fail', () => {
  for (const [bad, why] of [[[...GOOD, '.*'], /invalid tool name/], [[...GOOD, 'Bad Name'], /invalid tool name/], [[...GOOD, 42], /invalid tool name/], [[...GOOD, 'send-mail'], /duplicate/], [[...GOOD, 'a'.repeat(70)], /invalid tool name/]]) {
    const r = run(bad);
    assert.equal(r.status, 1, JSON.stringify(bad.slice(-1)));
    assert.match(r.stderr, why);
    assert.ok(!fs.existsSync(r.out));
  }
});

test('derive: missing hidden bridge tool or implausibly small list fails', () => {
  const r = run(['list-mail-messages', 'get-mail-message', 'send-mail', 'list-mail-folders', 'get-current-user']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hidden bridge tool/);
  const r2 = run(['add-mail-attachment', 'graph-batch']);
  assert.equal(r2.status, 1);
});

test('derive: a loopback listener that accepts but never answers fails within the deadline', () => {
  const t0 = Date.now();
  const r = run(GOOD, 'hold');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not start within/);
  assert.ok(Date.now() - t0 < 9000, `took ${Date.now() - t0} ms`);
});

test('derive: a child that floods stderr and never starts fails within the deadline with bounded memory', () => {
  const t0 = Date.now();
  const r = run(GOOD, 'flood', ['--deadline-ms', '3000']);
  assert.equal(r.status, 1, r.stderr.slice(-300));
  assert.match(r.stderr, /did not start within/);
  assert.ok(r.stderr.length < 6000, `derive stderr should carry only a bounded tail, got ${r.stderr.length}`);
  assert.ok(Date.now() - t0 < 9000);
});

test('derive: an oversized tools/list body fails', () => {
  const r = run(GOOD, 'huge');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /too large/);
});

// Composition: the real entrypoint (start.sh) with a runtime scope override,
// real pinned Softeria in --obo mode, real gate. Proves the derived surface
// reaches the running server and /health, and that a failed derivation never
// exposes the OBO server.
const OBO_ENV = (port, up) => ({
  PATH: process.env.PATH, HOME: '/tmp', PORT: String(port), HOST: '127.0.0.1', UPSTREAM_PORT: String(up),
  MS365_MCP_LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'compose-')),
  MS365_MCP_CLIENT_ID: '11111111-2222-3333-4444-555555555555', MS365_MCP_CLIENT_SECRET: 'not-a-real-secret',
  MS365_MCP_TENANT_ID: 'consumers', MS365_MCP_PUBLIC_URL: 'https://relay.example', MS365_MCP_DISABLE_DCR: 'true',
  MS365_MCP_ALLOWED_REDIRECT_URIS: 'https://claude.ai/api/mcp/auth_callback', MS365_MCP_TRUST_PROXY_HOPS: '2',
  MS365_MCP_ATTACHMENT_URL_BASE: 'https://relay.example', MS365_MCP_ATTACHMENT_URL_KEY: '0123456789abcdef0123456789abcdef',
});

// Temp copy of the app whose node_modules/.bin/ms-365-mcp-server is a recorder:
// it appends its argv to ARGV_LOG, then execs the real pinned binary. Proves what
// start.sh actually passes to the real OBO invocation.
function appCopyWithRecorder() {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'));
  const argvLog = path.join(app, 'argv.log');
  const src = path.join(__dirname, '..');
  for (const f of ['start.sh', 'derive-tools.js', 'gate.js', 'policy.json', 'package.json']) fs.copyFileSync(path.join(src, f), path.join(app, f));
  fs.mkdirSync(path.join(app, 'node_modules', '.bin'), { recursive: true });
  const real = fs.realpathSync(path.join(src, 'node_modules', '.bin', 'ms-365-mcp-server'));
  const rec = path.join(app, 'node_modules', '.bin', 'ms-365-mcp-server');
  fs.writeFileSync(rec, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconst c = require('child_process').spawn(process.execPath, [${JSON.stringify(real)}, ...process.argv.slice(2)], { stdio: 'inherit' }); c.on('exit', (code) => process.exit(code ?? 1)); for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => c.kill(sig));\n`);
  fs.chmodSync(rec, 0o755);
  return app;
}

test('composition: start.sh with a three-scope override passes the derived, escaped, anchored regex to the real --obo invocation', async () => {
  const port = 40000 + Math.floor(Math.random() * 10000); const up = port + 1;
  const app = appCopyWithRecorder();
  const argvLog = path.join(app, 'argv.log');
  const env = { ...OBO_ENV(port, up), MS365_MCP_ALLOWED_SCOPES: 'User.Read Mail.ReadWrite Mail.Send' };
  // Own process group so the whole tree (bash, recorder, real server, gate) is killed at the end.
  const child = spawn('bash', [path.join(app, 'start.sh')], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  try {
    let health = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status === 200) { health = await r.json(); break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(health, `no health within 60 s:\n${log.slice(-1500)}`);
    assert.deepEqual(health.scopes, ['User.Read', 'Mail.ReadWrite', 'Mail.Send']);
    assert.equal(health.tools, 46);
    assert.match(log, /derived 46 tools from 3 scopes/);
    // What the real OBO server was started with:
    const invocations = fs.readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const obo = invocations.find((a) => a.includes('--obo'));
    assert.ok(obo, 'a --obo invocation was recorded');
    const regex = obo[obo.indexOf('--enabled-tools') + 1];
    const derived = JSON.parse(fs.readFileSync(path.join(env.MS365_MCP_LOG_DIR, 'tools.json'), 'utf8'));
    assert.equal(regex, derived.enabledToolsRegex, 'the OBO server got exactly the derived regex');
    assert.equal(derived.tools.length, 46);
    assert.match(regex, /^\^\((?:[a-z0-9-]+\|)*[a-z0-9-]+\)\$$/, 'anchored alternation of escaped plain names only');
    assert.ok(new RegExp(regex).test('send-mail') && new RegExp(regex).test('add-mail-attachment'));
    assert.ok(!new RegExp(regex).test('list-users') && !new RegExp(regex).test('download-bytes') && !new RegExp(regex).test('get-calendar-view'));
    assert.ok(!obo.includes('--allowed-scopes'), 'the OBO invocation never carries --allowed-scopes (Softeria#697)');
    // The derivation invocation, by contrast, carried the scopes and the exclusion filter.
    const der = invocations.find((a) => a.includes('--allowed-scopes'));
    assert.ok(der && der[der.indexOf('--allowed-scopes') + 1] === 'User.Read Mail.ReadWrite Mail.Send');
    const m = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(m.status, 401);
  } finally { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } await new Promise((r) => setTimeout(r, 800)); try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } fs.rmSync(env.MS365_MCP_LOG_DIR, { recursive: true, force: true }); fs.rmSync(app, { recursive: true, force: true }); }
});

test('composition: a scope list that cannot cover the bridge fails start.sh before any server is exposed', async () => {
  const port = 40000 + Math.floor(Math.random() * 10000); const up = port + 1;
  const env = { ...OBO_ENV(port, up), MS365_MCP_ALLOWED_SCOPES: 'User.Read Mail.Read' };
  const r = spawnSync('bash', [path.join(__dirname, '..', 'start.sh')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /hidden bridge tool/);
  assert.doesNotMatch(r.stdout, /\[start\] tenant=/, 'servers must not be launched after a failed derivation');
  let reachable = false;
  try { await fetch(`http://127.0.0.1:${up}/`); reachable = true; } catch { /* expected */ }
  assert.equal(reachable, false, 'no OBO server listening');
  fs.rmSync(env.MS365_MCP_LOG_DIR, { recursive: true, force: true });
});
