# OpsCenter security notes

Honest current state for operators and reviewers. This is **not** a claim of enterprise hardening.

OpsCenter controls real game hosts. Treat the panel machine and agent gateway as sensitive.

## What is true today

| Area | Reality |
|------|---------|
| Panel login | **OAuth only** (no local password). New users stay pending until an Owner approves them. |
| First Owner | `OC_BOOTSTRAP_OWNERS` allowlist (`provider:subject`) |
| Sessions | Random tokens; hash stored; cookies `HttpOnly` / `SameSite=Lax`; `Secure` when `OC_DEV_MODE=false` |
| CSRF | Double-submit token on mutating API calls |
| RBAC | Server-side permission checks before API work and before agent dispatch |
| Steam secrets | Encrypted at rest (`OC_SECRETS_KEY`); sent to the agent **per job** over the agent WebSocket — never stored in the host package |
| Agent ops | Fixed typed operation catalog — no arbitrary shell from the panel |
| Game hosts | Agent **dials out**; you do not need inbound admin ports on home game PCs |
| Audit | Actions are recorded in the panel audit log |
| CI | Typecheck / web build / agent build / gitleaks (see `.github/workflows/ci.yml`) |

## Agent transport (important)

The default agent gateway is a **plaintext WebSocket** (`ws://`) on `OC_AGENT_ADDR` (default **:8443**).

- Identity is `X-Host-Id` plus a **one-time enroll token** on first connect; afterward the host id is enough to reattach on that channel
- There is **no mTLS** and no client-certificate pinning in the current Node gateway
- Steam credentials for install/mod jobs travel on that same WebSocket

**Recommendation:**

- **Dev / same LAN / trusted network:** plaintext `ws://` is acceptable if you understand the risk
- **Anything reachable beyond a trusted network:** terminate TLS in front of the panel and agent gateway and use **`wss://`** (set `OC_PUBLIC_URL` to `https://…` so downloaded `agent.json` picks the secure scheme). See production notes in [INSTALL.md](INSTALL.md)

Do not expose port **8443** to the whole internet without TLS and a clear access plan.

## Panel HTTP

- Installer / local defaults set `OC_DEV_MODE=true` (convenient cookies/CORS for local Vite)
- For production: `OC_DEV_MODE=false`, HTTPS on the panel URL, reverse proxy as needed (`deploy/Caddyfile` is a starting point for **HTTP :8080** only — extend it for the agent port / `wss` if you terminate TLS there)

## Uploads

Mission / key / config uploads use extension allow-lists and basic structural checks. Treat uploaded content as untrusted; review missions from unknown authors.

## Hardening checklist (operators)

- [ ] `OC_DEV_MODE=false` in production
- [ ] `OC_PUBLIC_URL` is the URL browsers and agents actually use (not `localhost` if hosts are remote)
- [ ] OAuth redirect URIs match that URL exactly
- [ ] `OC_BOOTSTRAP_OWNERS` set; Owner accounts reviewed under Admin → Users
- [ ] `deploy/control-plane.env`, SQLite DB, and secrets key stay off git and backups you do not trust
- [ ] Firewall: panel **8080** (or your HTTPS front) and **8443** reachable from agents; game hosts need outbound only
- [ ] Prefer `https` + `wss` when the panel leaves a trusted LAN

## Deferred / not claimed

These may appear in older notes or wishlists — they are **not** implemented as described here:

- Mutual TLS with per-agent client certificates
- Built-in login rate limiting / security header suite as a finished product feature
- Sandboxed PBO malware scanning pipeline

Vulnerability reports: see root **[SECURITY.md](../SECURITY.md)**.
