# m365-claude-relay

**Microsoft 365 for Claude custom connectors — each user acts as themselves.**
Give Claude (web, desktop; Free, Pro, Team, Enterprise) your users' own Outlook mail, calendar,
contacts and OneDrive through one small service you run. Sign-in is Microsoft's own (Entra
On-Behalf-Of); the relay never holds a password, never stores a token on disk, and exposes exactly
the tools your chosen Graph scopes cover. Nearly all of it is off-the-shelf:
[Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) (MIT), pinned
`0.160.0`, in `--http --obo` mode behind a minimal, reviewed gate.

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
| Tools | A fixed set chosen by Anthropic — about 40 listed in its security guide (7 read/search, the rest write) | 338 in the catalog; your scope list decides what is exposed (138 with the default scopes) |
| Areas | SharePoint/OneDrive search and file writes, Outlook mail and calendar, Teams chat and calendar | The same areas in depth, plus contacts, calendar sharing/delegation, mailbox rules, OneDrive file operations and Excel workbooks, To Do, OneNote, Planner, groups, rooms, presence, meeting transcripts/recordings, webhook subscriptions (some need additional or work-tenant scopes) |
| Accounts | Work or school only; personal accounts refused | Work tenants and personal accounts |
| Consent | Tenant-wide consent to Anthropic's app ("M365 MCP Server for Claude") by a Global Administrator | Your own app registration; users consent to exactly the scopes you list |
| Where it runs | Anthropic-hosted | A container you run, behind your ingress |
| Source | Anthropic-operated; source not published | Open source (MIT): Softeria's M365 MCP Server, pinned and reviewed, behind a minimal public-endpoint gate |

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
     ghcr.io/rmdevpro/m365-claude-relay:1.2.0
   ```

   Work tenant: add `-e MS365_MCP_ORG_MODE=true`. Check `https://relay.example.com/health` — it
   reports the running scopes, and the tool count once a client has listed the tools.
3. Add the connector in Claude and upload the skill — [docs/claude.md](docs/claude.md).

Change scopes later: edit `MS365_MCP_ALLOWED_SCOPES`, restart. No rebuild.

## Scopes decide the tool surface

**The policy is a list of Microsoft Graph scopes. Every Softeria tool whose required scopes are
covered by that list is exposed. The only exceptions are tools the relay replaces with a better
one: `download-bytes`/`download-bytes-to-file` are excluded in favour of `get-download-url`, and
three attachment primitives are hidden because Softeria's `get-upload-url` replaces them. Nothing is
withheld for any other reason — what an organisation does not want is Blocked in Claude.** The gate
adds one tool of its own, `read-mail-text` (see below). Users consent to exactly the
policy scopes at sign-in; Claude's per-tool permissions (Always allow / Needs approval / Blocked,
org-admin ceiling on Team/Enterprise) then decide what each user can actually use. A blocked tool
is removed from Claude's tool set entirely; connector tools are deferred-loaded, so a large
surface costs a list of names per conversation, not schemas. A tool whose service or permission
the account lacks simply fails (Graph 403/404) — nothing runs that the scope does not allow.

Softeria 0.160.0 ships 338 tools (`tools/list` in `--org-mode` with no filter). What today's policy
(default scopes, policy `2026-10-10.1`) exposes, and what more scopes would add, on a **personal**
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
| *(no scope)* | `get-download-url`, `get-upload-url`, `graph-batch` (hidden), `parse-teams-url`, the six webhook `*-subscription` tools (10) |

Softeria registers **140**; 3 of them are hidden (`add-mail-attachment`,
`create-mail-attachment-upload-session`, `graph-batch`), and the gate adds `read-mail-text`, so a
client sees **138** (shown in `/health` once listed). `download-bytes` is excluded because
`get-download-url` replaces it. Full per-tool list with Softeria's descriptions: [docs/tools.md](docs/tools.md).

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
(users re-consent at next sign-in). The running scope list is in the startup log line, the gate's
`listening` event and `/health`. What is fixed in the image and not environment-changeable: the
superseded-tool exclusions, the hidden tools, and the safety switches (`ENABLED_TOOLS`, which would
override the exclusions, is refused at start).

## What is OTS and what is custom

