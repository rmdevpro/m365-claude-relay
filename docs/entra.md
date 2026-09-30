# Entra app registration

One registration serves as both the OAuth client Claude signs in through and the API the relay's
token is issued for (the On-Behalf-Of model used by the upstream server). Create it in the tenant
whose users will use the relay (or as a personal-accounts app for outlook.com users).

1. **Register an application** — Entra admin center → App registrations → New registration.
   - Name: anything (users see it on the consent screen), e.g. `M365 Claude relay`.
   - Supported account types: *this organizational directory only* (work tenant) — or
     *personal Microsoft accounts only* for outlook.com users.
   - Redirect URI: **Web**, `https://claude.ai/api/mcp/auth_callback`.
2. **Expose an API** — Application ID URI `api://<client id>` (accept the default). Add a scope:
   name `access_as_user`, admins and users can consent, any display text. This is the scope
   Claude's sign-in requests; the relay validates every inbound token against it.
3. **Token version** — Manifest: `requestedAccessTokenVersion: 2` (v2 tokens; the relay rejects v1).
4. **API permissions** — Microsoft Graph, **delegated**, exactly the scopes you will set in
   `MS365_MCP_ALLOWED_SCOPES` (default: `User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite
   Contacts.ReadWrite MailboxSettings.ReadWrite Files.ReadWrite`) plus `offline_access`.
   Work tenant: **Grant admin consent** so users are not asked individually.
5. **Credential** — Certificates & secrets → new client secret (note the expiry; rotate before it).
   The relay reads it as `MS365_MCP_CLIENT_SECRET`. Production: prefer a certificate credential.
6. **Who may sign in** — Enterprise applications → your app → Properties → *Assignment required:
   Yes*, then assign the users or a group. Conditional Access and MFA apply unchanged.

Collect for the deployment: the **client id** (`MS365_MCP_CLIENT_ID`), the **tenant id**
(`MS365_MCP_TENANT_ID`; `consumers` for personal accounts) and the secret.

**Changing scopes later:** add the delegated permission here, grant admin consent, add the scope to
`MS365_MCP_ALLOWED_SCOPES`, restart the relay. Users re-consent at their next sign-in.
