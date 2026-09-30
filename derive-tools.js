#!/usr/bin/env node
// Derives the relay's tool surface from a scope list using Softeria's own
// --allowed-scopes logic (m365-claude-relay). Runs at container start (start.sh):
// starts the pinned ms-365-mcp-server on loopback with the scopes and the
// policy's excluded tools, reads tools/list, writes the list (and an escaped
// --enabled-tools regex) as JSON and exits. The real --obo server is then
// started on exactly that list, because passing --allowed-scopes to a running
// --obo server makes its /authorize drop the relay scope
// (api://<client>/access_as_user) — Softeria#697; when that is fixed this step
// retires and the flag goes straight through.
//
// The loopback response is NOT trusted: every name must match the tool-name
// grammar, be unique, not be a fixed excluded tool; the hidden bridge tools
// must be present. Any violation fails the derivation and the container never
// starts the OBO server. The whole bootstrap runs under one absolute deadline.
//
//   node derive-tools.js --scopes "User.Read Mail.ReadWrite ..." --out /path/tools.json
//   --scopes    defaults to policy.json "scopes"
//   --excluded  defaults to policy.json "excludedTools"
//   --deadline-ms  absolute bootstrap deadline (default 30000)
//   --bin       server executable (default node_modules/.bin/ms-365-mcp-server; tests only)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const POLICY = JSON.parse(fs.readFileSync(path.join(DIR, 'policy.json'), 'utf8'));

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const list = (v) => String(v || '').split(/\s+/).filter(Boolean);
const scopes = list(opt('--scopes') ?? POLICY.scopes.join(' '));
const excluded = list(opt('--excluded') ?? (POLICY.excludedTools || []).join(' '));
const hidden = POLICY.hiddenTools || [];
const out = opt('--out');
const DEADLINE_MS = Math.min(Math.max(Number(opt('--deadline-ms')) || 30000, 1000), 120000);
const BIN = opt('--bin') || path.join(DIR, 'node_modules', '.bin', 'ms-365-mcp-server');
const MAX_BODY = 4 * 1024 * 1024; // tools/list with schemas is ~1 MB for the full catalog
const TOOL_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const SCOPE_NAME = /^[A-Za-z][\w.]*$/;

function fail(msg) { console.error(`derive: ${msg}`); process.exit(1); }
if (!scopes.length) fail('no scopes');
for (const s of scopes) if (!SCOPE_NAME.test(s)) fail(`not a Graph scope name: ${s}`);
for (const t of [...excluded, ...hidden]) if (!TOOL_NAME.test(t)) fail(`not a tool name: ${t}`);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exclusionRegex = excluded.length ? `^(?!(${excluded.map(escapeRe).join('|')})$).*$` : '^.*$';

// Fetch with a shared absolute deadline and a body cap.
async function boundedFetch(url, init, deadlineAt, maxBytes) {
  const ac = new AbortController();
  const left = deadlineAt - Date.now();
  if (left <= 0) throw new Error('deadline exceeded');
  const timer = setTimeout(() => ac.abort(), left);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { reader.cancel(); throw new Error('response too large'); }
      chunks.push(value);
    }
    return { status: r.status, text: Buffer.concat(chunks).toString('utf8') };
  } finally { clearTimeout(timer); }
}

