#!/usr/bin/env node
// Gate for the M365 relay OBO deployment (m365-claude-relay). OTS-first.
//
// Softeria ms-365-mcp-server (loopback, `--http --obo`) owns OAuth/OBO, Graph,
// the tool surface (`--enabled-tools`), Graph consent scopes
// (`MS365_MCP_EXTRA_SCOPES`), attachment download links
// (`--enable-attachment-urls`) and the per-call audit log. This gate is the
// minimal custom delta, each piece justified in README.md:
//
//   1. Inbound relay-token validation before OBO (signature vs Microsoft's
//      keys, iss, aud, tid, lifetime, scope, optional user allowlist).
//   2. Upload bridge `get-attachment-upload-link` until upstream PR #695 lands.
//   3. Consent shim in /authorize until upstream PR #694 lands.
//   4. MCP glue: advertise/dispatch the upload tool, hide the two OTS upload
//      primitives it supersedes, replace server instructions that point at
//      disabled tools, refuse JSON-RPC batches.
//
// Public-service posture (m365-claude-relay "Final hardening list", section A):
// structured logs with a correlation id and fixed categories; canonical client
// address to the upstream; exact open routes; no CORS; security headers on
// every response; generic 401s; config validated as a security boundary
// (approved HTTPS origins); bounded outbound calls and JWKS cache age; per-IP
// rate limiting, per-user upload quotas, draft-only enforcement and
// tool-notification refusal as switchable mechanisms (section B, J decides).
//
// State held in memory only: Microsoft public keys; pending upload links
// (draft id, filename, the caller's bearer until used or expired, <= 5 min);
// one chunk of an upload while it streams to Graph. Nothing on disk.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- configuration (validated; bad values fail startup) ---------------------

