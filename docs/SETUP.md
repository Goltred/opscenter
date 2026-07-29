# OpsCenter setup (day-to-day)

**Installing the panel for the first time?** Use **[INSTALL.md](INSTALL.md)** — OAuth, Owner bootstrap, agent binary, networking, and the first-run wizard live there.

This guide is for **after** the panel is running and at least one host can connect.

## Typical flow

1. Host agent connected (INSTALL / Agent setup → **Verify**)
2. **Add instance** on the Dashboard host card
3. Add mods to the **Mods** library; download files via host **Mods & server**
4. Create a **Mission Profile** (and optional difficulty / mission / modlist)
5. **Apply** the profile to the instance, then start from Dashboard or the instance page

---

## Hosts and instances

### Hosts

- **Dashboard → Add host** (or Agent setup on an existing host) — paths, Steam account, download package, run agent, **Verify**.
- Host card **online** = agent connected.
- **Edit host** — Arma root, SteamCMD path, optional shared mods folder, optional **Reachable address** (only needed for cross-host headless; see below).
- Rebuild the panel-side agent binary when you change agent code: see INSTALL (or `dotnet publish` in `agent-csharp/`).

### Instances

An **instance** is one dedicated-server process (port + profile dir) on a host.

1. On the Dashboard host card, use **Add instance** (name + game port).
2. Open the instance from the host card or `/instances/:id`.
3. Start / stop / restart from the Dashboard or the instance page (agent must be online).
4. Apply a Mission Profile before the first useful start so config, mods, and mission are in place.

### Browse files

Dashboard host card → **Browse files** — navigate and delete under the host Arma root (and related roots the agent allows). There is no Steam “uninstall mod” button; remove files here if you need to clear an install.

---

## Mods: library vs host files

| Surface | Job |
|---------|-----|
| **Mods** (nav) | Panel **library** — workshop IDs/titles you attach to profiles and modlists |
| **Modlists** | Import Arma Launcher `modlist.html`; attach on Mission Profiles |
| **Dashboard → host → Mods & server** | Download/update files **on that host**, update dedicated server (Creator DLC), live job console |

Workflow: add entries under **Mods** (search or workshop ID) → on the host, open **Mods & server** to download what the host is missing → attach mods on a profile → **Apply**.

Steam account: **Admin → Steam** (encrypted on the panel; sent to the agent per job only). Workshop mods need an account that owns Arma 3; the dedicated server package does not. Prefer `wss://` outside a trusted LAN — see [SECURITY.md](SECURITY.md).

Steam Web API key (same Admin → Steam page, or optional `OC_OAUTH_STEAM_API_KEY`): not a Steam login — improves workshop titles and required-item deps. Without it, modlists may show IDs/URLs instead of names.

Shared mods folder (Edit host): read-only library the agent never writes into. Missing mods download into the host’s local workshop tree under Arma root.

---

## Missions, difficulties, profiles

- **Missions** — upload / manage mission PBOs used by profiles.
- **Difficulties** — reusable difficulty presets; Custom writes `Users/server/server.Arma3Profile` on apply.
- **Mission Profiles** — difficulty, Creator DLC checkboxes, workshop mods, mission, optional recommended local HC count.
  - **Apply** on an instance expands Workshop required items when needed and writes server.cfg / keys.
  - Start/restart reuse a persisted resolved mod list when present; optional **Refresh Steam Workshop dependencies** on apply.
  - Better dependency lookups: Admin → Steam → **Steam Web API key**, or `OC_OAUTH_STEAM_API_KEY` in `control-plane.env`.
  - Mod titles: Mods → **Refresh titles**.
- **Shared server.cfg** (on Profiles) — passwords, admins, BattlEye, etc. for the selected instance; profile overrides win.
- **Keys** — on apply/start, `.bikey` files from loaded workshop mods copy into `{armaRoot}\keys\`. Instance page: **Sync mod keys**. Extra keys: Mods → Signature keys → **Push signature keys** on the instance.

Official BI content (Contact, Apex, …) does not need a separate `-mod=` code; it comes with the dedicated / Creator DLC install. Players still need ownership where Steam requires it.

If the dedicated server binary is missing under Arma root, **Verify host** or **Apply profile** can install Steam’s Creator DLC dedicated branch (SteamCMD must already be on the game host).

---

## Headless clients

- **Same machine:** Instance page → local HC count (0–8).
- **Other machines:** Dashboard host card → **Add headless group** (name, target instance, start/stop/restart).
- **Reachable address** (Edit host) — only when the HC and dedicated server are on **different** hosts (game host = connect target; worker host = allowlist source IP). Same-host HCs do not need it.
- Missions must transfer AI to HCs; the panel only runs the processes.

---

## Schedules

**Schedules** (nav) — apply a mission profile and start an instance at a chosen time. Confirm within the window shown in the UI (stand down / finish as needed).

Optional Discord channel / requester IDs on a schedule work with **Admin → Discord** (bot). Panel Discord **login** is separate from the ops bot.

---

## Admin: users, roles, Steam, Discord

- **Users** — approve pending OAuth accounts, disable, assign roles. First Owner comes from `OC_BOOTSTRAP_OWNERS` (INSTALL).
- **Roles** — granular permissions (`host.add`, `instance.control`, `schedule.*`, …), optionally scoped to a host or instance.
- **Steam** — login accounts for installs/downloads; optional Web API key for workshop titles/deps; Guard cache status after first successful Guard on the host.
- **Discord** — optional bot for schedule reminders and slash commands (`/help` in Discord lists them). Configure token, guild, channels under Admin → Discord.
- **Audit** — who did what in the panel.

---

## Security (pointer)

Operational model and hardening checklist: **[SECURITY.md](SECURITY.md)**.  
Vulnerability reports: root **[SECURITY.md](../SECURITY.md)**.