Softeria owns OAuth/OBO exchange (including the scope personal accounts need on code and refresh
redemption), Microsoft Graph, the tool surface (derived from the operator's scopes with its own
`--allowed-scopes` logic at every start), Graph consent scopes (`--extra-scopes`), attachment
**download and upload** links (`--enable-attachment-urls`: `get-download-url` and `get-upload-url`;
signed, single-use, memory-only, TTL ≤ 300 s; uploads up to 150 MB streamed to Graph in 3.75 MiB
chunks), `/mcp` rate limits and the per-call JSON audit log. Four pieces the relay used to carry are
now upstream (Softeria#693, #694, #695, #703) and have been removed.

The custom delta (`gate.js`, `mail-text.js`) exists only for what Softeria does not do today:

| Piece | Why custom | Retire when |
|---|---|---|
| Inbound relay-token pre-check: the claims only (exp/nbf, version, aud, tid, iss, scope, optional user allowlist), so a token not meant for this relay gets a clean 401. The signature is verified by Microsoft when Softeria exchanges the token On-Behalf-Of the user; a forged token gets no Graph token and no data. | Softeria returns a 500 instead of a 401 for a token it cannot exchange, and has no tenant/user allowlist | upstream Softeria#696 (401 and allowlist accepted by the maintainer; signature checks stay out of Softeria by design) |
| `read-mail-text`: a triage view of up to 20 messages with quoted history, signatures, footers, image placeholders and tracking links removed (links as `⟦link: domain⟧`). Pattern-based and lossy (`get-mail-message` has the exact body); hardened for hostile bodies (linear-time cleaning, 300,000-character input cap per message, unforgeable link markers); a result over the limit is refused whole with advice to narrow it | Softeria returns each body with all of that clutter (20 inbox messages ≈ 400,000 characters vs ≈ 33,000–42,000) | upstream PR Softeria#708 |
| `/authorize`: the caller's `scope` is replaced by the relay scope before Softeria adds the configured Graph scopes | Softeria keeps whatever extra scopes the caller asks for; the relay's consent should be exactly the operator's list | — (relay posture) |
| Draft-only check on `get-upload-url` (mail targets must be unsent drafts; events exempt) | Softeria attaches to any message the user can write | — (relay posture, policy switch) |
| MCP glue: hide the three primitives `get-upload-url` supersedes and refuse the excluded tools; replace server instructions; refuse JSON-RPC batches | follows from the above | with the above |

## Public-service posture (gate)

- Structured JSON logs, one line per request: `ts, id, ip, method, path, status, cat, ms`. `cat` is a fixed category; no bodies, tokens, upstream error text, attachment names or addresses. `/token` failures log the OAuth error code and the AADSTS number only.
- A correlation id per request (`x-request-id`) sent upstream and returned to the client.
- One canonical client address is forwarded to Softeria, never the client's `X-Forwarded-For` chain. **Default (policy `trustedIngress: false`): the socket peer.** Only a policy that has proven the ingress strips/replaces forwarding headers and that the container is reachable solely through it may set `trustedIngress: true`, after which the last (ingress-appended) `X-Forwarded-For` entry is used; `MS365_MCP_TRUST_PROXY_HOPS` must then match the real ingress → gate → Softeria topology.
- Exact open routes only (`/`, `/authorize`, `/token`, `/attachment` (GET/PUT; the single-use ticket is the credential), `/.well-known/*`); `/register` is never forwarded (DCR off). Everything else needs a valid relay token. Paths must already be in normal form (no percent-encoding, dot segments or doubled slashes) or the request is refused before routing.
- No CORS (upstream CORS headers are stripped); `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` on every response. HSTS belongs at the TLS ingress (no preload).
- Generic 401 bodies; the reason category is in the log only.
- Config is a security boundary and is validated at startup: `MS365_MCP_PUBLIC_URL` (https origin) and `MS365_MCP_CLIENT_ID` required; `MS365_MCP_ATTACHMENT_URL_BASE` must be https and in the approved origins (`GATE_APPROVED_ORIGINS`, default = public origin + `login.microsoftonline.com`). The retired `GATE_JWKS_*` settings abort startup if still set.
- **Scopes are the operator's configuration; the tool surface follows from them at every start** (`MS365_MCP_ALLOWED_SCOPES`, see "Scopes decide the tool surface"). The gate validates the list (Graph scope names; `Mail.ReadWrite` required for drafts and `read-mail-text`) and requires `MS365_MCP_EXTRA_SCOPES` (the consent list) to be the same list — `start.sh` sets both, so users always consent to exactly the scopes the surface was derived from. **`policy.json` holds the image's fixed constraints**: the default scope list, the two byte-return tools excluded because `get-download-url` replaces them, the three primitives hidden because `get-upload-url` replaces them, and the three safety switches. Both `start.sh` and `gate.js` read only the copy beside them (`GATE_POLICY_FILE` is refused); a malformed policy fails startup; `GATE_DRAFT_ONLY`, `GATE_REJECT_TOOL_NOTIFICATIONS` or `GATE_TRUSTED_INGRESS` set to anything other than the policy value aborts startup (they cannot be weakened from the environment).
- Bounded operations: timeouts on loopback calls and client body reads; server header/request/keep-alive timeouts and a connection cap; `read-mail-text` results bounded by `GATE_READ_MAIL_TEXT_MAX_CHARS`. Upload streaming and its memory bound are Softeria's (one 3.75 MiB chunk at a time).
- `/health` is green only when Softeria answers; both processes are supervised (`start.sh`).

### Fixed constraints (committed `policy.json`, version `2026-10-10.1`)

| Field | Value | Effect |
|---|---|---|
| `scopes` | `User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite` | **default** for `MS365_MCP_ALLOWED_SCOPES`: Graph delegated scopes the user consents to at sign-in **and** the source of the tool surface — every Softeria tool whose required scopes these cover is exposed, except the `excludedTools` below and the three `hiddenTools` (140 registered in 0.160.0 on a personal tenant, incl. the 3 hidden; per-tool list in [docs/tools.md](docs/tools.md)) |
| `excludedTools` | `download-bytes`, `download-bytes-to-file` | removed from the derived surface because the relay's `get-download-url` (one-time links) replaces them; base64-in-conversation fails for real files |
| `hiddenTools` | `add-mail-attachment`, `create-mail-attachment-upload-session`, `graph-batch` | hidden from `tools/list`, refused on external `tools/call` (`get-upload-url` replaces them); `graph-batch` stays registered because `read-mail-text` uses it over loopback, as the user |
| `draftOnly` | `true` | `get-upload-url` for mail is passed to Softeria only when the target message is an unsent draft (checked as the user; events exempt) |
| `rejectToolNotifications` | `true` | JSON-RPC notifications whose method is not `notifications/*` are refused |
| `trustedIngress` | `false` | client address = socket peer (see above) |

### Tunable limits and bounds (environment)

| Setting | Default | Effect when set |
|---|---|---|
| `GATE_RATE_LIMIT_PER_MIN` | `0` (off) | per-client-IP limit on unauthenticated outcomes and on `/attachment`; `GATE_RATE_MAX_KEYS` bounds the map (10 000) |
| `GATE_READ_MAIL_TEXT_MAX_CHARS` | `80000` | largest `read-mail-text` result; larger is refused whole with the biggest messages named |
| `GATE_UPSTREAM_TIMEOUT_MS`, `GATE_BODY_IDLE_TIMEOUT_MS`, `GATE_HEADERS_TIMEOUT_MS`, `GATE_REQUEST_TIMEOUT_MS`, `GATE_MAX_CONNECTIONS`, `GATE_MCP_MAX_BODY_MB` | generous | bounds; values reviewed with the owner |
| `GATE_ALLOWED_USERS`, `GATE_ALLOWED_TIDS`, `GATE_APPROVED_ORIGINS` | any / configured tenant / public + login | allowlists |

## How it works

1. The Claude connector points at `https://<host>/mcp`. Claude discovers the OAuth endpoints and sends the user through `/authorize` → Microsoft sign-in with the relay's app registration; the user consents to the configured Graph scopes.
2. Microsoft issues Claude a token for the relay (`aud` = relay client id, scope `access_as_user`). Claude keeps and refreshes it through `/token`.
3. On every `/mcp` call the gate validates that token, then Softeria exchanges it On-Behalf-Of the user for a Graph token (in memory) and calls Graph **as that user**.

Every user acts as themselves; the relay has no standing access to any mailbox.

## Configuration

| Name | Kind | Value |
|---|---|---|
| `MS365_MCP_CLIENT_ID` | variable | relay app registration (application) id — **required** |
| `MS365_MCP_CLIENT_SECRET` | **secret** | relay app registration client secret (production: prefer a certificate credential) |
| `MS365_MCP_TENANT_ID` | variable | `consumers` (personal accounts) or the tenant GUID; with a tenant, also set `MS365_MCP_ORG_MODE=true` so the surface is derived in org mode |
| `MS365_MCP_ALLOWED_SCOPES` | variable | Graph delegated scopes users consent to; the tool surface is derived from them at every start. Default: `policy.json` `scopes`. Change → restart (and admin-consent the permission on the app registration) |
| `MS365_MCP_ORG_MODE` | variable | `true` for a work tenant (org-mode derivation; Teams/SharePoint/… tools become available to work scopes) |
| `MS365_MCP_PUBLIC_URL` | variable | https origin of the relay — **required** |
| *(excluded/hidden tools, switches)* | **`policy.json`** | fixed in the image; `GATE_DRAFT_ONLY` / `GATE_REJECT_TOOL_NOTIFICATIONS` / `GATE_TRUSTED_INGRESS` differing from the policy aborts startup; `MS365_MCP_EXTRA_SCOPES` must equal `MS365_MCP_ALLOWED_SCOPES` (start.sh sets it) |
| `MS365_MCP_ATTACHMENT_URL_BASE` | variable | https origin download and upload links are served from (must be approved) |
| `MS365_MCP_ATTACHMENT_URL_KEY` | **secret** | signing key for download and upload links |
| `MS365_MCP_ATTACHMENT_URL_TTL_S` | variable | ≤ 300 |
| `GATE_*` limits, timeouts, allowlists | variable | see the tunables table above |
| `MCP_GATE_KEY` | secret | optional shared `x-api-key`; unset = not required |

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

- Nothing is written to disk. Softeria's log files live on tmpfs; the gate logs metadata only.
- **Audit:** Softeria writes one JSON audit event per tool call to stderr and to `audit.log` on tmpfs, containing the user's UPN, tool, HTTP status and byte counts. That is intentional audit data, not redacted; a deployment needs a sink, access control and retention for it.
- Held in memory, bounded: rate-limit windows; Softeria's download and upload tickets (≤ 300 s, bounded store, with the user's token); one streaming chunk per active upload.
- Transits the relay: MCP requests/responses; attachment bytes on links; the user's relay access **and refresh tokens** on `/token`.