function fatal(msg) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', cat: 'config', msg }));
  process.exit(1);
}
function list(v) {
  return String(v || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}
function intEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw)) fatal(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min || n > max) fatal(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}
function boolEnv(name, def) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (raw === '') return def;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  fatal(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}
function parseOrigin(name, raw, { httpsOnly }) {
  let u;
  try { u = new URL(raw); } catch { fatal(`${name} is not a valid URL`); }
  if (httpsOnly && u.protocol !== 'https:') fatal(`${name} must be https`);
  if (!httpsOnly && !['https:', 'http:'].includes(u.protocol)) fatal(`${name} must be http or https`);
  return u;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSUMERS_TID = '9188040d-6c67-4c5b-b112-36a304b66dad'; // Microsoft personal-account tenant

// Test override: allows http origins (loopback JWKS/upstream) in the test suite
// only. Never set in a deployment; startup logs a warning when it is on.
const INSECURE_TEST = boolEnv('GATE_ALLOW_INSECURE_TEST', false);

const PORT = intEnv('PORT', 7860, 1, 65535);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = intEnv('UPSTREAM_PORT', 3000, 1, 65535);

const PUBLIC_RAW = (process.env.MS365_MCP_PUBLIC_URL || '').trim();
if (!PUBLIC_RAW) fatal('MS365_MCP_PUBLIC_URL is required');
const PUBLIC_U = parseOrigin('MS365_MCP_PUBLIC_URL', PUBLIC_RAW, { httpsOnly: !INSECURE_TEST });
if (PUBLIC_U.search || PUBLIC_U.hash || (PUBLIC_U.pathname && PUBLIC_U.pathname !== '/')) fatal('MS365_MCP_PUBLIC_URL must be an origin only');
const PUBLIC_URL = PUBLIC_U.origin;
const PUBLIC_HOST = PUBLIC_U.host;

const CLIENT_ID = (process.env.MS365_MCP_CLIENT_ID || '').trim();
if (!GUID.test(CLIENT_ID)) fatal('MS365_MCP_CLIENT_ID must be the relay app (client) id GUID');
const TENANT = (process.env.MS365_MCP_TENANT_ID || 'consumers').trim();
const ALLOWED_TIDS = list(process.env.GATE_ALLOWED_TIDS).length
  ? list(process.env.GATE_ALLOWED_TIDS)
  : [TENANT === 'consumers' ? CONSUMERS_TID : TENANT];
for (const t of ALLOWED_TIDS) if (!GUID.test(t)) fatal(`tenant id ${JSON.stringify(t)} is not a GUID`);
const REQUIRED_SCOPE = process.env.GATE_REQUIRED_SCOPE || 'access_as_user';
const ALLOWED_USERS = list(process.env.GATE_ALLOWED_USERS);
const GATE_KEY = process.env.MCP_GATE_KEY || '';
const CLOCK_SKEW = 300;

// ---- deployment policy (versioned, reviewed; env may not override) ---------
// policy.json holds the image's fixed constraints: the default scope list,
// the excluded tools, the hidden bridge tools and the behaviour switches.
// Scopes are overridable by the operator (MS365_MCP_ALLOWED_SCOPES); the
// switches may not be weakened through the environment.
// The only policy is the committed file next to this script; nothing selects
// another one. (Tests run a copy of this file with a different policy.json.)
if (process.env.GATE_POLICY_FILE !== undefined) fatal('GATE_POLICY_FILE is not supported: the policy is the committed policy.json next to gate.js');
const POLICY_PATH = path.join(__dirname, 'policy.json');
let POLICY;
try { POLICY = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')); } catch { fatal(`policy file ${POLICY_PATH} unreadable`); }
// Strict schema: wrong types never coerce into weaker behaviour.
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringList = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
const isStringListOrEmpty = (v) => Array.isArray(v) && v.every(isNonEmptyString);
if (!POLICY || typeof POLICY !== 'object' || Array.isArray(POLICY)) fatal('policy.json must be a JSON object');
const SCHEMA = {
  version: isNonEmptyString, description: (v) => v === undefined || typeof v === 'string',
  scopes: isStringList, excludedTools: isStringListOrEmpty, hiddenTools: isStringList,
  draftOnly: (v) => typeof v === 'boolean', rejectToolNotifications: (v) => typeof v === 'boolean', trustedIngress: (v) => typeof v === 'boolean',
};
for (const [k, ok] of Object.entries(SCHEMA)) if (!ok(POLICY[k])) fatal(`policy.json: "${k}" missing or of the wrong type`);
for (const k of Object.keys(POLICY)) if (!(k in SCHEMA)) fatal(`policy.json: unknown field "${k}"`);
for (const s of POLICY.scopes) if (!/^[A-Za-z][\w.]*$/.test(s)) fatal(`policy.json scopes: "${s}" is not a Graph scope name`);
for (const t of [...POLICY.excludedTools, ...POLICY.hiddenTools]) if (!/^[a-z][a-z0-9-]*$/.test(t)) fatal(`policy.json: "${t}" is not a tool name`);
// The upload bridge relies on these being registered upstream but hidden.
for (const t of ['add-mail-attachment', 'create-mail-attachment-upload-session', 'graph-batch']) {
  if (!POLICY.hiddenTools.includes(t)) fatal(`policy.json hiddenTools must include "${t}"`);
}
for (const t of POLICY.hiddenTools) if (POLICY.excludedTools.includes(t)) fatal(`policy.json: "${t}" cannot be both hidden and excluded`);
if (!POLICY.scopes.includes('Mail.ReadWrite')) fatal('policy.json scopes must include Mail.ReadWrite (the upload bridge attaches to drafts)');
function pinned(envName, policyValue, norm) {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return policyValue;
  if (norm(raw) !== norm(policyValue)) fatal(`${envName} differs from policy.json version ${POLICY.version}; change the policy, not the environment`);
  return policyValue;
}
const sortedList = (v) => list(Array.isArray(v) ? v.join(' ') : v).sort().join(' ');
const boolNorm = (v) => String(v).trim().toLowerCase().replace(/^(1|yes|on)$/, 'true').replace(/^(0|no|off)$/, 'false');
// Scopes are operator configuration: MS365_MCP_ALLOWED_SCOPES (start.sh
// derives the tool surface from them at every start), defaulting to the
// policy's list. MS365_MCP_EXTRA_SCOPES (the consent shim) must be the same
// list; start.sh sets both.
const ALLOWED_SCOPES = list(process.env.MS365_MCP_ALLOWED_SCOPES).length ? list(process.env.MS365_MCP_ALLOWED_SCOPES) : POLICY.scopes;
for (const sc of ALLOWED_SCOPES) if (!/^[A-Za-z][\w.]*$/.test(sc)) fatal(`MS365_MCP_ALLOWED_SCOPES: "${sc}" is not a Graph scope name`);
if (!ALLOWED_SCOPES.includes('Mail.ReadWrite')) fatal('MS365_MCP_ALLOWED_SCOPES must include Mail.ReadWrite (the upload bridge attaches to drafts)');
const TOOL_COUNT = Number(process.env.RELAY_TOOL_COUNT) || null;

// Approved origins: the only places the gate will fetch signing keys from, and
// the only origins attachment download links may point at. Default: the public
// origin and Microsoft's login authority.
const APPROVED_ORIGINS = new Set([
  PUBLIC_URL,
  'https://login.microsoftonline.com',
  ...list(process.env.GATE_APPROVED_ORIGINS).map((o) => parseOrigin('GATE_APPROVED_ORIGINS', o, { httpsOnly: !INSECURE_TEST }).origin),
]);
const JWKS_URI = (process.env.GATE_JWKS_URI || '').trim() || 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
{
  const u = parseOrigin('GATE_JWKS_URI', JWKS_URI, { httpsOnly: !INSECURE_TEST });
  if (!INSECURE_TEST && !APPROVED_ORIGINS.has(u.origin)) fatal(`GATE_JWKS_URI origin ${u.origin} is not in the approved origins`);
}
if (process.env.MS365_MCP_ATTACHMENT_URL_BASE) {
  const u = parseOrigin('MS365_MCP_ATTACHMENT_URL_BASE', process.env.MS365_MCP_ATTACHMENT_URL_BASE, { httpsOnly: !INSECURE_TEST });
  if (!INSECURE_TEST && !APPROVED_ORIGINS.has(u.origin)) fatal(`MS365_MCP_ATTACHMENT_URL_BASE origin ${u.origin} is not in the approved origins`);
}
// Graph upload-session hosts the bridge may PUT to (suffix match on the hostname,
// https only). Default covers the global cloud; set for other clouds.
const UPLOAD_HOST_SUFFIXES = list(process.env.GATE_UPLOAD_HOST_SUFFIXES).length
  ? list(process.env.GATE_UPLOAD_HOST_SUFFIXES)
  : ['.office.com', '.office365.com', '.outlook.com', '.microsoft.com', '.sharepoint.com', '.windows.net'];

// Graph consent scopes from the policy (start.sh exports the same list to
// Softeria as MS365_MCP_EXTRA_SCOPES; a differing value fails startup).
const CONSENT_SCOPES = list(pinned('MS365_MCP_EXTRA_SCOPES', ALLOWED_SCOPES, sortedList).join(' ')).map((s) => (s.includes('://') ? s : `https://graph.microsoft.com/${s}`));

// Timeouts and connection bounds (mechanisms; values reviewed with the owner).
const JWKS_TIMEOUT_MS = intEnv('GATE_JWKS_TIMEOUT_MS', 5000, 1000, 60000);
const JWKS_MAX_AGE_MS = intEnv('GATE_JWKS_MAX_AGE_SECONDS', 86400, 300, 604800) * 1000;
const UPSTREAM_TIMEOUT_MS = intEnv('GATE_UPSTREAM_TIMEOUT_MS', 60000, 1000, 600000);
const GRAPH_PUT_TIMEOUT_MS = intEnv('GATE_GRAPH_PUT_TIMEOUT_MS', 120000, 1000, 600000);
const BODY_IDLE_TIMEOUT_MS = intEnv('GATE_BODY_IDLE_TIMEOUT_MS', 60000, 1000, 600000);
const HEADERS_TIMEOUT_MS = intEnv('GATE_HEADERS_TIMEOUT_MS', 30000, 1000, 120000);
const REQUEST_TIMEOUT_MS = intEnv('GATE_REQUEST_TIMEOUT_MS', 900000, 10000, 3600000);
const MAX_CONNECTIONS = intEnv('GATE_MAX_CONNECTIONS', 256, 1, 65535);

// Rate limiting (per client IP, fixed one-minute window). 0 = off.
const RATE_LIMIT_PER_MIN = intEnv('GATE_RATE_LIMIT_PER_MIN', 0, 0, 100000);

// Upload bridge limits. 0 = unlimited for the count/quota values.
const LINK_TTL_MS = intEnv('GATE_LINK_TTL_SECONDS', 300, 30, 300) * 1000;
const LINK_MAX_BYTES = (intEnv('GATE_LINK_MAX_MB', 150, 0, 150) || 150) * 1024 * 1024;
const LINK_TOTAL_BYTES = intEnv('GATE_LINK_TOTAL_MB', 512, 0, 65536) * 1024 * 1024;
const LINK_MAX_PENDING = intEnv('GATE_LINK_MAX_PENDING', 64, 0, 100000);
const LINK_MAX_CONCURRENT = intEnv('GATE_LINK_MAX_CONCURRENT', 4, 0, 1024);
const LINK_MAX_PENDING_PER_USER = intEnv('GATE_LINK_MAX_PENDING_PER_USER', 0, 0, 100000);
const LINK_MAX_CONCURRENT_PER_USER = intEnv('GATE_LINK_MAX_CONCURRENT_PER_USER', 0, 0, 1024);
const MCP_MAX_BODY = intEnv('GATE_MCP_MAX_BODY_MB', 4, 1, 64) * 1024 * 1024;

// Behaviour switches decided by the owner (section B), pinned in the policy.
const DRAFT_ONLY = pinned('GATE_DRAFT_ONLY', POLICY.draftOnly, boolNorm) === true;
const REJECT_TOOL_NOTIFICATIONS = pinned('GATE_REJECT_TOOL_NOTIFICATIONS', POLICY.rejectToolNotifications, boolNorm) === true;
// Client address. Default: the socket peer. Only a policy that has proven the
// ingress strips/replaces forwarding headers and that the container is not
// reachable except through it may set trustedIngress, after which the last
// (ingress-appended) X-Forwarded-For entry is the client.
const TRUSTED_INGRESS = pinned('GATE_TRUSTED_INGRESS', POLICY.trustedIngress, boolNorm) === true;

// A path is accepted only if it is already in normal form: no percent-encoding,
// no '.'/'..' segments, no empty segments, bounded length. Anything else is
// refused before routing, so an open route cannot be reached by a look-alike.
function normalisedPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 2048 || p[0] !== '/') return false;
  if (/[%\\]/.test(p) || /[^\x21-\x7e]/.test(p)) return false;
  const segs = p.split('/');
  for (let i = 1; i < segs.length; i++) {
    const sg = segs[i];
    if (sg === '.' || sg === '..') return false;
    if (sg === '' && i !== segs.length - 1) return false; // '//' inside the path
  }
  return true;
}

