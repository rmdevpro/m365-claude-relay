# Deploy and verify

A checklist for putting the relay into an organisation's own tenant and proving it works before
anyone relies on it. Every check here was run against the public demo instance on Softeria 0.170.2; the image below is our build of 0.176.0 (see the README), verified on our own Azure test deployment.

## 1. Before you start

| Who | What |
|---|---|
| Tenant admin (Entra) | Creates the app registration per [entra.md](entra.md): Web redirect `https://claude.ai/api/mcp/auth_callback`, a client secret (or certificate), `api://<client id>` with scope `access_as_user`, `requestedAccessTokenVersion: 2`, the delegated Graph permissions you will list in `MS365_MCP_ALLOWED_SCOPES`, `offline_access`. **Grants admin consent.** Sets *Assignment required* and assigns the named users. |
| Host owner | Runs one container with an https origin. |
| Claude org owner (Team/Enterprise) | Adds the custom connector, sets tool permissions, and allows the relay host for code execution. |
| A tester | Has a Claude seat and a mailbox in the tenant. Use test data, not client data, for the first run. |

Decide the scope list first. **Mail only** is `User.Read Mail.ReadWrite Mail.Send` (45 tools on Softeria 0.170.2:
read, triage, draft, send, attachments). Add `Calendars.ReadWrite`, `Contacts.ReadWrite`,
`Files.ReadWrite` and so on later: change the variable, restart, and admin-consent the new permission.

## 2. Run the container

Our build of Softeria's server, one replica, behind HTTPS on port 3000:

- **Image:** `ghcr.io/rmdevpro/ms-365-mcp-server@sha256:456eb842902d32a5b95cdaff2f0db523dffa89af0abb11e4698c6af9c03bcf88` (Softeria 0.176.0 + Softeria#775 and #777; public, no pull credentials).
- **Arguments:** `--http 0.0.0.0:3000 --enable-attachment-urls`.
- **Environment:** [`relay.env.example`](../relay.env.example), with the client id, tenant id, host and the two secrets filled in. Every line is explained in the README.

One replica only: attachment links are single-use tickets held in the container's memory, so a
second replica would not recognise a link the first one issued.

Azure Container Apps example (adapt names; secrets via `secretref`; the remaining variables as in `relay.env.example`):

```bash
az containerapp create -g <rg> -n m365-relay --environment <env> \
  --image ghcr.io/rmdevpro/ms-365-mcp-server@sha256:456eb842902d32a5b95cdaff2f0db523dffa89af0abb11e4698c6af9c03bcf88 \
  --args "--http" "0.0.0.0:3000" "--enable-attachment-urls" \
  --ingress external --target-port 3000 --min-replicas 1 --max-replicas 1 \
  --secrets client-secret=<secret> attach-key=<hex> \
  --env-vars MS365_MCP_OBO=true MS365_MCP_CLIENT_ID=<id> MS365_MCP_CLIENT_SECRET=secretref:client-secret \
    MS365_MCP_TENANT_ID=<tenant> MS365_MCP_ORG_MODE=true MS365_MCP_OBO_ALLOWED_TENANTS=<tenant> \
    MS365_MCP_PUBLIC_URL=https://<fqdn> MS365_MCP_ATTACHMENT_URL_BASE=https://<fqdn> \
    MS365_MCP_ATTACHMENT_URL_KEY=secretref:attach-key MS365_MCP_ATTACHMENT_URL_TTL_S=300 \
    "MS365_MCP_ALLOWED_SCOPES=User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite" \
    "MS365_MCP_EXTRA_SCOPES=User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite" \
    "ENABLED_TOOLS=^(?!(?:download-bytes|download-bytes-to-file|get-mail-attachment-content|add-mail-attachment|create-mail-attachment-upload-session|add-calendar-event-attachment|create-calendar-event-attachment-upload-session|graph-batch)$)" \
    MS365_MCP_ALLOWED_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback MS365_MCP_DISABLE_DCR=true \
    MS365_MCP_TRUST_PROXY_HOPS=1
```

The container writes one JSON audit line per tool call (user, tool, status, sizes; no mail
content) to stderr. Point the platform's log collection at it and set retention.

## 3. Claude settings

1. **Connector:** Settings > Connectors > Add custom connector. URL `https://<relay host>/mcp`; Advanced > OAuth Client ID = the app registration id.
2. **Code execution:** the relay host must be on the allowed domains for code execution (Team/Enterprise: an org setting). Claude moves files with `curl` in its sandbox; without this, mail works but attachments do not. Claude's Free plan has no allowed-domains list, so it cannot move files through the relay.
3. **Tool permissions:** read-only tools can be *Always allow*; leave send, delete and share tools on *Needs approval*. Block anything the organisation does not want (see [tools.md](tools.md)).
4. **Skill:** upload `claude-skill/microsoft-365/SKILL.md` (and optionally `claude-skill/email-management`).

## 4. Verify from outside (no account needed)

```bash
./test/smoke.sh https://<relay host>
```

Six checks: the server answers on `/`; `/mcp` without a token gets 401; `/register` gets 404
(no dynamic registration); `/authorize` refuses a redirect other than Claude's (400) and accepts
Claude's (302 to Microsoft); an unknown attachment link gets 404.

## 5. Verify through Claude (the tester's own mailbox)

Run each in a new chat and keep the answers as the test record. Approve each tool when asked.

| # | Ask Claude to… | Pass when |
|---|---|---|
| 1 | Refresh the connector (connector ⋮ > Refresh tools list) | "Tools list refreshed"; the tool count matches the scopes (138 for the default seven scopes on a personal account, 139 on a work tenant) |
| 2 | "Use get-current-user" | It returns the tester's own name and address |
| 3 | "Use read-mail-text on my inbox, top 5" | Five messages as clean text, without quoted reply history; long messages marked `truncated` |
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
