#!/bin/bash
# M365 relay, OBO deployment (m365-claude-relay): Softeria (loopback, --http --obo)
# behind the gate (gate.js) on the public port. Both processes are supervised:
# if either exits, the container exits and the platform restarts it.
#
# Operator config (environment):
#   MS365_MCP_CLIENT_ID / MS365_MCP_CLIENT_SECRET   relay app registration (secret is SECRET)
#   MS365_MCP_TENANT_ID                              'consumers' or the tenant GUID
#   MS365_MCP_PUBLIC_URL                             https origin of this relay
#   MS365_MCP_ALLOWED_SCOPES                         Graph delegated scopes users consent to; the tool
#                                                    surface is derived from them at every start
#                                                    (default: policy.json "scopes"). Change → restart.
#   MS365_MCP_ORG_MODE=true                          work tenant (Teams/SharePoint/… tools; needs work scopes)
#   MS365_MCP_ATTACHMENT_URL_BASE/_KEY/_TTL_S        OTS attachment download links (KEY is SECRET)
#   GATE_*                                           gate limits/switches (see gate.js)
# Fixed in the image (policy.json): excluded tools (webhook subscriptions),
# hidden bridge tools, safety switches.
set -euo pipefail

: "${MS365_MCP_LOG_DIR:=/dev/shm/ms365-logs}"
: "${UPSTREAM_PORT:=3000}"
mkdir -p "$MS365_MCP_LOG_DIR"
export MS365_MCP_LOG_DIR

# Scope sent when redeeming codes / refresh tokens (personal accounts require it;
# see patch-softeria.js; retire when the upstream fix ships).
export MS365_MCP_TOKEN_SCOPE="${MS365_MCP_TOKEN_SCOPE:-${MS365_MCP_CLIENT_ID}/access_as_user offline_access}"

if [ -n "${GATE_POLICY_FILE:-}" ]; then echo "[start] GATE_POLICY_FILE is not supported; policy.json in the image holds the fixed constraints" >&2; exit 1; fi
HERE="$(dirname "$0")"
POLICY_FILE="$HERE/policy.json"
policy() { node -e 'const p=require(process.argv[1]);const v=p[process.argv[2]];process.stdout.write(Array.isArray(v)?v.join(" "):String(v))' "$POLICY_FILE" "$1"; }

# Scopes: operator-set, defaulting to the policy's list. Users consent to
# exactly these; Softeria's --allowed-scopes derives the tool surface.
export MS365_MCP_ALLOWED_SCOPES="${MS365_MCP_ALLOWED_SCOPES:-$(policy scopes)}"
export MS365_MCP_EXTRA_SCOPES="$MS365_MCP_ALLOWED_SCOPES"
TOOLS_FILE="$MS365_MCP_LOG_DIR/tools.json"
node "$HERE/derive-tools.js" --scopes "$MS365_MCP_ALLOWED_SCOPES" --excluded "$(policy excludedTools)" --out "$TOOLS_FILE"
# The exact --enabled-tools value (anchored, names escaped) comes from the derivation; the
# derivation fails closed on any invalid/duplicate/excluded name, so nothing below runs then.
POLICY_TOOLS="$(node -e 'const g=require(process.argv[1]);if(typeof g.enabledToolsRegex!=="string"||!g.enabledToolsRegex.startsWith("^(")){console.error("[start] bad derivation output");process.exit(1)}process.stdout.write(g.enabledToolsRegex)' "$TOOLS_FILE")"
export RELAY_TOOL_COUNT="$(node -e 'process.stdout.write(String(require(process.argv[1]).tools.length))' "$TOOLS_FILE")"

echo "[start] tenant=${MS365_MCP_TENANT_ID:-unset} org_mode=${MS365_MCP_ORG_MODE:-false} client_id=${MS365_MCP_CLIENT_ID:+set} secret=${MS365_MCP_CLIENT_SECRET:+set} public_url=${MS365_MCP_PUBLIC_URL:-unset} attachment_urls=${MS365_MCP_ATTACHMENT_URL_KEY:+on} policy=$(policy version) scopes=\"$MS365_MCP_ALLOWED_SCOPES\" tools=$RELAY_TOOL_COUNT"

node_modules/.bin/ms-365-mcp-server \
  --http "127.0.0.1:${UPSTREAM_PORT}" \
  --obo \
  --enabled-tools "$POLICY_TOOLS" \
  --enable-attachment-urls &
UP=$!

node "$HERE/gate.js" &
GATE=$!

trap 'kill $UP $GATE 2>/dev/null' EXIT
wait -n "$UP" "$GATE"
echo "[start] a process exited; stopping"
exit 1