// Routes that carry no relay bearer by design. Exact matches only, plus the
// discovery prefix. `/register` is never forwarded (DCR is off).
const OPEN_EXACT = new Set(['/', '/authorize', '/token', '/attachment']);
const OPEN_PREFIX = '/.well-known/';
const FILES_PREFIX = '/files/';

// OTS tools superseded by the upload bridge: hidden from tools/list and refused
// on external tools/call (the bridge calls them over loopback itself).
const HIDDEN_TOOLS = new Set(POLICY.hiddenTools);

// ---- logging (structured, metadata only) --------------------------------------

function logEvent(fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
function logReq(ctx, status, cat, extra) {
  logEvent({ id: ctx.id, ip: ctx.ip, method: ctx.req.method, path: ctx.path, status, cat, ms: Date.now() - ctx.start, ...(extra || {}) });
}

// ---- helpers ------------------------------------------------------------------

function clientIp(req) {
  if (TRUSTED_INGRESS) {
    const xff = String(req.headers['x-forwarded-for'] || '');
    const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress || 'unknown';
}
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
function send(ctx, status, body, extraHeaders) {
  const headers = { ...SECURITY_HEADERS, 'content-type': 'application/json', 'x-request-id': ctx.id, ...(extraHeaders || {}) };
  ctx.res.writeHead(status, headers);
  ctx.res.end(JSON.stringify(body) + '\n');
}
function reject(ctx, status, cat, error, description, extraHeaders) {
  const headers = { ...(extraHeaders || {}) };
  if (status === 401) {
    headers['www-authenticate'] = `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource", error="${error}", error_description="${description}"`;
  }
  send(ctx, status, { error, error_description: description }, headers);
  logReq(ctx, status, cat);
}

// ---- rate limiting (mechanism; off unless GATE_RATE_LIMIT_PER_MIN > 0) -------

const RATE_MAX_KEYS = intEnv('GATE_RATE_MAX_KEYS', 10000, 100, 1000000);
const rateWindows = new Map(); // ip -> { windowStart, count }; bounded, oldest evicted
function rateLimited(ip) {
  if (!RATE_LIMIT_PER_MIN) return false;
  const now = Date.now();
  const w = rateWindows.get(ip);
  if (!w || now - w.windowStart >= 60_000) {
    if (!w && rateWindows.size >= RATE_MAX_KEYS) rateWindows.delete(rateWindows.keys().next().value);
    rateWindows.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  w.count++;
  return w.count > RATE_LIMIT_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of rateWindows) if (now - w.windowStart >= 120_000) rateWindows.delete(ip);
}, 60_000).unref();

// ---- signing keys (in-memory; bounded age; refreshed on unknown kid) ----------

let keys = new Map();
let keysFetchedAt = 0;
let keysInFlight = null;
let lastKeyMiss = 0;

// One deadline covers headers AND the whole body; redirects are refused so the
// approved-origin check on JWKS_URI cannot be escaped; the body is size-capped.
const JWKS_MAX_BYTES = 1_000_000;
async function fetchBounded(url, ms, maxBytes) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400) throw new Error('redirect refused');
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const reader = resp.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new Error('too large'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(t); }
}
async function refreshKeys() {
  if (keysInFlight) return keysInFlight;
  keysInFlight = (async () => {
    const text = await fetchBounded(JWKS_URI, JWKS_TIMEOUT_MS, JWKS_MAX_BYTES);
    const { keys: jwks } = JSON.parse(text);
    const next = new Map();
    for (const jwk of jwks || []) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      try { next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* skip */ }
    }
    if (!next.size) throw new Error('jwks empty');
    keys = next;
    keysFetchedAt = Date.now();
  })();
  try { await keysInFlight; } finally { keysInFlight = null; }
}
async function keyFor(kid) {
  const now = Date.now();
  const stale = now - keysFetchedAt > JWKS_MAX_AGE_MS;
  if (stale || (!keys.has(kid) && now - lastKeyMiss > 60_000)) {
    if (!keys.has(kid)) lastKeyMiss = now;
    await refreshKeys(); // a stale cache is not trusted: failure here is a 503
  }
  return keys.get(kid);
}

