# A3Panel

Self-hosted control panel for **Arma 3 dedicated servers** — multiple Windows hosts (home/NAT or VPS), outbound agents, mission profiles, mods, and headless clients. Built for operators who are not SteamCMD experts.

AMP-style. Fully in-house. Open source.

## Built as an example of vibe coding

This repository is a working product **and** a concrete example of what vibe coding could yield on a very specific usage. I am a firm believer that service offerings will change over time due to AI, and this is my research in the area.

The idea of this code base is not to see how efficient or inneficient models are at coding (we kind of already know they can do great things in a sloppy manner), and rather how good it was to provide a product for a specific idea, without
worrying about how accurate or performant the code is (i've got my daily job for that). I approached this from a different angle: "What if I forget about coding and treat this as an AI-only contributor model". I believe it might prove to
be faster to trust agents to understand the codebase at record-time and be able to add new features or fix issues, instead of reviewing all the code that was written and bring it to "our" good practices and well established patterns.

My main role in this was that of stakeholder and tester. I provided an idea, verified the results in the final product, and sent it back to refinement.

This codebase was built over many days, but I think I did not spend more than one hour a day on it (or maybe less, i've got family and chores so i did not chat with my agent every single day). When I was working on this I was usually side-tracked
by a game or something, so i sent a prompt (or sometimes a chain of ideas) and let the agent work while I played games.

Built primarily in [Cursor](https://cursor.com) with agent workflows, persistent project rules, and skills — not a one-shot paste into a demo toy.


## Architecture

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
- **Web UI** (React + TypeScript): dashboard, setup wizards, mods & server tools, mission profiles.
- **Host agent** (.NET 8): outbound session; instance control; file/Steam jobs; host verify/bootstrap.

## Repository layout

```
server/          Node.js + TypeScript control plane (Express + SQLite)
web/             React + TypeScript SPA (Vite)
agent-csharp/    .NET 8 host agent (outbound client)
scripts/         npm start / npm run dev helpers
deploy/          env files + install-panel.ps1
docs/            Install + setup / security notes
.cursor/         Rules and skills used while building this project
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
- Host onboarding is the **Agent setup** wizard — one guided path.
- Operational guide (mods, profiles, headless): **[docs/SETUP.md](docs/SETUP.md)**.

## License

[MIT](LICENSE) © 2026 Goltred
