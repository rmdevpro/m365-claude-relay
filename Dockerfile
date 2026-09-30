# M365 relay, OBO deployment (m365-claude-relay): OTS Softeria ms-365-mcp-server (MIT)
# in --http --obo mode behind a minimal gate. Stateless, multi-user.
# Built as a Hugging Face Docker Space (app_port 7860); portable to any
# container host with HTTPS ingress.
#
# Supply chain: digest-pinned base; dependencies installed from the committed
# package-lock.json with `npm ci` (integrity-checked); SBOM in sbom.cdx.json;
# `npm audit` runs in the build and fails on critical advisories.
# Update path: bump the Softeria version in package.json, refresh the lock and
# SBOM (`npm install --package-lock-only && npm sbom ...`), rebuild, rerun .
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm audit --omit=dev --audit-level=critical \
    && npm cache clean --force

COPY gate.js start.sh patch-softeria.js policy.json derive-tools.js ./
# Softeria omits `scope` on code/refresh redemption; personal accounts require
# it (AADSTS70011). Build fails if the patch no longer applies (upstream PR pending).
RUN node patch-softeria.js /app/node_modules/@softeria/ms-365-mcp-server && chmod +x start.sh

# The tool surface, consent scopes and behaviour switches are pinned in
# policy.json (versioned, reviewed). Environment overrides fail startup.

# Stateless posture: no local MSAL cache in --http; OBO token cache in memory;
# Softeria log files on tmpfs; DCR off; redirects restricted to Claude's callback.
# Runtime posture the platform should enforce: read-only root filesystem (the
# service writes only to /dev/shm and /tmp), no-new-privileges, memory limit
# sized with NODE_OPTIONS below (uploads stream in 3.75 MiB chunks).
ENV PORT=7860 \
    UPSTREAM_PORT=3000 \
    NODE_OPTIONS=--max-old-space-size=768 \
    MS365_MCP_TENANT_ID=consumers \
    MS365_MCP_DISABLE_DCR=true \
    MS365_MCP_ALLOWED_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback \
    MS365_MCP_TRUST_PROXY_HOPS=2 \
    MS365_MCP_LOG_DIR=/dev/shm/ms365-logs \
    HOME=/tmp

EXPOSE 7860
USER 1000:1000
CMD ["./start.sh"]