// ---- token validation --------------------------------------------------------

function b64json(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}
// Returns { ok: true, claims } or { ok: false, cat } — the category is logged,
// never sent to the client.
async function validate(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, cat: 'token_malformed' };
  let header, claims;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { return { ok: false, cat: 'token_malformed' }; }
  if (header.alg !== 'RS256') return { ok: false, cat: 'token_alg' };
  const key = await keyFor(header.kid);
  if (!key) return { ok: false, cat: 'token_unknown_key' };
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) return { ok: false, cat: 'token_signature' };
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW < now) return { ok: false, cat: 'token_expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW > now) return { ok: false, cat: 'token_not_yet_valid' };
  if (claims.ver !== '2.0') return { ok: false, cat: 'token_version' };
  if (claims.aud !== CLIENT_ID) return { ok: false, cat: 'token_audience' };
  if (!ALLOWED_TIDS.includes(claims.tid)) return { ok: false, cat: 'token_tenant' };
  if (claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) return { ok: false, cat: 'token_issuer' };
  if (!(claims.scp || '').split(' ').includes(REQUIRED_SCOPE)) return { ok: false, cat: 'token_scope' };
  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(claims.oid)) return { ok: false, cat: 'token_user' };
  return { ok: true, claims };
}

// ---- proxying ----------------------------------------------------------------

const PASS_HEADERS = ['authorization', 'content-type', 'content-length', 'accept', 'accept-encoding',
  'mcp-protocol-version', 'mcp-session-id', 'last-event-id', 'user-agent'];

function upstreamHeaders(ctx, body) {
  const h = {};
  for (const k of PASS_HEADERS) if (ctx.req.headers[k] !== undefined) h[k] = ctx.req.headers[k];
  if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
  h.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  h['x-forwarded-proto'] = 'https';
  h['x-forwarded-host'] = PUBLIC_HOST;
  h['x-forwarded-for'] = ctx.ip; // one canonical client address, never the client's chain
  h['x-request-id'] = ctx.id;
  return h;
}
// Upstream response headers reach the client minus CORS (no browser client) and
// plus the gate's own security headers.
function relayHeaders(up, ctx) {
  const h = {};
  for (const [k, v] of Object.entries(up.headers)) {
    if (k.startsWith('access-control-')) continue;
    if (k === 'transfer-encoding') continue;
    h[k] = v;
  }
  return { ...h, ...SECURITY_HEADERS, 'x-request-id': ctx.id };
}

function forward(ctx, body) {
  const { req, res } = ctx;
  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers: upstreamHeaders(ctx, body), timeout: UPSTREAM_TIMEOUT_MS },
    (up) => {
      res.writeHead(up.statusCode, relayHeaders(up, ctx));
      up.pipe(res);
      if (up.statusCode < 400) return logReq(ctx, up.statusCode, 'ok');
      if (!ctx.path.startsWith('/token')) return logReq(ctx, up.statusCode, 'upstream_error');
      // OAuth failures: the error code and AADSTS number only.
      let buf = '';
      up.on('data', (c) => { if (buf.length < 4096) buf += c; });
      up.on('end', () => {
        let cat = 'oauth_error';
        let aad;
        try { const j = JSON.parse(buf); cat = `oauth_${String(j.error || 'error').replace(/[^a-z_]/gi, '').slice(0, 32)}`; aad = (/AADSTS\d+/.exec(j.error_description || '') || [])[0]; } catch { /* non-JSON */ }
        logReq(ctx, up.statusCode, cat, aad ? { aad } : undefined);
      });
    }
  );
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (e) => {
    if (!res.headersSent) send(ctx, 502, { error: 'upstream_unavailable' });
    logReq(ctx, 502, e.message === 'timeout' ? 'upstream_timeout' : 'upstream_unavailable');
  });
  if (body !== undefined) upstream.end(body);
  else req.pipe(upstream);
}

