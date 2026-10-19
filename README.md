# m365-claude-relay

**Microsoft 365 for Claude custom connectors — each user acts as themselves.**
Give Claude (web, desktop; Free, Pro, Team, Enterprise) your users' own Outlook mail, calendar,
contacts and OneDrive through one container you run. Sign-in is Microsoft's own (Entra
On-Behalf-Of); nothing is stored on disk, and Claude gets exactly the tools your chosen Graph
scopes cover.

**There is no custom code.** The container is Softeria's own image,
[`ghcr.io/softeria/ms-365-mcp-server`](https://github.com/Softeria/ms-365-mcp-server) (MIT),
unmodified. This repository is its configuration for Claude, the deployment and verification
guide, the Entra and Claude setup, and a Claude skill. Everything the relay once added is now part
of Softeria, through our upstream PRs and reports (Softeria#693, #694, #695, #703, #708, #733, #736):
the token checks and tenant allowlist, attachment upload links, `read-mail-text` and more.

Open source, MIT, best-effort support via GitHub issues.

## Why this exists

Claude's native Microsoft 365 connector can't send, forward or draft mail with attachments: per Anthropic's docs,
"attachments aren't supported in write tools, so sending, forwarding, and drafting all reject
messages with attachments" and "Claude can't attach files to the drafts it creates". It is also
a fixed set of tools chosen by Anthropic (its security guide lists about 40), refuses personal
Microsoft accounts, and requires tenant-wide consent to Anthropic's app. This relay is
Softeria's open-source Microsoft 365 MCP server, run yourself with your own app registration and
your own scope list.

| | Claude's native Microsoft 365 connector | m365-claude-relay |
|---|---|---|
| Email attachments | Not supported: sending, forwarding and drafting with attachments are rejected; Claude can't attach files to drafts | Read any attachment as a real file; send, forward and draft with files up to 150 MB |
| Calendar event attachments | Not supported | Supported (attendees receive the update) |
| Tools | A fixed set chosen by Anthropic — about 40 listed in its security guide (7 read/search, the rest write) | 350+ in the catalog; your scope list decides what is exposed (138 with the default scopes, 139 on a work tenant) |
| Areas | SharePoint/OneDrive search and file writes, Outlook mail and calendar, Teams chat and calendar | The same areas in depth, plus contacts, calendar sharing/delegation, mailbox rules, OneDrive file operations and Excel workbooks, To Do, OneNote, Planner, groups, rooms, presence, meeting transcripts/recordings, webhook subscriptions (some need additional or work-tenant scopes) |
| Accounts | Work or school only; personal accounts refused | Work tenants and personal accounts |
| Consent | Tenant-wide consent to Anthropic's app ("M365 MCP Server for Claude") by a Global Administrator | Your own app registration; users consent to exactly the scopes you list |
| Where it runs | Anthropic-hosted | A container you run, behind your ingress |
| Source | Anthropic-operated; source not published | Open source (MIT): Softeria's own image, unmodified, with the configuration in this repository |

Sources (September 2026): [Microsoft 365 connector](https://claude.com/docs/connectors/microsoft/365),
[Set up the Microsoft 365 connector](https://support.claude.com/en/articles/12542951-set-up-the-microsoft-365-connector),
[Microsoft 365 connector security guide](https://support.claude.com/en/articles/12684923-microsoft-365-connector-security-guide).

## Quickstart

1. Register an Entra app — [docs/entra.md](docs/entra.md). You need the client id, the tenant id and a secret.
2. Fill in [`relay.env.example`](relay.env.example) and run Softeria's image with it, one replica, behind your HTTPS ingress on port 3000:

   ```bash
   docker run -d --name m365-relay --env-file relay.env -p 127.0.0.1:3000:3000 \
     ghcr.io/softeria/ms-365-mcp-server@sha256:0e063c40f809448c184d55597db2b7a879a14d279f11c9cde881e411fbe056ec \
     --http 0.0.0.0:3000 --enable-attachment-urls
   ```

   (or [`docker-compose.example.yml`](docker-compose.example.yml); Azure Container Apps in the deploy guide).
3. Check it from outside: `./test/smoke.sh https://<relay host>`.
4. Add the connector in Claude and upload the skill — [docs/claude.md](docs/claude.md).
5. Verify through Claude before anyone relies on it — [docs/deploy-and-verify.md](docs/deploy-and-verify.md).

Change scopes later: edit `MS365_MCP_ALLOWED_SCOPES` and `MS365_MCP_EXTRA_SCOPES`, restart. Update:
move the image digest to a newer Softeria release, rerun the checks.

## The configuration, line by line

| Setting | Why |
|---|---|
| args `--http 0.0.0.0:3000 --enable-attachment-urls` | HTTP transport; attachment download and upload links (`get-download-url`, `get-upload-url`) that Claude's code sandbox fetches with `curl`, instead of base64 through the conversation |
| `MS365_MCP_OBO=true` | each call is exchanged On-Behalf-Of the signed-in user; Entra verifies the token at the exchange |
| `MS365_MCP_CLIENT_ID`, `MS365_MCP_CLIENT_SECRET`, `MS365_MCP_TENANT_ID` | the app registration; the secret belongs in the platform's secret store |
| `MS365_MCP_ORG_MODE=true` | work tenant (adds the work-only tools the scopes cover) |
| `MS365_MCP_PUBLIC_URL`, `MS365_MCP_ATTACHMENT_URL_BASE` | the container's public https origin, for OAuth redirects and file links |
| `MS365_MCP_ATTACHMENT_URL_KEY` | signs the file links (secret) |
| `MS365_MCP_ALLOWED_SCOPES`, `MS365_MCP_EXTRA_SCOPES` | the same scope list twice: what tools exist, and what users consent to |
| `ENABLED_TOOLS` | leaves out only the tools replaced by better ones: the base64 file reads and writes (replaced by the link tools) and `graph-batch` (it would bypass that) |
| `MS365_MCP_OBO_ALLOWED_TENANTS` (and optional `_USERS`) | only your tenant (or named users) may use it; others get 403 before any exchange |
| `MS365_MCP_ALLOWED_REDIRECT_URIS`, `MS365_MCP_DISABLE_DCR=true` | sign-in may only return to Claude; no dynamic client registration (Claude uses your client id) |
| `MS365_MCP_TRUST_PROXY_HOPS=1` | one HTTPS ingress in front, so rate limits see real client addresses |

**Scopes decide the tool surface.** Every Softeria tool whose required scopes are covered by the
list is exposed, apart from the replaced tools above. The default seven scopes give **138 tools**
on a personal account and **139** on a work tenant, including Softeria's `read-mail-text` (up to 20
messages as text with the bulk junk removed; essential for working through a large mailbox).
Per-tool list and recommended Claude permissions: [docs/tools.md](docs/tools.md). Claude's per-tool
settings (Always allow / Needs approval / Blocked) decide what each user may actually do.

## Operating it

- **One replica.** Attachment links are single-use tickets held in memory.
- **Health:** `GET /` answers "Microsoft 365 MCP Server is running".
- **Audit:** one JSON line per tool call (user, tool, status, sizes; no mail content) on stderr; point your log collection at it and set retention.
- **Attachments need the code sandbox to reach the relay:** add the relay host to Claude's code-execution allowed domains (Team/Enterprise: an org setting). Claude's Free plan has no such list, so on Free mail and calendar work but files do not.
- **Secret rotation:** replace `MS365_MCP_CLIENT_SECRET` before it expires and restart.
- **Updates:** Softeria releases often. Pin a digest, and move it deliberately: run `test/smoke.sh` and the Claude checklist against the new digest first.

## Repository

- `relay.env.example`, `docker-compose.example.yml`: the configuration.
- `docs/entra.md`, `docs/claude.md`, `docs/deploy-and-verify.md`, `docs/tools.md`.
- `claude-skill/m365-relay/SKILL.md`: teaches Claude the file-link workflow and the ground rules.
- `test/smoke.sh` (outside checks against any running relay), `test/tools.py` (tool surface); CI runs both against the pinned image on every push and weekly.

Releases up to 1.4.4 shipped an image of our own (`ghcr.io/rmdevpro/m365-claude-relay`). From 2.0.0
use Softeria's image; ours is no longer updated.

## Support and contributing

Best effort, no SLA: open a GitHub issue. Security reports: open a GitHub issue titled "security"
with no exploit details. Server fixes and features go to Softeria upstream.

## License

MIT. Upstream `@softeria/ms-365-mcp-server` is MIT. © 2026 BlueprintAgentic.
