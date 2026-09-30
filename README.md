# m365-claude-relay

**Microsoft 365 for Claude custom connectors — each user acts as themselves.**
Give Claude (web, desktop; Free, Pro, Team, Enterprise) your users' own Outlook mail, calendar,
contacts and OneDrive through one small service you run. Sign-in is Microsoft's own (Entra
On-Behalf-Of); the relay never holds a password, never stores a token on disk, and exposes exactly
the tools your chosen Graph scopes cover. Nearly all of it is off-the-shelf:
[Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server) (MIT), pinned
`0.157.0`, in `--http --obo` mode behind a minimal, reviewed gate.

Open source, MIT, best-effort support via GitHub issues. Image: `ghcr.io/rmdevpro/m365-claude-relay`.

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
     ghcr.io/rmdevpro/m365-claude-relay:1.0.0
   ```

   Work tenant: add `-e MS365_MCP_ORG_MODE=true`. Check `https://relay.example.com/health` — it
   reports the running scopes and tool count.
3. Add the connector in Claude and upload the skill — [docs/claude.md](docs/claude.md).

Change scopes later: edit `MS365_MCP_ALLOWED_SCOPES`, restart. No rebuild.

## Scopes decide the tool surface

**The policy is a list of Microsoft Graph scopes. Every Softeria tool whose required scopes are
covered by that list is exposed. The only exceptions are tools the relay replaces with a better
one: `download-bytes`/`download-bytes-to-file` are excluded in favour of `get-download-url`, and
the three attachment-bridge primitives are hidden behind `get-attachment-upload-link`. Nothing is
withheld for any other reason — what an organisation does not want is Blocked in Claude.** Users consent to exactly the
policy scopes at sign-in; Claude's per-tool permissions (Always allow / Needs approval / Blocked,
org-admin ceiling on Team/Enterprise) then decide what each user can actually use. A blocked tool
is removed from Claude's tool set entirely; connector tools are deferred-loaded, so a large
surface costs a list of names per conversation, not schemas. A tool whose service or permission
the account lacks simply fails (Graph 403/404) — nothing runs that the scope does not allow.

Softeria 0.157.0 ships 337 tools (`tools/list` in `--org-mode` with no filter). What today's policy
(default scopes, policy `2026-09-30.5`) exposes, and what more scopes would add, on a **personal**
(outlook.com, `MS365_MCP_TENANT_ID=consumers`, no `--org-mode`) account — which is how this
prototype currently runs:

| Scope in the policy | Exposes (tools) |
|---|---|
| `User.Read` | profile: `get-current-user`, `get-my-profile`, time zones/languages (4) |
| `Mail.ReadWrite` (+ `Mail.Read`) | mail read/search, folders, drafts, attachments, move/copy, categories, focused inbox (28) |
| `Mail.Send` | send, reply, reply-all, forward, send draft (5) |
| `Calendars.ReadWrite` (+ `Calendars.Read`) | calendar views, events CRUD, invitations, reminders, calendars CRUD, **sharing/delegation** (30) |
| `Contacts.ReadWrite` (+ `Contacts.Read`) | contacts and contact folders (13) |
| `MailboxSettings.ReadWrite` (+ `.Read`) | mailbox settings (auto-replies, time zone), **mail rules** (8) |
| `Files.ReadWrite` (+ `Files.Read`) | OneDrive browse/search/download, upload, copy/move/delete, **sharing links**, versions, thumbnails, and all Excel-workbook tools (42) |
| *(no scope)* | `get-download-url`, `graph-batch` (hidden), `parse-teams-url`, the six webhook `*-subscription` tools (9) |

Total **139** (derived at start; logged and shown in `/health`), of which 3 are hidden bridge
primitives; `download-bytes` is excluded because `get-download-url` replaces it. Full per-tool list with Softeria's descriptions: [docs/tools.md](docs/tools.md).

Scopes **not** in today's policy and what adding them would expose (personal accounts):
`Tasks.ReadWrite` → To Do (12); `Notes.ReadWrite`/`Notes.Create` → OneNote (13);
`User.ReadWrite` → profile edits (1); `Calendars.Read.Shared` → other people's calendars (1);
`SensitivityLabel.Read` (2).

