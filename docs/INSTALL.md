# OpsCenter — install the control plane

This guide gets the **panel** (Node API + web UI) running on one machine. Game hosts use a separate **agent** — you add those from the panel after sign-in.

**Quick path:** from the repo root in PowerShell:

```powershell
.\deploy\install-opscenter.ps1
```

**Manual path:** follow the sections below if you prefer step-by-step control or are not on Windows.

---

## What you need

| Requirement | Panel machine | Game host (later) |
|-------------|---------------|-------------------|
| OS | Windows (script) or any OS with Node 20+ | **Windows** |
| Node.js | 20+ | — |
| .NET 8 SDK | Recommended (builds the host agent) | — |
| OAuth app | At least one (Discord, Google, …) | — |
| Steam account | Saved in panel UI (any account can pull the dedicated server; **owns Arma 3** for Workshop mods) | — |
| SteamCMD | — | Installed on the game host (see below) |

**Networking:** game hosts dial **out** to the panel. You do **not** need inbound ports on home game PCs. The **panel** must accept:

- HTTP (default **8080**) for the browser UI / API  
- Agent WebSocket (default **8443**) from each game host  

Same machine for panel + game: `localhost` is fine. Panel on a VPS and game PC at home: set `OC_PUBLIC_URL` to the VPS hostname/IP and open **8443** (and HTTPS if you terminate TLS) toward the agents.

The panel uses **SQLite** (no separate database install).

---

## Create an OAuth app (required)

The panel has **no local passwords**. Pick one provider and register a redirect URI:

```text
{OC_PUBLIC_URL}/api/auth/oauth/{provider}/callback
```

Example for local install + Discord:

```text
http://localhost:8080/api/auth/oauth/discord/callback
```

### Discord (typical)

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **OAuth2** → add the redirect URI above
3. Copy **Client ID** and **Client Secret** into `deploy/control-plane.env`
4. Enable Discord **Developer Mode** (Settings → Advanced), right-click your avatar → **Copy User ID**
5. Set `OC_BOOTSTRAP_OWNERS=discord:YOUR_USER_ID` so your first sign-in becomes **Owner**

Google / Microsoft work the same idea: create an OAuth client, add the matching callback path (`…/google/callback` or `…/microsoft/callback`), paste ID/secret, and use `google:…` / `microsoft:…` in the bootstrap list as documented by each provider’s subject id.

If bootstrap is wrong or empty, every account stays **pending** and nobody can approve anyone — fix the env and restart the panel.

---

## Option A — One-click install (Windows)

```powershell
git clone https://github.com/Goltred/opscenter.git OpsCenter
cd OpsCenter
.\deploy\install-opscenter.ps1
```

The script will:

1. Check **Node.js 20+** (offer `winget` install if missing)
2. Install npm dependencies for `server/` and `web/`
3. Create `deploy/control-plane.env` from the example if missing
4. Generate **`OC_SECRETS_KEY`** if unset
5. Prompt for **panel URL**, **OAuth provider**, and **bootstrap Owner** identity
6. **Build** the host agent into `agent-csharp/publish/` (or unpack a zip you pass in)
7. Start the panel and open **http://localhost:8080**

### Host agent binary

| Approach | When to use |
|----------|-------------|
| **Build** (default) | Fresh clone with .NET 8 SDK — `install-opscenter.ps1` runs `dotnet publish` |
| **Pre-built zip** (optional) | You already have an `opscenter-agent` zip from a teammate, CI artifact, or a later project release |

```powershell
.\deploy\install-opscenter.ps1 -AgentZip C:\path\to\opscenter-agent.zip
```

Or extract manually so `agent-csharp/publish/opscenter-agent.exe` exists, or set `OC_AGENT_DIST_DIR` in `deploy/control-plane.env`.

> Official downloadable release zips may appear later. Until then, **building from source is the supported path**.

### Other flags

```powershell
.\deploy\install-opscenter.ps1 -NoStart          # configure only; start yourself with npm start
.\deploy\install-opscenter.ps1 -SkipAgent        # panel only; add agent binary later
.\deploy\install-opscenter.ps1 -NonInteractive   # use existing control-plane.env only
```

---

## Option B — Manual install

### 1. Clone and install dependencies

```powershell
git clone https://github.com/Goltred/opscenter.git OpsCenter
cd OpsCenter
npm run install:all
```

### 2. Configure environment

```powershell
copy deploy\control-plane.env.example deploy\control-plane.env
```

Edit `deploy/control-plane.env`. Minimum for first login:

```env
OC_PUBLIC_URL=http://localhost:8080
OC_HTTP_ADDR=:8080
OC_WEB_ORIGIN=http://localhost:8080
OC_DEV_MODE=true

# First Owner — provider:subject (see OAuth section above)
OC_BOOTSTRAP_OWNERS=discord:YOUR_DISCORD_USER_ID

# At least one OAuth provider, e.g. Discord:
OC_OAUTH_DISCORD_CLIENT_ID=...
OC_OAUTH_DISCORD_CLIENT_SECRET=...
```

