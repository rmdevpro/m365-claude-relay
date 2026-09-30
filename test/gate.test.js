const test = require('node:test');
const assert = require('node:assert/strict');
const { CLIENT_ID, POLICY, makeSigner, startJwks, startStallingJwks, startRedirectingJwks, startUpstream, startUploadSink, startGate, call } = require('./helpers');

const RPC = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const H = (tok) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json' });
const DRAFT = 'DRAFT-AAMkADAwATMwMAItYzhhMC1mMjIBLTAwAi0wMAoARgAAA';
const SENT = 'SENT-AAMkADAwATMwMAItYzhhMC1mMjIBLTAwAi0wMAoARgAAA';

let signer, jwks, up, sink, gate;
const baseEnv = () => ({ UPSTREAM_PORT: String(up.port), GATE_JWKS_URI: `http://127.0.0.1:${jwks.port}/` });
const NEUTRAL = { draftOnly: false, rejectToolNotifications: false }; // tests that exercise the switches turn them on explicitly

test.before(async () => {
  signer = makeSigner();
  jwks = await startJwks(signer.jwk);
  sink = await startUploadSink();
  up = await startUpstream({ uploadUrl: sink.url });
  gate = await startGate({ ...baseEnv(), GATE_LINK_MAX_MB: '5', GATE_LINK_MAX_PENDING: '3', GATE_LINK_MAX_CONCURRENT: '1', GATE_UPLOAD_HOST_SUFFIXES: '127.0.0.1' }, { policy: NEUTRAL });
});
test.after(() => { gate.close(); up.close(); jwks.close(); sink.close(); });

// ---- configuration validation ------------------------------------------------
test('bad or unapproved config fails startup', async () => {
  for (const env of [
    { GATE_LINK_TTL_SECONDS: 'not-a-number' }, { GATE_LINK_TTL_SECONDS: '9999' }, { GATE_RATE_LIMIT_PER_MIN: '-1' },
    { MS365_MCP_PUBLIC_URL: 'http://relay.example', GATE_ALLOW_INSECURE_TEST: '0' }, { MS365_MCP_PUBLIC_URL: '' }, { MS365_MCP_CLIENT_ID: 'nope' },
    { MS365_MCP_TENANT_ID: 'contoso' }, { GATE_DRAFT_ONLY: 'maybe' },
    { GATE_ALLOW_INSECURE_TEST: '0', GATE_JWKS_URI: 'http://127.0.0.1:1/' },                       // http JWKS outside tests
    { GATE_ALLOW_INSECURE_TEST: '0', GATE_JWKS_URI: 'https://evil.example/keys' },                  // unapproved origin
    { GATE_ALLOW_INSECURE_TEST: '0', MS365_MCP_ATTACHMENT_URL_BASE: 'https://other.example' },      // unapproved attachment origin
    { MS365_MCP_ALLOWED_SCOPES: 'Mail.Read' }, { MS365_MCP_ALLOWED_SCOPES: 'Mail.ReadWrite bad scope!' },  // scopes: bridge needs Mail.ReadWrite; bad name
    { MS365_MCP_EXTRA_SCOPES: 'Files.ReadWrite.All' },                                            // consent list must equal the allowed list
    { GATE_DRAFT_ONLY: 'false' }, { GATE_TRUSTED_INGRESS: 'true' },                              // policy drift: switches
    { GATE_POLICY_FILE: '/nonexistent/policy.json' },                                           // no alternate policy mechanism
  ]) {
    const r = await startGate({ UPSTREAM_PORT: '1', ...env }, { expectExit: true });
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.out, /"cat":"config"/);
  }
});