// Buffered request to Softeria (internal tool calls and small proxied replies).
function upstreamRequest(method, path, headers, body) {
  return new Promise((resolve, rej) => {
    const r = http.request({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, method, path, headers, timeout: UPSTREAM_TIMEOUT_MS }, (up) => {
      const chunks = [];
      let size = 0;
      up.on('data', (c) => { size += c.length; if (size > 16 * 1024 * 1024) { up.destroy(new Error('upstream body too large')); return; } chunks.push(c); });
      up.on('end', () => resolve({ status: up.statusCode, headers: up.headers, body: Buffer.concat(chunks) }));
      up.on('error', rej);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', rej);
    r.end(body);
  });
}
function parseRpc(buf) {
  const t = buf.toString('utf8').trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const line = t.split('\n').find((l) => l.startsWith('data:'));
  return line ? JSON.parse(line.slice(5).trim()) : null;
}

// Read a request body with a hard cap and an idle timeout.
function readBody(req, max) {
  return new Promise((resolve, rej) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return rej(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
    const chunks = [];
    let size = 0;
    let idle = setTimeout(onIdle, BODY_IDLE_TIMEOUT_MS);
    function onIdle() { req.destroy(); rej(Object.assign(new Error('idle'), { code: 'IDLE' })); }
    req.on('data', (c) => {
      clearTimeout(idle); idle = setTimeout(onIdle, BODY_IDLE_TIMEOUT_MS);
      size += c.length;
      if (size > max) { clearTimeout(idle); req.destroy(); rej(Object.assign(new Error('too large'), { code: 'TOO_LARGE' })); return; }
      chunks.push(c);
    });
    req.on('end', () => { clearTimeout(idle); resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { clearTimeout(idle); rej(e); });
  });
}

// ---- health -----------------------------------------------------------------

function health(ctx) {
  const fail = (why) => { if (!ctx.res.headersSent) send(ctx, 503, { ok: false, upstream: why }); };
  const r = http.request({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: 'GET', path: '/', timeout: 2000 }, (up) => {
    let buf = '';
    up.on('data', (c) => { if (buf.length < 1024) buf += c; });
    up.on('end', () => { if (up.statusCode === 200 && /running/i.test(buf)) send(ctx, 200, { ok: true, upstream: 'ready', scopes: ALLOWED_SCOPES, tools: TOOL_COUNT }); else fail('not ready'); });
  });
  r.on('timeout', () => { r.destroy(); fail('timeout'); });
  r.on('error', () => fail('unreachable'));
  r.end();
}

// ---- relay instructions (replace defaults that point at disabled tools) -----

const RELAY_INSTRUCTIONS = [
  'Microsoft 365 relay: mail, calendar, contacts and OneDrive of the signed-in user, via Microsoft Graph. Every call runs as that user.',
  'Mail: list-mail-messages supports $search (KQL; wrap the whole query in double quotes) or $filter (not both), $top, $select. Use $select and bodyPreview for lists; fetch full bodies with get-mail-message only when needed.',
  'READING ATTACHMENTS: list-mail-attachments gives ids and names. Then call get-download-url with target /me/messages/{message-id}/attachments/{attachment-id}/$value; it returns a single-use downloadUrl. In the code sandbox run curl -fsSL -o <name> "<downloadUrl>" and open the file like an uploaded file. Never ask for base64 file content.',
  'SENDING ATTACHMENTS: create a draft (create-draft-email or create-reply-draft / create-reply-all-draft / create-forward-draft), call get-attachment-upload-link with the draft id (or eventId for a calendar event) and filename, run the returned curl -T with the sandbox file path, then send-draft-message. Never inline base64 file content.',
  'FORWARDING: forward-mail-message (or create-forward-draft) carries the original attachments automatically. Replies do NOT carry the original attachments; forward instead. To drop some attachments: create-forward-draft, then delete-mail-attachment on the draft, then send-draft-message.',
  'Links are single-use and expire within 5 minutes. A sandbox network/proxy error on a link means the relay host must be added under Settings > Capabilities > Code execution > Additional allowed domains; tell the user.',
  'Calendar: prefer get-calendar-view with startDateTime/endDateTime (ISO 8601); set timeZone explicitly on events you create.',
  'Confirm with the user before sending, deleting, cancelling, or declining anything, unless they already asked for exactly that action.',
].join('\n');

// ---- upload bridge -----------------------------------------------------------

const UPLOAD_TOOL = 'get-attachment-upload-link';
const INLINE_MAX = 3 * 1024 * 1024 - 1; // Graph: < 3 MB inline, 3-150 MB upload session
const CHUNK = 320 * 1024 * 12;          // 3.75 MiB, a multiple of 320 KiB as Graph requires
const MESSAGE_ID = /^[A-Za-z0-9_=-]{20,1024}$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;

const UPLOAD_TOOL_DEF = {
  name: UPLOAD_TOOL,
  title: 'Get attachment upload link',
  description:
    'Attach a REAL FILE from your code sandbox to a draft email or to a calendar event, up to ' + Math.floor(LINK_MAX_BYTES / 1048576) + ' MB. Use this for every attachment; ' +
    'do not pass base64 contentBytes. Steps: (1) for mail, create the draft (create-draft-email, create-reply-draft, create-reply-all-draft or ' +
    'create-forward-draft) and take its id; for a calendar event take the event id; (2) call this tool with messageId (draft) OR eventId, plus filename; (3) in the code sandbox run the ' +
    'returned curl command, which uploads the file and attaches it (the response JSON confirms name and size); (4) repeat per file, then send ' +
    'with send-draft-message. The link works once and expires in ' + Math.floor(LINK_TTL_MS / 60000) + ' minutes. If the upload fails with a network/proxy error, the user ' +
    'must add the relay host to Settings > Capabilities > Code execution > Additional allowed domains.',
  inputSchema: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'Id of the DRAFT message to attach the file to (mail). Give messageId or eventId, not both.' },
      eventId: { type: 'string', description: 'Id of the calendar event to attach the file to. Saving an attachment on an event you organise sends an update to attendees.' },
      filename: { type: 'string', description: 'Attachment name as the recipient will see it, e.g. report.pdf' },
      contentType: { type: 'string', description: 'MIME type, e.g. application/pdf (optional; default application/octet-stream)' },
    },
    required: ['filename'],
    additionalProperties: false,
  },
  annotations: { title: 'Get attachment upload link', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

const links = new Map(); // key -> { messageId, filename, contentType, authorization, user, expires }
let activeUploads = 0;
let inflightBytes = 0;
const activePerUser = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of links) if (v.expires < now) links.delete(k);
}, 15_000).unref();

