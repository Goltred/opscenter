# A3Panel Security Runbook

Security is the primary design constraint: the panel and its agents control real
game servers on a real network. This document captures the threat model, the
controls in place, the hardening checklist, and the deferred iteration-2 work.

## Threat model

| Asset | Threat | Primary mitigation |
| --- | --- | --- |
| Game hosts | Remote code execution via the panel/agent | No arbitrary-exec agent; fixed typed operation catalog only |
| Agent transport | MITM / impersonation | Mutual TLS, per-agent client certs, cert-fingerprint pinning |
| Panel accounts | Credential theft / session abuse | OAuth-only login, secure sessions, rate limiting |
| Steam / Discord secrets | Disclosure | Encrypted vault (AES-256-GCM), never returned to browser |
| Uploaded files | Malicious payloads | Strict allow-list + structural validation + quarantine; pluggable scanner |
| Privilege escalation | Over-broad access | Granular, per-resource scoped RBAC checked server-side |
| Repudiation | "Who did what?" | Append-only audit log of every action |

## Architecture controls

- **Outbound-only agents.** Agents *dial out* to the control plane and hold a
  persistent stream. No inbound ports are opened on game hosts.
- **No arbitrary execution.** `shared/protocol` defines a closed enum of
  operations. The agent dispatcher rejects anything not in `ValidOps`. There is
  no "run shell command" path. The Arma launch line is built as a discrete
  `argv` slice (`armacfg.BuildArgv`), never a shell string, and mod folder names
  and extra flags are validated against allow-lists.
- **mTLS + pinning.** The gateway requires a client cert signed by the internal
  CA; the host is identified by the cert's SHA-256 fingerprint. First-time
  enrollment binds the cert to a host via a one-time, hashed token.
- **Defense in depth.** RCON commands are whitelisted on *both* the control
  plane and the agent. Uploads are re-validated on the agent. Host reboot is
  **not** exposed from the panel (manage the machine directly if a reboot is needed).

## AuthN / AuthZ

- **OAuth-only login** (Discord, Google, Microsoft, Steam, Epic as configured). Password
  login is disabled.
- Sessions are random 256-bit tokens; only the SHA-256 hash is stored. Cookies
  are `HttpOnly`, `SameSite=Lax`, and `Secure` outside dev.
- **CSRF**: double-submit token required on all mutating requests.
- **Granular RBAC**: atomic permissions (`host.add`, `instance.control`,
  `mission.upload`, …) each carry a scope (`global` / `host:{id}` / `instance:{id}`).
  A global grant covers everything; a host grant covers its instances; an
  instance grant covers only that instance. Checked server-side on every
  endpoint and before every agent dispatch (UI hiding is cosmetic only).
- New accounts stay **pending approval** until an Owner approves them.

## Upload safety (iteration 1 — implemented)

- Per-section extension allow-list: missions=`.pbo`, keys=`.bikey`,
  config=`.cfg/.hpp/.html/.htm/.paa/.sqf/.sqm/.ext`.
- Content/magic-byte verification (PBO header, bikey size, UTF-8/NUL checks for
  text) so the extension can't be spoofed.
- Filename sanitization rejecting path traversal / zip-slip / drive letters.
- Size limits per section.
- Quarantine flow: uploads land in staging, are validated, and are only moved to
  a host's Arma directory via the agent after explicit approval. Every upload is
  recorded with a content hash in the audit log.

## Upload safety (iteration 2 — deferred, documented)

The pipeline exposes a pluggable `Scanner` stage (`uploads.RegisterScanner`). A
heuristic scanner (`uploads/scanner.go`) is included but **off by default**;
enable with `A3P_ENABLE_MISSION_SCANNER=1`. Full iteration-2 scope:

- Unpack `.pbo` in an isolated sandbox.
- Statically scan `description.ext` / `init.sqf` / `*.sqf` for high-risk patterns
  (`execVM`/`call compile` of remote data, `preprocessFile` of unexpected
  extensions, `htmlLoad` to untrusted URLs, base64/obfuscated blobs,
  `remoteExec` of compiled code).
- Cross-check `allowedLoadFileExtensions` / `allowedHTMLLoadExtensions`.
- Optional AV/YARA hook; require manual approval for anything that trips a rule.

## Hardening checklist

- [x] OAuth-only authentication
- [x] Secure session cookies (HttpOnly / SameSite / Secure)
- [x] CSRF protection on mutations
- [x] Login rate limiting
- [x] Granular, server-enforced RBAC with per-resource scope
- [x] Owner approval gate for new accounts
- [x] mTLS agent transport with cert pinning + one-time enrollment
- [x] No-arbitrary-exec typed operation catalog
- [x] argv-array launch builder (no shell interpolation)
- [x] RCON command whitelist (control plane + agent)
- [x] Host reboot not exposed from the panel (manage OS directly)
- [x] Encrypted credential vault (Steam, Discord token)
- [x] Strict upload allow-list + structural validation + quarantine
- [x] Append-only audit log
- [x] Security headers (HSTS, CSP, X-Content-Type-Options, X-Frame-Options)
- [x] CI dependency scan (govulncheck), SAST (gosec), secret scan (gitleaks)
- [ ] Iteration-2 sandboxed PBO content scanning (deferred)
- [ ] Centralized log shipping / SIEM integration (deployment-specific)

## Pen-test / review checklist

Before exposing the panel publicly, verify:

1. **Authz**: every API route is gated by `require`/`requireAny`; attempt each
   action with a scoped-but-insufficient role and confirm `403` + audit entry.
2. **Scope isolation**: a user scoped to `instance:A` cannot control/view
   `instance:B` or its host.
3. **CSRF**: mutating requests without a valid `X-CSRF-Token` are rejected.
4. **Session**: cookies are `Secure`+`HttpOnly`; expired sessions are rejected by
   `requireAuth`.
5. **Uploads**: try a renamed `.exe`→`.pbo`, a zip-slip filename, an oversized
   file, and (with the scanner on) a script with `execVM "http://…"`.
6. **Agent transport**: a client cert not signed by the CA, or an unknown
   fingerprint without a valid enroll token, is refused.
7. **Injection**: confirm config values (hostname, mod names) cannot inject extra
   launch flags — `armacfg` validates mod folders and extra flags.
8. **Secrets**: confirm Steam/Discord secrets are never present in any API
   response body or logs.
9. **Reboot**: confirm panel has no reboot UI/API (`/hosts/:id/reboot` gone).
10. **Rate limiting / lockout**: hammer the login endpoint and confirm throttling.