test('GATE_POLICY_FILE is refused even when it points at a real file', async () => {
  const r = await startGate({ UPSTREAM_PORT: '1', GATE_POLICY_FILE: require('path').join(__dirname, '..', 'policy.json') }, { expectExit: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /GATE_POLICY_FILE is not supported/);
});

test('policy schema is strict: wrong types and shapes fail startup, never weaken', async () => {
  const bad = [
    { ...POLICY, draftOnly: 'true' }, { ...POLICY, rejectToolNotifications: 'true' }, { ...POLICY, trustedIngress: 'false' },
    { ...POLICY, hiddenTools: 'add-mail-attachment' }, { ...POLICY, hiddenTools: [] }, { ...POLICY, hiddenTools: ['graph-batch'] },
    { ...POLICY, scopes: 'Mail.Send' }, { ...POLICY, scopes: ['Files.ReadWrite', ''] }, { ...POLICY, scopes: ['User.Read', 'Mail.Send'] },
    { ...POLICY, excludedTools: 'x' }, { ...POLICY, excludedTools: ['graph-batch'] }, { ...POLICY, excludedTools: ['Bad Name'] },
    { ...POLICY, version: '' }, { ...POLICY, extra: 1 }, [POLICY], 'not json {',
  ];
  for (const rawPolicy of bad) {
    const r = await startGate({ UPSTREAM_PORT: '1' }, { expectExit: true, rawPolicy });
    assert.equal(r.code, 1, JSON.stringify(rawPolicy).slice(0, 80));
    assert.match(r.out, /"cat":"config"/);
  }
  const { description, ...noDesc } = POLICY;
  const g = await startGate({ UPSTREAM_PORT: String(up.port), GATE_JWKS_URI: `http://127.0.0.1:${jwks.port}/` }, { rawPolicy: noDesc });
  g.close();
});

test('operator scopes: MS365_MCP_ALLOWED_SCOPES overrides the policy default and drives the consent shim', async () => {
  const g = await startGate({ ...baseEnv(), MS365_MCP_ALLOWED_SCOPES: 'User.Read Mail.ReadWrite Mail.Send', MS365_MCP_EXTRA_SCOPES: 'Mail.Send Mail.ReadWrite User.Read', GATE_DRAFT_ONLY: 'true', RELAY_TOOL_COUNT: '40' });
  const r = await call(g.port, '/authorize?response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=s&scope=evil', { method: 'GET' });
  assert.equal(r.status, 302);
  const scope = new URL(r.headers.get('location')).searchParams.get('scope');
  assert.equal(scope, `${CLIENT_ID}/access_as_user https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send`);
  const h = await call(g.port, '/health', { method: 'GET' });
  assert.deepEqual(h.json.scopes, ['User.Read', 'Mail.ReadWrite', 'Mail.Send']);
  assert.equal(h.json.tools, 40);
  g.close();
  const g2 = await startGate({ ...baseEnv() }, { policy: { excludedTools: [] } });
  g2.close();
});

test('approved attachment origin is accepted', async () => {
  // Real (https) JWKS default; nothing is fetched until a token arrives.
  const g = await startGate({ UPSTREAM_PORT: String(up.port), GATE_ALLOW_INSECURE_TEST: '0', MS365_MCP_ATTACHMENT_URL_BASE: 'https://relay.example' });
  g.close();
});

async function waitForLog(g, needle, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (g.output().includes(needle)) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}

// ---- token validation --------------------------------------------------------
test('token rejection matrix: all 401 with a generic body; reason only in the log', async () => {
  const cases = {
    token_audience: signer.mint({ aud: 'x' }),
    token_expired: signer.mint({ exp: 1 }),
    token_tenant: signer.mint({ tid: 't2', iss: 'https://login.microsoftonline.com/t2/v2.0' }),
    token_scope: signer.mint({ scp: 'User.Read' }),
    token_version: signer.mint({ ver: '1.0' }),
    token_unknown_key: signer.mint({}, { kid: 'nope' }),
    token_signature: signer.mint().slice(0, -4) + 'AAAA',
  };
  for (const [cat, tok] of Object.entries(cases)) {
    const r = await call(gate.port, '/mcp', { headers: H(tok), body: RPC('initialize', {}) });
    assert.equal(r.status, 401, cat);
    assert.equal(r.json.error_description, 'invalid token');
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="https:\/\/relay\.example\/\.well-known\/oauth-protected-resource"/);
    assert.ok(await waitForLog(gate, `"cat":"${cat}"`), `log has ${cat}`);
  }
  const none = await call(gate.port, '/mcp', { headers: { 'content-type': 'application/json' }, body: RPC('initialize', {}) });
  assert.equal(none.status, 401);
});