### 3. Host agent package (required before adding hosts)

The panel serves a zip download per host. The binary must exist on the **panel machine**:

```powershell
cd agent-csharp
dotnet publish -c Release -o publish
cd ..
```

Or place a pre-built `opscenter-agent.exe` (and dependencies) under `agent-csharp/publish/`, or set:

```env
OC_AGENT_DIST_DIR=C:\path\to\folder\with\opscenter-agent.exe
```

### 4. Start the panel

```powershell
npm start
```

Open **http://localhost:8080**, sign in with the provider you configured. If your identity matches `OC_BOOTSTRAP_OWNERS`, you become **Owner** immediately.

### 5. First-run setup wizard

After sign-in, the panel opens the **setup wizard** (or go to `/setup`). It walks through:

1. Confirm the agent package is available  
2. Sign-in / Owner allowlist  
3. Panel and agent gateway URLs  
4. Save a **Steam account** (for Arma install and mods)  
5. **Add your first host** (agent package → game machine → verify)

Skip moves to the next step; on the last step, skip leaves the dashboard without finishing. After you have at least one host entry, the panel stops forcing the wizard.

---

## Game host prerequisites (before Verify)

On each **Windows game host**:

1. Install **[SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD)** (Valve) and note the path to `steamcmd.exe` (often `C:\steamcmd\steamcmd.exe`)
2. Enter that path in Agent setup → Host settings  
3. Use a Steam account saved under Admin → Steam or in the setup wizard. **Workshop mods** need an account that **owns Arma 3**; installing the dedicated server package alone does not.  
4. If Steam Guard prompts on first download, complete it on the host when the job asks — the panel shows whether Guard is cached afterward  

Verify / Apply can install the dedicated server under your Arma root when it is missing; SteamCMD itself must already be present.

---

## Verify the install

| Check | How |
|-------|-----|
| Panel API | `http://localhost:8080/healthz` → `{"ok":true}` |
| Sign-in | OAuth buttons on login page |
| Owner | You reach the dashboard (not “pending approval”) |
| Agent package | Setup wizard step “Panel ready” shows OK |
| First host | Dashboard host card shows **agent connected** |

---

## Production notes

- Set `OC_PUBLIC_URL` to the URL operators and **agents** actually use (hostname/IP, not `localhost`, if hosts are remote).
- Set **`OC_DEV_MODE=false`** outside local development (installer defaults to `true` for convenience).
- Serve the panel over **HTTPS** when exposed beyond a trusted LAN (reverse proxy; `deploy/Caddyfile` is a starting point for HTTP `:8080` — extend for agent/`wss` as needed).
- Prefer **`wss://`** for the agent gateway when using HTTPS (`OC_PUBLIC_URL` drives the scheme in downloaded agent configs). Default code speaks plaintext `ws://` — see [SECURITY.md](SECURITY.md).
- Keep `deploy/control-plane.env` out of git (already gitignored).

Day-to-day operations (hosts, mods, profiles, headless) are in **[SETUP.md](SETUP.md)**.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No OAuth providers on login | Set client ID/secret in `control-plane.env`, restart panel |
| Stuck on pending approval | Add your `provider:subject` to `OC_BOOTSTRAP_OWNERS`, restart, sign in again. If nobody is Owner yet, only the env can unblock you. |
| OAuth redirect mismatch | Callback URL in the provider app must exactly match `OC_PUBLIC_URL` + `/api/auth/oauth/{provider}/callback` |
| Agent package unavailable | Run `dotnet publish` in `agent-csharp` (or supply `-AgentZip`) |
| Agent never connects | Panel firewall: allow **inbound** agent port **8443**. On the game host, check the gateway URL in `agent.json` — if it says `localhost` but the panel is elsewhere, fix `OC_PUBLIC_URL` and download a new package. |
| Verify can’t find SteamCMD | Install SteamCMD on the **game** host and set the path in Agent setup |

---

## File reference

| Path | Purpose |
|------|---------|
| `deploy/install-opscenter.ps1` | One-click Windows installer |
| `deploy/control-plane.env` | Panel configuration (create from `.example`) |
| `scripts/start.mjs` | Load env, build UI, start API+SPA (`npm start`) |
| `agent-csharp/publish/` | Default folder for host agent binary |
| `docs/INDEX.md` | Map of install vs setup vs security docs |
| `docs/SETUP.md` | Day-to-day operations after install |
| `docs/SECURITY.md` | Threat model and hardening (current stack) |
| `SECURITY.md` (repo root) | How to report vulnerabilities |
