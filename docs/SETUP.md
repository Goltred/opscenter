# A3Panel Setup Guide

A3Panel has three deployable pieces:

1. **Control plane** (`server/`) — Node.js API + agent gateway + optional static SPA.
2. **Host agent** (`agent-csharp/`) — .NET 8 Windows worker; **dials out** to the gateway (NAT-friendly).
3. **Web UI** (`web/`) — React SPA (served by the control plane or Vite in dev).

## Connection model

Game hosts (home or VPS) run the agent, which opens an **outbound** WebSocket to the panel.
The panel never needs to dial into the agent. A host is **online / agent connected** when that
session is up. Commands (start/stop, SteamCMD, bootstrap, …) ride that session.

## Prerequisites

- Node.js 20+
- .NET 8 SDK (agent hosts only)
- (Per game host) SteamCMD and/or ability for the agent to locate/install it; an Arma 3
  dedicated server tree (or install separately), plus a Steam account that **owns Arma 3**.

## 1. Database

SQLite is embedded. Set `A3P_DATABASE_URL` (default `deploy/a3panel.sqlite`). Schema applies on boot.

## 2. Control plane + UI

```powershell
npm start
```

Or:

```powershell
cd deploy
.\run-server.ps1 -EnvFile .\control-plane.env
```

Env highlights:

- `A3P_PUBLIC_URL` — used for OAuth redirect URIs (`{url}/api/auth/oauth/{provider}/callback`)
- `A3P_BOOTSTRAP_OWNERS` — comma-separated `provider:subject` (e.g. `discord:123…`). Matching logins become **Owner**.
- OAuth client IDs/secrets: `A3P_OAUTH_DISCORD_*`, `A3P_OAUTH_GOOGLE_*`, `A3P_OAUTH_MICROSOFT_*`, `A3P_OAUTH_STEAM=1`, `A3P_OAUTH_EPIC_*`
- `A3P_AGENT_ADDR` (default `:8443`) — agents connect here
- `A3P_SECRETS_KEY` (optional) — encrypts SteamCMD passwords in SQLite

### Authentication

- **No email/password.** Sign-in is OAuth only (Discord, Google, Microsoft, Steam, Epic — whichever you configure).
- New users are created on first login but stay **pending** until an Owner approves them and assigns a role (Admin → Users).
- First Owner: put your identity in `A3P_BOOTSTRAP_OWNERS`, configure at least one provider, sign in.

## 3. Host agent enrollment

1. Dashboard → **Add host** opens the agent setup wizard (same wizard as **Agent setup** on an existing host).
2. **Host settings** creates/saves the host (name, armaRoot, steamCmdPath, …), then continue: Steam → download package → install & run → Start.
3. When connected, the host card shows **agent connected**. Start (or Dashboard Prepare) creates folders and can install the creatordlc dedicated server if missing.

Manual alternative (publish on the panel machine, copy binary yourself):

```powershell
cd agent-csharp
dotnet publish -c Release -o publish
```

Or use `deploy\install-agent.ps1`:

```powershell
cd deploy
.\install-agent.ps1 -Config ..\agent-csharp\agent.json -Build
# optional Windows Service:
.\install-agent.ps1 -Config ..\agent-csharp\agent.json -Build -Service
```

Panel zip downloads from `agent-csharp/publish` (override with `A3P_AGENT_DIST_DIR`).

`controlPlaneUrl` example: `ws://PANEL_IP:8443/agent/connect` (use **`wss://`** in production).

## 4. Steam accounts / SteamCMD / instances

- **Admin → Steam** — add Steam username/password once (encrypted at rest). Required for mod downloads and server install/updates.
- You do **not** need a pre-installed Arma dedicated server. **Prepare host** or **Apply profile** detects a missing `arma3server_x64.exe` / `arma3server.exe` under the configured path and runs `app_update 233780 -beta creatordlc`.
- **Dashboard → host card → Edit** — optional **shared mods library** path (read-only). Supports `{workshopId}` folders and `@ModName` junctions (via `meta.cpp` `publishedid`). The panel/agent **never write into this folder**. On apply, missing mods can be SteamCMD’d into the **local** `{armaRoot}\steamapps\workshop\…` tree; local `armaRoot\mods\` junctions may be created pointing at shared folders. Launch prefers local workshop copies, then shared.
- **Dashboard → host card → SteamCMD** — download mods, update dedicated server, live console.
  - **Update server (Creator DLC)** runs `app_update 233780 -beta creatordlc` so CDLC folders (`vn`, `ws`, …) exist on the host.
- Credentials are sent to the agent **per job** over the agent WebSocket; they are not stored on the host.
- **Mission Profiles** — difficulty (`forcedDifficulty` + Custom → `Users/server/server.Arma3Profile`), Creator DLC checkboxes (`-mod=` codes), workshop mods, mission. Apply expands Steam Workshop **Required items** and **persists** the resolved list on the profile (30-day TTL; cleared when you edit mods). Start/restart reuse that list (no Steam). Optional **Refresh Steam Workshop dependencies** on apply bypasses caches. Set `A3P_OAUTH_STEAM_API_KEY` for batched dep lookups; without it, HTML scrape is a last resort. Mod titles use a 30-day DB cache — Mods → **Refresh titles** to update.
- **Mission Profiles → Shared server.cfg** — passwords, `admins[]`, BattlEye, etc. for the selected instance; profile overrides win. Apply writes `class Missions` from the profile’s selected mission PBO (`template` without `.pbo`).
- **Keys** — on profile apply (and start/restart), `.bikey` files from each loaded workshop mod are copied into `{armaRoot}\keys\` so `verifySignatures` accepts signed client content. Instance page also has **Sync mod keys**.
- **Instance start** uses the loaded profile: `-config=…/server.cfg`, `-name=server`, `-mod=` (DLC codes + paths from the host mods library), `-serverMod=` for server-only mods. Start fails clearly if the dedicated server binary is still missing (run Prepare host first).
- **Headless clients** — **Local:** on the Instance page, set desired same-host HC count (0–8). **Remote / dedicated HC hosts:** Dashboard → host card → **Add headless group** (compact card: name, target instance, start/stop/restart). Cross-host needs a <strong>Reachable address</strong> on Edit host (game host = connect target; worker host = allowlist source IP). Panel syncs `headlessClients[]` automatically for managed groups. Missions must transfer AI to HCs; the panel only runs the processes. Profiles may store an optional **recommended** local HC count (Apply can optionally match it).
- Official BI content (Contact, Apex, …) does **not** use a `-mod=` code; it comes with the dedicated server / creatordlc install. Players still need ownership where Steam requires it.
- **Modlists** — import Arma Launcher `modlist.html`, attach on Mission Profiles.
- **Dashboard / Instance** — start/stop/restart via the connected agent.

## Security

- One-time enroll token, then host id identity on the WS session.
- Panel RBAC before every dispatch; agent accepts only the typed op catalog.
- OAuth-only panel login; Owners via `A3P_BOOTSTRAP_OWNERS`; new users pending until approved.
- SteamCMD passwords encrypted at rest (`A3P_SECRETS_KEY` / `.a3p_secrets_key`); prefer TLS (`wss://`) on the agent gateway in production.
- Prefer TLS on the panel HTTP front in production; plaintext WS is for local/dev only.
