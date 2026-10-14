#!/usr/bin/env node
// Gate for m365-claude-relay: a transparent pass-through to Softeria
// ms-365-mcp-server (loopback, `--http --obo`) that adds one tool,
// read-mail-text (mail-text.js), until Softeria#708 ships it upstream.
//
// Everything else is Softeria's own behaviour: OAuth and the On-Behalf-Of
// exchange, token checks (401 on a rejected token, the tenant/user allowlist),
// the tool surface (scopes and --enabled-tools, set by start.sh), attachment
// links, rate limits, security headers and the audit log. The gate does not
// read or judge tokens: read-mail-text calls Softeria's mail tools with the
// caller's own bearer, so Softeria decides exactly as for any other call.
//
// Requests pass through untouched, except: POST /mcp is buffered (size-capped)
// so tools/list can gain the tool and its tools/call can be answered here, and
// the socket peer is appended to X-Forwarded-For as any proxy does.

const http = require('http');
const mailText = require('./mail-text');

function intEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max) {
    console.error(JSON.stringify({ level: 'fatal', cat: 'config', msg: `${name} must be an integer from ${min} to ${max}` }));
    process.exit(1);
  }
  return n;
}

const PORT = intEnv('PORT', 7860, 1, 65535);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = intEnv('UPSTREAM_PORT', 3000, 1, 65535);
const MCP_MAX_BODY = intEnv('GATE_MCP_MAX_BODY_MB', 4, 1, 64) * 1024 * 1024;
const READ_MAIL_TEXT_MAX_CHARS = intEnv('GATE_READ_MAIL_TEXT_MAX_CHARS', 80000, 1000, 1000000);

const log = (fields) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));

function upstreamHeaders(req, length) {
  const h = { ...req.headers };
  const xff = req.headers['x-forwarded-for'];
  h['x-forwarded-for'] = xff ? `${xff}, ${req.socket.remoteAddress}` : req.socket.remoteAddress;
  if (length !== undefined) { h['content-length'] = String(length); delete h['transfer-encoding']; }
  return h;
}

// Stream a request to Softeria and its answer back, unchanged.
function pipeThrough(req, res, body) {
  const up = http.request({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers: upstreamHeaders(req, body && body.length) }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"upstream_unavailable"}'); } });
  if (body) up.end(body); else req.pipe(up);
}

// A buffered request to Softeria (tools/list, internal tool calls).
function upstreamRequest(path, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: 'POST', path, headers }, (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => resolve({ status: up.statusCode, headers: up.headers, body: Buffer.concat(chunks) }));
      up.on('error', reject);
    });
    r.on('error', reject);
    r.end(body);
  });
}

function parseRpc(buf) {
  const t = buf.toString('utf8').trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const line = t.split('\n').find((l) => l.startsWith('data:'));
  return line ? JSON.parse(line.slice(5).trim()) : null;
}

// Send a buffered upstream answer: its status, headers and body, with the
// framing headers rewritten for the buffered body.
function relayBuffered(res, up) {
  const headers = { ...up.headers };
  delete headers['transfer-encoding'];
  headers['content-length'] = up.body.length;
  res.writeHead(up.status, headers);
  res.end(up.body);
}

function sendJson(res, status, obj, extra) {
  const out = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { ...(extra || {}), 'content-type': 'application/json', 'content-length': out.length });
  res.end(out);
}

// Run a Softeria tool as the caller (same bearer). A 401/403 from Softeria is
// the caller being refused: it is thrown with the response so the client gets
// exactly Softeria's answer (and re-authenticates).
async function callTool(req, name, args) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'gate', method: 'tools/call', params: { name, arguments: args } }));
  const headers = {
    ...upstreamHeaders(req, body.length), 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  };
  const up = await upstreamRequest('/mcp', headers, body);
  if (up.status === 401 || up.status === 403) throw Object.assign(new Error('refused'), { refusal: up });
  const rpc = parseRpc(up.body);
  if (!rpc || rpc.error || !rpc.result) throw new Error(rpc && rpc.error ? rpc.error.message : `upstream HTTP ${up.status}`);
  const text = (rpc.result.content || []).map((c) => c.text || '').join('');
  if (rpc.result.isError) throw new Error(text.slice(0, 500));
  return JSON.parse(text);
}

async function handleReadMailText(req, res, rpc) {
  const reply = (payload, isError) => sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: !!isError } });
  try {
    const out = await mailText.readMailText(rpc.params.arguments, (name, args) => callTool(req, name, args), READ_MAIL_TEXT_MAX_CHARS);
    log({ cat: 'read_mail_text', messages: out.length });
    return reply(out);
  } catch (e) {
    if (e.refusal) return relayBuffered(res, e.refusal);
    log({ cat: e instanceof mailText.ToolError ? 'read_mail_text_refused' : 'read_mail_text_failed' });
    return reply({ error: e.message }, true);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (over) return; // drain the rest so the 413 can be delivered
      if (size > MCP_MAX_BODY) { over = true; chunks.length = 0; reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/mcp') return pipeThrough(req, res);
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 413, { error: 'request body too large' }, { connection: 'close' }); }
  let rpc = null;
  try { rpc = JSON.parse(body.toString('utf8')); } catch { /* Softeria answers */ }
  if (!rpc || Array.isArray(rpc) || typeof rpc !== 'object') return pipeThrough(req, res, body);

  if (rpc.method === 'tools/call' && rpc.params && rpc.params.name === mailText.TOOL_NAME) {
    // Same precondition as any /mcp call: no bearer, Softeria's own 401.
    if (!/^Bearer \S/.test(req.headers.authorization || '')) return pipeThrough(req, res, body);
    return handleReadMailText(req, res, rpc);
  }
  if (rpc.method === 'tools/list') {
    let up;
    try { up = await upstreamRequest(req.url, upstreamHeaders(req, body.length), body); } catch { return sendJson(res, 502, { error: 'upstream_unavailable' }); }
    let r = null;
    try { r = parseRpc(up.body); } catch { /* pass through as is */ }
    if (up.status === 200 && r && r.result && Array.isArray(r.result.tools)) {
      r.result.tools = r.result.tools.filter((t) => t.name !== mailText.TOOL_NAME).concat(mailText.TOOL_DEF);
      const headers = { ...up.headers };
      delete headers['content-length']; delete headers['transfer-encoding']; delete headers['content-type'];
      return sendJson(res, 200, r, headers);
    }
    return relayBuffered(res, up);
  }
  pipeThrough(req, res, body);
});

server.listen(PORT, HOST, () => log({ cat: 'listening', host: HOST, port: PORT, upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`, readMailTextMaxChars: READ_MAIL_TEXT_MAX_CHARS }));
