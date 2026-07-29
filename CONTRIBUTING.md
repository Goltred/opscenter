# Contributing

Thanks for your interest in OpsCenter. This repo is intentionally small and product-focused. Be mindful that the repository is intentionally "left to its fate", this was fully vibe-coded and the intent is to be able to use it as-is. 
Updates with coding agents are encouraged, they will be reviewed by me personally for now  (since I want to keep control and is also the other part of the learning experience). I will probably end up using an agent for it in the future as well.

## Development setup

1. Node.js **20+**
2. .NET **8** SDK (to build the host agent)
3. Copy `deploy/control-plane.env.example` → `deploy/control-plane.env`, set `OC_BOOTSTRAP_OWNERS`, and configure a sign-in provider via the installer / `oauth-bootstrap.json` or Admin → Sign-in (see [docs/INSTALL.md](docs/INSTALL.md); doc map: [docs/INDEX.md](docs/INDEX.md))

```powershell
npm run install:all
cd agent-csharp
dotnet publish -c Release -o publish
cd ..
npm run dev
```

- Panel API: `http://localhost:8080`
- Vite UI (hot reload): `http://localhost:5173`
- Agent gateway (default): port **8443**

## Pull requests

- Prefer small, reviewable diffs that match existing patterns in `web/src`, `server/src`, and `agent-csharp/`
- Keep UI copy outcome-oriented (see `.cursor/rules/OpsCenter-product-goal.mdc`) — avoid branding primary actions as “SteamCMD” unless the surface is a technical log
- Do not commit `deploy/control-plane.env`, SQLite DBs, secrets keys, or `agent-csharp/publish/`
- Say how you verified (panel refresh, agent reconnect, which wizard step)

## Agent binary

Day-to-day: `dotnet publish -c Release -o publish` from `agent-csharp/`. That folder is what the panel zips for host downloads.

Pre-built zips are optional for operators who already have a binary; shipping GitHub Release assets is a separate maintainer step after the repo is public — not required to develop or contribute.
