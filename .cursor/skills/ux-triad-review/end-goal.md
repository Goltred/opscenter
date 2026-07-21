# A3Panel end-goal (reviewer reference)

## Product

In-house control panel for Arma 3 dedicated servers on Windows hosts (home/NAT or VPS).

- **Panel** = brain and UX (auth, hosts, instances, profiles, mods, jobs)
- **Agent** = outbound worker on each game host (processes, files, SteamCMD jobs)
- Host **online** = agent connected

## Core operator journeys

1. **Add / set up a host** — Agent setup wizard → package → run agent → Verify host (check summary)
2. **Get Arma installed** — Verify host / Mods & server → Install (Creator DLC when needed)
3. **Download mods** — Mods & server → workshop link or ID (not a raw SteamCMD console)
4. **Configure & apply a mission** — Profiles → Apply on instance (host tools stay on Dashboard host)
5. **Run local or remote headless** — local HCs on instance; HC groups on host for cross-host; reachable address only when machines differ

## UX bar (pass/fail)

| Pass | Fail |
|------|------|
| Action labels are outcomes | Primary UI branded as SteamCMD / prepare / bootstrap jargon |
| Host tools on host card | Host files / mod-server tools beside Apply profile |
| Wizard is the setup path | Duplicate prepare/verify primary actions |
| Help text in one short plain sentence | Flag dumps, agent.json field names in primary help |
| Status then action | Alert-only results with no checklist |
| Empty optional fields explained simply | Reachable address / shared mods unexplained |

## Non-goals for UX passes

- Redesigning auth/RBAC unless the finding is label confusion
- Replacing the agent protocol
- Full SteamCMD uninstall product (file delete via Browse files is OK to mention)