## Build, update, tests

- `Dockerfile`: digest-pinned `node:22-slim`; `npm ci` from `package-lock.json`; `npm audit` fails the build on critical advisories; `sbom.cdx.json` is the CycloneDX SBOM; `NODE_OPTIONS` bounds the heap. Platform should run it read-only with no-new-privileges.
- `.github/workflows/ci.yml`: `npm audit`, syntax checks, tests and a Docker build on every push; `release.yml`: on a `v*` tag, tests, then a multi-arch image to GHCR with cosign keyless signing, provenance and SBOM.
- Update Softeria: bump the version in `package.json`; `npm install --package-lock-only`; regenerate the SBOM; `npm test`; rebuild; rerun your acceptance tests. Change the scopes: set `MS365_MCP_ALLOWED_SCOPES` in the deployment and restart (no rebuild). Change the fixed constraints: edit `policy.json` (bump `version`), `npm test`, review, redeploy.
- Tests: `npm ci && npm test` (56) — composition tier (real `start.sh` + real `--obo` server with a runtime scope override; a recorder proves Softeria is started once, with the scopes in its environment and only the exclusions as `--enabled-tools`; `/authorize` through the real stack keeps the relay scope and adds the configured Graph scopes; `ENABLED_TOOLS` and a scope list without `Mail.ReadWrite` stop the start), unit tier against a mock upstream (config and policy-schema validation, policy drift, token pre-check matrix, forged-signature pass-through and user allowlist, protocol shapes, forged-XFF/rate limiting, glue, `/authorize` scope, `/attachment` route, draft-only on `get-upload-url`, `read-mail-text` through `graph-batch` as the caller and its size refusal, health, logs), `read-mail-text` cleaning cases (including linear time on hostile bodies and unforgeable link markers), and an integration tier against the real pinned Softeria on loopback (scope-derived surface of 138 with exclusions, hidden tools and `read-mail-text`; instructions, notifications, discovery, `/authorize` under `--obo`, `/register`, health). OAuth/OBO/ticket flows need a real Entra app: run the acceptance checks against your tenant.

## Support and contributing

Best effort, no SLA: open a GitHub issue. Security reports: open a GitHub issue titled "security"
with no exploit details. Upstream fixes are preferred over relay code: four former relay pieces are
now Softeria features, and `read-mail-text` (Softeria#708) and the 401/allowlist part of the token
pre-check (Softeria#696) are on their way upstream.

## License

MIT. Upstream `@softeria/ms-365-mcp-server` is MIT. © 2026 BlueprintAgentic.