function pendingForUser(user) {
  let n = 0;
  for (const v of links.values()) if (v.user === user) n++;
  return n;
}
function rpcResult(ctx, id, payload, isError) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  send(ctx, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: !!isError } });
}
function safeName(name, contentType) {
  let n = String(name || '').replace(/[\\/\r\n"\x00-\x1f]/g, '_').trim().slice(0, 200);
  if (!n) n = `attachment${{ 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' }[contentType] || ''}`;
  return n;
}

// Call a Softeria tool internally as the given user (bearer). Errors carry only
// a category; upstream text never leaves this function.
async function callUpstreamTool(authorization, name, args, ctx) {
  const call = JSON.stringify({ jsonrpc: '2.0', id: 'gate-int', method: 'tools/call', params: { name, arguments: args } });
  const headers = {
    authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18', 'content-length': Buffer.byteLength(call), host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
    'x-forwarded-for': ctx.ip, 'x-request-id': ctx.id,
  };
  let up;
  try { up = await upstreamRequest('POST', '/mcp', headers, call); } catch (e) { throw Object.assign(new Error('upstream'), { cat: e.message === 'timeout' ? 'upstream_timeout' : 'upstream_unavailable' }); }
  let r;
  try { r = parseRpc(up.body); } catch { r = null; }
  if (!r) throw Object.assign(new Error('upstream'), { cat: 'upstream_bad_response' });
  if (r.error) throw Object.assign(new Error('upstream'), { cat: 'upstream_rpc_error' });
  const text = (r.result.content || []).map((c) => c.text || '').join('');
  if (r.result.isError) throw Object.assign(new Error('graph'), { cat: 'graph_error' });
  try { return JSON.parse(text); } catch { return { text }; }
}

async function isDraft(authorization, messageId, ctx) {
  const m = await callUpstreamTool(authorization, 'get-mail-message', { messageId, $select: 'isDraft' }, ctx);
  return m && m.isDraft === true;
}

async function handleUploadTool(ctx, rpc) {
  const args = (rpc.params && rpc.params.arguments) || {};
  const messageId = String(args.messageId || '');
  const eventId = String(args.eventId || '');
  if ((messageId && eventId) || (!messageId && !eventId)) return rpcResult(ctx, rpc.id, { error: 'give_message_id_or_event_id' }, true);
  if (messageId && !MESSAGE_ID.test(messageId)) return rpcResult(ctx, rpc.id, { error: 'invalid_message_id' }, true);
  if (eventId && !MESSAGE_ID.test(eventId)) return rpcResult(ctx, rpc.id, { error: 'invalid_event_id' }, true);
  const kind = eventId ? 'event' : 'message';
  const contentType = args.contentType ? String(args.contentType) : 'application/octet-stream';
  if (!MIME.test(contentType)) return rpcResult(ctx, rpc.id, { error: 'invalid_content_type' }, true);
  const filename = safeName(args.filename, contentType);
  const user = ctx.user;
  if (LINK_MAX_PENDING && links.size >= LINK_MAX_PENDING) return rpcResult(ctx, rpc.id, { error: 'busy', retryAfterSeconds: 30 }, true);
  if (LINK_MAX_PENDING_PER_USER && pendingForUser(user) >= LINK_MAX_PENDING_PER_USER) return rpcResult(ctx, rpc.id, { error: 'too_many_pending_links', max: LINK_MAX_PENDING_PER_USER }, true);
  if (DRAFT_ONLY && kind === 'message') {
    let draft;
    try { draft = await isDraft(ctx.req.headers.authorization, messageId, ctx); } catch (e) { logReq(ctx, 200, e.cat || 'graph_error'); return rpcResult(ctx, rpc.id, { error: 'message_lookup_failed' }, true); }
    if (!draft) return rpcResult(ctx, rpc.id, { error: 'not_a_draft', hint: 'Create a draft first (create-draft-email / create-*-draft) and pass its id.' }, true);
  }
  const key = crypto.randomBytes(24).toString('base64url');
  links.set(key, { kind, messageId, eventId, filename, contentType, authorization: ctx.req.headers.authorization, user, expires: Date.now() + LINK_TTL_MS });
  const url = `${PUBLIC_URL}${FILES_PREFIX}${key}`;
  logReq(ctx, 200, 'upload_link_issued', { pending: links.size });
  rpcResult(ctx, rpc.id, {
    url, filename, expiresInSeconds: LINK_TTL_MS / 1000, singleUse: true, maxBytes: LINK_MAX_BYTES,
    curl: `curl -fsS -T '<path-to-local-file>' '${url}'`,
    note: 'Replace <path-to-local-file> with the sandbox path of the file. The response JSON confirms the attachment.',
  });
}

function approvedUploadUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && !(INSECURE_TEST && u.protocol === 'http:')) return null;
  const host = u.hostname.toLowerCase();
  return UPLOAD_HOST_SUFFIXES.some((s) => host.endsWith(s.toLowerCase())) ? u : null;
}

function putChunk(u, chunk, start, total) {
  return new Promise((resolve, rej) => {
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request({
      method: 'PUT', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, timeout: GRAPH_PUT_TIMEOUT_MS,
      headers: { 'content-type': 'application/octet-stream', 'content-length': chunk.length, 'content-range': `bytes ${start}-${start + chunk.length - 1}/${total}` },
    }, (resp) => {
      resp.resume();
      resp.on('end', () => resolve(resp.statusCode));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', rej);
    r.end(chunk);
  });
}

// Attach the request body to the draft: inline when small; otherwise stream it
// to a Graph upload session one bounded chunk at a time.
// Softeria has message-attachment tools but none for events; events go through
// its generic graph-batch tool (hidden from clients) with a single sub-request.
async function graphOne(auth, method, url, body, ctx) {
  const r = await callUpstreamTool(auth, 'graph-batch', { body: { requests: [{ id: '1', method, url, headers: { 'Content-Type': 'application/json' }, body }] } }, ctx);
  const resp = r && Array.isArray(r.responses) ? r.responses.find((x) => String(x.id) === '1') : null;
  if (!resp || resp.status < 200 || resp.status >= 300) throw Object.assign(new Error('graph'), { cat: 'graph_error' });
  return resp.body || {};
}
async function attachInline(entry, buf, ctx) {
  const body = { '@odata.type': '#microsoft.graph.fileAttachment', name: entry.filename, contentType: entry.contentType, contentBytes: buf.toString('base64') };
  if (entry.kind === 'event') return graphOne(entry.authorization, 'POST', `/me/events/${entry.eventId}/attachments`, body, ctx);
  return callUpstreamTool(entry.authorization, 'add-mail-attachment', { messageId: entry.messageId, body }, ctx);
}
async function createSession(entry, declared, ctx) {
  const body = { AttachmentItem: { attachmentType: 'file', name: entry.filename, size: declared, contentType: entry.contentType } };
  if (entry.kind === 'event') return graphOne(entry.authorization, 'POST', `/me/events/${entry.eventId}/attachments/createUploadSession`, body, ctx);
  return callUpstreamTool(entry.authorization, 'create-mail-attachment-upload-session', { messageId: entry.messageId, body }, ctx);
}

async function attachStream(ctx, entry, declared) {
  if (declared <= INLINE_MAX) {
    const buf = await readBody(ctx.req, declared);
    if (buf.length !== declared) throw Object.assign(new Error('short'), { cat: 'upload_short_body' });
    const r = await attachInline(entry, buf, ctx);
    return { method: 'inline', attachmentId: r.id };
  }
  const session = await createSession(entry, declared, ctx);
  const u = approvedUploadUrl(session && session.uploadUrl);
  if (!u) throw Object.assign(new Error('bad upload url'), { cat: 'upload_url_rejected' });

  let pending = [];
  let pendingBytes = 0;
  let offset = 0;
  let last = 0;
  let idle = null;
  const armIdle = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => ctx.req.destroy(new Error('idle')), BODY_IDLE_TIMEOUT_MS); };
  armIdle();
  try {
    for await (const piece of ctx.req) {
      armIdle();
      pending.push(piece); pendingBytes += piece.length;
      if (offset + pendingBytes > declared) throw Object.assign(new Error('long'), { cat: 'upload_long_body' });
      while (pendingBytes >= CHUNK) {
        const joined = Buffer.concat(pending);
        const chunk = joined.subarray(0, CHUNK);
        last = await putChunk(u, chunk, offset, declared);
        if (![200, 201, 202].includes(last)) throw Object.assign(new Error('chunk'), { cat: 'graph_upload_chunk_failed' });
        offset += chunk.length;
        const rest = joined.subarray(CHUNK);
        pending = rest.length ? [Buffer.from(rest)] : [];
        pendingBytes = rest.length;
      }
    }
  } finally { if (idle) clearTimeout(idle); }
  if (pendingBytes) {
    last = await putChunk(u, Buffer.concat(pending), offset, declared);
    if (![200, 201, 202].includes(last)) throw Object.assign(new Error('chunk'), { cat: 'graph_upload_chunk_failed' });
    offset += pendingBytes;
  }
  if (offset !== declared) throw Object.assign(new Error('short'), { cat: 'upload_short_body' });
  return { method: 'upload-session', finalStatus: last };
}

