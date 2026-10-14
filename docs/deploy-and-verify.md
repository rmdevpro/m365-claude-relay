# Deploy and verify

A checklist for putting the relay into an organisation's own tenant and proving it works before
anyone relies on it. Every check here was run against the public demo instance for release 1.4.0.

## 1. Before you start

| Who | What |
|---|---|
| Tenant admin (Entra) | Creates the app registration per [entra.md](entra.md): Web redirect `https://claude.ai/api/mcp/auth_callback`, a client secret (or certificate), `api://<client id>` with scope `access_as_user`, `requestedAccessTokenVersion: 2`, the delegated Graph permissions you will list in `MS365_MCP_ALLOWED_SCOPES`, `offline_access`. **Grants admin consent.** Sets *Assignment required* and assigns the named users. |
| Host owner | Runs one container with an https origin. |
| Claude org owner (Team/Enterprise) | Adds the custom connector, sets tool permissions, and allows the relay host for code execution. |
| A tester | Has a Claude seat and a mailbox in the tenant. Use test data, not client data, for the first run. |

Decide the scope list first. **Mail only** is `User.Read Mail.ReadWrite Mail.Send` (45 tools in release 1.4.0:
read, triage, draft, send, attachments). Add `Calendars.ReadWrite`, `Contacts.ReadWrite`,
`Files.ReadWrite` and so on later: change the variable, restart, and admin-consent the new permission.

## 2. Run the container

One replica only. Attachment links are single-use tickets held in the container's memory, so a
second replica would not recognise a link the first one issued.

Pin the image by digest, which the release page and `docker buildx imagetools inspect` show. Verify
the signature if your policy requires it:

```bash
cosign verify ghcr.io/rmdevpro/m365-claude-relay@sha256:<digest> \
  --certificate-identity-regexp 'https://github.com/rmdevpro/m365-claude-relay/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Environment (secrets marked):

| Name | Value |
|---|---|
| `MS365_MCP_CLIENT_ID` | app registration id |
| `MS365_MCP_CLIENT_SECRET` | **secret** |
| `MS365_MCP_TENANT_ID` | tenant GUID |
| `MS365_MCP_ORG_MODE` | `true` |
| `MS365_MCP_PUBLIC_URL` | `https://<relay host>` |
| `MS365_MCP_ATTACHMENT_URL_BASE` | `https://<relay host>` |
| `MS365_MCP_ATTACHMENT_URL_KEY` | **secret**, 32+ random hex characters |
| `MS365_MCP_ALLOWED_SCOPES` | e.g. `User.Read Mail.ReadWrite Mail.Send` |
| `MS365_MCP_OBO_ALLOWED_USERS` | optional: user object ids, to narrow further than the tenant |
| `MS365_MCP_TRUST_PROXY_HOPS` | number of proxies in front of Softeria, counting the relay's own pass-through (one ingress = `2`, the image default) |

Azure Container Apps example (adapt names; secrets via `secretref`):

```bash
az containerapp create -g <rg> -n m365-relay --environment <env> \
  --image ghcr.io/rmdevpro/m365-claude-relay@sha256:<digest> \
  --ingress external --target-port 7860 --min-replicas 1 --max-replicas 1 \
  --secrets client-secret=<secret> attach-key=<hex> \
  --env-vars MS365_MCP_CLIENT_ID=<id> MS365_MCP_CLIENT_SECRET=secretref:client-secret \
    MS365_MCP_TENANT_ID=<tenant> MS365_MCP_ORG_MODE=true \
    MS365_MCP_PUBLIC_URL=https://<fqdn> MS365_MCP_ATTACHMENT_URL_BASE=https://<fqdn> \
    MS365_MCP_ATTACHMENT_URL_KEY=secretref:attach-key \
    "MS365_MCP_ALLOWED_SCOPES=User.Read Mail.ReadWrite Mail.Send"
```

Softeria writes one JSON audit line per tool call (user, tool, status, sizes; no mail content) to
stderr. Point the platform's log collection at it and set retention.

## 3. Claude settings

1. **Connector:** Settings > Connectors > Add custom connector. URL `https://<relay host>/mcp`; Advanced > OAuth Client ID = the app registration id.
2. **Code execution:** the relay host must be on the allowed domains for code execution (Team/Enterprise: an org setting). Claude moves files with `curl` in its sandbox; without this, mail works but attachments do not. Claude's Free plan has no allowed-domains list, so it cannot move files through the relay.
3. **Tool permissions:** read-only tools can be *Always allow*; leave send, delete and share tools on *Needs approval*. Block anything the organisation does not want (see [tools.md](tools.md)).
4. **Skill:** upload `claude-skill/m365-relay/SKILL.md`.

## 4. Verify from outside (no account needed)

```bash
H=https://<relay host>
curl -s $H/                                   # Microsoft 365 MCP Server is running
curl -s -o /dev/null -w '%{http_code}\n' -X POST $H/mcp -H 'content-type: application/json' -d '{}'   # 401
curl -s -D - -o /dev/null -X POST $H/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate   # resource_metadata="https://<relay host>/.well-known/oauth-protected-resource"
curl -s -o /dev/null -w '%{http_code}\n' -X POST $H/register -H 'content-type: application/json' -d '{}'   # 404 (no dynamic registration)
curl -s -o /dev/null -w '%{http_code}\n' "$H/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&state=abcdefghij&code_challenge=x&code_challenge_method=S256"   # 400 (redirect not allowed)
curl -s -o /dev/null -w '%{http_code}\n' "$H/attachment?t=bogus"   # 404
```

The startup log line shows the tenant, scopes, allowed tenants/users and policy version.

## 5. Verify through Claude (the tester's own mailbox)

Run each in a new chat and keep the answers as the test record. Approve each tool when asked.

| # | Ask Claude to… | Pass when |
|---|---|---|
| 1 | Refresh the connector (connector ⋮ > Refresh tools list) | "Tools list refreshed"; the tool count matches the scopes (138 for the default seven scopes, 45 for mail only, in release 1.4.0) |
| 2 | "Use get-current-user" | It returns the tester's own name and address |
| 3 | "Use read-mail-text on my inbox, top 5" | Five messages with clean text, no quoted history or long tracking links |
| 4 | "Use read-mail-text with these two message ids" (from a listing) | The same text as in step 3 |
| 5 | "Create a 2 MB file test.bin in the sandbox and print its sha256; create a draft to me; attach the file with get-upload-url and curl -T; confirm with list-mail-attachments; download it back with get-download-url and curl; print its sha256; delete the draft" | Upload answers `{"ok":true,…}`; the attachment is listed; **the two sha256 values match** |
| 6 | "Forward <a message with an attachment> to me" | The forward arrives with the original attachment |
| 7 | "Send me a short test email" | Claude asks for approval first, then the mail arrives |
| 8 | A second tester repeats 2 and 3 | Each sees only their own mailbox |

If step 5 fails with `CONNECT tunnel failed, response 403`, the relay host is not on the code
execution allowed domains (section 3, step 2). A 401 on any call means the sign-in expired: reconnect
the connector.

## 6. Updates

Releases are tagged on GitHub with notes, and each one is a new signed image. To update, re-run
sections 4 and 5, steps 1–5, against the new digest in a test container, then move the production
container to it. Scope changes need no new image: change `MS365_MCP_ALLOWED_SCOPES`, admin-consent
any new permission, restart, and refresh the connector's tools in Claude.