**Work tenants.** Set `MS365_MCP_TENANT_ID` to the tenant GUID and `MS365_MCP_ORG_MODE=true`; the
derivation then runs in org mode (with the same seven scopes that yields 140 tools — `get-schedule`
is added). Admin-consented work scopes (`Sites.Read.All`/`Sites.Selected`, `ChannelMessage.Send`,
`User.Read.All`, `Group.ReadWrite.All`, …) added to `MS365_MCP_ALLOWED_SCOPES` unlock the remaining
~170 tools: Teams, SharePoint, shared mailboxes, Planner, directory and people. Which scopes Blue Fox
gets is a Martech decision, made in their app registration and their container environment; the
resulting surface should be exercised against the real tenant before go-live.

**Scopes are runtime configuration — no rebuild to change them.** `MS365_MCP_ALLOWED_SCOPES` in the
container environment is the scope list (default: `policy.json` `scopes`). At every start, `start.sh`
runs `derive-tools.js`, which starts the pinned Softeria once on loopback with `--allowed-scopes`,
reads `tools/list` (a few seconds), and then starts the real `--obo` server on exactly that list. To
change the surface: change the variable, restart the container; add the permission on the app
registration and admin-consent it (users re-consent at next sign-in). The running scope list and tool
count are in the startup log line, the gate's `listening` event and `/health`. (Why the extra step: a
running `--obo` server cannot take `--allowed-scopes` itself — its `/authorize` would drop the relay
scope, Softeria#697; when fixed, the flag goes straight through.) What is fixed in the image and not
environment-changeable: the superseded-tool exclusions, the hidden bridge tools, and the safety switches.

## What is OTS and what is custom