async function receiveUpload(ctx, key) {
  const entry = links.get(key);
  if (!entry || entry.expires < Date.now()) { links.delete(key); send(ctx, 404, { ok: false, error: 'link_not_found' }); return logReq(ctx, 404, 'upload_link_not_found'); }
  links.delete(key); // claimed before any byte is read: one attempt per link
  const declared = Number(ctx.req.headers['content-length']);
  if (!Number.isInteger(declared) || declared < 0) { send(ctx, 411, { ok: false, error: 'length_required' }); return logReq(ctx, 411, 'upload_no_length'); }
  if (declared === 0) { send(ctx, 400, { ok: false, error: 'empty_upload' }); return logReq(ctx, 400, 'upload_empty'); }
  if (declared > LINK_MAX_BYTES) { send(ctx, 413, { ok: false, error: 'too_large', maxBytes: LINK_MAX_BYTES }); return logReq(ctx, 413, 'upload_too_large'); }
  if (LINK_MAX_CONCURRENT && activeUploads >= LINK_MAX_CONCURRENT) { send(ctx, 503, { ok: false, error: 'busy', retryAfterSeconds: 15 }); return logReq(ctx, 503, 'upload_busy'); }
  const perUser = activePerUser.get(entry.user) || 0;
  if (LINK_MAX_CONCURRENT_PER_USER && perUser >= LINK_MAX_CONCURRENT_PER_USER) { send(ctx, 503, { ok: false, error: 'busy', retryAfterSeconds: 15 }); return logReq(ctx, 503, 'upload_busy_user'); }
  const reserve = Math.min(declared, CHUNK * 2); // streaming: at most two chunks resident per upload
  if (LINK_TOTAL_BYTES && inflightBytes + reserve > LINK_TOTAL_BYTES) { send(ctx, 503, { ok: false, error: 'busy', retryAfterSeconds: 30 }); return logReq(ctx, 503, 'upload_memory_budget'); }

  activeUploads++; inflightBytes += reserve; activePerUser.set(entry.user, perUser + 1);
  try {
    if (DRAFT_ONLY && entry.kind === 'message') {
      let draft = false;
      try { draft = await isDraft(entry.authorization, entry.messageId, ctx); } catch (e) { send(ctx, 502, { ok: false, error: 'message_lookup_failed' }); return logReq(ctx, 502, e.cat || 'graph_error'); }
      if (!draft) { send(ctx, 409, { ok: false, error: 'not_a_draft' }); return logReq(ctx, 409, 'upload_not_draft'); }
    }
    const r = await attachStream(ctx, entry, declared);
    send(ctx, 200, { ok: true, name: entry.filename, size: declared, ...r });
    logReq(ctx, 200, 'upload_attached', { bytes: declared, method: r.method });
  } catch (e) {
    const cat = e.cat || (e.code === 'TOO_LARGE' ? 'upload_too_large' : e.code === 'IDLE' || e.message === 'idle' ? 'upload_idle_timeout' : 'upload_failed');
    const status = cat.startsWith('graph') || cat.startsWith('upstream') ? 502 : cat === 'upload_too_large' ? 413 : 400;
    if (!ctx.res.headersSent) send(ctx, status, { ok: false, error: cat });
    logReq(ctx, status, cat);
  } finally {
    activeUploads--; inflightBytes -= reserve;
    const n = (activePerUser.get(entry.user) || 1) - 1;
    if (n <= 0) activePerUser.delete(entry.user); else activePerUser.set(entry.user, n);
  }
}

// ---- /mcp: single JSON-RPC object only; glue for the upload tool -----------

