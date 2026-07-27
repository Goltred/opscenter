# A3Panel — In-House Arma 3 Multi-Server Management Panel

A secure, self-hosted control panel for managing multiple Arma 3 dedicated servers
running on separate Windows hosts (home/NAT **or** VPS). AMP-style, fully in-house.

## Architecture (mixed hosts)

```
Browser  →  Panel (Node)  ←── outbound WebSocket ──  C# Agent (each game host)
                 │                                         │
              SQLite / UI                          SteamCMD + Arma files
```

- **Panel** = brain and UX: users, RBAC, hosts, instances, modlists, profiles, jobs.
- **Agent** = hands on the metal: dials **out** to the panel (works behind NAT), runs typed ops only.
- Host card **online** means **agent connected**, not “panel reached an agent URL.”
- Do **not** open inbound admin ports on home hosts by default.

## Highlights

- **Control plane** (Node.js + TypeScript): web API, auth, RBAC, SQLite, agent WebSocket hub.
- **Web UI** (React + TypeScript): dashboard host cards, modlists, SteamCMD console.
- **Host agent** (C#): outbound session; instance start/stop/restart; config apply; SteamCMD; host prepare/bootstrap.

## Repository layout

```
server/          Node.js + TypeScript control plane (Express + SQLite)
web/             React + TypeScript SPA (Vite)
agent-csharp/    .NET 8 host agent (outbound client)
scripts/         npm start / npm run dev helpers
deploy/          env files + install/run scripts
docs/            Install + setup / security notes
```

## Getting started

**New install:** see **[docs/INSTALL.md](docs/INSTALL.md)** for the full guide.

### Quick install (Windows)

Prerequisites: **Node.js 20+**. .NET 8 SDK is needed only if you build the agent locally (the installer can use a pre-built agent zip instead).

```powershell
.\deploy\install-panel.ps1
```

This installs dependencies, creates `deploy/control-plane.env`, builds or unpacks the host agent, and starts the panel at **http://localhost:8080**.

Pre-built agent only (no SDK):

```powershell
.\deploy\install-panel.ps1 -AgentZip C:\path\to\a3panel-agent.zip
```

### Manual start (after config)

```powershell
npm start
```

Sign in with OAuth. Put your identity in `A3P_BOOTSTRAP_OWNERS` (e.g. `discord:YOUR_ID`) so the first login becomes Owner — see `docs/INSTALL.md`.

### First-run setup wizard

After sign-in, the panel opens **Panel setup** (`/setup`): confirm the agent package, save a Steam account, then **Add your first host** (same flow as Dashboard → Add host). Skip anytime; the wizard returns until setup is complete or dismissed.

### Register a game host

1. Dashboard → **Add host** (or continue from the setup wizard).
2. Follow **Agent setup**: host paths → Steam account → download package → run on game machine → **Verify**.
3. When the agent dials the panel gateway (default port **8443**), the host card shows **agent connected**.

### Hot-reload UI

```powershell
npm run dev
```

Vite on **http://localhost:5173** (proxies `/api` to `:8080`).

## Notes

- SQLite defaults to `deploy/a3panel.sqlite`.
- Host onboarding is the **Agent setup** wizard — one guided path, no duplicate prepare buttons.
- Operational guide (mods, profiles, headless): **[docs/SETUP.md](docs/SETUP.md)**.