Softeria owns OAuth/OBO exchange, Microsoft Graph, the tool surface (derived from the
operator's scopes with its own `--allowed-scopes` logic at every start, then pinned via `--enabled-tools`),
Graph consent scopes (`--extra-scopes`), attachment **download** links
(`--enable-attachment-urls`: signed, single-use, memory-only, TTL ≤ 300 s, the exchanged Graph
token kept with the ticket), `/mcp` rate limits and the per-call JSON audit log.

The custom delta (`gate.js`) exists only for what Softeria cannot do today:

| Piece | Why custom | Retire when |
|---|---|---|
| Inbound relay-token validation (RS256 vs Microsoft keys from an approved origin, iss, aud, tid, exp/nbf, scope, optional user allowlist; JWKS cache with a maximum age) | Softeria only checks a bearer is present and unexpired | upstream proposal Softeria#696 |
| Upload bridge `get-attachment-upload-link` (one-time PUT link → attach to a **draft** or an **event** as the user; < 3 MB inline, 3–150 MB streamed to a Graph upload session one 3.75 MiB chunk at a time) | no upstream equivalent | upstream PR Softeria#695 |
| Consent shim in `/authorize` (relay scope + the policy's consent scopes; caller scope ignored) | 0.157.0 ignores `--extra-scopes` in OBO `/authorize` | upstream PR Softeria#694 |
| `patch-softeria.js` (send `scope` on code/refresh redemption) | personal accounts fail with AADSTS70011 without it | upstream PR Softeria#693 |
| MCP glue: advertise/dispatch the upload tool; hide the three OTS primitives it supersedes (`add-mail-attachment`, `create-mail-attachment-upload-session`, `graph-batch`); replace server instructions that point at disabled tools; refuse JSON-RPC batches | follows from the above | with the above |

## Public-service posture (gate)

- Structured JSON logs, one line per request: `ts, id, ip, method, path, status, cat, ms`. `cat` is a fixed category; no bodies, tokens, upstream error text, attachment names or addresses. `/token` failures log the OAuth error code and the AADSTS number only.
- A correlation id per request (`x-request-id`) sent upstream and returned to the client.
- One canonical client address is forwarded to Softeria, never the client's `X-Forwarded-For` chain. **Default (policy `trustedIngress: false`): the socket peer.** Only a policy that has proven the ingress strips/replaces forwarding headers and that the container is reachable solely through it may set `trustedIngress: true`, after which the last (ingress-appended) `X-Forwarded-For` entry is used; `MS365_MCP_TRUST_PROXY_HOPS` must then match the real ingress → gate → Softeria topology.
- Exact open routes only (`/`, `/authorize`, `/token`, `/attachment`, `/.well-known/*`); `/register` is never forwarded (DCR off). Everything else needs a valid relay token.
- No CORS (upstream CORS headers are stripped); `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` on every response. HSTS belongs at the TLS ingress (no preload).
- Generic 401 bodies; the reason category is in the log only.
- Config is a security boundary and is validated at startup: `MS365_MCP_PUBLIC_URL` (https origin) and `MS365_MCP_CLIENT_ID` required; `GATE_JWKS_URI` and `MS365_MCP_ATTACHMENT_URL_BASE` must be https and in the approved origins (`GATE_APPROVED_ORIGINS`, default = public origin + `login.microsoftonline.com`); Graph upload-session URLs must be https on an approved Microsoft host suffix (`GATE_UPLOAD_HOST_SUFFIXES`); JWKS is fetched with one deadline over headers and body, size-capped, redirects refused.
- **Scopes are the operator's configuration; the tool surface follows from them at every start** (`MS365_MCP_ALLOWED_SCOPES`, see "Scopes decide the tool surface"). The gate validates the list (Graph scope names; `Mail.ReadWrite` required by the upload bridge) and requires `MS365_MCP_EXTRA_SCOPES` (the consent shim) to be the same list — `start.sh` sets both, so users always consent to exactly the scopes the surface was derived from. **`policy.json` holds the image's fixed constraints**: the default scope list, the two byte-return tools excluded because `get-download-url` replaces them, the hidden bridge tools and the three safety switches. Both `start.sh` and `gate.js` read only the copy beside them (`GATE_POLICY_FILE` is refused); a malformed policy fails startup; `GATE_DRAFT_ONLY`, `GATE_REJECT_TOOL_NOTIFICATIONS` or `GATE_TRUSTED_INGRESS` set to anything other than the policy value aborts startup (they cannot be weakened from the environment).
- Bounded operations: timeouts on JWKS fetches, loopback calls, Graph PUTs and client body reads; server header/request/keep-alive timeouts and a connection cap; upload memory bounded by the streaming chunk size, not the file size.
- `/health` is green only when Softeria answers; both processes are supervised (`start.sh`).

### Fixed constraints (committed `policy.json`, version `2026-09-30.5`)

| Field | Value | Effect |
|---|---|---|
| `scopes` | `User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite` | **default** for `MS365_MCP_ALLOWED_SCOPES`: Graph delegated scopes the user consents to at sign-in **and** the source of the tool surface — every Softeria tool whose required scopes these cover is exposed, except the `excludedTools` below and the three `hiddenTools` (139 in 0.157.0 on a personal tenant, incl. the 3 hidden; per-tool list in [docs/tools.md](docs/tools.md)) |
| `excludedTools` | `download-bytes`, `download-bytes-to-file` | removed from the derived surface because the relay's `get-download-url` (one-time links) replaces them; base64-in-conversation fails for real files |
| `hiddenTools` | `add-mail-attachment`, `create-mail-attachment-upload-session`, `graph-batch` | hidden from `tools/list`, refused on external `tools/call`; used by the bridge over loopback |
| `draftOnly` | `true` | uploads attach only to unsent drafts, checked at link issue and again at upload time (events exempt) |
| `rejectToolNotifications` | `true` | JSON-RPC notifications whose method is not `notifications/*` are refused |
| `trustedIngress` | `false` | client address = socket peer (see above) |

### Tunable limits and bounds (environment)

| Setting | Default | Effect when set |
|---|---|---|
| `GATE_RATE_LIMIT_PER_MIN` | `0` (off) | per-client-IP limit on unauthenticated outcomes and on `/files/`; `GATE_RATE_MAX_KEYS` bounds the map (10 000) |
| `GATE_LINK_MAX_PENDING_PER_USER`, `GATE_LINK_MAX_CONCURRENT_PER_USER` | `0` (unlimited) | per-user upload quotas |
| `GATE_LINK_MAX_MB`, `GATE_LINK_TOTAL_MB`, `GATE_LINK_MAX_PENDING`, `GATE_LINK_MAX_CONCURRENT`, `GATE_LINK_TTL_SECONDS` | 150 / 512 / 64 / 4 / 300 | global upload limits (`0` = unlimited for the counts) |
| `GATE_JWKS_TIMEOUT_MS`, `GATE_JWKS_MAX_AGE_SECONDS`, `GATE_UPSTREAM_TIMEOUT_MS`, `GATE_GRAPH_PUT_TIMEOUT_MS`, `GATE_BODY_IDLE_TIMEOUT_MS`, `GATE_HEADERS_TIMEOUT_MS`, `GATE_REQUEST_TIMEOUT_MS`, `GATE_MAX_CONNECTIONS`, `GATE_MCP_MAX_BODY_MB` | generous | bounds; values reviewed with the owner |
| `GATE_ALLOWED_USERS`, `GATE_ALLOWED_TIDS`, `GATE_APPROVED_ORIGINS`, `GATE_UPLOAD_HOST_SUFFIXES` | any / configured tenant / public + login / Microsoft suffixes | allowlists |

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
| `MS365_MCP_ATTACHMENT_URL_BASE` | variable | https origin download links are served from (must be approved) |
| `MS365_MCP_ATTACHMENT_URL_KEY` | **secret** | signing key for download links |
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
- Held in memory, bounded: Microsoft public keys (max age); download tickets (≤ 300 s, ≤ 256, with the user's Graph token); pending upload links (≤ 300 s, with the user's relay bearer until used); one streaming chunk per active upload.
- Transits the relay: MCP requests/responses; attachment bytes on links; the user's relay access **and refresh tokens** on `/token`.

## Build, update, tests

- `Dockerfile`: digest-pinned `node:22-slim`; `npm ci` from `package-lock.json`; `npm audit` fails the build on critical advisories; `sbom.cdx.json` is the CycloneDX SBOM; `NODE_OPTIONS` bounds the heap. Platform should run it read-only with no-new-privileges.
- `.github/workflows/m365-relay-audit.yml`: weekly `npm audit` + tests.
- Update Softeria: bump the version in `package.json`; `npm install --package-lock-only`; regenerate the SBOM; `npm test`; rebuild; rerun your acceptance tests. Change the scopes: set `MS365_MCP_ALLOWED_SCOPES` in the deployment and restart (no rebuild). Change the fixed constraints: edit `policy.json` (bump `version`), `npm test`, review, redeploy.
- Tests: `npm ci && npm test` (42) — derivation boundary tier (fake loopback server: invalid/duplicate/excluded/regex-meta names, hold-open, stderr flood, oversized body → fail closed, bounded), composition tier (real `start.sh` + real `--obo` server with a runtime scope override, an argv recorder proving the derived escaped regex is what the OBO server is started with; failed derivation exposes nothing), unit tier against a mock upstream (config and policy-schema validation, policy drift, token matrix, protocol shapes, forged-XFF/rate limiting, JWKS stall and redirect, glue, consent shim, health, quotas, draft-only, streaming uploads, event attachments, logs) and an integration tier against the real pinned Softeria on loopback (start-time scope derivation → tool filtering, hidden tools, instructions, notifications, discovery, `/authorize`, `/register`, health with scope/tool count). OAuth/OBO/ticket flows need a real Entra app: run the acceptance checks against your tenant.

## Support and contributing

Best effort, no SLA: open a GitHub issue. Security reports: open an issue titled "security" with no
exploit details, or email security@blueprintagentic.ai. Upstream fixes are preferred over relay
code — three of the relay's pieces exist only until the corresponding Softeria PRs merge.

## License

MIT. Upstream `@softeria/ms-365-mcp-server` is MIT. © 2026 BlueprintAgentic.
