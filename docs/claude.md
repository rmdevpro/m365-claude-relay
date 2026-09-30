# Claude setup

Works with Claude web/desktop custom connectors (Free, Pro, Team, Enterprise).

1. **Add the connector** — Settings → Connectors → Add custom connector.
   - Name: e.g. `Microsoft 365`.
   - MCP server URL: `https://<your relay host>/mcp`.
   - Authentication: *Sign in now* (detected). OAuth client: *Use your own OAuth client* → **OAuth
     client ID = the relay's `MS365_MCP_CLIENT_ID`**; leave the secret blank (dynamic client
     registration is off on the relay by design).
2. **Connect** — click Connect, sign in with the Microsoft account, accept the consent screen. The
   scopes shown are exactly the relay's `MS365_MCP_ALLOWED_SCOPES`.
3. **Code execution domain** — Settings → Capabilities → Code execution → *Additional allowed
   domains*: add the relay host. Attachments and files move through one-time links that Claude's
   sandbox fetches; without this, downloads/uploads fail.
4. **Skill** — Customize → Skills → Upload skill → `claude-skill/m365-relay/SKILL.md`. It teaches
   Claude the attachment link workflow, forwarding, calendar attachments and when to stop.
5. **Tool permissions** — connector → Tool permissions. Each tool is *Always allow*, *Needs
   approval* or *Blocked*. Recommended: reads, drafts and reversible edits → Always allow; anything
   that sends, deletes, shares/delegates, or changes mail rules or mailbox settings → Needs approval;
   anything your organisation does not want → Blocked (a blocked tool is removed from Claude's tool
   set entirely). Per-tool guidance: [`docs/tools.md`](tools.md).
   Team/Enterprise: the org admin sets these as a ceiling per tool; users choose within it.
6. **After changing relay scopes** — connector ⋮ → *Refresh tools list*, then set permissions for
   the new tools (they default to Needs approval).

Claude loads connector tools lazily (names in context, schemas on demand), so a large tool surface
costs little; block what you don't want rather than trimming the relay.
