# A3Panel — install the control plane

This guide gets the **panel** (Node API + web UI) running on one machine. Game hosts use a separate **agent** — you add those from the panel after sign-in.

**Quick path:** from the repo root in PowerShell:

```powershell
.\deploy\install-panel.ps1
```

**Manual path:** follow the sections below if you prefer step-by-step control or are not on Windows.

---

## What you need

| Requirement | Panel machine | Game host (later) |
|-------------|---------------|-------------------|
| OS | Windows (script) or any OS with Node 20+ | Windows |
| Node.js | 20+ | — |
| .NET 8 SDK | Only if you **build** the agent locally | — |
| OAuth app | At least one (Discord, Google, …) | — |
| Steam account | Saved in panel UI (owns Arma 3) | — |

The panel uses **SQLite** (no separate database install). The agent dials **out** to the panel on port **8443** by default.

---

## Option A — One-click install (Windows)

```powershell
git clone <your-repo-url> A3Panel
cd A3Panel
.\deploy\install-panel.ps1
```

The script will:

1. Check **Node.js 20+** (offer `winget` install if missing)
2. Install npm dependencies for `server/` and `web/`
3. Create `deploy/control-plane.env` from the example if missing
4. Generate **`A3P_SECRETS_KEY`** if unset
5. Prompt for **panel URL**, **OAuth provider**, and **bootstrap Owner** identity
6. **Build or unpack** the host agent into `agent-csharp/publish/`
7. Start the panel and open **http://localhost:8080**

### Agent binary: build vs pre-built

| Approach | When to use |
|----------|-------------|
| **Build** (default) | You cloned the repo and have .NET 8 SDK — `install-panel.ps1` runs `dotnet publish` |
| **Pre-built zip** | Download `a3panel-agent-*.zip` from GitHub Releases (or CI artifacts) |

Use a pre-built agent:

```powershell
.\deploy\install-panel.ps1 -AgentZip C:\Downloads\a3panel-agent-win-x64.zip
```

Or extract manually to `agent-csharp/publish/` (must contain `a3panel-agent.exe`), or set `A3P_AGENT_DIST_DIR` in `deploy/control-plane.env`.

### Other flags

```powershell
.\deploy\install-panel.ps1 -NoStart          # configure only; start yourself with npm start
.\deploy\install-panel.ps1 -SkipAgent        # panel only; add agent binary later
.\deploy\install-panel.ps1 -NonInteractive   # use existing control-plane.env only
```

---

## Option B — Manual install

### 1. Clone and install dependencies

```powershell
git clone <your-repo-url> A3Panel
cd A3Panel
npm run install:all
```

### 2. Configure environment

```powershell
copy deploy\control-plane.env.example deploy\control-plane.env
```

Edit `deploy/control-plane.env`. Minimum for first login:

```env
A3P_PUBLIC_URL=http://localhost:8080
A3P_HTTP_ADDR=:8080
A3P_WEB_ORIGIN=http://localhost:8080
A3P_DEV_MODE=true

# First Owner — provider:subject (see below)
A3P_BOOTSTRAP_OWNERS=discord:YOUR_DISCORD_USER_ID

# At least one OAuth provider, e.g. Discord:
A3P_OAUTH_DISCORD_CLIENT_ID=...
A3P_OAUTH_DISCORD_CLIENT_SECRET=...
```

**Finding your Discord user ID:** Discord → Settings → Advanced → Developer Mode → right-click your avatar → Copy User ID → `discord:123456789012345678`.

**OAuth redirect URI** (register in the provider app):

```text
{A3P_PUBLIC_URL}/api/auth/oauth/{provider}/callback
```

Example: `http://localhost:8080/api/auth/oauth/discord/callback`

### 3. Host agent package (required before adding hosts)

The panel serves a zip download per host. The binary must exist on the **panel machine**:

**Build from source:**

```powershell
cd agent-csharp
dotnet publish -c Release -o publish
cd ..
```

**Or** extract a release zip into `agent-csharp/publish/`, or set:

```env
A3P_AGENT_DIST_DIR=C:\path\to\folder\with\a3panel-agent.exe
```

### 4. Start the panel

```powershell
npm start
```

Open **http://localhost:8080**, sign in with the provider you configured. If your identity matches `A3P_BOOTSTRAP_OWNERS`, you become **Owner** immediately.

### 5. First-run setup wizard

After sign-in, the panel opens the **setup wizard** (or go to `/setup`). It walks through:

1. Confirm the agent package is available  
2. Sign-in / Owner allowlist  
3. Panel and agent gateway URLs  
4. Save a **Steam account** (for Arma install and mods)  
5. **Add your first host** (agent package → game machine → verify)

You can skip the wizard and return from the dashboard later; it reappears until setup is complete or dismissed.

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

- Set `A3P_PUBLIC_URL` to your public HTTPS URL (e.g. `https://panel.example.com`).
- Set `A3P_DEV_MODE=false` and serve TLS (reverse proxy or `deploy/Caddyfile` as a starting point).
- Use **`wss://`** for the agent gateway when the panel is on HTTPS (`A3P_PUBLIC_URL` drives the scheme in agent download configs).
- Keep `deploy/control-plane.env` out of git (already gitignored).

Day-to-day operations (hosts, mods, profiles, headless) are in **[SETUP.md](SETUP.md)**.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No OAuth providers on login | Set client ID/secret in `control-plane.env`, restart panel |
| Stuck on pending approval | Add your `provider:subject` to `A3P_BOOTSTRAP_OWNERS`, restart, sign in again |
| Agent package unavailable | Build or copy `a3panel-agent.exe` — see step 3 above |
| OAuth redirect mismatch | Callback URL in provider app must exactly match `A3P_PUBLIC_URL` + `/api/auth/oauth/.../callback` |
| Agent never connects | Firewall: allow **outbound** WS to panel port 8443; check gateway URL in downloaded `agent.json` |

---

## File reference

| Path | Purpose |
|------|---------|
| `deploy/install-panel.ps1` | One-click Windows installer |
| `deploy/control-plane.env` | Panel configuration (create from `.example`) |
| `scripts/start.mjs` | Load env, build UI, start API+SPA (`npm start`) |
| `agent-csharp/publish/` | Default folder for host agent binary |
| `docs/SETUP.md` | Using the panel after install |
