// Test helpers: a token minter, a mock Softeria upstream and a gate launcher.
// Loopback only; no real credentials. The gate never judges tokens, so the
// mock plays Softeria's part: a bearer whose payload has oid "REJECT" gets
// Softeria's 401, as when Entra refuses the assertion at the OBO exchange.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'policy.json'), 'utf8'));

function mint(claims = {}) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256', typ: 'JWT' })}.${b({ aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600, oid: 'oid-1', ...claims })}.sig`;
}

// A port the OS reports free right now (bound to 0, then released).
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function claimsOf(req) {
  try { return JSON.parse(Buffer.from(String(req.headers.authorization || '').split('.')[1] || '', 'base64url').toString()); } catch { return {}; }
}

// Mock Softeria: records every request; answers MCP like the real server (SSE
// when opts.sse), plus a plain route for pass-through checks.
async function startUpstream(opts = {}) {
  const seen = [];
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url !== '/mcp') {
        res.writeHead(201, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
        return res.end(`echo ${req.method} ${req.url} ${body}`);
      }
      if (!req.headers.authorization) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer resource_metadata="https://relay.example/.well-known/oauth-protected-resource", error="invalid_token"' });
        return res.end('{"error":"invalid_token"}');
      }
      if (claimsOf(req).oid === 'REJECT') {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' });
        return res.end('{"error":"invalid_token","error_description":"The access token was rejected; sign in again"}');
      }
      let rpc; try { rpc = JSON.parse(body); } catch { rpc = null; }
      const reply = (result) => {
        const msg = JSON.stringify({ jsonrpc: '2.0', id: rpc && rpc.id, result });
        res.writeHead(200, { 'content-type': opts.sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'S1' });
        res.end(opts.sse ? `event: message\ndata: ${msg}\n\n` : msg);
      };
      const text = (o, isError) => reply({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }], ...(isError ? { isError: true } : {}) });
      if (!rpc || Array.isArray(rpc)) return reply({ batch: true });
      if (rpc.method === 'tools/list') return reply({ tools: [{ name: 'list-mail-messages', inputSchema: { type: 'object' } }, { name: 'get-upload-url', inputSchema: { type: 'object' } }] });
      if (rpc.method === 'tools/call') {
        const { name, arguments: args = {} } = rpc.params;
        const msg = (id) => ({ id, subject: `S-${id}`, body: { contentType: 'text', content: `Body ${id}\n\nOn Mon, 6 Oct 2026, P wrote:\n> old` }, from: { emailAddress: { address: 'p@example.com' } } });
        if (name === 'get-mail-message') {
          if (String(args.messageId).startsWith('MISSING')) return text('Microsoft Graph API error: 404 Not Found - {"error":{"code":"ErrorItemNotFound","message":"x"}}', true);
          return text(msg(args.messageId));
        }
        if (name === 'list-mail-folder-messages') {
          if (args.filter === 'bad') return text('Microsoft Graph API error: 400 Bad Request - {"error":{"code":"BadRequest","message":"Invalid filter clause"}}', true);
          const n = Math.min(args.top || 2, opts.bigBodies ? 20 : 2);
          return text({ value: Array.from({ length: n }, (_, i) => (opts.bigBodies ? { ...msg(`F${i}`), body: { content: 'x'.repeat(10000) } } : msg(`F${i + 1}`))) });
        }
        return text({ called: name });
      }
      return reply({ method: rpc.method });
    });
  });
  const port = await listen(s);
  return { port, seen, close: () => s.close() };
}

async function startGate(env, { expectExit } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'gate.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', ...env },
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

async function call(port, p, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

module.exports = { CLIENT_ID, POLICY, mint, freePort, startUpstream, startGate, call, crypto };