async function handleMcp(ctx) {
  let body;
  try { body = await readBody(ctx.req, MCP_MAX_BODY); } catch (e) {
    return reject(ctx, e.code === 'TOO_LARGE' ? 413 : 400, e.code === 'TOO_LARGE' ? 'mcp_body_too_large' : 'mcp_body_error', 'invalid_request', 'request body rejected');
  }
  let rpc;
  try { rpc = JSON.parse(body.toString('utf8')); } catch { return reject(ctx, 400, 'mcp_not_json', 'invalid_request', 'body is not JSON'); }
  // One JSON-RPC message per request. Batches (arrays) are refused so every
  // message is seen and handled individually.
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || typeof rpc.method !== 'string') {
    return reject(ctx, 400, 'mcp_bad_shape', 'invalid_request', 'expected a single JSON-RPC message');
  }
  const isNotification = rpc.id === undefined || rpc.id === null;
  if (REJECT_TOOL_NOTIFICATIONS && isNotification && !rpc.method.startsWith('notifications/')) {
    return reject(ctx, 400, 'mcp_notification_refused', 'invalid_request', 'notifications may only use notifications/* methods');
  }
  if (rpc.method === 'tools/call' && rpc.params) {
    if (rpc.params.name === UPLOAD_TOOL) return handleUploadTool(ctx, rpc);
    if (HIDDEN_TOOLS.has(rpc.params.name)) {
      logReq(ctx, 200, 'tool_hidden_refused');
      return rpcResult(ctx, rpc.id, { error: 'tool_not_available', hint: `Use ${UPLOAD_TOOL} to attach files.` }, true);
    }
  }
  if (rpc.method === 'tools/list' || rpc.method === 'initialize') {
    let up;
    try { up = await upstreamRequest('POST', ctx.req.url, upstreamHeaders(ctx, body), body); } catch (e) {
      send(ctx, 502, { error: 'upstream_unavailable' });
      return logReq(ctx, 502, e.message === 'timeout' ? 'upstream_timeout' : 'upstream_unavailable');
    }
    let out = up.body;
    try {
      const r = parseRpc(up.body);
      if (r && r.result && rpc.method === 'initialize') {
        r.result.instructions = RELAY_INSTRUCTIONS;
        out = Buffer.from(JSON.stringify(r));
      } else if (r && r.result && Array.isArray(r.result.tools)) {
        r.result.tools = r.result.tools.filter((t) => !HIDDEN_TOOLS.has(t.name));
        r.result.tools.push(UPLOAD_TOOL_DEF);
        out = Buffer.from(JSON.stringify(r));
      }
    } catch { /* leave untouched */ }
    ctx.res.writeHead(up.status, { ...relayHeaders(up, ctx), 'content-type': 'application/json', 'content-length': out.length });
    ctx.res.end(out);
    return logReq(ctx, up.status, 'ok');
  }
  forward(ctx, body);
}

// ---- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const ctx = { req, res, id: crypto.randomUUID(), ip: clientIp(req), path: req.url.split('?')[0], start: Date.now(), user: null };
  // Route matching happens on the path exactly as sent: any percent-encoding,
  // dot segment or doubled slash that would change the path after normalisation
  // is refused before any routing decision (no encoded look-alikes of open routes).
  if (!normalisedPath(ctx.path)) return reject(ctx, 400, 'bad_path', 'bad_request', 'path must be normalised');
  const p = ctx.path;

  if (p === '/health') return health(ctx);
  if (p === '/register') return reject(ctx, 404, 'register_disabled', 'not_found', 'dynamic client registration is disabled');

  if (p.startsWith(FILES_PREFIX)) {
    if (rateLimited(ctx.ip)) return reject(ctx, 429, 'rate_limited', 'rate_limited', 'too many requests', { 'retry-after': '60' });
    if (req.method !== 'PUT') return reject(ctx, 405, 'files_method', 'method_not_allowed', 'PUT only', { allow: 'PUT' });
    return receiveUpload(ctx, p.slice(FILES_PREFIX.length));
  }
  if (p === '/authorize') {
    // Consent shim: the authorize scope is fixed by the relay, never taken from the caller.
    const u = new URL(req.url, PUBLIC_URL);
    u.searchParams.set('scope', [`${CLIENT_ID}/${REQUIRED_SCOPE}`, ...CONSENT_SCOPES].join(' '));
    req.url = u.pathname + u.search;
  }
  if (OPEN_EXACT.has(p) || p.startsWith(OPEN_PREFIX)) return forward(ctx);

  if (rateLimited(ctx.ip)) return reject(ctx, 429, 'rate_limited', 'rate_limited', 'too many requests', { 'retry-after': '60' });
  if (GATE_KEY && !timingSafeEqual(req.headers['x-api-key'] || '', GATE_KEY)) return reject(ctx, 401, 'apikey', 'invalid_request', 'invalid request');
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return reject(ctx, 401, 'token_missing', 'invalid_token', 'invalid token');
  let v;
  try { v = await validate(auth.slice(7)); } catch { return reject(ctx, 503, 'jwks_unavailable', 'server_error', 'temporarily unavailable'); }
  if (!v.ok) return reject(ctx, 401, v.cat, 'invalid_token', 'invalid token');
  ctx.user = v.claims.oid || v.claims.sub || 'unknown';

  if (req.method === 'POST' && p === '/mcp') return handleMcp(ctx);
  forward(ctx);
});

server.headersTimeout = HEADERS_TIMEOUT_MS;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = 5000;
server.maxConnections = MAX_CONNECTIONS;

server.listen(PORT, HOST, () => {
  if (INSECURE_TEST) logEvent({ level: 'warn', cat: 'config', msg: 'GATE_ALLOW_INSECURE_TEST is on: http origins accepted (tests only)' });
  logEvent({
    level: 'info', cat: 'listening', host: HOST, port: PORT, upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`, public: PUBLIC_URL, policy: POLICY.version, trustedIngress: TRUSTED_INGRESS,
    aud: CLIENT_ID.slice(0, 8), tids: ALLOWED_TIDS.length, scope: REQUIRED_SCOPE, users: ALLOWED_USERS.length || 'any', apikey: !!GATE_KEY,
    allowedScopes: ALLOWED_SCOPES, tools: TOOL_COUNT, rateLimitPerMin: RATE_LIMIT_PER_MIN, draftOnly: DRAFT_ONLY, rejectToolNotifications: REJECT_TOOL_NOTIFICATIONS,
    upload: { ttlSeconds: LINK_TTL_MS / 1000, maxMB: LINK_MAX_BYTES / 1048576, totalMB: LINK_TOTAL_BYTES / 1048576, maxPending: LINK_MAX_PENDING, maxConcurrent: LINK_MAX_CONCURRENT, perUserPending: LINK_MAX_PENDING_PER_USER, perUserConcurrent: LINK_MAX_CONCURRENT_PER_USER },
  });
});
