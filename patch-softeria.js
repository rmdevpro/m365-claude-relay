#!/usr/bin/env node
// Build-time patch for @softeria/ms-365-mcp-server 0.156.2 (m365-claude-relay).
//
// Softeria's OAuth proxy redeems authorization codes and refresh tokens at the
// Microsoft v2 token endpoint WITHOUT a `scope` parameter. For personal
// Microsoft accounts Entra rejects that: AADSTS70011 "The provided request must
// include a 'scope' input parameter." This adds `scope` from
// MS365_MCP_TOKEN_SCOPE (set by start.sh) to both requests when it is set.
//
// Fails the build if the expected code is not found, so a Softeria bump cannot
// silently drop the fix — re-check upstream and update or retire this patch.

const fs = require('fs');
const path = require('path');

const file = path.join(
  process.argv[2] || '/usr/local/lib/node_modules/@softeria/ms-365-mcp-server',
  'dist/lib/microsoft-auth.js'
);
let src = fs.readFileSync(file, 'utf8');
if (src.includes('MS365_MCP_TOKEN_SCOPE')) {
  console.log('patch-softeria: already applied');
  process.exit(0);
}

const anchor = /(\n(\s*)const params = new URLSearchParams\(\{\n\s*grant_type: "(authorization_code|refresh_token)",[\s\S]*?client_id: clientId\n\s*\}\);)/g;
const matches = src.match(anchor) || [];
if (matches.length !== 2) {
  console.error(`patch-softeria: expected 2 token-request blocks, found ${matches.length} in ${file}`);
  process.exit(1);
}
src = src.replace(
  anchor,
  (m, block, indent) => `${block}\n${indent}if (process.env.MS365_MCP_TOKEN_SCOPE) params.append("scope", process.env.MS365_MCP_TOKEN_SCOPE);`
);
fs.writeFileSync(file, src);
console.log('patch-softeria: added MS365_MCP_TOKEN_SCOPE to code + refresh token requests');
