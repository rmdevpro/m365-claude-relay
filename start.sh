#!/bin/bash
# M365 relay, OBO deployment (m365-claude-relay): Softeria (loopback, --http --obo)
# behind the gate (gate.js) on the public port. Both processes are supervised:
# if either exits, the container exits and the platform restarts it.
#
# Operator config (environment):
#   MS365_MCP_CLIENT_ID / MS365_MCP_CLIENT_SECRET   relay app registration (secret is SECRET)
#   MS365_MCP_TENANT_ID                              'consumers' or the tenant GUID
#   MS365_MCP_PUBLIC_URL                             https origin of this relay
#   MS365_MCP_ALLOWED_SCOPES                         Graph delegated scopes users consent to; Softeria
#                                                    derives the tool surface from them at every start
#                                                    (default: policy.json "scopes"). Change → restart.
#   MS365_MCP_ORG_MODE=true                          work tenant (Teams/SharePoint/… tools; needs work scopes)
#   MS365_MCP_OBO_ALLOWED_TENANTS / _USERS           who may use the relay (tenant ids / user object ids);
#                                                    default: the configured tenant, any user
#   MS365_MCP_ATTACHMENT_URL_BASE/_KEY/_TTL_S        OTS attachment download/upload links (KEY is SECRET)
#   GATE_*                                           gate limits/switches (see gate.js)
# Fixed in the image (policy.json): tools excluded because the relay replaces
# them (download-bytes* → get-download-url), tools hidden because get-upload-url
# replaces them, safety switches.
set -euo pipefail

: "${MS365_MCP_LOG_DIR:=/dev/shm/ms365-logs}"
: "${UPSTREAM_PORT:=3000}"
mkdir -p "$MS365_MCP_LOG_DIR"
export MS365_MCP_LOG_DIR

if [ -n "${GATE_POLICY_FILE:-}" ]; then echo "[start] GATE_POLICY_FILE is not supported; policy.json in the image holds the fixed constraints" >&2; exit 1; fi
# Softeria reads ENABLED_TOOLS from the environment and it would override the
# exclusions below, so it is refused.
if [ -n "${ENABLED_TOOLS:-}" ]; then echo "[start] ENABLED_TOOLS is not supported; the tool surface follows MS365_MCP_ALLOWED_SCOPES" >&2; exit 1; fi
HERE="$(dirname "$0")"
POLICY_FILE="$HERE/policy.json"
policy() { node -e 'const p=require(process.argv[1]);const v=p[process.argv[2]];process.stdout.write(Array.isArray(v)?v.join(" "):String(v))' "$POLICY_FILE" "$1"; }

# Scopes: operator-set, defaulting to the policy's list. Users consent to
# exactly these (MS365_MCP_EXTRA_SCOPES); Softeria's --allowed-scopes derives
# the tool surface from them (MS365_MCP_ALLOWED_SCOPES).
export MS365_MCP_ALLOWED_SCOPES="${MS365_MCP_ALLOWED_SCOPES:-$(policy scopes)}"
export MS365_MCP_EXTRA_SCOPES="$MS365_MCP_ALLOWED_SCOPES"
# Who may use the relay (enforced by Softeria before the On-Behalf-Of exchange):
# by default only the configured tenant (personal accounts: Microsoft's consumer
# tenant). Narrow to named users with MS365_MCP_OBO_ALLOWED_USERS (object ids).
CONSUMERS_TID=9188040d-6c67-4c5b-b112-36a304b66dad
TENANT_ID="${MS365_MCP_TENANT_ID:-consumers}"
if [ "$TENANT_ID" = consumers ]; then DEFAULT_TID="$CONSUMERS_TID"; else DEFAULT_TID="$TENANT_ID"; fi
export MS365_MCP_OBO_ALLOWED_TENANTS="${MS365_MCP_OBO_ALLOWED_TENANTS:-$DEFAULT_TID}"
# Excluded tools (replaced by better ones) are not registered at all: an
# anchored negative lookahead over the policy's names (validated as
# [a-z][a-z0-9-]* by the gate at start, so no regex metacharacters).
EXCLUDED="$(policy excludedTools)"
for t in $EXCLUDED; do case "$t" in *[!a-z0-9-]*|'') echo "[start] bad excluded tool name: $t" >&2; exit 1;; esac; done
ENABLED_ARGS=()
if [ -n "$EXCLUDED" ]; then ENABLED_ARGS=(--enabled-tools "^(?!(?:${EXCLUDED// /|})\$)"); fi

echo "[start] tenant=${MS365_MCP_TENANT_ID:-unset} org_mode=${MS365_MCP_ORG_MODE:-false} client_id=${MS365_MCP_CLIENT_ID:+set} secret=${MS365_MCP_CLIENT_SECRET:+set} public_url=${MS365_MCP_PUBLIC_URL:-unset} attachment_urls=${MS365_MCP_ATTACHMENT_URL_KEY:+on} policy=$(policy version) scopes=\"$MS365_MCP_ALLOWED_SCOPES\" allowed_tenants=$MS365_MCP_OBO_ALLOWED_TENANTS allowed_users=${MS365_MCP_OBO_ALLOWED_USERS:-any}"

node_modules/.bin/ms-365-mcp-server \
  --http "127.0.0.1:${UPSTREAM_PORT}" \
  --obo \
  "${ENABLED_ARGS[@]}" \
  --enable-attachment-urls &
UP=$!

node "$HERE/gate.js" &
GATE=$!

trap 'kill $UP $GATE 2>/dev/null' EXIT
wait -n "$UP" "$GATE"
echo "[start] a process exited; stopping"
exit 1
