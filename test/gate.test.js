// The gate is a pass-through that adds read-mail-text; everything else is
// Softeria's. These tests pin both halves: what passes through untouched, and
// what the one added tool does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mint, startUpstream, startGate, call } = require('./helpers');

const RPC = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const H = (tok) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
const READ = (args, id = 1) => RPC('tools/call', { name: 'read-mail-text', arguments: args }, id);

let up, gate;
test.before(async () => {
  up = await startUpstream();
  gate = await startGate({ UPSTREAM_PORT: String(up.port) });
});
test.after(() => { gate.close(); up.close(); });

test('bad config fails startup', async () => {
  for (const env of [{ UPSTREAM_PORT: 'x' }, { GATE_READ_MAIL_TEXT_MAX_CHARS: '10' }, { GATE_MCP_MAX_BODY_MB: '0' }]) {
    const r = await startGate(env, { expectExit: true });
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.out, /"cat":"config"/);
  }
});

// ---- pass-through -----------------------------------------------------------
test('non-MCP routes stream through untouched: method, path, query, body, status, headers', async () => {
  up.seen.length = 0;
  const r = await call(gate.port, '/attachment?t=abc', { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-custom': '1' }, body: 'bytes' });
  assert.equal(r.status, 201);
  assert.equal(r.text, 'echo PUT /attachment?t=abc bytes');
  assert.equal(r.headers.get('x-upstream'), 'yes');
  assert.equal(up.seen[0].headers['x-custom'], '1');
  const g = await call(gate.port, '/authorize?scope=x&state=s', { method: 'GET' });
  assert.equal(g.text, 'echo GET /authorize?scope=x&state=s ', 'the caller\'s query, scope included, reaches Softeria as sent');
});

test('the client address is appended to X-Forwarded-For, as any proxy does', async () => {
  up.seen.length = 0;
  await call(gate.port, '/x', { method: 'GET', headers: { 'x-forwarded-for': '203.0.113.9' } });
  await call(gate.port, '/x', { method: 'GET' });
  assert.equal(up.seen[0].headers['x-forwarded-for'], '203.0.113.9, 127.0.0.1');
  assert.equal(up.seen[1].headers['x-forwarded-for'], '127.0.0.1');
});

test('MCP calls other than read-mail-text pass through with the caller\'s bearer; Softeria\'s answers come back as is', async () => {
  up.seen.length = 0;
  const tok = mint();
  const r = await call(gate.port, '/mcp', { headers: H(tok), body: RPC('tools/call', { name: 'list-mail-messages', arguments: {} }) });
  assert.equal(JSON.parse(r.json.result.content[0].text).called, 'list-mail-messages');
  assert.equal(up.seen[0].headers.authorization, `Bearer ${tok}`);
  assert.equal(r.headers.get('mcp-session-id'), 'S1');
  const none = await call(gate.port, '/mcp', { headers: { 'content-type': 'application/json' }, body: RPC('tools/list', {}) });
  assert.equal(none.status, 401, 'no bearer: Softeria\'s 401');
  assert.match(none.headers.get('www-authenticate'), /resource_metadata=/);
  const batch = await call(gate.port, '/mcp', { headers: H(tok), body: JSON.stringify([JSON.parse(RPC('ping', {}))]) });
  assert.equal(batch.json.result.batch, true, 'batches are Softeria\'s business');
});

test('an oversized MCP body is refused before Softeria', async () => {
  up.seen.length = 0;
  const r = await call(gate.port, '/mcp', { headers: H(mint()), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { pad: 'x'.repeat(5 * 1024 * 1024) } }) });
  assert.equal(r.status, 413);
  assert.equal(up.seen.length, 0);
});

// ---- tools/list -------------------------------------------------------------
test('tools/list gains read-mail-text (JSON and SSE upstream answers)', async () => {
  const r = await call(gate.port, '/mcp', { headers: H(mint()), body: RPC('tools/list', {}) });
  assert.deepEqual(r.json.result.tools.map((t) => t.name), ['list-mail-messages', 'get-upload-url', 'read-mail-text']);
  assert.equal(r.headers.get('mcp-session-id'), 'S1');
  const sse = await startUpstream({ sse: true });
  const g = await startGate({ UPSTREAM_PORT: String(sse.port) });
  try {
    const s = await call(g.port, '/mcp', { headers: H(mint()), body: RPC('tools/list', {}) });
    assert.deepEqual(s.json.result.tools.map((t) => t.name).slice(-1), ['read-mail-text']);
  } finally { g.close(); sse.close(); }
  const rejected = await call(gate.port, '/mcp', { headers: H(mint({ oid: 'REJECT' })), body: RPC('tools/list', {}) });
  assert.equal(rejected.status, 401, 'a refused caller gets Softeria\'s 401, not a tool list');
});

