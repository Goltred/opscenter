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
deploy/          env files + run/install scripts
docs/            Setup / security notes
```

## Getting started

Prerequisites: **Node.js 20+**, **.NET 8 SDK** (for the agent).

```powershell
npm start
```

Open **http://localhost:8080**

Configure OAuth in `deploy/control-plane.env` (see `docs/SETUP.md`). Put your identity in `A3P_BOOTSTRAP_OWNERS` (e.g. `discord:YOUR_ID`), then sign in with that provider to become Owner. Other users wait for approval under **Admin → Users**.

### Register a host (outbound agent)

1. Dashboard → **Add host** → generate enroll token.
2. Copy the shown `agent.json` snippet onto the game host (`agent-csharp/agent.json`).
3. Run `deploy\install-agent.ps1 -Config ...\agent.json -Build`.
4. When the agent dials the panel gateway (`A3P_AGENT_ADDR`, default `:8443`), the host card flips to **agent connected**.

Gateway URL in `agent.json`: `ws://PANEL_IP:8443/agent/connect`.

### Hot-reload UI

```powershell
npm run dev
```

Vite on **http://localhost:5173** (proxies `/api` to `:8080`).

## Notes

- SQLite defaults to `deploy/a3panel.sqlite`.
- **Prepare host** (Dashboard) asks the agent to check SteamCMD, create folder layout, and report Arma install status.
