# m365-claude-relay

**Microsoft 365 for Claude custom connectors — each user acts as themselves.**
Give Claude (web, desktop; Free, Pro, Team, Enterprise) your users' own Outlook mail, calendar,
contacts and OneDrive through one small service you run. Sign-in is Microsoft's own (Entra
On-Behalf-Of); the relay never holds a password, never stores a token on disk, and exposes exactly
the tools your chosen Graph scopes cover. Nearly all of it is off-the-shelf:
[Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) (MIT), pinned
`0.166.0`, in `--http --obo` mode, configured by a start script; a thin pass-through adds one tool
(`read-mail-text`) until Softeria ships it.

Open source, MIT, best-effort support via GitHub issues. Image: `ghcr.io/rmdevpro/m365-claude-relay`.

## Why this exists

Claude's native Microsoft 365 connector can't send, forward or draft mail with attachments: per Anthropic's docs,
"attachments aren't supported in write tools, so sending, forwarding, and drafting all reject
messages with attachments" and "Claude can't attach files to the drafts it creates". It is also
a fixed set of tools chosen by Anthropic (its security guide lists about 40), refuses personal
Microsoft accounts, and requires tenant-wide consent to Anthropic's app. This relay runs an
open-source Microsoft 365 MCP server (Softeria's) yourself, with your own app registration and
your own scope list, and adds the hardening a public endpoint needs.

| | Claude's native Microsoft 365 connector | m365-claude-relay |
|---|---|---|
| Email attachments | Not supported: sending, forwarding and drafting with attachments are rejected; Claude can't attach files to drafts | Read any attachment as a real file; send, forward and draft with files up to 150 MB |
| Calendar event attachments | Not supported | Supported (attendees receive the update) |
| Tools | A fixed set chosen by Anthropic — about 40 listed in its security guide (7 read/search, the rest write) | 354 in the catalog; your scope list decides what is exposed (138 with the default scopes) |
| Areas | SharePoint/OneDrive search and file writes, Outlook mail and calendar, Teams chat and calendar | The same areas in depth, plus contacts, calendar sharing/delegation, mailbox rules, OneDrive file operations and Excel workbooks, To Do, OneNote, Planner, groups, rooms, presence, meeting transcripts/recordings, webhook subscriptions (some need additional or work-tenant scopes) |
| Accounts | Work or school only; personal accounts refused | Work tenants and personal accounts |
| Consent | Tenant-wide consent to Anthropic's app ("M365 MCP Server for Claude") by a Global Administrator | Your own app registration; users consent to exactly the scopes you list |
| Where it runs | Anthropic-hosted | A container you run, behind your ingress |
| Source | Anthropic-operated; source not published | Open source (MIT): Softeria's M365 MCP Server, pinned and configured, plus one tool until upstream ships it |

Sources (September 2026): [Microsoft 365 connector](https://claude.com/docs/connectors/microsoft/365),
[Set up the Microsoft 365 connector](https://support.claude.com/en/articles/12542951-set-up-the-microsoft-365-connector),
[Microsoft 365 connector security guide](https://support.claude.com/en/articles/12684923-microsoft-365-connector-security-guide).

## Quickstart

1. Register an Entra app — [docs/entra.md](docs/entra.md) (10 minutes; you need the client id, tenant id and a secret).
2. Run the image behind your TLS ingress on port 7860:

   ```bash
   docker run -d --name m365-claude-relay --read-only --security-opt no-new-privileges \
     --tmpfs /dev/shm:rw,size=64m -p 7860:7860 \
     -e MS365_MCP_CLIENT_ID=<client id> -e MS365_MCP_CLIENT_SECRET=<secret> \
     -e MS365_MCP_TENANT_ID=<tenant id or consumers> \
     -e MS365_MCP_PUBLIC_URL=https://relay.example.com \
     -e MS365_MCP_ATTACHMENT_URL_BASE=https://relay.example.com \
     -e MS365_MCP_ATTACHMENT_URL_KEY=<32+ random hex> \
     -e MS365_MCP_ALLOWED_SCOPES="User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite" \
     ghcr.io/rmdevpro/m365-claude-relay:1.4.4
   ```

   Work tenant: add `-e MS365_MCP_ORG_MODE=true`. `https://relay.example.com/` answers
   "Microsoft 365 MCP Server is running"; the startup log line shows the scopes and allowlist.
3. Add the connector in Claude and upload the skill — [docs/claude.md](docs/claude.md).
4. Verify before anyone relies on it — [docs/deploy-and-verify.md](docs/deploy-and-verify.md) (outside probes, then a checklist through Claude including a file round trip).

Change scopes later: edit `MS365_MCP_ALLOWED_SCOPES`, restart. No rebuild.

## Scopes decide the tool surface

**The policy is a list of Microsoft Graph scopes. Every Softeria tool whose required scopes are
covered by that list is exposed. The only exceptions are tools the relay replaces with a better
one: the base64 file reads are excluded in favour of `get-download-url`, the base64 and
upload-session attachment writes in favour of `get-upload-url`, and the raw `graph-batch` because it
would bypass those exclusions. Nothing is withheld for any other reason — what an organisation does not want is Blocked in Claude.** The gate
adds one tool of its own, `read-mail-text` (see below). Users consent to exactly the
policy scopes at sign-in; Claude's per-tool permissions (Always allow / Needs approval / Blocked,
org-admin ceiling on Team/Enterprise) then decide what each user can actually use. A blocked tool
is removed from Claude's tool set entirely; connector tools are deferred-loaded, so a large
surface costs a list of names per conversation, not schemas. A tool whose service or permission
the account lacks simply fails (Graph 403/404) — nothing runs that the scope does not allow.

Softeria 0.166.0 ships 354 tools (`tools/list` in `--org-mode` with no filter). What today's policy
(default scopes, policy `2026-10-14.1`) exposes, and what more scopes would add, on a **personal**
(outlook.com, `MS365_MCP_TENANT_ID=consumers`, no `--org-mode`) account:

| Scope in the policy | Exposes (tools) |
|---|---|
| `User.Read` | profile: `get-current-user`, `get-my-profile`, time zones/languages (4) |
| `Mail.ReadWrite` (+ `Mail.Read`) | mail read/search, folders, drafts, attachments, move/copy, categories, focused inbox (28) |
| `Mail.Send` | send, reply, reply-all, forward, send draft (5) |
| `Calendars.ReadWrite` (+ `Calendars.Read`) | calendar views, events CRUD, invitations, reminders, calendars CRUD, **sharing/delegation** (30) |
| `Contacts.ReadWrite` (+ `Contacts.Read`) | contacts and contact folders (13) |
| `MailboxSettings.ReadWrite` (+ `.Read`) | mailbox settings (auto-replies, time zone), **mail rules** (8) |
| `Files.ReadWrite` (+ `Files.Read`) | OneDrive browse/search/download, upload, copy/move/delete, **sharing links**, versions, thumbnails, and all Excel-workbook tools (42) |
| *(no scope)* | `get-download-url`, `get-upload-url`, `parse-teams-url`, the six webhook `*-subscription` tools (9) |

Softeria registers **137** after the exclusions, and the pass-through adds `read-mail-text`, so a
client sees **138**. Full per-tool list with Softeria's descriptions: [docs/tools.md](docs/tools.md).

Scopes **not** in today's policy and what adding them would expose (personal accounts):
`Tasks.ReadWrite` → To Do (12); `Notes.ReadWrite`/`Notes.Create` → OneNote (13);
`User.ReadWrite` → profile edits (1); `Calendars.Read.Shared` → other people's calendars (1);
`SensitivityLabel.Read` (2).

**Work tenants.** Set `MS365_MCP_TENANT_ID` to the tenant GUID and `MS365_MCP_ORG_MODE=true`;
Softeria then derives the surface in org mode (with the same seven scopes it registers 141 tools —
`get-schedule` is added). Admin-consented work scopes (`Sites.Read.All`/`Sites.Selected`, `ChannelMessage.Send`,
`User.Read.All`, `Group.ReadWrite.All`, …) added to `MS365_MCP_ALLOWED_SCOPES` unlock the remaining
~170 tools: Teams, SharePoint, shared mailboxes, Planner, directory and people. Which scopes a
work tenant gets is that organisation's decision, made in its app registration and its container
environment; exercise the resulting surface against the real tenant before go-live.

**Scopes are runtime configuration — no rebuild to change them.** `MS365_MCP_ALLOWED_SCOPES` in the
container environment is the scope list (default: `policy.json` `scopes`). `start.sh` hands it to
Softeria, whose `--allowed-scopes` logic derives the tool surface at every start, and as
`MS365_MCP_EXTRA_SCOPES`, the scopes users consent to at sign-in. To change the surface: change the
variable, restart the container; add the permission on the app registration and admin-consent it
(users re-consent at next sign-in). The running scope list is in the startup log line. What is
fixed in the image and not environment-changeable: the superseded-tool exclusions (`ENABLED_TOOLS`, which would
override the exclusions, is refused at start).

## What is OTS and what is custom

Everything is Softeria's own behaviour, configured by `start.sh`:
- OAuth and the On-Behalf-Of exchange (including the scope personal accounts need on code and refresh redemption).
- Token checks: Entra verifies the assertion at the exchange, Softeria answers 401 when it is rejected and enforces the tenant/user allowlist.
- The tool surface (`--allowed-scopes` plus `--enabled-tools` for the exclusions) and the consent scopes (`--extra-scopes`).
- Attachment **download and upload** links (`--enable-attachment-urls`: `get-download-url`, `get-upload-url`; signed, single-use, memory-only, TTL ≤ 300 s, uploads up to 150 MB streamed in 3.75 MiB chunks).
- Rate limits, security headers, dynamic client registration off, the redirect allowlist, and the per-call JSON audit log.

Five pieces the relay used to carry are now upstream: Softeria#693, #694, #695, #703 and #733, the last two from our own reports and PRs.

The only custom code is `gate.js` (about 150 lines) with `mail-text.js`. It is a transparent pass-through that adds one tool:

| Piece | Why | Retire when |
|---|---|---|
| `read-mail-text`: up to 20 messages as text with only the bulk junk removed — runs of invisible padding, image placeholders (a bracketed image-file address) and quoted reply history from its header down (forwards keep theirs); links kept (Safe Links, Proofpoint and Google redirects unwrapped, tracking parameters dropped; only addresses still over 300 characters shortened to `⟦link: domain⟧`). Everything else — signatures, footers, whitespace — is left as the message has it; line endings become `\n` and `⟦ ⟧` in the body itself appear as `[ ]` (reserved for link markers). Each message is cut to `maxChars` characters, default 3,000 (`truncated: true`; pass up to 300,000 for a whole long message), so a page of 20 fits the result limit. Hardened for hostile bodies (linear-time cleaning, unforgeable link markers); a result over the limit is refused whole with advice to narrow it | Softeria returns each body with all of that clutter (20 inbox messages ≈ 280,000 characters vs ≈ 70,000 on a real mailbox). Essential for working through a large mailbox | upstream PR Softeria#708, then the gate is removed and the image runs Softeria alone |

The pass-through:
- **Changes nothing else.** Requests and answers stream through untouched; it appends the client address to `X-Forwarded-For`, as any proxy does.
- **Buffers only `POST /mcp`** (capped at 4 MB): it adds the tool to `tools/list` and answers its calls.
- **Never judges a token.** `read-mail-text` calls Softeria's own mail tools (`get-mail-message`, `list-mail-folder-messages`) with the caller's bearer, so Softeria decides exactly as for any other call, and its 401/403 reach the client unchanged.

## Operating it

- **Scopes are the operator's configuration** (`MS365_MCP_ALLOWED_SCOPES`). `start.sh` passes the same list to Softeria as the surface (`--allowed-scopes`) and as the consent list (`MS365_MCP_EXTRA_SCOPES`), so users consent to exactly the scopes the surface was derived from. `ENABLED_TOOLS` in the environment is refused at start, because it would override the exclusions.
- **Who may use it.** `MS365_MCP_OBO_ALLOWED_TENANTS` defaults to the configured tenant (personal accounts: Microsoft's consumer tenant). `MS365_MCP_OBO_ALLOWED_USERS` narrows it to named users (object ids). Others get 403 before any exchange.
- **Attachments need the code sandbox to reach the relay.** Claude fetches and uploads files with `curl` in its code sandbox, so the relay host must be on the sandbox's allowed domains: Settings > Capabilities > Code execution > Additional allowed domains (Team/Enterprise: an org-admin setting). Claude's **Free** plan has no such list, so on Free the relay works for mail and calendar but cannot move files.
- **Health:** `GET /` answers "Microsoft 365 MCP Server is running". Both processes are supervised; if either exits, the container exits and the platform restarts it.
- **TLS and HSTS** belong at the ingress. Set `MS365_MCP_TRUST_PROXY_HOPS` to the number of proxies in front of Softeria, counting the pass-through: the image default `2` is one ingress plus the pass-through.

### Defaults in the image (`policy.json`, version `2026-10-14.2`)

| Field | Value | Effect |
|---|---|---|
| `scopes` | `User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite` | **default** for `MS365_MCP_ALLOWED_SCOPES`: the Graph delegated scopes the user consents to at sign-in, and the source of the tool surface (137 registered in 0.166.0 on a personal tenant; per-tool list in [docs/tools.md](docs/tools.md)) |
| `excludedTools` | `download-bytes`, `download-bytes-to-file`, `get-mail-attachment-content`, `add-mail-attachment`, `create-mail-attachment-upload-session`, `add-calendar-event-attachment`, `create-calendar-event-attachment-upload-session`, `graph-batch` | not registered: the link tools replace the base64/upload-session file tools, and `graph-batch` would bypass that |

## How it works

1. The Claude connector points at `https://<host>/mcp`. Claude discovers the OAuth endpoints and sends the user through `/authorize` → Microsoft sign-in with the relay's app registration; the user consents to the configured Graph scopes.
2. Microsoft issues Claude a token for the relay (`aud` = relay client id, scope `access_as_user`). Claude keeps and refreshes it through `/token`.
3. On every `/mcp` call Softeria exchanges that token On-Behalf-Of the user for a Graph token (in memory; Entra verifies the assertion) and calls Graph **as that user**.

Every user acts as themselves; the relay has no standing access to any mailbox.

## Configuration

| Name | Kind | Value |
|---|---|---|
| `MS365_MCP_CLIENT_ID` | variable | relay app registration (application) id — **required** |
| `MS365_MCP_CLIENT_SECRET` | **secret** | relay app registration client secret (keep it in the platform's secret store; rotate before it expires) |
| `MS365_MCP_TENANT_ID` | variable | `consumers` (personal accounts) or the tenant GUID; with a tenant, also set `MS365_MCP_ORG_MODE=true` |
| `MS365_MCP_ALLOWED_SCOPES` | variable | Graph delegated scopes users consent to; the tool surface is derived from them at every start. Default: `policy.json` `scopes`. Change → restart (and admin-consent the permission on the app registration) |
| `MS365_MCP_ORG_MODE` | variable | `true` for a work tenant (Teams/SharePoint/… tools become available to work scopes) |
| `MS365_MCP_PUBLIC_URL` | variable | https origin of the relay — **required** |
| `MS365_MCP_OBO_ALLOWED_TENANTS` / `MS365_MCP_OBO_ALLOWED_USERS` | variable | who may use the relay; default: the configured tenant, any user |
| `MS365_MCP_ATTACHMENT_URL_BASE` | variable | https origin download and upload links are served from (the relay's public origin) |
| `MS365_MCP_ATTACHMENT_URL_KEY` | **secret** | signing key for download and upload links |
| `MS365_MCP_ATTACHMENT_URL_TTL_S` | variable | ≤ 300 |
| `GATE_READ_MAIL_TEXT_MAX_CHARS` | variable | largest `read-mail-text` result (default 80000); larger is refused whole with the biggest messages named |

## App registration (Entra)

One registration is both the OAuth client Claude signs in through and the API the token is
issued for (Softeria's OBO model): Web platform, redirect `https://claude.ai/api/mcp/auth_callback`,
a credential, `api://<client id>` with scope `access_as_user`, `requestedAccessTokenVersion: 2`,
Microsoft Graph **delegated** permissions matching the deployment's `MS365_MCP_ALLOWED_SCOPES` (default: the policy's `scopes`),
`offline_access`. Organisation: single tenant, assignment required, admin consent.

## Claude side

- Custom connector URL `https://<host>/mcp`; Advanced → OAuth Client ID = relay client id (DCR is off).
- Settings → Capabilities → Code execution → **Additional allowed domains**: the relay host.
- Customize → Skills: upload `claude-skill/m365-relay/SKILL.md`.
- After relay tool changes: connector ⋮ → **Refresh tools list**.
- Tool permissions (Always allow / Needs approval / Blocked) are the trusted approval boundary for side-effecting tools; recommended profile in [docs/tools.md](docs/tools.md).

## Data handling

- Nothing is written to disk. Softeria's log files live on tmpfs; the pass-through logs one metadata line per `read-mail-text` call.
- **Audit:** Softeria writes one JSON audit event per tool call to stderr and to `audit.log` on tmpfs, containing the user's UPN, tool, HTTP status and byte counts. That is intentional audit data, not redacted; a deployment needs a sink, access control and retention for it.
- Held in memory, bounded: Softeria's download and upload tickets (≤ 300 s, bounded store, with the user's token); one streaming chunk per active upload.
- Transits the relay: MCP requests/responses; attachment bytes on links; the user's relay access **and refresh tokens** on `/token`.

## Build, update, tests

- `Dockerfile`: digest-pinned `node:22-slim`; `npm ci` from `package-lock.json`; `npm audit` fails the build on critical advisories; `sbom.cdx.json` is the CycloneDX SBOM; `NODE_OPTIONS` bounds the heap. Platform should run it read-only with no-new-privileges.
- `.github/workflows/ci.yml`: `npm audit`, syntax checks, tests and a Docker build on every push; `release.yml`: on a `v*` tag, tests, then a multi-arch image to GHCR with cosign keyless signing, provenance and SBOM.
- Update Softeria: bump the version in `package.json`; `npm install --package-lock-only`; regenerate the SBOM; `npm test`; rebuild; rerun your acceptance tests. Change the scopes: set `MS365_MCP_ALLOWED_SCOPES` in the deployment and restart (no rebuild). Change the fixed constraints: edit `policy.json` (bump `version`), `npm test`, review, redeploy.
- Tests: `npm ci && npm test` — the pass-through against a mock Softeria (untouched pass-through of routes, bodies, statuses and headers; `X-Forwarded-For`; body cap; `tools/list` gains the tool from JSON and SSE answers; `read-mail-text` through `get-mail-message`/`list-mail-folder-messages` as the caller, per-message errors, Softeria's 401 relayed, the size refusal; logs), `read-mail-text` cleaning (including linear time on hostile bodies and unforgeable link markers), the real `start.sh` with the real `--obo` Softeria (a recorder proves the scopes, allowlist and exclusions it is started with; `/authorize` keeps the relay scope and adds the Graph scopes), and the real pinned Softeria behind the pass-through (the 138-tool surface with the exclusions, Softeria's 401 without a token, discovery, the redirect allowlist, DCR off). OAuth/OBO/ticket flows need a real Entra app: run the acceptance checks against your tenant.

## Support and contributing

Best effort, no SLA: open a GitHub issue. Security reports: open a GitHub issue titled "security"
with no exploit details. Upstream fixes are preferred over relay code: five former relay pieces are
now Softeria features, and the last, `read-mail-text` (Softeria#708), is in review; when it ships,
the pass-through goes and the image is Softeria alone.

## License

MIT. Upstream `@softeria/ms-365-mcp-server` is MIT. © 2026 BlueprintAgentic.