// ---- read-mail-text ---------------------------------------------------------
test('read-mail-text by ids: get-mail-message per id as the caller, cleaned, unknown ids reported', async () => {
  up.seen.length = 0;
  const tok = mint();
  const r = await call(gate.port, '/mcp', { headers: H(tok), body: READ({ messageIds: ['AAA', 'MISSING-1'] }) });
  assert.equal(r.json.result.isError, false);
  const out = JSON.parse(r.json.result.content[0].text);
  assert.equal(out[0].text, 'Body AAA\n\n');
  assert.deepEqual(out[1], { id: 'MISSING-1', error: 'not found' });
  const calls = up.seen.map((x) => JSON.parse(x.body).params);
  assert.deepEqual(calls.map((c) => [c.name, c.arguments.messageId]).sort(), [['get-mail-message', 'AAA'], ['get-mail-message', 'MISSING-1']]);
  assert.match(calls[0].arguments.select, /\bbody\b/);
  for (const x of up.seen) assert.equal(x.headers.authorization, `Bearer ${tok}`);
});

test('read-mail-text by folder: list-mail-folder-messages with top and search passed for Softeria to normalise', async () => {
  up.seen.length = 0;
  const r = await call(gate.port, '/mcp', { headers: H(mint()), body: READ({ folderId: 'inbox', top: 2, search: 'subject:"q report"' }) });
  assert.deepEqual(JSON.parse(r.json.result.content[0].text).map((m) => m.text), ['Body F1\n\n', 'Body F2\n\n']);
  const c = JSON.parse(up.seen[0].body).params;
  assert.equal(c.name, 'list-mail-folder-messages');
  assert.deepEqual([c.arguments.mailFolderId, c.arguments.top, c.arguments.search], ['inbox', 2, 'subject:"q report"']);
});

test('read-mail-text errors: bad arguments, a Graph error, and a refused caller (Softeria\'s 401 relayed)', async () => {
  const bad = await call(gate.port, '/mcp', { headers: H(mint()), body: READ({}) });
  assert.equal(bad.json.result.isError, true);
  assert.match(JSON.parse(bad.json.result.content[0].text).error, /messageIds or folderId/);
  const graph = await call(gate.port, '/mcp', { headers: H(mint()), body: READ({ folderId: 'inbox', filter: 'bad' }) });
  assert.equal(graph.json.result.isError, true);
  assert.match(JSON.parse(graph.json.result.content[0].text).error, /Invalid filter clause/);
  const refused = await call(gate.port, '/mcp', { headers: H(mint({ oid: 'REJECT' })), body: READ({ folderId: 'inbox' }) });
  assert.equal(refused.status, 401);
  assert.match(refused.headers.get('www-authenticate'), /invalid_token/);
  up.seen.length = 0;
  const noBearer = await call(gate.port, '/mcp', { headers: { 'content-type': 'application/json' }, body: READ({ folderId: 'inbox' }) });
  assert.equal(noBearer.status, 401, 'no bearer: passed to Softeria, which answers 401');
  assert.equal(up.seen.length, 1);
});

test('read-mail-text: a result over the limit is refused whole', async () => {
  const big = await startUpstream({ bigBodies: true });
  const g = await startGate({ UPSTREAM_PORT: String(big.port), GATE_READ_MAIL_TEXT_MAX_CHARS: '50000' });
  try {
    const r = await call(g.port, '/mcp', { headers: H(mint()), body: READ({ folderId: 'inbox', top: 20 }) });
    assert.equal(r.json.result.isError, true);
    assert.match(JSON.parse(r.json.result.content[0].text).error, /^Response would be [\d,]+ characters \(limit 50,000\)/);
    const ok = await call(g.port, '/mcp', { headers: H(mint()), body: READ({ folderId: 'inbox', top: 20, maxChars: 1000 }) });
    assert.equal(JSON.parse(ok.json.result.content[0].text).length, 20);
  } finally { g.close(); big.close(); }
});

test('logs are structured and carry no mail content or tokens', async () => {
  const out = gate.output();
  for (const l of out.trim().split('\n').filter(Boolean)) assert.ok(JSON.parse(l).cat, l);
  assert.doesNotMatch(out, /Body AAA|Bearer |eyJ/);
});