test('valid token reaches upstream with a canonical client address and allowlisted headers', async () => {
  up.seen.length = 0;
  const r = await call(gate.port, '/mcp', { headers: { ...H(signer.mint()), 'x-forwarded-host': 'evil', 'x-forwarded-proto': 'http', cookie: 'a=b', 'x-forwarded-for': '203.0.113.9, 198.51.100.7' }, body: RPC('tools/call', { name: 'list-mail-messages', arguments: {} }) });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.json.result.content[0].text).called, 'list-mail-messages');
  const h = up.seen[0].headers;
  assert.equal(h['x-forwarded-for'], '127.0.0.1', 'default policy: the socket peer, never a client-supplied chain');
  assert.equal(h['x-forwarded-host'], 'relay.example');
  assert.equal(h['x-forwarded-proto'], 'https');
  assert.equal(h.cookie, undefined);
  assert.match(h['x-request-id'], /^[0-9a-f-]{36}$/);
  assert.equal(h.host, `127.0.0.1:${up.port}`);
  // Responses: no CORS from upstream, security headers and the request id present.
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('with a policy-declared trusted ingress only the ingress-appended (last) entry is used', async () => {
  const g = await startGate(baseEnv(), { policy: { ...NEUTRAL, trustedIngress: true } });
  try {
    up.seen.length = 0;
    await call(g.port, '/mcp', { headers: { ...H(signer.mint()), 'x-forwarded-for': '203.0.113.9, 198.51.100.7' }, body: RPC('ping', {}) });
    assert.equal(up.seen[0].headers['x-forwarded-for'], '198.51.100.7');
  } finally { g.close(); }
});

test('forged X-Forwarded-For cannot evade the per-IP limit by default', async () => {
  const g = await startGate({ ...baseEnv(), GATE_RATE_LIMIT_PER_MIN: '1' }, { policy: NEUTRAL });
  try {
    const a = await call(g.port, '/mcp', { headers: { 'x-forwarded-for': '1.1.1.1' }, body: '{}' });
    const b = await call(g.port, '/mcp', { headers: { 'x-forwarded-for': '2.2.2.2' }, body: '{}' });
    assert.deepEqual([a.status, b.status], [401, 429]);
  } finally { g.close(); }
});

test('rate-key map is bounded', async () => {
  const g = await startGate({ ...baseEnv(), GATE_RATE_LIMIT_PER_MIN: '100', GATE_RATE_MAX_KEYS: '100' }, { policy: { ...NEUTRAL, trustedIngress: true } });
  try {
    for (let i = 0; i < 150; i++) await call(g.port, '/mcp', { headers: { 'x-forwarded-for': `10.0.${Math.floor(i / 250)}.${i % 250}` }, body: '{}' });
    const r = await call(g.port, '/mcp', { headers: { 'x-forwarded-for': '10.9.9.9' }, body: '{}' });
    assert.equal(r.status, 401, 'still serving after more keys than the cap');
  } finally { g.close(); }
});

test('JWKS: header-only stall honours the deadline; cross-origin redirect is refused', async () => {
  const stall = await startStallingJwks();
  const g1 = await startGate({ ...baseEnv(), GATE_JWKS_URI: `http://127.0.0.1:${stall.port}/`, GATE_JWKS_TIMEOUT_MS: '1000' }, { policy: NEUTRAL });
  try {
    const t0 = Date.now();
    const r = await call(g1.port, '/mcp', { headers: H(signer.mint()), body: RPC('initialize', {}) });
    assert.equal(r.status, 503);
    assert.ok(Date.now() - t0 < 2500, `answered in ${Date.now() - t0} ms`);
  } finally { g1.close(); stall.close(); }
  const redir = await startRedirectingJwks(`http://127.0.0.1:${jwks.port}/`);
  const g2 = await startGate({ ...baseEnv(), GATE_JWKS_URI: `http://127.0.0.1:${redir.port}/` }, { policy: NEUTRAL });
  try {
    const r = await call(g2.port, '/mcp', { headers: H(signer.mint()), body: RPC('initialize', {}) });
    assert.equal(r.status, 503, 'redirect to the real JWKS is refused, not followed');
    assert.ok(await waitForLog(g2, '"cat":"jwks_unavailable"'));
  } finally { g2.close(); redir.close(); }
});

// ---- routes ------------------------------------------------------------------
test('exact open routes; /register never forwarded; look-alike paths need auth', async () => {
  up.seen.length = 0;
  assert.equal((await call(gate.port, '/register', { body: '{}' })).status, 404);
  assert.equal((await call(gate.port, '/tokenanything', { body: '{}' })).status, 401);
  assert.equal((await call(gate.port, '/authorizeX', { method: 'GET' })).status, 401);
  assert.equal(up.seen.length, 0);
  const wk = await call(gate.port, '/.well-known/oauth-protected-resource', { method: 'GET' });
  assert.equal(wk.status, 200);
});

