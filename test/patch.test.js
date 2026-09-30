// Fixture test for patch-softeria.js: both token-redemption paths carry `scope`
// after patching the pinned Softeria, and re-running is a no-op.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('patch adds scope to code and refresh redemption, idempotently', () => {
  const src = path.join(__dirname, '..', 'node_modules', '@softeria', 'ms-365-mcp-server');
  if (!fs.existsSync(src)) { test.skip('run `npm ci` first'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'softeria-'));
  fs.cpSync(src, tmp, { recursive: true });
  const patch = path.join(__dirname, '..', 'patch-softeria.js');
  const out1 = execFileSync(process.execPath, [patch, tmp]).toString();
  assert.match(out1, /added MS365_MCP_TOKEN_SCOPE/);
  const js = fs.readFileSync(path.join(tmp, 'dist/lib/microsoft-auth.js'), 'utf8');
  const blocks = js.split('grant_type: "').slice(1);
  const code = blocks.find((b) => b.startsWith('authorization_code'));
  const refresh = blocks.find((b) => b.startsWith('refresh_token'));
  assert.match(code, /params\.append\("scope", process\.env\.MS365_MCP_TOKEN_SCOPE\)/);
  assert.match(refresh, /params\.append\("scope", process\.env\.MS365_MCP_TOKEN_SCOPE\)/);
  const out2 = execFileSync(process.execPath, [patch, tmp]).toString();
  assert.match(out2, /already applied/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