async function derive() {
  const port = 30000 + Math.floor(Math.random() * 10000);
  const tmp = fs.mkdtempSync(path.join(process.env.MS365_MCP_LOG_DIR || '/tmp', 'derive-'));
  const deadlineAt = Date.now() + DEADLINE_MS;
  const child = spawn(BIN, ['--http', `127.0.0.1:${port}`, '--allowed-scopes', scopes.join(' '), '--enabled-tools', exclusionRegex, '--enable-attachment-urls'], {
    env: {
      PATH: process.env.PATH, HOME: tmp, MS365_MCP_LOG_DIR: tmp,
      MS365_MCP_CLIENT_ID: '11111111-2222-3333-4444-555555555555', MS365_MCP_TENANT_ID: process.env.MS365_MCP_TENANT_ID || 'consumers',
      MS365_MCP_PUBLIC_URL: 'https://relay.example', MS365_MCP_DISABLE_DCR: 'true',
      MS365_MCP_ALLOWED_REDIRECT_URIS: 'https://claude.ai/api/mcp/auth_callback',
      MS365_MCP_ATTACHMENT_URL_BASE: 'https://relay.example', MS365_MCP_ATTACHMENT_URL_KEY: '0123456789abcdef0123456789abcdef',
      ...(process.env.MS365_MCP_ORG_MODE ? { MS365_MCP_ORG_MODE: process.env.MS365_MCP_ORG_MODE } : {}),
      // test hook: the fake server (--bin) takes its behaviour from these; never set for the real binary
      ...(opt('--bin') ? { FAKE_MODE: process.env.FAKE_MODE || '', FAKE_TOOLS: process.env.FAKE_TOOLS || '[]' } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Keep only the tail of the child's stderr (diagnostics); a flooding child must not grow our heap.
  const MAX_ERR = 4096;
  let err = '';
  child.stderr.on('data', (d) => { const t = d.toString('utf8'); err = (err.length + t.length > MAX_ERR ? (err + t).slice(-MAX_ERR) : err + t); });
  const killer = setTimeout(() => child.kill('SIGKILL'), DEADLINE_MS + 2000);
  try {
    let ready = false;
    while (Date.now() < deadlineAt) {
      try { const r = await boundedFetch(`http://127.0.0.1:${port}/`, {}, Math.min(deadlineAt, Date.now() + 2000), 64 * 1024); if (r.status === 200) { ready = true; break; } } catch { /* not yet, or this probe timed out */ }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw new Error(`ms-365-mcp-server did not start within ${DEADLINE_MS} ms: ${err.slice(-500)}`);
    const r = await boundedFetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer derive', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }, deadlineAt, MAX_BODY);
    if (r.status !== 200) throw new Error(`tools/list returned ${r.status}`);
    const line = r.text.split('\n').map((l) => l.replace(/^data: /, '').trim()).find((l) => l.startsWith('{'));
    if (!line) throw new Error('tools/list: no JSON payload');
    const parsed = JSON.parse(line);
    const tools = parsed && parsed.result && parsed.result.tools;
    if (!Array.isArray(tools)) throw new Error('tools/list: malformed result');
    return tools.map((t) => t && t.name);
  } finally {
    clearTimeout(killer);
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Fail-closed validation of what the loopback server returned.
function validate(names) {
  if (names.length < 5) throw new Error('implausibly small tool list');
  const seen = new Set();
  for (const n of names) {
    if (typeof n !== 'string' || !TOOL_NAME.test(n)) throw new Error(`loopback returned an invalid tool name: ${JSON.stringify(n)}`);
    if (seen.has(n)) throw new Error(`loopback returned a duplicate tool name: ${n}`);
    seen.add(n);
    if (excluded.includes(n)) throw new Error(`loopback returned a fixed excluded tool: ${n}`);
  }
  for (const t of hidden) if (!seen.has(t)) throw new Error(`scopes do not cover hidden bridge tool "${t}" (Mail.ReadWrite is required)`);
  return [...seen].sort();
}

(async () => {
  const tools = validate(await derive());
  const doc = {
    scopes: [...scopes].sort(), excludedTools: [...excluded].sort(),
    softeria: require('./package.json').dependencies['@softeria/ms-365-mcp-server'],
    tools,
    // The exact --enabled-tools value for the real server: anchored, every name escaped.
    enabledToolsRegex: `^(${tools.map(escapeRe).join('|')})$`,
  };
  const json = JSON.stringify(doc, null, 1) + '\n';
  if (out) fs.writeFileSync(out, json); else process.stdout.write(json);
  console.error(`derived ${tools.length} tools from ${scopes.length} scopes`);
})().catch((e) => { console.error(`derive: ${e.message}`); process.exit(1); });
