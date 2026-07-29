# OpsCenter

Self-hosted control panel for **dedicated game servers** — multiple Windows hosts (home/NAT or VPS), outbound agents, mission profiles, mods, schedules, and headless clients. Built for operators who should not need to live in SteamCMD.

**Today:** Arma 3 dedicated. **Planned:** more titles (e.g. Reforger, Arma 4).

Fully in-house. Open source (MIT).

> **Not affiliated** with Bohemia Interactive, Valve, or Steam. Game titles, Steam, and SteamCMD are trademarks of their respective owners. “AMP-style” here only means a self-hosted game-server panel with remote agents — not CubeCoders AMP or any other commercial product.

## Architecture

```
Browser  →  Panel (Node)  ←── outbound WebSocket ──  C# Agent (each game host)
                 │                                         │
              SQLite / UI                          host tools + game files
```

- **Panel** = brain and UX: users, RBAC, hosts, instances, modlists, profiles, jobs.
- **Agent** = hands on the metal: dials **out** to the panel (works behind NAT), runs typed ops only.
- Host card **online** means **agent connected**, not “panel reached an agent URL.”
- Do **not** open inbound admin ports on home **game** hosts by default. The **panel** machine must accept the agent connection (default port **8443**).

## Highlights

- **Control plane** (Node.js + TypeScript): web API, auth, RBAC, SQLite, agent WebSocket hub.
- **Web UI** (React + TypeScript): dashboard, setup wizards, mods & server tools, mission profiles.
- **Host agent** (.NET 8): outbound session; instance control; file/Steam jobs; host verify/bootstrap.

## Repository layout

```
server/          Node.js + TypeScript control plane (Express + SQLite)
web/             React + TypeScript SPA (Vite)
agent-csharp/    .NET 8 host agent (outbound client)
scripts/         npm start / npm run dev helpers
deploy/          env files + install-opscenter.ps1
docs/            Install, day-to-day setup, security notes (see docs/README.md)
.cursor/         Rules and skills used while building this project
```

## Getting started

Full guide: **[docs/INSTALL.md](docs/INSTALL.md)**. Contributing: **[CONTRIBUTING.md](CONTRIBUTING.md)**. Doc map: **[docs/README.md](docs/README.md)**.

Repo: [github.com/Goltred/opscenter](https://github.com/Goltred/opscenter)

### Quick install (Windows)

Prerequisites: **Node.js 20+**. **.NET 8 SDK** to build the host agent on the panel machine (recommended for a fresh clone).

```powershell
.\deploy\install-opscenter.ps1
```

This installs dependencies, creates `deploy/control-plane.env`, builds the host agent, and starts the panel at **http://localhost:8080**.

If you already have a pre-built agent zip (from a teammate or a later release):

```powershell
.\deploy\install-opscenter.ps1 -AgentZip C:\path\to\opscenter-agent.zip
```

### Manual start (after config)

```powershell
npm start
```

Sign in with OAuth. Put your identity in `OC_BOOTSTRAP_OWNERS` (e.g. `discord:YOUR_ID`) so the first login becomes Owner — see `docs/INSTALL.md`.

### First-run setup wizard

After sign-in, the panel opens **Panel setup** (`/setup`): confirm the agent package, save a Steam account, then **Add your first host**. You can skip steps; on the last step, skip leaves the dashboard without finishing setup.

### Register a game host

1. Dashboard → **Add host** (or continue from the setup wizard).
2. Follow **Agent setup**: host paths → Steam account → download package → run on game machine → **Verify**.
3. When the agent dials the panel gateway (default port **8443**), the host card shows **agent connected**.

If the game host is **not** the same machine as the panel, set `OC_PUBLIC_URL` to a hostname or IP the game host can reach — not `http://localhost:8080`.

### Hot-reload UI

```powershell
npm run dev
```

Vite on **http://localhost:5173** (proxies `/api` to `:8080`).

## Notes

- SQLite defaults to `deploy/opscenter.sqlite`.
- Host onboarding is the **Agent setup** wizard — one guided path.
- Day-to-day ops: **[docs/SETUP.md](docs/SETUP.md)**. Security: **[docs/SECURITY.md](docs/SECURITY.md)**.

## Built with AI-assisted development

This repo is a working product and an example of steering agents toward a real operator tool (Cursor rules/skills under `.cursor/`). Stakeholder testing mattered more than polishing every line by hand — see the history if you are curious; install docs above are the path for operators.

## License

[MIT](LICENSE) © 2026 Goltred
