#!/usr/bin/env bash
# Outside checks for a running relay (no account needed): ./test/smoke.sh https://<relay host>
set -u
H="${1:?usage: smoke.sh <relay origin>}"; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1 ($3)"; else echo "FAIL $1: expected $2, got $3"; fail=1; fi; }
check "GET / is up" "Microsoft 365 MCP Server is running" "$(curl -s -m 20 "$H/")"
check "POST /mcp without a token" 401 "$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$H/mcp" -H 'content-type: application/json' -d '{}')"
check "dynamic client registration off" 404 "$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST "$H/register" -H 'content-type: application/json' -d '{}')"
check "unlisted redirect refused" 400 "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$H/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&state=abcdefghij&code_challenge=x&code_challenge_method=S256")"
check "Claude's redirect accepted" 302 "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$H/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=abcdefghij&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&scope=openid")"
check "unknown attachment link" 404 "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$H/attachment?t=bogus")"
exit $fail