test('paths that are not in normal form are refused before routing (no encoded look-alikes of open routes)', async () => {
  up.seen.length = 0;
  // Sent on a raw socket: URL parsers (fetch, new URL) would collapse '.'/'..' and
  // '//' before the request left the client, which is exactly what the gate must
  // not rely on.
  const raw = (target) => new Promise((resolve, reject) => {
    const net = require('net');
    const sock = net.connect(gate.port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: relay.example\r\nConnection: close\r\n\r\n`));
    let buf = '';
    sock.on('data', (d) => { buf += d; }); sock.on('error', reject);
    sock.on('close', () => { const m = /^HTTP\/1\.1 (\d+)/.exec(buf); resolve({ status: m ? Number(m[1]) : 0, text: buf }); });
  });
  for (const bad of ['/.well-known/%2F..%2Fmcp', '/.well-known/../mcp', '/.well-known/./x', '//token', '/%61uthorize', '/authorize%00', '/a//b', '/mcp\\x', '/' + 'a'.repeat(2100)]) {
    const r = await raw(bad);
    assert.equal(r.status, 400, bad);
    assert.ok(r.text.includes('bad_request'), bad);
  }
  assert.equal(up.seen.length, 0, 'nothing reached upstream');
  // A trailing slash is a plain path; '/.well-known/' is an open discovery prefix.
  assert.equal((await raw('/.well-known/')).status, 200);
});

// ---- protocol shapes ---------------------------------------------------------
test('JSON-RPC batches, non-objects and malformed bodies are refused', async () => {
  up.seen.length = 0;
  const tok = signer.mint();
  assert.equal((await call(gate.port, '/mcp', { headers: H(tok), body: JSON.stringify([JSON.parse(RPC('tools/call', { name: 'download-bytes', arguments: {} }))]) })).status, 400);
  assert.equal((await call(gate.port, '/mcp', { headers: H(tok), body: '"x"' })).status, 400);
  assert.equal((await call(gate.port, '/mcp', { headers: H(tok), body: JSON.stringify({ jsonrpc: '2.0', id: 1 }) })).status, 400);
  assert.equal((await call(gate.port, '/mcp', { headers: H(tok), body: '{not json' })).status, 400);
  assert.equal(up.seen.length, 0, 'nothing reached upstream');
});

test('notifications: forwarded by default; tool-call notifications refused when the switch is on', async () => {
  up.seen.length = 0;
  const r = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(r.status, 200);
  assert.equal(up.seen.length, 1);
  const g = await startGate(baseEnv(), { policy: { ...NEUTRAL, rejectToolNotifications: true } });
  try {
    up.seen.length = 0;
    const ok = await call(g.port, '/mcp', { headers: H(signer.mint()), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(ok.status, 200);
    const bad = await call(g.port, '/mcp', { headers: H(signer.mint()), body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'list-mail-messages', arguments: {} } }) });
    assert.equal(bad.status, 400);
    assert.equal(up.seen.length, 1);
  } finally { g.close(); }
});

test('oversized MCP body is refused before upstream', async () => {
  up.seen.length = 0;
  const r = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { pad: 'x'.repeat(5 * 1024 * 1024) } }) });
  assert.equal(r.status, 413);
  assert.equal(up.seen.length, 0);
});

// ---- MCP glue ------------------------------------------------------------------
test('initialize replaces instructions; tools/list hides superseded tools and appends the upload tool', async () => {
  const init = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: RPC('initialize', {}) });
  assert.match(init.json.result.instructions, /^Microsoft 365 relay/);
  const list = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: RPC('tools/list', {}) });
  assert.deepEqual(list.json.result.tools.map((t) => t.name), ['list-mail-messages', 'get-attachment-upload-link']);
  up.seen.length = 0;
  for (const name of ['add-mail-attachment', 'create-mail-attachment-upload-session', 'graph-batch']) {
    const r = await call(gate.port, '/mcp', { headers: H(signer.mint()), body: RPC('tools/call', { name, arguments: {} }) });
    assert.equal(r.json.result.isError, true, name);
    assert.equal(JSON.parse(r.json.result.content[0].text).error, 'tool_not_available');
  }
  assert.equal(up.seen.length, 0, 'hidden tools never reach upstream from outside');
});

// ---- consent shim --------------------------------------------------------------
test('/authorize scope is fixed by the relay, caller scope ignored', async () => {
  const r = await call(gate.port, '/authorize?response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=s&scope=Files.ReadWrite.All%20evil', { method: 'GET' });
  assert.equal(r.status, 302);
  const scope = new URL(r.headers.get('location')).searchParams.get('scope');
  assert.equal(scope, [`${CLIENT_ID}/access_as_user`, ...POLICY.scopes.map((x) => `https://graph.microsoft.com/${x}`)].join(' '));
});

// ---- health / rate limiting --------------------------------------------------
test('/health reflects upstream readiness', async () => {
  assert.equal((await call(gate.port, '/health', { method: 'GET' })).status, 200);
  const dead = await startGate({ ...baseEnv(), UPSTREAM_PORT: '1' }, { policy: NEUTRAL });
  try { assert.equal((await call(dead.port, '/health', { method: 'GET' })).status, 503); } finally { dead.close(); }
});

test('per-IP rate limit is off by default and enforced when set', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call(gate.port, '/mcp', { body: '{}' })).status, 401);
  const g = await startGate({ ...baseEnv(), GATE_RATE_LIMIT_PER_MIN: '3' }, { policy: NEUTRAL });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call(g.port, '/mcp', { body: '{}' })).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    assert.equal((await call(g.port, '/files/x', { method: 'PUT', body: 'x' })).status, 429);
  } finally { g.close(); }
});

