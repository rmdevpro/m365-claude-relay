// Test helpers: a local JWKS + token minter, a mock Softeria upstream, a mock
// Graph upload-session receiver, and a gate launcher. Loopback only; no real
// credentials. GATE_ALLOW_INSECURE_TEST=1 lets the gate accept http loopback
// origins; deployments never set it.
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const CONSUMERS_TID = '9188040d-6c67-4c5b-b112-36a304b66dad';

function makeSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' };
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  function mint(over = {}, hdr = {}) {
    const now = Math.floor(Date.now() / 1000);
    const c = { ver: '2.0', aud: CLIENT_ID, tid: CONSUMERS_TID, iss: `https://login.microsoftonline.com/${CONSUMERS_TID}/v2.0`,
      scp: 'access_as_user', oid: 'oid-1', exp: now + 3600, nbf: now - 10, ...over };
    const h = { alg: 'RS256', kid: 'k1', ...hdr };
    const d = `${b(h)}.${b(c)}`;
    return d + '.' + crypto.sign('RSA-SHA256', Buffer.from(d), privateKey).toString('base64url');
  }
  return { jwk, mint };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function startJwks(jwk) {
  const s = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ keys: [jwk] })); });
  const port = await listen(s);
  return { port, close: () => s.close() };
}

// Mock Graph upload-session receiver: records each chunk's Content-Range.
async function startUploadSink() {
  const puts = [];
  const s = http.createServer((req, res) => {
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.on('end', () => { puts.push({ range: req.headers['content-range'], length: n }); res.writeHead(202); res.end(); });
  });
  const port = await listen(s);
  return { port, puts, url: `http://127.0.0.1:${port}/session`, close: () => s.close() };
}

// Mock upstream: records every request; answers MCP methods; serves "/".
async function startUpstream(opts = {}) {
  const seen = [];
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const base = { 'content-type': 'application/json', 'access-control-allow-origin': 'http://localhost:3000' };
      if (req.url === '/') { res.writeHead(200, base); return res.end('Microsoft 365 MCP Server is running'); }
      if (req.url.startsWith('/authorize')) { res.writeHead(302, { ...base, location: 'https://login.microsoftonline.com/x?' + req.url.split('?')[1] }); return res.end(); }
      if (req.url === '/mcp') {
        let rpc; try { rpc = JSON.parse(body); } catch { rpc = null; }
        const msgs = Array.isArray(rpc) ? rpc : [rpc];
        const out = msgs.map((m) => {
          if (!m || !m.method) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'bad' } };
          if (m.method === 'initialize') return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '0' }, instructions: 'UPSTREAM DEFAULT' } };
          if (m.method === 'tools/list') return { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'list-mail-messages', inputSchema: { type: 'object' } }, { name: 'add-mail-attachment', inputSchema: { type: 'object' } }, { name: 'create-mail-attachment-upload-session', inputSchema: { type: 'object' } }, { name: 'graph-batch', inputSchema: { type: 'object' } }] } };
          if (m.method === 'tools/call') {
            const name = m.params && m.params.name;
            const args = (m.params && m.params.arguments) || {};
            const text = (o) => ({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
            if (name === 'add-mail-attachment') return text({ id: 'att-1' });
            if (name === 'create-mail-attachment-upload-session') return text({ uploadUrl: opts.uploadUrl || 'https://outlook.office.com/api/session' });
            if (name === 'get-mail-message') return text({ id: args.messageId, isDraft: String(args.messageId).startsWith('DRAFT') });
            if (name === 'graph-batch') {
              const rq = args.body.requests[0];
              const body = rq.url.endsWith('/createUploadSession') ? { uploadUrl: opts.uploadUrl || 'https://outlook.office.com/api/session' } : { id: 'att-e' };
              return text({ responses: [{ id: rq.id, status: 201, body }] });
            }
            return text({ called: name });
          }
          return { jsonrpc: '2.0', id: m.id, result: {} };
        });
        res.writeHead(200, base);
        return res.end(JSON.stringify(Array.isArray(rpc) ? out : out[0]));
      }
      res.writeHead(200, base); res.end('{}');
    });
  });
  const port = await listen(s);
  return { port, seen, close: () => s.close() };
}

const fs = require('fs');
const os = require('os');
const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'policy.json'), 'utf8'));

// JWKS that sends headers then never finishes the body (deadline test).
async function startStallingJwks() {
  const sockets = new Set();
  const s = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.write('{"keys":['); });
  s.on('connection', (c) => sockets.add(c));
  const port = await listen(s);
  return { port, close: () => { for (const c of sockets) c.destroy(); s.close(); } };
}
// JWKS that redirects to another origin (redirect-refusal test).
async function startRedirectingJwks(target) {
  const s = http.createServer((q, r) => { r.writeHead(302, { location: target }); r.end(); });
  const port = await listen(s);
  return { port, close: () => s.close() };
}

// `policy` = overrides merged into the committed policy; `rawPolicy` = used
// verbatim (schema tests). Either way the gate runs as a COPY of gate.js in a
// temp dir next to that policy.json: there is no runtime mechanism to point a
// deployed gate at another policy, and the tests must not need one.
async function startGate(env, { expectExit, policy, rawPolicy } = {}) {
  let gatePath = path.join(__dirname, '..', 'gate.js');
  if (policy || rawPolicy) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-copy-'));
    fs.copyFileSync(gatePath, path.join(dir, 'gate.js'));
    fs.writeFileSync(path.join(dir, 'policy.json'), typeof rawPolicy === 'string' ? rawPolicy : JSON.stringify(rawPolicy || { ...POLICY, ...policy }));
    gatePath = path.join(dir, 'gate.js');
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [gatePath], {
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', MS365_MCP_PUBLIC_URL: 'https://relay.example', MS365_MCP_CLIENT_ID: CLIENT_ID, GATE_ALLOW_INSECURE_TEST: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  if (expectExit) {
    const code = await new Promise((resolve) => child.on('exit', resolve));
    return { code, out };
  }
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gate did not start: ' + out)), 8000);
    child.stdout.on('data', function onData(c) { if (String(c).includes('"listening"')) { clearTimeout(t); resolve(); } });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`gate exited ${code}: ${out}`)); });
  });
  return { port, child, output: () => out, close: () => child.kill() };
}

async function call(port, path, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

module.exports = { CLIENT_ID, CONSUMERS_TID, POLICY, makeSigner, startJwks, startStallingJwks, startRedirectingJwks, startUpstream, startUploadSink, startGate, call };