// ---- upload bridge -------------------------------------------------------------
async function issueLink(port, tok, over = {}) {
  const r = await call(port, '/mcp', { headers: H(tok), body: RPC('tools/call', { name: 'get-attachment-upload-link', arguments: { messageId: DRAFT, filename: 'a.txt', contentType: 'text/plain', ...over } }) });
  return JSON.parse(r.json.result.content[0].text);
}

test('upload link: inline attach, single use, invalid inputs, size cap, pending cap', async () => {
  const tok = signer.mint();
  const link = await issueLink(gate.port, tok);
  assert.match(link.url, /^https:\/\/relay\.example\/files\/[A-Za-z0-9_-]{32}$/);
  const p = new URL(link.url).pathname;
  const okPut = await call(gate.port, p, { method: 'PUT', body: 'hello' });
  assert.equal(okPut.status, 200);
  assert.equal(okPut.json.method, 'inline');
  assert.equal(okPut.headers.get('cache-control'), 'no-store');
  const attach = up.seen.filter((s) => s.body.includes('add-mail-attachment')).pop();
  assert.match(attach.body, /"contentBytes":"aGVsbG8="/);
  assert.equal((await call(gate.port, p, { method: 'PUT', body: 'hello' })).status, 404);
  assert.equal((await call(gate.port, p, { method: 'GET' })).status, 405);

  const badId = await call(gate.port, '/mcp', { headers: H(tok), body: RPC('tools/call', { name: 'get-attachment-upload-link', arguments: { messageId: '../x', filename: 'a' } }) });
  assert.equal(JSON.parse(badId.json.result.content[0].text).error, 'invalid_message_id');

  const big = await issueLink(gate.port, tok);
  assert.equal((await call(gate.port, new URL(big.url).pathname, { method: 'PUT', headers: { 'content-length': String(6 * 1024 * 1024) }, body: Buffer.alloc(6 * 1024 * 1024) })).status, 413);
  const noLen = await issueLink(gate.port, tok);
  const noLenStatus = await new Promise((resolve, rej) => {
    const http = require('http');
    const r = http.request({ host: '127.0.0.1', port: gate.port, method: 'PUT', path: new URL(noLen.url).pathname, headers: { 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', rej); r.write('x'); r.end();
  });
  assert.equal(noLenStatus, 411);

  await issueLink(gate.port, tok); await issueLink(gate.port, tok); await issueLink(gate.port, tok);
  assert.equal((await issueLink(gate.port, tok)).error, 'busy');
});

test('large upload streams to the Graph session in bounded chunks', async () => {
  const g = await startGate({ ...baseEnv(), GATE_UPLOAD_HOST_SUFFIXES: '127.0.0.1' }, { policy: NEUTRAL });
  try {
    sink.puts.length = 0;
    const link = await issueLink(g.port, signer.mint(), { filename: 'big.bin', contentType: 'application/octet-stream' });
    const size = 4 * 1024 * 1024;
    const r = await call(g.port, new URL(link.url).pathname, { method: 'PUT', headers: { 'content-length': String(size) }, body: Buffer.alloc(size, 1) });
    assert.equal(r.status, 200);
    assert.equal(r.json.method, 'upload-session');
    const CHUNK = 320 * 1024 * 12;
    assert.deepEqual(sink.puts, [{ range: `bytes 0-${CHUNK - 1}/${size}`, length: CHUNK }, { range: `bytes ${CHUNK}-${size - 1}/${size}`, length: size - CHUNK }]);
  } finally { g.close(); }
});

test('upload URL outside the approved hosts is refused', async () => {
  const g = await startGate({ ...baseEnv(), GATE_UPLOAD_HOST_SUFFIXES: '.office.com' }, { policy: NEUTRAL });
  try {
    const link = await issueLink(g.port, signer.mint());
    const r = await call(g.port, new URL(link.url).pathname, { method: 'PUT', headers: { 'content-length': String(4 * 1024 * 1024) }, body: Buffer.alloc(4 * 1024 * 1024) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'upload_url_rejected');
  } finally { g.close(); }
});

test('per-user pending quota and draft-only enforcement', async () => {
  const g = await startGate({ ...baseEnv(), GATE_LINK_MAX_PENDING_PER_USER: '1' }, { policy: { ...NEUTRAL, draftOnly: true } });
  try {
    const a = signer.mint({ oid: 'user-a' });
    const b = signer.mint({ oid: 'user-b' });
    const c = signer.mint({ oid: 'user-c' });
    const first = await issueLink(g.port, a);
    assert.ok(first.url);
    assert.equal((await issueLink(g.port, a)).error, 'too_many_pending_links');
    assert.ok((await issueLink(g.port, b)).url, 'quota is per user');
    assert.equal((await issueLink(g.port, c, { messageId: SENT })).error, 'not_a_draft');
  } finally { g.close(); }
});

test('event attachments go through graph-batch as the user; both ids refused', async () => {
  const g = await startGate(baseEnv(), { policy: NEUTRAL }); // fresh gate: the shared one has pending links from the cap test
  try {
    const tok = signer.mint();
    const EVT = 'EVT-AAMkADAwATMwMAItYzhhMC1mMjIBLTAwAi0wMAoARgAAA';
    const both = await call(g.port, '/mcp', { headers: H(tok), body: RPC('tools/call', { name: 'get-attachment-upload-link', arguments: { messageId: DRAFT, eventId: EVT, filename: 'a.txt' } }) });
    assert.equal(JSON.parse(both.json.result.content[0].text).error, 'give_message_id_or_event_id');
    const r = await call(g.port, '/mcp', { headers: H(tok), body: RPC('tools/call', { name: 'get-attachment-upload-link', arguments: { eventId: EVT, filename: 'agenda.txt', contentType: 'text/plain' } }) });
    const link = JSON.parse(r.json.result.content[0].text);
    up.seen.length = 0;
    const put = await call(g.port, new URL(link.url).pathname, { method: 'PUT', body: 'agenda' });
    assert.equal(put.status, 200);
    assert.equal(put.json.attachmentId, 'att-e');
    const batch = up.seen.find((x) => x.body.includes('graph-batch'));
    const req = JSON.parse(batch.body).params.arguments.body.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `/me/events/${EVT}/attachments`);
    assert.equal(req.body.contentBytes, Buffer.from('agenda').toString('base64'));
  } finally { g.close(); }
});

test('upload links expire', async () => {
  const g = await startGate({ ...baseEnv(), GATE_LINK_TTL_SECONDS: '30' }, { policy: NEUTRAL });
  try { assert.equal((await issueLink(g.port, signer.mint())).expiresInSeconds, 30); } finally { g.close(); }
});

test('logs are structured and carry no upstream text', async () => {
  const out = gate.output();
  const lines = out.trim().split('\n').filter((l) => l.startsWith('{'));
  assert.ok(lines.length > 10);
  for (const l of lines) { const j = JSON.parse(l); assert.ok(j.ts && (j.cat || j.level), l); }
  assert.doesNotMatch(out, /UPSTREAM DEFAULT|Bearer |contentBytes|aGVsbG8/);
});
