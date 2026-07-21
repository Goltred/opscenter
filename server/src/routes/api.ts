import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { getDb, jsonParse } from "../db.js";
import { AuthedRequest, clientIp, csrfProtect, requireApproved, requireAuth, requirePerm } from "../auth/middleware.js";
import { ALL_PERMISSIONS } from "../rbac.js";
import { parseArmaModlistHtml } from "../modlist/parseArmaModlistHtml.js";
import { getHub } from "../agent/hub.js";
import {
  describeWorkshopItems,
  ensureWorkshopMeta,
  expandWorkshopDependencies,
  formatWorkshopRefList,
  isFresh,
  parseWorkshopId,
  PROFILE_RESOLVED_MAX_AGE_MS,
  profileModsSourceHash,
  readCachedWorkshopMeta,
  refreshExpiredWorkshopMeta,
  searchWorkshop,
  workshopUrl,
} from "../steam/workshop.js";
import { resolveSteamAccount, steamCredsPayload } from "../steam/accounts.js";
import { agentPackageAvailable, buildAgentJson, streamAgentPackageZip } from "../agentPackage.js";
import { encryptSecret } from "../secrets.js";
import { normalizeDlcCodes } from "../arma/dlcs.js";
import {
  isDefaultModsLibrary,
  modFolderLaunchArg,
  resolveModsLibraryPath,
} from "../arma/modsLibrary.js";
import {
  buildHeadlessLaunchSpecs,
  clampHeadlessCount,
  injectHeadlessIntoServerCfg,
  instanceHeadlessCount,
  parseRemoteHcIps,
  parseRemoteHcIpsColumn,
  recommendedHeadlessFromProfile,
  serializeRemoteHcIps,
  serverCfgPassword,
} from "../arma/headless.js";
import { JOBS_HISTORY_LIMIT, jobDto, listActiveJobs, pruneInstanceJobs } from "../jobs.js";
import {
  diffSnapshots,
  getProfileRevision,
  getOrCreateSharedSettings,
  getSharedCfgRevision,
  listProfileRevisions,
  listSharedCfgRevisions,
  profileSnapshotFromBody,
  recordProfileRevision,
  recordSharedCfgRevision,
  resolveInstanceSharedCfg,
  restoreProfileFromRevision,
  restoreSharedCfgFromRevision,
} from "../revisions.js";
import {
  normalizeCustomDifficulty,
  normalizeForcedDifficulty,
  renderArma3Profile,
} from "../arma/difficulty.js";
import { mergeServerCfg, pboToMissionTemplate, renderServerCfg } from "../arma/serverCfg.js";
import { registerHcGroupRoutes } from "./hcGroupsApi.js";
import { effectiveRemoteHcIps, groupsTargetingInstance, parseAdvertiseHost } from "../hcGroups.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

export const apiRouter = Router();

apiRouter.use(requireAuth);
apiRouter.use(requireApproved);

// CSRF on mutating methods (auth router handles its own)
apiRouter.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return csrfProtect(req as AuthedRequest, res, next);
});

function audit(req: AuthedRequest, action: string, targetId = "", result = "ok") {
  getDb()
    .prepare(
      `INSERT INTO audit_log(actor_id, actor_email, action, target_id, result, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(req.user?.id || null, req.user?.email || "", action, targetId, result, clientIp(req));
}

function agentControlPlaneUrl(): string {
  const agentPort = (() => {
    const addr = config.agentAddr || ":8443";
    if (addr.startsWith(":")) return Number(addr.slice(1)) || 8443;
    const i = addr.lastIndexOf(":");
    return i >= 0 ? Number(addr.slice(i + 1)) || 8443 : 8443;
  })();
  let hostPart = "127.0.0.1";
  try {
    hostPart = new URL(config.publicUrl).hostname || "127.0.0.1";
  } catch {
    /* keep localhost */
  }
  return `ws://${hostPart}:${agentPort}/agent/connect`;
}

// ---- hosts ----
apiRouter.get("/hosts", (req: AuthedRequest, res) => {
  const hub = getHub();
  const rows = getDb().prepare("SELECT * FROM hosts ORDER BY name").all() as Record<string, unknown>[];
  res.json(
    rows.map((h) => {
      const id = String(h.id);
      const live = hub.getHostLive(id);
      return {
        id: h.id,
        name: h.name,
        armaRoot: h.arma_root,
        modsLibraryPath: String(h.mods_library_path || ""),
        advertiseHost: String(h.advertise_host || ""),
        allowReboot: !!h.allow_reboot,
        status: live.online ? "online" : h.status,
        online: live.online,
        lastSeenAt: live.lastSeen ? new Date(live.lastSeen).toISOString() : h.last_seen_at || undefined,
        agentVersion: live.agentVersion,
        os: live.os,
        capabilities: live.capabilities,
        steamcmdRunning: live.steamcmdRunning,
        steamcmdPid: live.steamcmdPid,
        orphans: live.orphans || [],
        bootstrap: live.bootstrap,
      };
    }),
  );
});

apiRouter.post("/hosts", requirePerm("host.add"), (req: AuthedRequest, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const id = uuid();
  const armaRoot = String(req.body?.armaRoot || "C:\\arma3server");
  const modsLibraryPath = String(req.body?.modsLibraryPath || "").trim();
  const advertiseHost = parseAdvertiseHost(req.body?.advertiseHost);
  getDb()
    .prepare(
      `INSERT INTO hosts(id, name, enroll_token, arma_root, mods_library_path, advertise_host, allow_reboot, status)
       VALUES (?, ?, '', ?, ?, ?, ?, 'offline')`,
    )
    .run(id, name, armaRoot, modsLibraryPath, advertiseHost, 0);
  audit(req, "host.create", id);
  res.status(201).json({
    id,
    name,
    armaRoot,
    modsLibraryPath,
    advertiseHost,
    allowReboot: false,
    online: false,
    status: "offline",
  });
});

apiRouter.patch("/hosts/:id", requirePerm("host.add"), (req: AuthedRequest, res) => {
  const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!host) return res.status(404).json({ error: "not found" });
  const name = req.body?.name != null ? String(req.body.name).trim() : String(host.name);
  if (!name) return res.status(400).json({ error: "name required" });
  const armaRoot = req.body?.armaRoot != null ? String(req.body.armaRoot).trim() : String(host.arma_root);
  const modsLibraryPath =
    req.body?.modsLibraryPath != null ? String(req.body.modsLibraryPath).trim() : String(host.mods_library_path || "");
  const advertiseHost =
    req.body?.advertiseHost != null ? parseAdvertiseHost(req.body.advertiseHost) : String(host.advertise_host || "");
  // Panel does not offer host reboot — keep flag cleared.
  getDb()
    .prepare("UPDATE hosts SET name = ?, arma_root = ?, mods_library_path = ?, advertise_host = ?, allow_reboot = 0 WHERE id = ?")
    .run(name, armaRoot || "C:\\arma3server", modsLibraryPath, advertiseHost, req.params.id);
  audit(req, "host.update", req.params.id);
  res.json({
    id: req.params.id,
    name,
    armaRoot: armaRoot || "C:\\arma3server",
    modsLibraryPath,
    advertiseHost,
    allowReboot: false,
  });
});

apiRouter.delete("/hosts/:id", requirePerm("host.remove"), (req: AuthedRequest, res) => {
  const hostId = req.params.id;
  // Instances cascade via FK; also drop related rows that may not cascade from older DBs.
  getDb().prepare("DELETE FROM hc_groups WHERE host_id = ?").run(hostId);
  getDb().prepare("DELETE FROM instances WHERE host_id = ?").run(hostId);
  getDb().prepare("DELETE FROM hosts WHERE id = ?").run(hostId);
  audit(req, "host.delete", hostId);
  res.status(204).end();
});

apiRouter.get("/hosts/:id/agent-setup", requirePerm("host.add"), (req: AuthedRequest, res) => {
  const host = getDb()
    .prepare("SELECT id, name, arma_root, mods_library_path, enroll_token FROM hosts WHERE id = ?")
    .get(req.params.id) as
    | { id: string; name: string; arma_root: string; mods_library_path: string; enroll_token: string }
    | undefined;
  if (!host) return res.status(404).json({ error: "not found" });
  const live = getHub().getHostLive(host.id);
  const pkg = agentPackageAvailable();
  const steamAccountCount = (
    getDb().prepare("SELECT COUNT(*) AS n FROM steam_accounts").get() as { n: number }
  ).n;
  res.json({
    hostId: host.id,
    name: host.name,
    armaRoot: host.arma_root,
    modsLibraryPath: host.mods_library_path || "",
    controlPlaneUrl: agentControlPlaneUrl(),
    online: live.online,
    enrollPending: !!host.enroll_token,
    // Token is one-time and hashed — never recoverable. Client must regenerate if needed.
    enrollToken: null as string | null,
    packageAvailable: pkg.ok,
    packageMessage: pkg.message || null,
    steamAccountCount,
    armaServerPresent: live.bootstrap?.armaServerPresent === true,
  });
});

apiRouter.post("/hosts/:id/enroll-token", requirePerm("host.add"), (req: AuthedRequest, res) => {
  const host = getDb().prepare("SELECT id, arma_root, mods_library_path FROM hosts WHERE id = ?").get(req.params.id) as
    | { id: string; arma_root: string; mods_library_path: string }
    | undefined;
  if (!host) return res.status(404).json({ error: "not found" });
  const token = crypto.randomBytes(24).toString("base64url");
  const hashed = crypto.createHash("sha256").update(token).digest("hex");
  getDb().prepare("UPDATE hosts SET enroll_token = ? WHERE id = ?").run(hashed, req.params.id);
  audit(req, "host.enroll-token", req.params.id);
  res.json({
    hostId: req.params.id,
    enrollToken: token,
    token, // backwards compatible
    controlPlaneUrl: agentControlPlaneUrl(),
    armaRoot: host.arma_root || "C:\\arma3server",
    modsLibraryPath: host.mods_library_path || "",
  });
});

/** Download zip: published agent binary + deps + fresh agent.json (new enroll token). */
apiRouter.post("/hosts/:id/agent-package", requirePerm("host.add"), async (req: AuthedRequest, res) => {
  const host = getDb()
    .prepare("SELECT id, name, arma_root, mods_library_path FROM hosts WHERE id = ?")
    .get(req.params.id) as
    | { id: string; name: string; arma_root: string; mods_library_path: string }
    | undefined;
  if (!host) return res.status(404).json({ error: "not found" });
  const pkg = agentPackageAvailable();
  if (!pkg.ok) return res.status(503).json({ error: pkg.message || "agent package unavailable" });

  const steamCmdPath = String(req.body?.steamCmdPath || "C:\\steamcmd\\steamcmd.exe").trim() || "C:\\steamcmd\\steamcmd.exe";
  const token = crypto.randomBytes(24).toString("base64url");
  const hashed = crypto.createHash("sha256").update(token).digest("hex");
  getDb().prepare("UPDATE hosts SET enroll_token = ? WHERE id = ?").run(hashed, host.id);
  audit(req, "host.agent-package", host.id);

  const agentJson = buildAgentJson({
    controlPlaneUrl: agentControlPlaneUrl(),
    hostId: host.id,
    enrollToken: token,
    armaRoot: host.arma_root || "C:\\arma3server",
    modsLibraryPath: host.mods_library_path || "",
    steamCmdPath,
  });

  try {
    await streamAgentPackageZip(res, { hostName: host.name, agentJson });
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e instanceof Error ? e.message : "failed to build agent package" });
    }
  }
});

/** Whether the panel can serve an agent zip (no host required). */
apiRouter.get("/agent-package/status", requirePerm("host.add"), (_req, res) => {
  const pkg = agentPackageAvailable();
  res.json({ packageAvailable: pkg.ok, packageMessage: pkg.message || null });
});

apiRouter.post("/hosts/:id/prepare", requirePerm("host.add"), async (req: AuthedRequest, res) => {
  const hub = getHub();
  const hostId = req.params.id;
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline — wait until the host card shows agent connected" });
  try {
    const result = await hub.dispatch(
      hostId,
      "host.bootstrap",
      { ensureSteamCmd: req.body?.ensureSteamCmd !== false, ensureDirs: req.body?.ensureDirs !== false },
      120_000,
    );
    if (result.data) hub.setBootstrap(hostId, result.data);
    audit(req, "host.prepare", hostId, result.ok ? "ok" : "failed");

    const armaPresent = result.data?.armaServerPresent === true;
    const installServer = req.body?.installServer !== false;
    if (result.ok && !armaPresent && installServer) {
      if (result.data?.steamCmdPresent !== true) {
        return res.status(400).json({
          status: "failed",
          result,
          bootstrap: result.data,
          error:
            "Arma dedicated server is not installed, and SteamCMD is missing on the host. Install SteamCMD, set steamCmdPath in agent.json, then Prepare again to download the creatordlc branch.",
        });
      }
      let creds;
      try {
        creds = resolveSteamAccount(req.body?.steamAccountId);
      } catch (e) {
        return res.status(400).json({
          status: "failed",
          result,
          bootstrap: result.data,
          error:
            (e instanceof Error ? e.message : "Steam account required") +
            " Add one under Admin → Steam so Prepare can download the creatordlc dedicated server.",
        });
      }
      const jobId = startCreatorDlcServerInstall(req, hostId, creds, !!req.body?.validate, "prepare");
      return res.json({
        status: "installing",
        jobId,
        result: {
          ...result,
          message:
            "Folders ready; downloading Arma 3 dedicated server (creatordlc) into armaRoot via SteamCMD…",
        },
        bootstrap: result.data,
      });
    }

    res.json({ status: result.ok ? "ok" : "failed", result, bootstrap: result.data });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "prepare failed" });
  }
});

/** Fire-and-forget SteamCMD app_update 233780 -beta creatordlc; returns job id. */
function startCreatorDlcServerInstall(
  req: AuthedRequest,
  hostId: string,
  creds: ReturnType<typeof resolveSteamAccount>,
  validate: boolean,
  reason: string,
): string {
  const hub = getHub();
  const jobId = uuid();
  getDb()
    .prepare(
      `INSERT INTO jobs(id, kind, host_id, state, stage, progress, requested_by)
       VALUES (?, 'steamcmd_app_update', ?, 'running', 'installing', '[]', ?)`,
    )
    .run(jobId, hostId, req.user?.id || null);
  hub.clearLogs(hostId);
  hub.setSteamDownloading(hostId, jobId, "233780");
  hub.appendLog(
    hostId,
    `starting Arma dedicated server install (233780 -beta creatordlc) as ${creds.label} [${reason}]`,
  );
  audit(req, "steamcmd.install-server", hostId, reason);
  void hub
    .dispatch(
      hostId,
      "steam.app.update",
      {
        appId: "233780",
        ...steamCredsPayload(creds),
        validate,
        beta: "creatordlc",
        jobId,
      },
      2 * 60 * 60 * 1000,
    )
    .then((installResult) => {
      getDb()
        .prepare(`UPDATE jobs SET state=?, stage=?, error=?, updated_at=datetime('now') WHERE id=?`)
        .run(
          installResult.ok ? "done" : "failed",
          installResult.stage || "done",
          installResult.error || "",
          jobId,
        );
      const st = hub.getSteamStatus(hostId);
      st.running = false;
      if (!installResult.ok) st.error = installResult.error || installResult.message;
      hub.emit("steamcmd-status", hostId, st);
      // Refresh bootstrap so the host card shows Arma present after install.
      void hub
        .dispatch(hostId, "host.info", {}, 30_000)
        .then((info) => {
          if (info.data) hub.setBootstrap(hostId, info.data);
        })
        .catch(() => undefined);
    })
    .catch((err) => {
      getDb()
        .prepare(`UPDATE jobs SET state='failed', error=?, updated_at=datetime('now') WHERE id=?`)
        .run(String(err), jobId);
      const st = hub.getSteamStatus(hostId);
      st.running = false;
      st.error = String(err);
      hub.emit("steamcmd-status", hostId, st);
    });
  return jobId;
}

// ---- instances ----
function instanceDto(row: Record<string, unknown>) {
  const hub = getHub();
  const hostId = String(row.host_id);
  const live = hub.getInstanceStatus(hostId, String(row.id));
  const hostOnline = hub.isOnline(hostId);
  let currentProfileName: string | undefined;
  if (row.current_profile_id) {
    const p = getDb().prepare("SELECT name FROM mission_profiles WHERE id = ?").get(row.current_profile_id) as
      | { name: string }
      | undefined;
    currentProfileName = p?.name;
  }
  const shared = getOrCreateSharedSettings();
  return {
    id: row.id,
    hostId: row.host_id,
    name: row.name,
    port: row.port,
    profileDir: row.profile_dir,
    currentProfileId: row.current_profile_id || undefined,
    currentProfileName,
    state: live?.state || row.state,
    status: {
      state: live?.state || String(row.state || "stopped"),
      pid: live?.pid,
      players: live?.players ?? 0,
      maxPlayers: live?.maxPlayers ?? 0,
      uptimeSec: live?.uptimeSec,
      queryOk: live?.queryOk === true,
      queryError: live?.queryError || undefined,
      hostname: live?.hostname || undefined,
      map: live?.map || undefined,
      password: live?.password === true,
      queryPort: live?.queryPort || undefined,
      queriedAt: live?.queriedAt || undefined,
      adopted: live?.adopted === true,
      headless: Array.isArray(live?.headless) ? live!.headless : undefined,
    },
    online: hostOnline && (live?.state === "running" || live?.state === "starting" || !!live?.pid),
    sharedServerCfg: shared.serverCfg,
    sharedCfgVersion: shared.version,
    headlessCount: instanceHeadlessCount(row),
    remoteHcIps: parseRemoteHcIpsColumn(row),
    remoteHcGroups: groupsTargetingInstance(String(row.id)).map((g) => ({
      id: g.id,
      name: g.name,
      hostId: g.host_id,
      desiredCount: clampHeadlessCount(g.desired_count),
    })),
  };
}

apiRouter.get("/instances", (req: AuthedRequest, res) => {
  const rows = getDb().prepare("SELECT * FROM instances ORDER BY name").all() as Record<string, unknown>[];
  res.json(rows.map(instanceDto));
});

apiRouter.post("/instances", requirePerm("host.add"), (req: AuthedRequest, res) => {
  const hostId = String(req.body?.hostId || "");
  const name = String(req.body?.name || "").trim();
  if (!hostId || !name) return res.status(400).json({ error: "hostId and name required" });
  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO instances(id, host_id, name, port, profile_dir, state)
       VALUES (?, ?, ?, ?, ?, 'stopped')`,
    )
    .run(id, hostId, name, Number(req.body?.port) || 2302, String(req.body?.profileDir || "profiles"));
  audit(req, "instance.create", id);
  res.status(201).json({ id });
});

apiRouter.get("/instances/:id", (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(instanceDto(row));
});

apiRouter.patch("/instances/:id", requirePerm("instance.config.edit"), (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  const name = b.name != null ? String(b.name).trim() : String(row.name);
  const port = b.port != null ? Number(b.port) : Number(row.port) || 2302;
  const profileDir = b.profileDir != null ? String(b.profileDir).trim() : String(row.profile_dir || "profiles");
  const headlessCount =
    b.headlessCount != null ? clampHeadlessCount(b.headlessCount) : instanceHeadlessCount(row);
  const remoteHcIps =
    b.remoteHcIps != null ? parseRemoteHcIps(b.remoteHcIps) : parseRemoteHcIpsColumn(row);
  if (!name) return res.status(400).json({ error: "name required" });
  getDb()
    .prepare(`UPDATE instances SET name=?, port=?, profile_dir=?, headless_count=?, remote_hc_ips=? WHERE id=?`)
    .run(name, port, profileDir || "profiles", headlessCount, serializeRemoteHcIps(remoteHcIps), req.params.id);
  audit(req, "instance.update", String(req.params.id));
  const updated = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown>;
  res.json(instanceDto(updated));
});

apiRouter.delete("/instances/:id", requirePerm("host.remove"), (req: AuthedRequest, res) => {
  const linked = groupsTargetingInstance(req.params.id);
  if (linked.length) {
    return res.status(409).json({
      error: `Detach or delete ${linked.length} HC group(s) targeting this instance first: ${linked.map((g) => g.name).join(", ")}`,
    });
  }
  getDb().prepare("DELETE FROM instances WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

async function dispatchInstanceOp(
  req: AuthedRequest,
  res: import("express").Response,
  op: "instance.start" | "instance.stop" | "instance.restart" | "instance.status",
) {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(row.host_id) as Record<string, unknown> | undefined;
  const hub = getHub();
  const hostId = String(row.host_id);
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });

  const payload: Record<string, unknown> = {
    instanceId: String(row.id),
    port: Number(row.port) || 2302,
    profileDir: String(row.profile_dir || "profiles"),
    armaRoot: String(host?.arma_root || ""),
  };

  if ((op === "instance.start" || op === "instance.restart") && host) {
    try {
      const info = await hub.dispatch(hostId, "host.info", {}, 30_000);
      if (info.data) hub.setBootstrap(hostId, info.data);
      if (info.ok && info.data?.armaServerPresent === false) {
        return res.status(409).json({
          error:
            `Arma 3 dedicated server is not installed at ${String(host.arma_root || "armaRoot")}. ` +
            "Use Prepare host (or Apply a Mission Profile) to download the creatordlc branch via SteamCMD.",
        });
      }
    } catch {
      /* proceed — agent Start still fails clearly if the exe is missing */
    }

    let profile: Record<string, unknown> | null = null;
    if (row.current_profile_id) {
      profile =
        (getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(row.current_profile_id) as
          | Record<string, unknown>
          | undefined) || null;
    }
    let resolvedPaths: Record<string, string> = {};
    let client: string[] = [];
    let server: string[] = [];
    let missionTemplate = "";
    if (profile) {
      try {
        const prepared = await prepareProfileLaunch(hostId, host, row, profile);
        client = prepared.client;
        server = prepared.server;
        resolvedPaths = prepared.resolvedPaths;
        missionTemplate = prepared.missionTemplate;
      } catch (e) {
        return res.status(502).json({
          error: e instanceof Error ? e.message : "failed to prepare profile for launch",
        });
      }
    }
    payload.args = buildInstanceLaunchArgs(host, row, profile, resolvedPaths, { client, server }, {
      missionTemplate,
    });
    const sharedCfg = resolveInstanceSharedCfg(row);
    const profileCfg = profile
      ? jsonParse<Record<string, unknown>>(String(profile.server_cfg_overrides), {})
      : {};
    const mergedCfg = injectHeadlessIntoServerCfg(
      mergeServerCfg(sharedCfg, profileCfg),
      instanceHeadlessCount(row),
      effectiveRemoteHcIps(row),
    );
    payload.headless = buildHeadlessPayload(host, row, profile, resolvedPaths, { client, server }, mergedCfg);
    if (!profile) {
      payload.warning =
        "No profile loaded on this instance — start uses bare -config only (no -mod= / mission). Apply a Mission Profile first.";
    } else {
      const modArg = (payload.args as string[]).find((a) => a.startsWith("-mod="));
      payload.launchSummary = {
        mods: modArg ? modArg.split("=")[1]?.split(";").filter(Boolean).length || 0 : 0,
        mission: missionTemplate || null,
        autoInit: (payload.args as string[]).some((a) => a.toLowerCase() === "-autoinit"),
        headless: (payload.headless as unknown[]).length,
      };
    }
  }

  try {
    const result = await hub.dispatch(hostId, op, payload, 120_000);
    const state = String(result.data?.state || (op === "instance.stop" ? "stopped" : result.ok ? "running" : row.state));
    getDb().prepare("UPDATE instances SET state = ? WHERE id = ?").run(state, row.id);
    audit(req, op, String(row.id), result.ok ? "ok" : "failed");
    if (!result.ok) return res.status(502).json({ error: result.error || result.message || "agent error" });
    res.json({
      status: "ok",
      state,
      result,
      warning: payload.warning,
      launchSummary: payload.launchSummary,
      args: payload.args,
    });
  } catch (e) {
    audit(req, op, String(row.id), "failed");
    res.status(503).json({ error: e instanceof Error ? e.message : "dispatch failed" });
  }
}

apiRouter.post("/instances/:id/start", requirePerm("instance.control"), (req, res) =>
  dispatchInstanceOp(req as AuthedRequest, res, "instance.start"),
);
apiRouter.post("/instances/:id/stop", requirePerm("instance.control"), (req, res) =>
  dispatchInstanceOp(req as AuthedRequest, res, "instance.stop"),
);
apiRouter.post("/instances/:id/restart", requirePerm("instance.control"), (req, res) =>
  dispatchInstanceOp(req as AuthedRequest, res, "instance.restart"),
);

async function resolveHeadlessLaunchContext(inst: Record<string, unknown>, host: Record<string, unknown>) {
  const hostId = String(inst.host_id);
  let profile: Record<string, unknown> | null = null;
  if (inst.current_profile_id) {
    profile =
      (getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(inst.current_profile_id) as
        | Record<string, unknown>
        | undefined) || null;
  }
  let resolvedPaths: Record<string, string> = {};
  let client: string[] = [];
  let server: string[] = [];
  if (profile) {
    const expanded = await resolveProfileWorkshopIds(profile, { preferStale: true });
    client = expanded.client;
    server = expanded.server;
    resolvedPaths = await resolveModLaunchPaths(hostId, host, uniqueIds([...client, ...server]));
  }
  const sharedCfg = resolveInstanceSharedCfg(inst);
  const profileCfg = profile
    ? jsonParse<Record<string, unknown>>(String(profile.server_cfg_overrides), {})
    : {};
  const mergedCfg = injectHeadlessIntoServerCfg(
    mergeServerCfg(sharedCfg, profileCfg),
    instanceHeadlessCount(inst),
    effectiveRemoteHcIps(inst),
  );
  return { profile, resolvedPaths, client, server, mergedCfg };
}

/** Ensure server.cfg on host includes HC allowlists (e.g. after changing remote IPs). */
async function rewriteInstanceServerCfgForHeadless(
  hostId: string,
  inst: Record<string, unknown>,
  host: Record<string, unknown>,
) {
  const ctx = await resolveHeadlessLaunchContext(inst, host);
  if (ctx.profile) {
    await writeProfileConfigToHost(hostId, inst, ctx.profile, undefined, ctx.client.length);
  } else {
    const serverCfg = renderServerCfg(ctx.mergedCfg, {});
    const hub = getHub();
    const cfgResult = await hub.dispatch(
      hostId,
      "config.apply",
      {
        instanceId: inst.id,
        profileDir: inst.profile_dir,
        files: [{ relativePath: "server.cfg", content: serverCfg }],
      },
      60_000,
    );
    if (!cfgResult.ok) throw new Error(cfgResult.error || "config.apply failed");
  }
  return ctx;
}

apiRouter.post("/instances/:id/headless/scale", requirePerm("instance.control"), async (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(row.host_id) as Record<string, unknown> | undefined;
  if (!host) return res.status(404).json({ error: "host not found" });
  const hub = getHub();
  const hostId = String(row.host_id);
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });

  let target = instanceHeadlessCount(row);
  if (req.body?.count != null) {
    target = clampHeadlessCount(req.body.count);
  } else if (req.body?.delta != null) {
    target = clampHeadlessCount(target + Number(req.body.delta));
  } else {
    return res.status(400).json({ error: "count or delta required" });
  }

  getDb().prepare("UPDATE instances SET headless_count = ? WHERE id = ?").run(target, row.id);
  const updated = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(row.id) as Record<string, unknown>;

  const live = hub.getInstanceStatus(hostId, String(row.id));
  const serverUp =
    String(live?.state || "").toLowerCase() === "running" ||
    String(live?.state || "").toLowerCase() === "starting" ||
    !!live?.pid;

  try {
    await rewriteInstanceServerCfgForHeadless(hostId, updated, host);
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : "failed to update server.cfg" });
  }

  if (!serverUp) {
    audit(req, "instance.headless.scale", String(row.id), `saved:${target}`);
    return res.json({ status: "ok", headlessCount: target, started: false, instance: instanceDto(updated) });
  }

  const ctx = await resolveHeadlessLaunchContext(updated, host);
  const headless = buildHeadlessPayload(
    host,
    updated,
    ctx.profile,
    ctx.resolvedPaths,
    { client: ctx.client, server: ctx.server },
    ctx.mergedCfg,
    target,
  );
  try {
    const result = await hub.dispatch(
      hostId,
      "instance.headless.scale",
      {
        instanceId: String(row.id),
        port: Number(row.port) || 2302,
        profileDir: String(row.profile_dir || "profiles"),
        armaRoot: String(host.arma_root || ""),
        headless,
        desiredCount: target,
      },
      180_000,
    );
    audit(req, "instance.headless.scale", String(row.id), result.ok ? "ok" : "failed");
    if (!result.ok) return res.status(502).json({ error: result.error || result.message || "scale failed" });
    const fresh = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(row.id) as Record<string, unknown>;
    res.json({ status: "ok", headlessCount: target, started: true, result, instance: instanceDto(fresh) });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "scale failed" });
  }
});

apiRouter.post("/instances/:id/headless/:name/restart", requirePerm("instance.control"), async (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(row.host_id) as Record<string, unknown> | undefined;
  if (!host) return res.status(404).json({ error: "host not found" });
  const hub = getHub();
  const hostId = String(row.host_id);
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });
  const name = String(req.params.name || "").trim();
  if (!/^hc\d+$/i.test(name)) return res.status(400).json({ error: "invalid headless name" });

  try {
    const ctx = await resolveHeadlessLaunchContext(row, host);
    const all = buildHeadlessPayload(
      host,
      row,
      ctx.profile,
      ctx.resolvedPaths,
      { client: ctx.client, server: ctx.server },
      ctx.mergedCfg,
    );
    const one = all.find((h) => h.name.toLowerCase() === name.toLowerCase());
    if (!one) return res.status(404).json({ error: `headless ${name} is outside desired count` });
    const result = await hub.dispatch(
      hostId,
      "instance.headless.restart",
      {
        instanceId: String(row.id),
        port: Number(row.port) || 2302,
        profileDir: String(row.profile_dir || "profiles"),
        armaRoot: String(host.arma_root || ""),
        headless: [one],
        name: one.name,
      },
      120_000,
    );
    audit(req, "instance.headless.restart", String(row.id), result.ok ? name : "failed");
    if (!result.ok) return res.status(502).json({ error: result.error || result.message || "restart failed" });
    res.json({ status: "ok", result });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "restart failed" });
  }
});

apiRouter.post("/instances/:id/headless/:name/stop", requirePerm("instance.control"), async (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(row.host_id) as Record<string, unknown> | undefined;
  if (!host) return res.status(404).json({ error: "host not found" });
  const hub = getHub();
  const hostId = String(row.host_id);
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });
  const name = String(req.params.name || "").trim();
  if (!/^hc\d+$/i.test(name)) return res.status(400).json({ error: "invalid headless name" });

  // Stopping one HC also lowers desired count to max(remaining, index).
  const m = /^hc(\d+)$/i.exec(name);
  const idx = m ? Number(m[1]) : -1;
  const current = instanceHeadlessCount(row);
  const nextCount = idx >= 0 ? Math.min(current, idx) : Math.max(0, current - 1);
  getDb().prepare("UPDATE instances SET headless_count = ? WHERE id = ?").run(nextCount, row.id);

  try {
    const result = await hub.dispatch(
      hostId,
      "instance.headless.stop",
      {
        instanceId: String(row.id),
        name,
        armaRoot: String(host.arma_root || ""),
        profileDir: String(row.profile_dir || "profiles"),
      },
      60_000,
    );
    audit(req, "instance.headless.stop", String(row.id), result.ok ? name : "failed");
    if (!result.ok) return res.status(502).json({ error: result.error || result.message || "stop failed" });
    const fresh = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(row.id) as Record<string, unknown>;
    res.json({ status: "ok", headlessCount: nextCount, result, instance: instanceDto(fresh) });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "stop failed" });
  }
});

apiRouter.post("/instances/:id/rcon", requirePerm("instance.rcon"), async (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const hub = getHub();
  if (!hub.isOnline(String(row.host_id))) return res.status(503).json({ error: "agent offline" });
  try {
    const result = await hub.dispatch(String(row.host_id), "rcon.command", {
      instanceId: row.id,
      command: String(req.body?.command || ""),
    }, 30_000);
    if (!result.ok) return res.status(502).json({ error: result.error || "rcon failed" });
    res.json({ status: "ok", result });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "rcon failed" });
  }
});

apiRouter.post("/instances/:id/config/apply", requirePerm("instance.config.edit"), async (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const hub = getHub();
  if (!hub.isOnline(String(row.host_id))) return res.status(503).json({ error: "agent offline" });
  const files = Array.isArray(req.body?.files) ? [...req.body.files] : [];
  if (req.body?.serverCfg && typeof req.body.serverCfg === "string") {
    files.push({ relativePath: "server.cfg", content: req.body.serverCfg });
  } else if (req.body?.serverCfg && typeof req.body.serverCfg === "object") {
    const sharedCfg = resolveInstanceSharedCfg(row);
    const merged = mergeServerCfg(sharedCfg, req.body.serverCfg as Record<string, unknown>);
    files.push({ relativePath: "server.cfg", content: renderServerCfg(merged) });
  }
  try {
    const result = await hub.dispatch(
      String(row.host_id),
      "config.apply",
      { instanceId: row.id, profileDir: row.profile_dir, files },
      60_000,
    );
    audit(req, "config.apply", String(row.id), result.ok ? "ok" : "failed");
    if (!result.ok) return res.status(502).json({ error: result.error || "apply failed" });
    res.json({ status: "ok", result });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "apply failed" });
  }
});

apiRouter.get("/instances/:id/files", requirePerm("instance.view"), async (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const hub = getHub();
  const hostId = String(row.host_id);
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });
  const root = String(req.query.root || "mpmissions");
  const relativePath = String(req.query.path || "");
  try {
    const result = await hub.dispatch(hostId, "file.list", { root, relativePath }, 30_000);
    if (!result.ok) return res.status(502).json({ error: result.error || "list failed" });
    res.json({ status: "ok", ...result.data, message: result.message });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "list failed" });
  }
});

apiRouter.get("/hosts/:id/files", requirePerm("instance.view"), async (req: AuthedRequest, res) => {
  const hub = getHub();
  const hostId = req.params.id;
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });
  const root = String(req.query.root || "arma");
  const relativePath = String(req.query.path || "");
  const host = getDb().prepare("SELECT arma_root, mods_library_path FROM hosts WHERE id = ?").get(hostId) as
    | { arma_root: string; mods_library_path: string }
    | undefined;
  const libraryPath =
    root === "modsLibrary" && host
      ? resolveModsLibraryPath(String(host.arma_root || ""), host.mods_library_path)
      : undefined;
  try {
    const result = await hub.dispatch(hostId, "file.list", { root, relativePath, libraryPath }, 30_000);
    if (!result.ok) return res.status(502).json({ error: result.error || "list failed" });
    res.json({ status: "ok", ...result.data, message: result.message });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "list failed" });
  }
});

apiRouter.get("/hosts/:id/file", requirePerm("instance.view"), async (req: AuthedRequest, res) => {
  const hub = getHub();
  const hostId = req.params.id;
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });
  const root = String(req.query.root || "arma");
  const relativePath = String(req.query.path || "");
  if (!relativePath) return res.status(400).json({ error: "path required" });
  const host = getDb().prepare("SELECT arma_root, mods_library_path FROM hosts WHERE id = ?").get(hostId) as
    | { arma_root: string; mods_library_path: string }
    | undefined;
  const libraryPath =
    root === "modsLibrary" && host
      ? resolveModsLibraryPath(String(host.arma_root || ""), host.mods_library_path)
      : undefined;
  try {
    const result = await hub.dispatch(hostId, "file.read", { root, relativePath, libraryPath }, 60_000);
    if (!result.ok) return res.status(502).json({ error: result.error || "read failed" });
    res.json({
      status: "ok",
      content: result.data?.content ?? "",
      path: result.data?.path,
      relativePath: result.data?.relativePath ?? relativePath,
      size: result.data?.size,
      truncated: !!result.data?.truncated,
      encoding: result.data?.encoding || "utf-8",
      message: result.message,
    });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "read failed" });
  }
});

apiRouter.post("/instances/:id/sync-keys", requirePerm("mod.manage"), async (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(row.host_id) as Record<string, unknown> | undefined;
  const hub = getHub();
  if (!hub.isOnline(String(row.host_id))) return res.status(503).json({ error: "agent offline" });

  let workshopIds: string[] = Array.isArray(req.body?.workshopIds)
    ? (req.body.workshopIds as unknown[]).map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (!workshopIds.length && row.current_profile_id) {
    const profile = getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(row.current_profile_id) as
      | Record<string, unknown>
      | undefined;
    if (profile) {
      const expanded = await resolveProfileWorkshopIds(profile, { preferStale: true });
      workshopIds = uniqueIds([...expanded.client, ...expanded.server]);
    }
  }

  const armaRoot = String(host?.arma_root || "");
  const modsLibraryPath = String(host?.mods_library_path || "").trim();
  const libraryPath = modsLibraryPath ? resolveModsLibraryPath(armaRoot, modsLibraryPath) : "";
  const resolvedPaths = host ? await resolveModLaunchPaths(String(row.host_id), host, workshopIds) : {};
  const modPaths = uniqueLaunchPaths(Object.values(resolvedPaths));
  const payload: Record<string, unknown> = { workshopIds, modPaths };
  if (libraryPath) payload.libraryPath = libraryPath;

  try {
    const result = await hub.dispatch(String(row.host_id), "keys.sync", payload, 120_000);
    audit(req, "keys.sync", String(row.id), result.ok ? "ok" : "failed");
    if (!result.ok) return res.status(502).json({ error: result.error || result.message || "sync failed" });
    res.json({ status: "ok", result });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "sync failed" });
  }
});

apiRouter.get("/instances/:id/logs", (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    res.status(404).end();
    return;
  }
  const instanceId = String(row.id);
  const hostId = String(row.host_id);
  const hub = getHub();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const firstViewer = hub.subscribeInstanceLogs(instanceId);

  const buffered = hub.getInstanceLogs(instanceId);
  if (buffered.length) {
    for (const line of buffered) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
  } else {
    res.write(
      `data: ${JSON.stringify({
        line: hub.isOnline(hostId)
          ? "[a3panel] live console on — waiting for Arma RPT lines…"
          : "[a3panel] agent offline — connect the host agent to stream logs",
      })}\n\n`,
    );
  }

  const followPayload = () => {
    const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(hostId) as Record<string, unknown> | undefined;
    return {
      instanceId,
      port: Number(row.port) || 2302,
      profileDir: String(row.profile_dir || "profiles"),
      armaRoot: String(host?.arma_root || ""),
    };
  };

  // Only the first viewer asks the agent to start RPT tailing.
  if (firstViewer && hub.isOnline(hostId)) {
    void hub
      .dispatch(hostId, "instance.status", { ...followPayload(), followLogs: true }, 15_000)
      .catch(() => {
        /* ignore */
      });
  }

  const onLog = (id: string, line: string) => {
    if (id !== instanceId) return;
    res.write(`data: ${JSON.stringify({ line })}\n\n`);
  };
  hub.on("instance-log", onLog);
  req.on("close", () => {
    hub.off("instance-log", onLog);
    const lastViewer = hub.unsubscribeInstanceLogs(instanceId);
    if (lastViewer && hub.isOnline(hostId)) {
      void hub
        .dispatch(hostId, "instance.status", { ...followPayload(), followLogs: false }, 15_000)
        .catch(() => {
          /* ignore */
        });
    }
  });
});

apiRouter.get("/instances/:id/jobs", (req, res) => {
  pruneInstanceJobs(req.params.id);
  const rows = getDb()
    .prepare("SELECT * FROM jobs WHERE instance_id = ? ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?")
    .all(req.params.id, JOBS_HISTORY_LIMIT) as Record<string, unknown>[];
  res.json(rows.map(jobDto));
});

function profileDto(row: Record<string, unknown>) {
  let missionName: string | undefined;
  let modlistName: string | undefined;
  if (row.mission_id) {
    const m = getDb().prepare("SELECT name FROM missions WHERE id = ?").get(row.mission_id) as { name: string } | undefined;
    missionName = m?.name;
  }
  if (row.modlist_id) {
    const ml = getDb().prepare("SELECT name FROM modlists WHERE id = ?").get(row.modlist_id) as { name: string } | undefined;
    modlistName = ml?.name;
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    mods: jsonParse<string[]>(String(row.mods), []),
    serverMods: jsonParse<string[]>(String(row.server_mods), []),
    missionId: row.mission_id || undefined,
    missionName,
    modlistId: row.modlist_id || undefined,
    modlistName,
    serverCfgOverrides: jsonParse(String(row.server_cfg_overrides), {}),
    basicCfgOverrides: jsonParse(String(row.basic_cfg_overrides), {}),
    extraArgs: jsonParse(String(row.extra_args), []),
    customDifficulty: normalizeCustomDifficulty(jsonParse(String(row.custom_difficulty), {})),
    dlcs: normalizeDlcCodes(jsonParse(String(row.dlcs), [])),
    resolvedModsAt: row.resolved_mods_at || undefined,
    recommendedHeadlessCount:
      row.recommended_headless_count == null || row.recommended_headless_count === ""
        ? null
        : clampHeadlessCount(row.recommended_headless_count),
  };
}

apiRouter.get("/profiles", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM mission_profiles ORDER BY name").all() as Record<string, unknown>[];
  res.json(rows.map(profileDto));
});

apiRouter.get("/instances/:id/profiles", (_req, res) => {
  // Profiles are global; keep this route as an alias for older clients.
  const rows = getDb().prepare("SELECT * FROM mission_profiles ORDER BY name").all() as Record<string, unknown>[];
  res.json(rows.map(profileDto));
});

apiRouter.post("/profiles", requirePerm("profile.edit"), (req: AuthedRequest, res) => {
  const id = uuid();
  const snapshot = profileSnapshotFromBody(req.body || {});
  getDb()
    .prepare(
      `INSERT INTO mission_profiles(id, name, version, mods, server_mods, mission_id, modlist_id, server_cfg_overrides, basic_cfg_overrides, extra_args, custom_difficulty, dlcs, recommended_headless_count)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      snapshot.name || "profile",
      JSON.stringify(snapshot.mods),
      JSON.stringify(snapshot.serverMods),
      snapshot.missionId,
      snapshot.modlistId,
      JSON.stringify(snapshot.serverCfgOverrides),
      JSON.stringify(snapshot.basicCfgOverrides),
      JSON.stringify(snapshot.extraArgs),
      JSON.stringify(snapshot.customDifficulty),
      JSON.stringify(snapshot.dlcs),
      snapshot.recommendedHeadlessCount,
    );
  recordProfileRevision(id, 1, snapshot, { id: req.user?.id, email: req.user?.email });
  audit(req, "profile.create", id);
  res.status(201).json({ id });
});

apiRouter.post("/instances/:id/profiles", requirePerm("profile.edit"), (req: AuthedRequest, res) => {
  // Alias → global create (instance id ignored).
  const id = uuid();
  const snapshot = profileSnapshotFromBody(req.body || {});
  getDb()
    .prepare(
      `INSERT INTO mission_profiles(id, name, version, mods, server_mods, mission_id, modlist_id, server_cfg_overrides, basic_cfg_overrides, extra_args, custom_difficulty, dlcs, recommended_headless_count)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      snapshot.name || "profile",
      JSON.stringify(snapshot.mods),
      JSON.stringify(snapshot.serverMods),
      snapshot.missionId,
      snapshot.modlistId,
      JSON.stringify(snapshot.serverCfgOverrides),
      JSON.stringify(snapshot.basicCfgOverrides),
      JSON.stringify(snapshot.extraArgs),
      JSON.stringify(snapshot.customDifficulty),
      JSON.stringify(snapshot.dlcs),
      snapshot.recommendedHeadlessCount,
    );
  recordProfileRevision(id, 1, snapshot, { id: req.user?.id, email: req.user?.email });
  audit(req, "profile.create", id);
  res.status(201).json({ id });
});

// ---- profiles ----
apiRouter.get("/profiles/:id", (req, res) => {
  const row = getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(profileDto(row));
});

apiRouter.put("/profiles/:id", requirePerm("profile.edit"), (req: AuthedRequest, res) => {
  const existing = getDb().prepare("SELECT id FROM mission_profiles WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  const snapshot = profileSnapshotFromBody(b);
  getDb()
    .prepare(
      `UPDATE mission_profiles SET name=?, version=version+1, mods=?, server_mods=?, mission_id=?, modlist_id=?,
       server_cfg_overrides=?, basic_cfg_overrides=?, extra_args=?, custom_difficulty=?, dlcs=?,
       recommended_headless_count=?,
       resolved_client_mods='[]', resolved_server_mods='[]', resolved_mods_at=NULL, resolved_mods_hash='',
       updated_at=datetime('now') WHERE id=?`,
    )
    .run(
      snapshot.name,
      JSON.stringify(snapshot.mods),
      JSON.stringify(snapshot.serverMods),
      snapshot.missionId,
      snapshot.modlistId,
      JSON.stringify(snapshot.serverCfgOverrides),
      JSON.stringify(snapshot.basicCfgOverrides),
      JSON.stringify(snapshot.extraArgs),
      JSON.stringify(snapshot.customDifficulty),
      JSON.stringify(snapshot.dlcs),
      snapshot.recommendedHeadlessCount,
      req.params.id,
    );
  const updated = getDb().prepare("SELECT version FROM mission_profiles WHERE id = ?").get(req.params.id) as {
    version: number;
  };
  recordProfileRevision(String(req.params.id), Number(updated.version), snapshot, {
    id: req.user?.id,
    email: req.user?.email,
  });
  audit(req, "profile.update", String(req.params.id));
  res.json({ status: "ok", version: Number(updated.version) });
});

apiRouter.get("/profiles/:id/revisions", (req, res) => {
  const row = getDb().prepare("SELECT id FROM mission_profiles WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(listProfileRevisions(String(req.params.id)));
});

apiRouter.get("/profiles/:id/revisions/compare", (req, res) => {
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return res.status(400).json({ error: "a and b version query params required" });
  }
  const left = getProfileRevision(String(req.params.id), a);
  const right = getProfileRevision(String(req.params.id), b);
  if (!left || !right) return res.status(404).json({ error: "revision not found" });
  res.json({
    a: left,
    b: right,
    changes: diffSnapshots(
      left.snapshot as unknown as Record<string, unknown>,
      right.snapshot as unknown as Record<string, unknown>,
    ),
  });
});

apiRouter.get("/profiles/:id/revisions/:version", (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isFinite(version)) return res.status(400).json({ error: "invalid version" });
  const rev = getProfileRevision(String(req.params.id), version);
  if (!rev) return res.status(404).json({ error: "not found" });
  res.json(rev);
});

apiRouter.post("/profiles/:id/restore", requirePerm("profile.edit"), (req: AuthedRequest, res) => {
  const version = Number(req.body?.version);
  if (!Number.isFinite(version)) return res.status(400).json({ error: "version required" });
  const result = restoreProfileFromRevision(String(req.params.id), version, {
    id: req.user?.id,
    email: req.user?.email,
  });
  if ("error" in result) return res.status(404).json({ error: result.error });
  audit(req, "profile.restore", String(req.params.id));
  res.json({ status: "ok", version: result.newVersion });
});

apiRouter.get("/shared-cfg-presets", (_req, res) => {
  const shared = getOrCreateSharedSettings();
  const row = getDb().prepare("SELECT created_at, updated_at FROM shared_cfg_presets WHERE id = ?").get(shared.id) as
    | { created_at?: string; updated_at?: string }
    | undefined;
  res.json([
    {
      id: shared.id,
      name: shared.name,
      version: shared.version,
      serverCfg: shared.serverCfg,
      createdAt: row?.created_at ? String(row.created_at) : undefined,
      updatedAt: row?.updated_at ? String(row.updated_at) : undefined,
    },
  ]);
});

apiRouter.post("/shared-cfg-presets", requirePerm("instance.config.edit"), (req: AuthedRequest, res) => {
  // Singleton: creating when one already exists returns the existing id.
  const existing = getDb().prepare("SELECT id FROM shared_cfg_presets ORDER BY rowid LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (existing) return res.status(200).json({ id: existing.id });
  const id = uuid();
  const serverCfg =
    req.body?.serverCfg && typeof req.body.serverCfg === "object" ? (req.body.serverCfg as Record<string, unknown>) : {};
  getDb()
    .prepare(
      `INSERT INTO shared_cfg_presets(id, name, version, server_cfg, created_at, updated_at)
       VALUES (?, 'Shared settings', 1, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, JSON.stringify(serverCfg));
  recordSharedCfgRevision(id, 1, serverCfg, { id: req.user?.id, email: req.user?.email });
  audit(req, "shared_cfg.create", id);
  res.status(201).json({ id });
});

apiRouter.put("/shared-cfg-presets/:id", requirePerm("instance.config.edit"), (req: AuthedRequest, res) => {
  const shared = getOrCreateSharedSettings();
  if (String(req.params.id) !== shared.id) {
    return res.status(404).json({ error: "not found" });
  }
  const serverCfg =
    req.body?.serverCfg && typeof req.body.serverCfg === "object"
      ? (req.body.serverCfg as Record<string, unknown>)
      : shared.serverCfg;
  getDb()
    .prepare(
      `UPDATE shared_cfg_presets SET name='Shared settings', version=version+1, server_cfg=?, updated_at=datetime('now') WHERE id=?`,
    )
    .run(JSON.stringify(serverCfg), shared.id);
  const updated = getDb().prepare("SELECT version FROM shared_cfg_presets WHERE id = ?").get(shared.id) as {
    version: number;
  };
  recordSharedCfgRevision(shared.id, Number(updated.version), serverCfg, {
    id: req.user?.id,
    email: req.user?.email,
  });
  audit(req, "shared_cfg.update", shared.id);
  res.json({ status: "ok", version: Number(updated.version) });
});

apiRouter.delete("/shared-cfg-presets/:id", requirePerm("instance.config.edit"), (_req: AuthedRequest, res) => {
  res.status(400).json({ error: "shared settings cannot be deleted" });
});

apiRouter.get("/shared-cfg-presets/:id/revisions", (req, res) => {
  const row = getDb().prepare("SELECT id FROM shared_cfg_presets WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(listSharedCfgRevisions(String(req.params.id)));
});

apiRouter.get("/shared-cfg-presets/:id/revisions/compare", (req, res) => {
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return res.status(400).json({ error: "a and b version query params required" });
  }
  const left = getSharedCfgRevision(String(req.params.id), a);
  const right = getSharedCfgRevision(String(req.params.id), b);
  if (!left || !right) return res.status(404).json({ error: "revision not found" });
  res.json({ a: left, b: right, changes: diffSnapshots(left.snapshot, right.snapshot) });
});

apiRouter.get("/shared-cfg-presets/:id/revisions/:version", (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isFinite(version)) return res.status(400).json({ error: "invalid version" });
  const rev = getSharedCfgRevision(String(req.params.id), version);
  if (!rev) return res.status(404).json({ error: "not found" });
  res.json(rev);
});

apiRouter.post("/shared-cfg-presets/:id/restore", requirePerm("instance.config.edit"), (req: AuthedRequest, res) => {
  const version = Number(req.body?.version);
  if (!Number.isFinite(version)) return res.status(400).json({ error: "version required" });
  const result = restoreSharedCfgFromRevision(String(req.params.id), version, {
    id: req.user?.id,
    email: req.user?.email,
  });
  if ("error" in result) return res.status(404).json({ error: result.error });
  audit(req, "shared_cfg.restore", String(req.params.id));
  res.json({ status: "ok", version: result.newVersion });
});

apiRouter.delete("/profiles/:id", requirePerm("profile.delete"), (req, res) => {
  getDb().prepare("DELETE FROM mission_profiles WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

/** Find a mission PBO on the panel disk (stored_path, deploy/missions, or quarantine). */
function resolveMissionLocalPath(mission: Record<string, unknown>): string | null {
  const stored = String(mission.stored_path || "");
  if (stored && fs.existsSync(stored)) return stored;

  const pbo = String(mission.pbo_filename || mission.name || "").trim();
  const hash = String(mission.content_hash || "").trim();

  const missionsDir = path.join(config.repoRoot, "deploy", "missions");
  if (pbo && fs.existsSync(missionsDir)) {
    const hit = fs.readdirSync(missionsDir).find((f) => f === pbo || f.endsWith(`-${pbo}`) || f.endsWith(pbo));
    if (hit) {
      const full = path.join(missionsDir, hit);
      if (fs.existsSync(full)) return full;
    }
  }

  const quarantineDir = path.join(config.repoRoot, "deploy", "quarantine");
  if (fs.existsSync(quarantineDir)) {
    const files = fs.readdirSync(quarantineDir);
    let hit =
      (hash && files.find((f) => f.includes(hash.slice(0, 12)))) ||
      (pbo && files.find((f) => f.endsWith(`-${pbo}`) || f.endsWith(pbo)));
    if (hit) {
      const full = path.join(quarantineDir, hit);
      if (fs.existsSync(full)) return full;
    }
  }

  return null;
}

async function hostHasMission(hostId: string, pboFilename: string): Promise<boolean> {
  const hub = getHub();
  try {
    const listing = await hub.dispatch(hostId, "file.list", { root: "mpmissions", relativePath: "" }, 30_000);
    if (!listing.ok) return false;
    const entries = (listing.data?.entries as { name?: string; isDir?: boolean }[]) || [];
    return entries.some((e) => !e.isDir && String(e.name || "").toLowerCase() === pboFilename.toLowerCase());
  } catch {
    return false;
  }
}

async function ensureMissionOnHost(
  hostId: string,
  missionId: string,
  pushProgress: (stage: string, message: string) => void,
  opts?: { required?: boolean },
) {
  const required = !!opts?.required;
  const hub = getHub();
  const mission = getDb().prepare("SELECT * FROM missions WHERE id = ?").get(missionId) as
    | Record<string, unknown>
    | undefined;
  if (!mission) {
    const msg = "Profile mission not found in library — skipped";
    pushProgress("mission", msg);
    if (required) throw new Error(msg);
    return;
  }

  const pboFilename = String(mission.pbo_filename || mission.name || "").trim();
  if (!pboFilename) {
    const msg = "Mission has no filename — skipped";
    pushProgress("mission", msg);
    if (required) throw new Error(msg);
    return;
  }

  pushProgress("mission", `Checking mpmissions for ${pboFilename}`);
  if (await hostHasMission(hostId, pboFilename)) {
    pushProgress("mission", `${pboFilename} already on host — skipped copy`);
    return;
  }

  const localPath = resolveMissionLocalPath(mission);
  if (!localPath) {
    const msg = `${pboFilename} missing on host and not accessible on the panel — re-upload/deploy the mission first`;
    pushProgress("mission", msg);
    if (required) throw new Error(msg);
    return;
  }

  // Persist discovered path for next apply
  if (!mission.stored_path || !fs.existsSync(String(mission.stored_path))) {
    getDb().prepare("UPDATE missions SET stored_path = ? WHERE id = ?").run(localPath, missionId);
  }

  const bytes = fs.readFileSync(localPath);
  const maxBytes = 80 * 1024 * 1024;
  if (bytes.length > maxBytes) {
    throw new Error(`mission file too large to push (${bytes.length} bytes, max 80MB)`);
  }

  pushProgress("mission", `Copying ${pboFilename} to host mpmissions (${bytes.length} bytes)`);
  const dep = await hub.dispatch(
    hostId,
    "file.deploy",
    {
      root: "mpmissions",
      relativePath: pboFilename,
      contentBase64: bytes.toString("base64"),
      skipIfExists: true,
    },
    180_000,
  );
  if (!dep.ok) throw new Error(dep.error || "mission deploy failed");
  if (dep.data?.skipped) {
    pushProgress("mission", `${pboFilename} already on host — skipped copy`);
  } else {
    pushProgress("mission", `Copied ${pboFilename} → ${dep.data?.path || "mpmissions"}`);
  }

  if (!(await hostHasMission(hostId, pboFilename))) {
    throw new Error(`${pboFilename} was not found in host mpmissions after deploy`);
  }
}

function collectProfileWorkshopIds(profile: Record<string, unknown>): string[] {
  const { client, server } = collectProfileWorkshopIdsSplit(profile);
  return [...new Set([...client, ...server])];
}

/** Client ( -mod ) vs server-only ( -serverMod ) workshop IDs from profile + modlist. */
function collectProfileWorkshopIdsSplit(profile: Record<string, unknown>): { client: string[]; server: string[] } {
  const client = new Set<string>();
  const server = new Set<string>();
  const add = (raw: unknown, into: Set<string>) => {
    const s = String(raw || "").trim();
    if (/^\d+$/.test(s)) into.add(s);
  };

  if (profile.modlist_id) {
    const ml = getDb().prepare("SELECT entries FROM modlists WHERE id = ?").get(profile.modlist_id) as
      | { entries: string }
      | undefined;
    const entries = jsonParse<{ workshopId?: string; kind?: string }[]>(ml?.entries, []);
    for (const e of entries) {
      if (e.kind === "server") add(e.workshopId, server);
      else add(e.workshopId, client);
    }
  }

  for (const id of jsonParse<string[]>(String(profile.mods), [])) add(id, client);
  for (const id of jsonParse<string[]>(String(profile.server_mods), [])) add(id, server);
  return { client: [...client], server: [...server] };
}

/** Expand Steam Workshop required items (deps first) for launch / apply.
 * Union BFS first so overlapping deps are fetched once; then split client vs server. */
async function expandProfileWorkshopIds(
  profile: Record<string, unknown>,
  opts: { force?: boolean } = {},
): Promise<{
  client: string[];
  server: string[];
  clientAdded: string[];
  serverAdded: string[];
}> {
  const base = collectProfileWorkshopIdsSplit(profile);
  // Warm the full graph in one batched walk (singleflight + dep cache).
  await expandWorkshopDependencies([...base.client, ...base.server], opts);
  const clientExp = await expandWorkshopDependencies(base.client, opts);
  const serverExp = await expandWorkshopDependencies(base.server, opts);
  const client = uniqueIds(clientExp.ordered);
  const clientSet = new Set(client);
  const server = uniqueIds(serverExp.ordered).filter((id) => !clientSet.has(id));
  return {
    client,
    server,
    clientAdded: clientExp.added,
    serverAdded: serverExp.added.filter((id) => !clientSet.has(id)),
  };
}

function readPersistedResolvedMods(
  profile: Record<string, unknown>,
  opts: { allowExpired?: boolean } = {},
): {
  client: string[];
  server: string[];
} | null {
  const base = collectProfileWorkshopIdsSplit(profile);
  const hash = profileModsSourceHash(base.client, base.server);
  const storedHash = String(profile.resolved_mods_hash || "");
  const at = profile.resolved_mods_at ? String(profile.resolved_mods_at) : null;
  if (!at || storedHash !== hash) return null;
  if (!opts.allowExpired && !isFresh(at, PROFILE_RESOLVED_MAX_AGE_MS)) return null;
  const client = uniqueIds(jsonParse<string[]>(String(profile.resolved_client_mods), []));
  const server = uniqueIds(jsonParse<string[]>(String(profile.resolved_server_mods), [])).filter(
    (id) => !new Set(client).has(id),
  );
  if (!client.length && !server.length && (base.client.length || base.server.length)) return null;
  return { client, server };
}

function persistResolvedMods(
  profileId: string,
  resolved: { client: string[]; server: string[] },
  sourceHash: string,
) {
  getDb()
    .prepare(
      `UPDATE mission_profiles SET resolved_client_mods=?, resolved_server_mods=?, resolved_mods_at=datetime('now'),
       resolved_mods_hash=?, updated_at=datetime('now') WHERE id=?`,
    )
    .run(JSON.stringify(resolved.client), JSON.stringify(resolved.server), sourceHash, profileId);
}

/**
 * Resolve profile workshop IDs for apply/start.
 * Start prefers persisted list (including expired-but-matching) to avoid Steam.
 * Apply uses fresh cache or re-expands when expired / forced; always persists.
 */
async function resolveProfileWorkshopIds(
  profile: Record<string, unknown>,
  opts: { force?: boolean; preferStale?: boolean } = {},
): Promise<{
  client: string[];
  server: string[];
  clientAdded: string[];
  serverAdded: string[];
  fromCache: boolean;
}> {
  const base = collectProfileWorkshopIdsSplit(profile);
  const sourceHash = profileModsSourceHash(base.client, base.server);

  if (!opts.force) {
    const cached = readPersistedResolvedMods(profile, { allowExpired: !!opts.preferStale });
    if (cached) {
      return { ...cached, clientAdded: [], serverAdded: [], fromCache: true };
    }
  }

  const expanded = await expandProfileWorkshopIds(profile, { force: !!opts.force });
  if (profile.id) {
    persistResolvedMods(String(profile.id), { client: expanded.client, server: expanded.server }, sourceHash);
  }
  return { ...expanded, fromCache: false };
}

function uniqueIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Deduplicate -mod= / -serverMod= path segments (same folder must appear once). */
function uniqueLaunchPaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = String(raw || "").trim();
    if (!p) continue;
    const key = process.platform === "win32" ? p.toLowerCase().replace(/\//g, "\\") : p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Write server.cfg (+ optional Arma3Profile) for the profile; ensure mission PBO on host. */
async function writeProfileConfigToHost(
  hostId: string,
  inst: Record<string, unknown>,
  profile: Record<string, unknown>,
  pushProgress?: (stage: string, message: string) => void,
  modCountHint = 0,
): Promise<{ missionTemplate: string; serverCfg: string; mergedCfg: Record<string, unknown> }> {
  const hub = getHub();
  const sharedCfg = resolveInstanceSharedCfg(inst);
  const profileCfg = jsonParse<Record<string, unknown>>(String(profile.server_cfg_overrides), {});
  let mergedCfg = mergeServerCfg(sharedCfg, profileCfg);
  mergedCfg = injectHeadlessIntoServerCfg(
    mergedCfg,
    instanceHeadlessCount(inst),
    effectiveRemoteHcIps(inst),
  );
  if (!String(mergedCfg.hostname || "").trim()) {
    mergedCfg.hostname = String(profile.name || "A3Panel Server");
  }
  const forcedDifficulty = normalizeForcedDifficulty(mergedCfg.forcedDifficulty);
  let missionTemplate = "";
  if (profile.mission_id) {
    const mission = getDb().prepare("SELECT pbo_filename, name FROM missions WHERE id = ?").get(profile.mission_id) as
      | { pbo_filename: string; name: string }
      | undefined;
    missionTemplate = pboToMissionTemplate(mission?.pbo_filename || mission?.name || "");
  }
  const serverCfg = renderServerCfg(mergedCfg, {
    missionTemplate: missionTemplate || undefined,
    missionDifficulty: forcedDifficulty || undefined,
    modCountHint,
  });
  const files: { relativePath: string; content: string }[] = [{ relativePath: "server.cfg", content: serverCfg }];
  if (forcedDifficulty === "Custom") {
    const custom = normalizeCustomDifficulty(jsonParse(String(profile.custom_difficulty), {}));
    files.push({
      relativePath: "Users/server/server.Arma3Profile",
      content: renderArma3Profile(custom),
    });
  }
  const cfgResult = await hub.dispatch(
    hostId,
    "config.apply",
    {
      instanceId: inst.id,
      profileDir: inst.profile_dir,
      files,
    },
    60_000,
  );
  if (!cfgResult.ok) throw new Error(cfgResult.error || "config.apply failed");

  if (profile.mission_id) {
    await ensureMissionOnHost(hostId, profile.mission_id as string, pushProgress || (() => {}), {
      required: true,
    });
  }

  return { missionTemplate, serverCfg, mergedCfg };
}

function clientModPartsForLaunch(
  host: Record<string, unknown>,
  profile: Record<string, unknown> | null,
  resolvedPaths: Record<string, string>,
  preExpanded?: { client: string[]; server: string[] },
): string[] {
  if (!profile) return [];
  const armaRoot = String(host.arma_root || "").replace(/[/\\]+$/, "");
  const dlcs = normalizeDlcCodes(jsonParse(String(profile.dlcs), []));
  const split = preExpanded || collectProfileWorkshopIdsSplit(profile);
  const client = uniqueIds(split.client);
  const libPath = String(host.mods_library_path || "");
  const pathFor = (id: string) => {
    const resolved = resolvedPaths?.[id];
    if (resolved && String(resolved).trim()) return String(resolved).trim();
    return modFolderLaunchArg(armaRoot, libPath, id);
  };
  return uniqueLaunchPaths([...dlcs, ...client.map(pathFor)]);
}

function buildHeadlessPayload(
  host: Record<string, unknown>,
  inst: Record<string, unknown>,
  profile: Record<string, unknown> | null,
  resolvedPaths: Record<string, string>,
  preExpanded: { client: string[]; server: string[] } | undefined,
  mergedCfg: Record<string, unknown>,
  countOverride?: number,
): { name: string; args: string[]; profileDir: string; port: number }[] {
  const count = countOverride != null ? clampHeadlessCount(countOverride) : instanceHeadlessCount(inst);
  if (count <= 0) return [];
  const modParts = clientModPartsForLaunch(host, profile, resolvedPaths, preExpanded);
  const specs = buildHeadlessLaunchSpecs({
    count,
    serverPort: Number(inst.port) || 2302,
    instanceProfileDir: String(inst.profile_dir || "profiles"),
    password: serverCfgPassword(mergedCfg),
    modParts,
  });
  return specs.map((s) => ({
    name: s.name,
    args: s.args,
    profileDir: s.profileDir,
    port: s.port,
  }));
}

/** Resolve mods + write config so Start/Restart launch with the loaded profile. */
async function prepareProfileLaunch(
  hostId: string,
  host: Record<string, unknown>,
  inst: Record<string, unknown>,
  profile: Record<string, unknown>,
): Promise<{ client: string[]; server: string[]; resolvedPaths: Record<string, string>; missionTemplate: string }> {
  const expanded = await resolveProfileWorkshopIds(profile, { preferStale: true });
  const client = expanded.client;
  const server = expanded.server;
  const workshopIds = uniqueIds([...client, ...server]);

  await writeProfileConfigToHost(hostId, inst, profile, undefined, client.length);

  if (workshopIds.length) {
    const modsLibraryPath = String(host.mods_library_path || "").trim();
    const libraryPath = modsLibraryPath
      ? resolveModsLibraryPath(String(host.arma_root || ""), modsLibraryPath)
      : "";
    const hub = getHub();
    const modCheckPayload: Record<string, unknown> = { workshopIds, ensureLocalLinks: true };
    if (libraryPath) modCheckPayload.libraryPath = libraryPath;
    try {
      await hub.dispatch(hostId, "mod.check", modCheckPayload, 60_000);
    } catch {
      /* launch still proceeds */
    }
  }

  const resolvedPaths = await resolveModLaunchPaths(hostId, host, workshopIds);

  if (workshopIds.length) {
    const modsLibraryPath = String(host.mods_library_path || "").trim();
    const libraryPath = modsLibraryPath
      ? resolveModsLibraryPath(String(host.arma_root || ""), modsLibraryPath)
      : "";
    const hub = getHub();
    const keysPayload: Record<string, unknown> = {
      workshopIds,
      modPaths: uniqueLaunchPaths(Object.values(resolvedPaths)),
    };
    if (libraryPath) keysPayload.libraryPath = libraryPath;
    try {
      await hub.dispatch(hostId, "keys.sync", keysPayload, 120_000);
    } catch {
      /* launch still proceeds */
    }
  }

  let missionTemplate = "";
  if (profile.mission_id) {
    const mission = getDb().prepare("SELECT pbo_filename, name FROM missions WHERE id = ?").get(profile.mission_id) as
      | { pbo_filename: string; name: string }
      | undefined;
    missionTemplate = pboToMissionTemplate(mission?.pbo_filename || mission?.name || "");
  }
  return { client, server, resolvedPaths, missionTemplate };
}

/** Build Arma launch args from the instance's current (or given) mission profile. */
function buildInstanceLaunchArgs(
  host: Record<string, unknown>,
  inst: Record<string, unknown>,
  profile: Record<string, unknown> | null,
  resolvedPaths?: Record<string, string>,
  preExpanded?: { client: string[]; server: string[] },
  opts?: { missionTemplate?: string },
): string[] {
  const armaRoot = String(host.arma_root || "").replace(/[/\\]+$/, "");
  const profileDir = String(inst.profile_dir || "profiles");
  const profilePath = path.isAbsolute(profileDir) ? profileDir : path.join(armaRoot, profileDir);
  const configPath = path.join(profilePath, "server.cfg");

  const args: string[] = [
    `-config=${configPath}`,
    "-name=server",
  ];

  if (!profile) return args;

  const dlcs = normalizeDlcCodes(jsonParse(String(profile.dlcs), []));
  const split = preExpanded || collectProfileWorkshopIdsSplit(profile);
  const client = uniqueIds(split.client);
  const clientSet = new Set(client);
  const server = uniqueIds(split.server).filter((id) => !clientSet.has(id));
  const libPath = String(host.mods_library_path || "");
  const pathFor = (id: string) => {
    const resolved = resolvedPaths?.[id];
    if (resolved && String(resolved).trim()) return String(resolved).trim();
    return modFolderLaunchArg(armaRoot, libPath, id);
  };
  const modParts = uniqueLaunchPaths([...dlcs, ...client.map(pathFor)]);
  const serverModParts = uniqueLaunchPaths(server.map(pathFor));
  if (modParts.length) args.push(`-mod=${modParts.join(";")}`);
  if (serverModParts.length) args.push(`-serverMod=${serverModParts.join(";")}`);

  const missionTemplate = String(opts?.missionTemplate || "").trim();
  const extra = jsonParse<string[]>(String(profile.extra_args), []);
  const extraNorm = extra.map((a) => String(a || "").trim()).filter(Boolean);
  const hasAutoInit = extraNorm.some((a) => a.toLowerCase() === "-autoinit");
  // BI: -autoInit is ignored unless server.cfg has persistent=1. We default persistent on
  // when a mission template is present (see renderServerCfg).
  if (missionTemplate && !hasAutoInit) {
    args.push("-autoInit");
  }
  for (const s of extraNorm) {
    args.push(s);
  }
  return args;
}

async function resolveModLaunchPaths(
  hostId: string,
  host: Record<string, unknown>,
  workshopIds: string[],
): Promise<Record<string, string>> {
  if (!workshopIds.length) return {};
  // Only override agent.json when the host has an explicit mods library path in the panel.
  const configured = String(host.mods_library_path || "").trim();
  const payload: Record<string, unknown> = { workshopIds };
  if (configured) {
    payload.libraryPath = resolveModsLibraryPath(String(host.arma_root || ""), configured);
  }
  try {
    const check = await getHub().dispatch(hostId, "mod.check", payload, 60_000);
    if (!check.ok || !check.data?.paths || typeof check.data.paths !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(check.data.paths as Record<string, unknown>)) {
      if (v != null && String(v).trim()) out[k] = String(v).trim();
    }
    return out;
  } catch {
    return {};
  }
}

async function steamcmdAwait(
  hostId: string,
  op: "mod.download" | "steam.app.update",
  payload: Record<string, unknown>,
  pushProgress: (stage: string, message: string) => void,
  stage: string,
  label: string,
  timeoutMs: number,
) {
  const hub = getHub();
  hub.clearLogs(hostId);
  hub.setSteamDownloading(hostId, String(payload.jobId || op), String(payload.workshopId || payload.appId || label));
  pushProgress(stage, `SteamCMD: ${label}`);
  const result = await hub.dispatch(hostId, op, payload, timeoutMs);
  const st = hub.getSteamStatus(hostId);
  st.running = false;
  if (!result.ok) st.error = result.error || result.message;
  hub.emit("steamcmd-status", hostId, st);
  if (!result.ok) {
    const summary = result.error || result.message || `${label} failed`;
    const hint =
      result.error && result.message && result.message !== result.error ? String(result.message) : "";
    let failedIds = Array.isArray(result.data?.failedWorkshopIds)
      ? (result.data!.failedWorkshopIds as string[]).map(String).filter((id) => /^\d+$/.test(id))
      : [];
    if (!failedIds.length) {
      const fromPayload = [
        ...(Array.isArray(payload.workshopIds) ? payload.workshopIds.map(String) : []),
        ...(payload.workshopId ? [String(payload.workshopId)] : []),
      ].filter((id) => /^\d+$/.test(id));
      // Prefer IDs mentioned in the SteamCMD summary; else all requested when a batch failed.
      const mentioned = [...summary.matchAll(/\b(\d{6,12})\b/g)].map((m) => m[1]);
      failedIds = [...new Set(mentioned.length ? mentioned : fromPayload)];
    }
    const parts: string[] = [];
    if (failedIds.length) {
      const refs = await formatWorkshopRefList(failedIds);
      parts.push(`SteamCMD failed for ${failedIds.length} workshop item(s):`);
      if (refs) parts.push(refs);
      if (!summary.startsWith("SteamCMD failed")) parts.push(summary);
    } else {
      parts.push(summary);
    }
    if (hint && hint !== summary) parts.push(hint);
    const errMsg = parts.join("\n");
    st.error = errMsg;
    hub.emit("steamcmd-status", hostId, st);
    throw new Error(errMsg);
  }
  pushProgress(stage, result.message || `${label} done`);
}

apiRouter.post("/profiles/:id/apply", requirePerm("profile.apply"), async (req: AuthedRequest, res) => {
  const profile = getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!profile) return res.status(404).json({ error: "not found" });
  const targetInstanceId = String(req.body?.instanceId || "").trim();
  if (!targetInstanceId) return res.status(400).json({ error: "instanceId required" });
  const inst = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(targetInstanceId) as
    | Record<string, unknown>
    | undefined;
  if (!inst) return res.status(404).json({ error: "instance not found" });
  const hostRow = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(inst.host_id) as Record<string, unknown> | undefined;
  if (!hostRow) return res.status(404).json({ error: "host not found" });

  const downloadMods = req.body?.downloadMods !== false;
  const updateServer = !!req.body?.updateServer;
  const validate = !!req.body?.validate;
  const matchHeadlessRecommendation = !!req.body?.matchHeadlessRecommendation;
  const profileDlcs = normalizeDlcCodes(jsonParse(String(profile.dlcs), []));
  const armaRoot = String(hostRow.arma_root || "");
  const modsLibraryPath = String(hostRow.mods_library_path || "").trim();
  // Prefer panel host setting; if unset, omit libraryPath so the agent uses agent.json modsLibraryPath.
  const libraryPath = modsLibraryPath ? resolveModsLibraryPath(armaRoot, modsLibraryPath) : "";
  const defaultLibrary = !modsLibraryPath || isDefaultModsLibrary(armaRoot, modsLibraryPath);
  // SteamCMD always installs under armaRoot workshop — never into a shared mods library.
  const maySteamMods = downloadMods;
  let steamPayload: ReturnType<typeof steamCredsPayload> | null = null;
  if (maySteamMods || updateServer) {
    try {
      steamPayload = steamCredsPayload(resolveSteamAccount(req.body?.steamAccountId));
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : "Steam account required" });
    }
  }

  if (matchHeadlessRecommendation) {
    const rec = recommendedHeadlessFromProfile(profile);
    if (rec != null) {
      getDb().prepare("UPDATE instances SET headless_count = ? WHERE id = ?").run(rec, inst.id);
      (inst as Record<string, unknown>).headless_count = rec;
    }
  }
  const hostId = String(inst.host_id);
  const hub = getHub();
  const jobId = uuid();
  const progress: { stage: string; message: string; at: string }[] = [];
  const pushProgress = (stage: string, message: string) => {
    progress.push({ stage, message, at: new Date().toISOString() });
    getDb()
      .prepare(`UPDATE jobs SET stage=?, progress=?, state=?, updated_at=datetime('now') WHERE id=?`)
      .run(stage, JSON.stringify(progress), stage === "failed" ? "failed" : "running", jobId);
  };

  getDb()
    .prepare(
      `INSERT INTO jobs(id, kind, host_id, instance_id, profile_id, state, stage, progress, requested_by)
       VALUES (?, 'apply_profile', ?, ?, ?, 'running', 'start', ?, ?)`,
    )
    .run(jobId, hostId, String(inst.id), req.params.id, JSON.stringify(progress), req.user?.id || null);
  pruneInstanceJobs(String(inst.id));

  if (!hub.isOnline(hostId)) {
    pushProgress("failed", "agent offline");
    getDb().prepare("UPDATE jobs SET error=? WHERE id=?").run("agent offline", jobId);
    return res.status(503).json({ error: "agent offline", jobId });
  }

  // Return immediately; SteamCMD can take a long time. Client polls job / SteamCMD logs.
  res.json({
    jobId,
    status: "started",
    instanceId: inst.id,
    hostId,
    profileId: req.params.id,
    profileName: profile.name,
    downloadedMods: downloadMods,
    updatedServer: updateServer,
    modsLibraryPath: libraryPath || undefined,
  });

  void (async () => {
    try {
      const live = hub.getInstanceStatus(hostId, String(inst.id));
      let wasRunning =
        String(live?.state || "").toLowerCase() === "running" ||
        String(live?.state || "").toLowerCase() === "starting" ||
        !!live?.pid ||
        String(inst.state || "").toLowerCase() === "running" ||
        String(inst.state || "").toLowerCase() === "starting";

      const controlPayload = {
        instanceId: String(inst.id),
        port: Number(inst.port) || 2302,
        profileDir: String(inst.profile_dir || "profiles"),
        armaRoot: String(hostRow.arma_root || ""),
      };

      // Always stop before writing server.cfg — Arma locks it while running.
      // Stop is idempotent and also kills orphan processes (agent restart, lost handle).
      pushProgress("instance", wasRunning ? "Stopping running instance before apply…" : "Ensuring instance is stopped before writing config…");
      const stop = await hub.dispatch(hostId, "instance.stop", controlPayload, 120_000);
      if (!stop.ok) throw new Error(stop.error || stop.message || "failed to stop instance");
      if (stop.data?.killed === true) wasRunning = true;
      getDb().prepare("UPDATE instances SET state = 'stopped' WHERE id = ?").run(inst.id);
      pushProgress(
        "instance",
        stop.data?.killed === true
          ? `Instance stopped (pid(s) ${(Array.isArray(stop.data?.killedPids) ? stop.data.killedPids : []).join(", ") || "ok"})`
          : "Instance was already stopped",
      );

      let needCreatorBranchUpdate = false;
      let needFreshInstall = false;
      // Always probe install state (binary + optional CDLC folders). Fresh hosts have no Arma install.
      pushProgress(
        "server_update",
        profileDlcs.length
          ? `Checking Arma install / Creator DLC branch for: ${profileDlcs.join(", ")}`
          : "Checking whether Arma dedicated server is installed…",
      );
      const dlcCheck = await hub.dispatch(
        hostId,
        "host.dlc.check",
        { codes: profileDlcs, armaRoot },
        30_000,
      );
      if (!dlcCheck.ok) {
        // Older agents: if profile needs CDLCs, assume we need creatordlc; otherwise try host.info.
        if (profileDlcs.length) {
          pushProgress(
            "server_update",
            `Could not detect branch (${dlcCheck.error || dlcCheck.message || "unsupported"}) — will install creatordlc if Steam is available`,
          );
          needCreatorBranchUpdate = true;
        } else {
          try {
            const info = await hub.dispatch(hostId, "host.info", {}, 30_000);
            if (info.data) hub.setBootstrap(hostId, info.data);
            if (info.data?.armaServerPresent !== true) {
              needFreshInstall = true;
              pushProgress(
                "server_update",
                "Arma dedicated server not installed — will download creatordlc branch",
              );
            } else {
              pushProgress("server_update", "Arma dedicated server present");
            }
          } catch {
            pushProgress(
              "server_update",
              "Could not detect Arma install — will attempt creatordlc install if Steam is available",
            );
            needFreshInstall = true;
          }
        }
      } else {
        if (dlcCheck.data) {
          const prev = hub.getHostLive(hostId).bootstrap || {};
          hub.setBootstrap(hostId, { ...prev, ...dlcCheck.data });
        }
        const armaPresentField = dlcCheck.data?.armaServerPresent;
        const onCreator = dlcCheck.data?.onCreatorBranch === true;
        const missing = Array.isArray(dlcCheck.data?.missing)
          ? (dlcCheck.data!.missing as string[]).map(String)
          : [];
        const beta = String(dlcCheck.data?.beta || "");
        // Prefer explicit agent flag; fall back to branch evidence for older agents.
        const armaPresent =
          armaPresentField === true ||
          (armaPresentField !== false && (onCreator || beta.length > 0));
        if (!armaPresent) {
          needFreshInstall = true;
          pushProgress(
            "server_update",
            "Arma dedicated server not installed under armaRoot — downloading creatordlc branch",
          );
        } else if (profileDlcs.length) {
          if (onCreator && missing.length === 0) {
            pushProgress(
              "server_update",
              "Already on creatordlc branch with required CDLC folders — skipping branch change",
            );
          } else if (onCreator && missing.length) {
            pushProgress(
              "server_update",
              `On creatordlc but missing folders (${missing.join(", ")}) — updating dedicated server`,
            );
            needCreatorBranchUpdate = true;
          } else {
            pushProgress(
              "server_update",
              beta
                ? `Dedicated server branch is “${beta}” — switching to creatordlc`
                : "Dedicated server not on creatordlc — installing creatordlc branch",
            );
            needCreatorBranchUpdate = true;
          }
        } else {
          pushProgress("server_update", "Arma dedicated server present");
        }
      }

      const runServerUpdate = updateServer || needCreatorBranchUpdate || needFreshInstall;
      // Fresh installs and CDLC profiles always use the creatordlc Steam branch.
      const useCreatorBeta =
        needFreshInstall || (profileDlcs.length > 0 && (needCreatorBranchUpdate || updateServer));
      if (runServerUpdate) {
        if (!steamPayload) {
          try {
            steamPayload = steamCredsPayload(resolveSteamAccount(req.body?.steamAccountId));
          } catch (e) {
            throw new Error(
              e instanceof Error
                ? e.message
                : needFreshInstall
                  ? "Steam account required to download the Arma dedicated server (creatordlc)"
                  : "Steam account required to install/update the Creator DLC server branch",
            );
          }
        }
        await steamcmdAwait(
          hostId,
          "steam.app.update",
          {
            appId: "233780",
            ...steamPayload,
            validate,
            jobId: `${jobId}:server`,
            ...(useCreatorBeta ? { beta: "creatordlc" } : {}),
          },
          pushProgress,
          "server_update",
          useCreatorBeta
            ? needFreshInstall
              ? "installing Arma 3 dedicated server (233780 -beta creatordlc)"
              : "updating Arma 3 dedicated server (233780 -beta creatordlc)"
            : "updating Arma 3 dedicated server (233780)",
          2 * 60 * 60 * 1000,
        );
      }

      const expanded = await resolveProfileWorkshopIds(profile, {
        force: !!req.body?.refreshDeps,
        preferStale: false,
      });
      const workshopIds = [...expanded.client, ...expanded.server];
      if (workshopIds.length === 0) {
        pushProgress("mods", "No workshop mods on this profile");
      } else {
        if (expanded.fromCache) {
          pushProgress("mods", `Using cached resolved mod list (${workshopIds.length} items)`);
        } else if (expanded.clientAdded.length || expanded.serverAdded.length) {
          pushProgress(
            "mods",
            `Steam Workshop deps: +${expanded.clientAdded.length + expanded.serverAdded.length} required item(s) → ${workshopIds.length} total`,
          );
        }
        const modCheckPayload: Record<string, unknown> = {
          workshopIds,
          // Agent no-ops if library == local workshop; creates mods\ junctions for shared !Workshop etc.
          ensureLocalLinks: true,
        };
        if (libraryPath) modCheckPayload.libraryPath = libraryPath;
        pushProgress(
          "mods",
          libraryPath
            ? `Checking shared mods library (read-only): ${libraryPath}`
            : "Checking mods (agent.json modsLibraryPath / local workshop / mods / @*)",
        );
        const check = await hub.dispatch(hostId, "mod.check", modCheckPayload, 60_000);
        if (!check.ok) throw new Error(check.error || check.message || "mod check failed");
        const usedLibrary = String(check.data?.libraryPath || libraryPath || "(unknown)");
        const sharedReadOnly = check.data?.libraryReadOnly === true || (!!libraryPath && !defaultLibrary);
        pushProgress("mods", `Resolved library path: ${usedLibrary}`);
        if (check.data?.scanNote) pushProgress("mods", String(check.data.scanNote));
        const present = Array.isArray(check.data?.present) ? (check.data!.present as string[]) : [];
        let missing = Array.isArray(check.data?.missing) ? (check.data!.missing as string[]) : [...workshopIds];
        const linksCreated = Array.isArray(check.data?.linksCreated) ? (check.data!.linksCreated as string[]) : [];
        if (linksCreated.length) {
          pushProgress("mods", `Created ${linksCreated.length} local junction(s) under mods\\ → shared library (shared untouched)`);
        }
        if (missing.length) {
          const refs = await formatWorkshopRefList(missing);
          const hints = Array.isArray(check.data?.missingHints)
            ? (check.data!.missingHints as string[]).filter(Boolean)
            : [];
          pushProgress(
            "mods",
            `${present.length} present, ${missing.length} missing:\n` +
              (refs || missing.map((id) => `• ${id} — ${workshopUrl(id)}`).join("\n")) +
              (hints.length ? `\n${hints.map((h) => `• ${h}`).join("\n")}` : ""),
          );
        } else {
          pushProgress("mods", `${present.length} present, 0 missing`);
        }

        if (missing.length && downloadMods) {
          // SteamCMD always writes to {armaRoot}\steamapps\workshop\content\107410 — never the shared library.
          pushProgress(
            "mods",
            sharedReadOnly
              ? `SteamCMD will download ${missing.length} missing mod(s) into local armaRoot workshop (shared library stays read-only)`
              : `SteamCMD downloading ${missing.length} missing workshop mod(s)`,
          );
          await steamcmdAwait(
            hostId,
            "mod.download",
            {
              workshopIds: missing,
              ...steamPayload!,
              validate,
              jobId: `${jobId}:mods`,
            },
            pushProgress,
            "mods",
            `downloading ${missing.length} missing workshop mod(s) into local armaRoot`,
            2 * 60 * 60 * 1000,
          );
          const recheckPayload: Record<string, unknown> = { workshopIds: missing, ensureLocalLinks: false };
          if (libraryPath) recheckPayload.libraryPath = libraryPath;
          const recheck = await hub.dispatch(hostId, "mod.check", recheckPayload, 60_000);
          if (!recheck.ok) throw new Error(recheck.error || recheck.message || "mod re-check failed");
          missing = Array.isArray(recheck.data?.missing) ? (recheck.data!.missing as string[]) : missing;
          if (missing.length) {
            const refs = await formatWorkshopRefList(missing);
            throw new Error(
              `Mods still missing after SteamCMD (${missing.length}):\n` +
                (refs ? `${refs}\n` : `${missing.join(", ")}\n`) +
                (sharedReadOnly
                  ? "Place them on the shared library or fix Steam ownership, then re-apply."
                  : "Check SteamCMD logs / Arma ownership."),
            );
          }
          pushProgress("mods", "SteamCMD finished — all mods present (local workshop and/or shared)");
        } else if (missing.length) {
          // User chose not to SteamCMD — still apply config / switch profile; warn only.
          const refs = await formatWorkshopRefList(missing);
          pushProgress(
            "mods",
            `Continuing without SteamCMD — ${missing.length} mod(s) not found on host (start may fail until they are present):\n` +
              (refs || missing.map((id) => `• ${id} — ${workshopUrl(id)}`).join("\n")),
          );
        } else {
          pushProgress(
            "mods",
            sharedReadOnly || libraryPath
              ? "All profile mods resolved from shared library and/or local workshop — skipped SteamCMD"
              : "All profile mods present — skipped SteamCMD",
          );
        }
      }

      pushProgress("config", "Writing profile config to host");
      const { missionTemplate } = await writeProfileConfigToHost(
        hostId,
        inst,
        profile,
        pushProgress,
        expanded.client.length,
      );
      if (missionTemplate) {
        pushProgress("config", `server.cfg will load mission template “${missionTemplate}”`);
      }

      if (workshopIds.length) {
        pushProgress("keys", "Copying .bikey files from loaded mods into armaRoot\\keys");
        const resolvedPaths = await resolveModLaunchPaths(hostId, hostRow, workshopIds);
        const keysPayload: Record<string, unknown> = {
          workshopIds,
          modPaths: uniqueLaunchPaths(Object.values(resolvedPaths)),
        };
        if (libraryPath) keysPayload.libraryPath = libraryPath;
        const keysResult = await hub.dispatch(hostId, "keys.sync", keysPayload, 120_000);
        if (!keysResult.ok) throw new Error(keysResult.error || keysResult.message || "keys.sync failed");
        const copied = Number(keysResult.data?.copiedCount ?? 0);
        const unchanged = Number(keysResult.data?.unchangedCount ?? 0);
        const noKeys = Array.isArray(keysResult.data?.modsWithoutKeys)
          ? (keysResult.data!.modsWithoutKeys as string[])
          : [];
        const missing = Array.isArray(keysResult.data?.missingMods)
          ? (keysResult.data!.missingMods as string[])
          : [];
        pushProgress(
          "keys",
          keysResult.message ||
            `Keys: ${copied} copied, ${unchanged} already present` +
              (noKeys.length ? `; ${noKeys.length} mod(s) had no .bikey` : "") +
              (missing.length ? `; ${missing.length} mod folder(s) not found` : ""),
        );
        if (noKeys.length) {
          pushProgress(
            "keys",
            `No .bikey in: ${noKeys.slice(0, 12).join(", ")}${noKeys.length > 12 ? "…" : ""} (unsigned / server-only).`,
          );
        }
        if (missing.length) {
          pushProgress(
            "keys",
            `Could not resolve folder for: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? "…" : ""}`,
          );
        }
      }

      getDb().prepare("UPDATE instances SET current_profile_id = ? WHERE id = ?").run(req.params.id, inst.id);

      if (wasRunning) {
        pushProgress("instance", "Starting instance with the applied profile…");
        const freshInst =
          (getDb().prepare("SELECT * FROM instances WHERE id = ?").get(inst.id) as Record<string, unknown>) || inst;
        const resolvedPaths = await resolveModLaunchPaths(hostId, hostRow, [
          ...expanded.client,
          ...expanded.server,
        ]);
        const args = buildInstanceLaunchArgs(
          hostRow,
          freshInst,
          profile,
          resolvedPaths,
          {
            client: expanded.client,
            server: expanded.server,
          },
          { missionTemplate },
        );
        const sharedCfg = resolveInstanceSharedCfg(freshInst);
        const profileCfg = jsonParse<Record<string, unknown>>(String(profile.server_cfg_overrides), {});
        const mergedCfg = injectHeadlessIntoServerCfg(
          mergeServerCfg(sharedCfg, profileCfg),
          instanceHeadlessCount(freshInst),
          effectiveRemoteHcIps(freshInst),
        );
        const headless = buildHeadlessPayload(
          hostRow,
          freshInst,
          profile,
          resolvedPaths,
          { client: expanded.client, server: expanded.server },
          mergedCfg,
        );
        const start = await hub.dispatch(
          hostId,
          "instance.start",
          { ...controlPayload, args, headless },
          180_000,
        );
        if (!start.ok) {
          getDb().prepare("UPDATE instances SET state = 'stopped' WHERE id = ?").run(inst.id);
          throw new Error(
            `Profile applied, but restart failed: ${start.error || start.message || "instance.start failed"}`,
          );
        }
        const state = String(start.data?.state || "running");
        getDb().prepare("UPDATE instances SET state = ? WHERE id = ?").run(state, inst.id);
        pushProgress(
          "instance",
          headless.length
            ? `Instance restarted with applied profile (${headless.length} headless client(s))`
            : "Instance restarted with applied profile",
        );
      }

      pushProgress("done", wasRunning ? "Profile applied and instance restarted" : "Profile applied");
      getDb().prepare("UPDATE jobs SET state='done', stage='done', error='', updated_at=datetime('now') WHERE id=?").run(jobId);
      audit(req, "profile.apply", String(req.params.id), "ok");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "apply failed";
      pushProgress("failed", msg);
      getDb().prepare("UPDATE jobs SET state='failed', error=?, updated_at=datetime('now') WHERE id=?").run(msg, jobId);
      audit(req, "profile.apply", String(req.params.id), "failed");
    }
  })();
});

apiRouter.get("/jobs/active", (_req, res) => {
  res.json(listActiveJobs());
});

apiRouter.get("/jobs/:id", (req, res) => {
  const j = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!j) return res.status(404).json({ error: "not found" });
  res.json(jobDto(j));
});

// ---- config preview ----
apiRouter.post("/config/preview", (req, res) => {
  const shared = (req.body?.sharedServerCfg || {}) as Record<string, unknown>;
  const overrides = (req.body?.serverCfgOverrides || req.body?.serverCfg || {}) as Record<string, unknown>;
  const merged = mergeServerCfg(shared, overrides);
  const missionTemplate = req.body?.missionTemplate
    ? pboToMissionTemplate(String(req.body.missionTemplate))
    : undefined;
  res.json({
    serverCfg: renderServerCfg(merged, {
      missionTemplate,
      missionDifficulty: normalizeForcedDifficulty(merged.forcedDifficulty) || undefined,
    }),
  });
});

// ---- modlists ----
function modlistDto(row: Record<string, unknown>) {
  const entries = jsonParse(String(row.entries), [] as { workshopId: string; name?: string; kind: string }[]);
  const meta = readCachedWorkshopMeta(entries.map((e) => e.workshopId));
  return {
    id: row.id,
    name: row.name,
    sourceFilename: row.source_filename || "",
    entries: entries.map((e) => {
      const m = meta.get(e.workshopId);
      return {
        workshopId: e.workshopId,
        name: e.name || m?.title || e.workshopId,
        kind: e.kind || "client",
        previewUrl: m?.previewUrl || undefined,
        workshopUrl: workshopUrl(e.workshopId),
      };
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertModFromEntry(workshopId: string, name: string, kind: string) {
  const existing = getDb().prepare("SELECT id FROM mods WHERE workshop_id = ?").get(workshopId) as { id: string } | undefined;
  const id = existing?.id || uuid();
  getDb()
    .prepare(
      `INSERT INTO mods(id, workshop_id, name, kind, bikeys) VALUES (?, ?, ?, ?, '[]')
       ON CONFLICT(workshop_id) DO UPDATE SET name=CASE WHEN excluded.name != excluded.workshop_id THEN excluded.name ELSE mods.name END, kind=excluded.kind`,
    )
    .run(id, workshopId, name || workshopId, kind === "server" ? "server" : "client");
  return id;
}

apiRouter.get("/modlists", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM modlists ORDER BY name").all() as Record<string, unknown>[];
  res.json(rows.map(modlistDto));
});

apiRouter.get("/modlists/:id", (req, res) => {
  const row = getDb().prepare("SELECT * FROM modlists WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(modlistDto(row));
});

apiRouter.post("/modlists", requirePerm("mod.manage"), (req, res) => {
  const b = req.body || {};
  const entries = Array.isArray(b.entries) ? b.entries : [];
  const id = uuid();
  getDb()
    .prepare(`INSERT INTO modlists(id, name, source_filename, entries) VALUES (?, ?, ?, ?)`)
    .run(id, String(b.name || "Modlist"), String(b.sourceFilename || ""), JSON.stringify(entries));
  for (const e of entries) {
    if (e?.workshopId) upsertModFromEntry(String(e.workshopId), String(e.name || e.workshopId), String(e.kind || "client"));
  }
  res.status(201).json({ id });
});

apiRouter.put("/modlists/:id", requirePerm("mod.manage"), (req, res) => {
  const b = req.body || {};
  const existing = getDb().prepare("SELECT * FROM modlists WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!existing) return res.status(404).json({ error: "not found" });
  const entries = Array.isArray(b.entries) ? b.entries : jsonParse(String(existing.entries), []);
  getDb()
    .prepare(`UPDATE modlists SET name=?, entries=?, updated_at=datetime('now') WHERE id=?`)
    .run(String(b.name ?? existing.name), JSON.stringify(entries), req.params.id);
  for (const e of entries as { workshopId?: string; name?: string; kind?: string }[]) {
    if (e?.workshopId) upsertModFromEntry(String(e.workshopId), String(e.name || e.workshopId), String(e.kind || "client"));
  }
  res.json({ status: "ok" });
});

apiRouter.delete("/modlists/:id", requirePerm("mod.manage"), (req, res) => {
  getDb().prepare("DELETE FROM modlists WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

apiRouter.post("/modlists/import", requirePerm("mod.manage"), upload.single("file"), async (req: AuthedRequest, res) => {
  const html = req.file?.buffer?.toString("utf8") || String(req.body?.html || "");
  if (!html.trim()) return res.status(400).json({ error: "html or file required" });
  const entries = parseArmaModlistHtml(html);
  if (!entries.length) return res.status(400).json({ error: "no workshop ids found in modlist.html" });
  const name = String(req.body?.name || req.file?.originalname?.replace(/\.html?$/i, "") || "Imported modlist");
  const sourceFilename = req.file?.originalname || String(req.body?.sourceFilename || "modlist.html");
  const id = uuid();
  getDb()
    .prepare(`INSERT INTO modlists(id, name, source_filename, entries) VALUES (?, ?, ?, ?)`)
    .run(id, name, sourceFilename, JSON.stringify(entries));
  for (const e of entries) upsertModFromEntry(e.workshopId, e.name || e.workshopId, e.kind);
  try {
    await ensureWorkshopMeta(entries.map((e) => e.workshopId));
  } catch (e) {
    console.warn("workshop meta after import", e);
  }
  audit(req, "modlist.import", id);
  const row = getDb().prepare("SELECT * FROM modlists WHERE id = ?").get(id) as Record<string, unknown>;
  res.status(201).json({ ...modlistDto(row), entryCount: entries.length });
});

// ---- mods ----
apiRouter.get("/mods", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM mods ORDER BY name").all() as Record<string, unknown>[];
  res.json(
    rows.map((m) => ({
      id: m.id,
      workshopId: m.workshop_id,
      name: m.workshop_title || m.name,
      kind: m.kind,
      bikeys: jsonParse<string[]>(String(m.bikeys), []),
      previewUrl: m.preview_url || undefined,
      workshopUrl: workshopUrl(String(m.workshop_id)),
    })),
  );
});

apiRouter.post("/mods/resolve-deps", requirePerm("mod.manage"), async (req: AuthedRequest, res) => {
  const ids = Array.isArray(req.body?.workshopIds) ? req.body.workshopIds.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: "workshopIds required" });
  try {
    const force = !!req.body?.force;
    const expanded = await expandWorkshopDependencies(ids, { force });
    // Titles from cache only; fill gaps without force-refreshing the whole set
    await ensureWorkshopMeta(expanded.ordered).catch(() => {});
    const meta = readCachedWorkshopMeta(expanded.ordered);
    res.json({
      roots: expanded.roots,
      ordered: expanded.ordered,
      added: expanded.added,
      mods: expanded.ordered.map((id) => ({
        workshopId: id,
        title: meta.get(id)?.title || id,
        workshopUrl: workshopUrl(id),
        isRoot: expanded.roots.includes(id),
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "dependency resolve failed" });
  }
});

apiRouter.post("/mods/workshop-meta", async (req: AuthedRequest, res) => {
  const ids = Array.isArray(req.body?.workshopIds)
    ? req.body.workshopIds.map(String)
    : getDb()
        .prepare("SELECT workshop_id FROM mods")
        .all()
        .map((r) => String((r as { workshop_id: string }).workshop_id));
  const force = !!req.body?.force;
  const refreshExpired = !!req.body?.refreshExpired;
  const meta = refreshExpired || force
    ? await refreshExpiredWorkshopMeta(ids, { force })
    : await ensureWorkshopMeta(ids, { force: false });
  res.json(
    Object.fromEntries(
      [...meta.entries()].map(([id, m]) => [
        id,
        { workshopId: id, title: m.title, previewUrl: m.previewUrl, workshopUrl: workshopUrl(id) },
      ]),
    ),
  );
});

apiRouter.get("/mods/workshop-search", async (req: AuthedRequest, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q required" });
  try {
    const byId = parseWorkshopId(q);
    if (byId) {
      // Cache first; network only if unknown
      let m = readCachedWorkshopMeta([byId]).get(byId);
      if (!m?.title || m.title === byId) {
        const meta = await ensureWorkshopMeta([byId]);
        m = meta.get(byId);
      }
      return res.json({
        query: q,
        results: m
          ? [{ workshopId: byId, title: m.title, previewUrl: m.previewUrl, workshopUrl: workshopUrl(byId) }]
          : [],
      });
    }
    const results = await searchWorkshop(q, Number(req.query.page) || 1);
    res.json({
      query: q,
      results: results.map((r) => ({
        workshopId: r.workshopId,
        title: r.title,
        previewUrl: r.previewUrl,
        workshopUrl: workshopUrl(r.workshopId),
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "search failed" });
  }
});

apiRouter.post("/mods", requirePerm("mod.manage"), (req, res) => {
  const b = req.body || {};
  const workshopId = String(b.workshopId || "");
  if (!workshopId) return res.status(400).json({ error: "workshopId required" });
  const existing = getDb().prepare("SELECT id FROM mods WHERE workshop_id = ?").get(workshopId) as { id: string } | undefined;
  const id = existing?.id || uuid();
  getDb()
    .prepare(
      `INSERT INTO mods(id, workshop_id, name, kind, bikeys) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workshop_id) DO UPDATE SET name=excluded.name, kind=excluded.kind, bikeys=excluded.bikeys`,
    )
    .run(id, workshopId, String(b.name || workshopId), String(b.kind || "client"), JSON.stringify(b.bikeys || []));
  res.status(201).json({ id });
});

apiRouter.delete("/mods/:id", requirePerm("mod.manage"), (req, res) => {
  getDb().prepare("DELETE FROM mods WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

apiRouter.post("/mods/:workshopId/download", requirePerm("mod.manage"), async (req: AuthedRequest, res) => {
  const hostId = String(req.body?.hostId || "");
  if (!hostId) return res.status(400).json({ error: "hostId required" });
  try {
    const jobId = await startSteamcmdDownload(req, hostId, req.params.workshopId, String(req.body?.steamAccountId || ""), !!req.body?.validate);
    res.json({ jobId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "download failed";
    const code = /steam account|no steam account/i.test(msg) ? 400 : 503;
    res.status(code).json({ error: msg });
  }
});

async function startSteamcmdDownload(
  req: AuthedRequest,
  hostId: string,
  workshopId: string,
  steamAccountId: string,
  validate: boolean,
): Promise<string> {
  const hub = getHub();
  if (!hub.isOnline(hostId)) throw new Error("agent offline");
  const creds = resolveSteamAccount(steamAccountId || null);
  const jobId = uuid();
  getDb()
    .prepare(
      `INSERT INTO jobs(id, kind, host_id, state, stage, progress, requested_by)
       VALUES (?, 'steamcmd_download', ?, 'running', 'downloading', '[]', ?)`,
    )
    .run(jobId, hostId, req.user?.id || null);
  hub.clearLogs(hostId);
  hub.setSteamDownloading(hostId, jobId, workshopId);
  const [desc] = await describeWorkshopItems([workshopId]);
  const modLabel = desc?.line || workshopId;
  hub.appendLog(hostId, `starting download ${modLabel} (account ${creds.label})`);
  audit(req, "steamcmd.download", workshopId);

  // fire-and-forget dispatch; progress updates fill hub logs
  void hub
    .dispatch(hostId, "mod.download", {
      workshopId,
      ...steamCredsPayload(creds),
      validate,
      jobId,
    })
    .then(async (result) => {
      let error = result.error || "";
      if (!result.ok) {
        let failedIds = Array.isArray(result.data?.failedWorkshopIds)
          ? (result.data!.failedWorkshopIds as string[]).map(String).filter((id) => /^\d+$/.test(id))
          : [];
        if (!failedIds.length) failedIds = [workshopId];
        const refs = await formatWorkshopRefList(failedIds);
        error = [
          `SteamCMD failed for ${failedIds.length} workshop item(s):`,
          refs,
          result.error || result.message || "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      getDb()
        .prepare(`UPDATE jobs SET state=?, stage=?, error=?, progress=?, updated_at=datetime('now') WHERE id=?`)
        .run(
          result.ok ? "done" : "failed",
          result.stage || "done",
          error,
          JSON.stringify([{ stage: result.stage || "done", message: result.message || "", at: new Date().toISOString() }]),
          jobId,
        );
      const st = hub.getSteamStatus(hostId);
      st.running = false;
      if (!result.ok) st.error = error || result.error || result.message;
      hub.emit("steamcmd-status", hostId, st);
    })
    .catch(async (err) => {
      const refs = await formatWorkshopRefList([workshopId]);
      const error = [`SteamCMD failed:`, refs, String(err)].filter(Boolean).join("\n");
      getDb()
        .prepare(`UPDATE jobs SET state='failed', error=?, updated_at=datetime('now') WHERE id=?`)
        .run(error, jobId);
      const st = hub.getSteamStatus(hostId);
      st.running = false;
      st.error = error;
      hub.emit("steamcmd-status", hostId, st);
    });

  return jobId;
}

// ---- steamcmd admin ----
apiRouter.get("/steamcmd/status", requirePerm("mod.manage"), (req, res) => {
  const hostId = String(req.query.hostId || "");
  if (!hostId) return res.status(400).json({ error: "hostId required" });
  const hub = getHub();
  res.json({ ...hub.getSteamStatus(hostId), online: hub.isOnline(hostId) });
});

/** Arma dedicated server install / Steam branch status (via agent host.dlc.check). */
apiRouter.get("/hosts/:id/arma-install", requirePerm("mod.manage"), async (req: AuthedRequest, res) => {
  const hostId = req.params.id;
  const hub = getHub();
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });
  try {
    const result = await hub.dispatch(hostId, "host.dlc.check", { codes: [] }, 30_000);
    if (!result.ok) {
      return res.status(502).json({ error: result.error || result.message || "Could not read Arma install status" });
    }
    const data = (result.data || {}) as Record<string, unknown>;
    res.json({
      armaRoot: String(data.armaRoot || ""),
      armaServerPresent: data.armaServerPresent === true,
      armaServerExe: String(data.armaServerExe || ""),
      beta: String(data.beta || ""),
      onCreatorBranch: data.onCreatorBranch === true,
      message: result.message || "",
    });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "arma-install check failed" });
  }
});

apiRouter.post("/steamcmd/download", requirePerm("mod.manage"), async (req: AuthedRequest, res) => {
  const hostId = String(req.body?.hostId || "");
  const workshopId = String(req.body?.workshopId || "");
  if (!hostId || !workshopId) return res.status(400).json({ error: "hostId and workshopId required" });
  try {
    const jobId = await startSteamcmdDownload(
      req,
      hostId,
      workshopId,
      String(req.body?.steamAccountId || ""),
      !!req.body?.validate,
    );
    res.json({ jobId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "download failed";
    const code = /steam account|no steam account/i.test(msg) ? 400 : 503;
    res.status(code).json({ error: msg });
  }
});

apiRouter.post("/steamcmd/update-server", requirePerm("mod.manage"), async (req: AuthedRequest, res) => {
  const hostId = String(req.body?.hostId || "");
  if (!hostId) return res.status(400).json({ error: "hostId required" });
  let creds;
  try {
    creds = resolveSteamAccount(req.body?.steamAccountId);
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : "Steam account required" });
  }
  const hub = getHub();
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });
  const jobId = uuid();
  getDb()
    .prepare(
      `INSERT INTO jobs(id, kind, host_id, state, stage, progress, requested_by)
       VALUES (?, 'steamcmd_app_update', ?, 'running', 'updating', '[]', ?)`,
    )
    .run(jobId, hostId, req.user?.id || null);
  hub.clearLogs(hostId);
  hub.setSteamDownloading(hostId, jobId, "233780");
  const beta = String(req.body?.beta || "").trim();
  const branchNote = beta ? ` (branch ${beta})` : "";
  hub.appendLog(hostId, `starting Arma dedicated server update (233780)${branchNote} as ${creds.label}`);
  audit(req, "steamcmd.update-server", hostId);
  void hub
    .dispatch(
      hostId,
      "steam.app.update",
      {
        appId: String(req.body?.appId || "233780"),
        ...steamCredsPayload(creds),
        validate: !!req.body?.validate,
        ...(beta ? { beta } : {}),
        jobId,
      },
      2 * 60 * 60 * 1000,
    )
    .then((result) => {
      getDb()
        .prepare(`UPDATE jobs SET state=?, stage=?, error=?, updated_at=datetime('now') WHERE id=?`)
        .run(result.ok ? "done" : "failed", result.stage || "done", result.error || "", jobId);
      const st = hub.getSteamStatus(hostId);
      st.running = false;
      if (!result.ok) st.error = result.error || result.message;
      hub.emit("steamcmd-status", hostId, st);
    })
    .catch((err) => {
      getDb().prepare(`UPDATE jobs SET state='failed', error=?, updated_at=datetime('now') WHERE id=?`).run(String(err), jobId);
      const st = hub.getSteamStatus(hostId);
      st.running = false;
      st.error = String(err);
      hub.emit("steamcmd-status", hostId, st);
    });
  res.json({ jobId });
});

apiRouter.post("/steamcmd/cancel", requirePerm("mod.manage"), async (req: AuthedRequest, res) => {
  const hub = getHub();
  const hostId = String(req.body?.hostId || "");
  const jobId = String(req.body?.jobId || hub.getSteamStatus(hostId).jobId || "");
  if (!hostId) return res.status(400).json({ error: "hostId required" });
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });
  try {
    const result = await hub.dispatch(hostId, "mod.download.cancel", { jobId }, 30_000);
    hub.appendLog(hostId, "cancel requested");
    const st = hub.getSteamStatus(hostId);
    st.running = false;
    hub.emit("steamcmd-status", hostId, st);
    audit(req, "steamcmd.cancel", hostId);
    res.json({ status: "ok", result });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "cancel failed" });
  }
});

apiRouter.get("/steamcmd/logs", requirePerm("mod.manage"), (req, res) => {
  const hostId = String(req.query.hostId || "");
  if (!hostId) return res.status(400).json({ error: "hostId required" });
  const hub = getHub();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  for (const line of hub.getLogs(hostId)) {
    res.write(`data: ${JSON.stringify({ line })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ status: hub.getSteamStatus(hostId) })}\n\n`);

  const onLog = (id: string, line: string) => {
    if (id !== hostId) return;
    res.write(`data: ${JSON.stringify({ line })}\n\n`);
  };
  const onStatus = (id: string, status: unknown) => {
    if (id !== hostId) return;
    res.write(`data: ${JSON.stringify({ status })}\n\n`);
  };
  hub.on("steamcmd-log", onLog);
  hub.on("steamcmd-status", onStatus);
  req.on("close", () => {
    hub.off("steamcmd-log", onLog);
    hub.off("steamcmd-status", onStatus);
  });
});

// ---- uploads / missions ----
apiRouter.get("/uploads", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM uploads ORDER BY created_at DESC LIMIT 200").all() as Record<string, unknown>[];
  res.json(
    rows.map((u) => ({
      id: u.id,
      section: u.section,
      originalName: u.original_name,
      contentHash: u.content_hash,
      sizeBytes: u.size_bytes,
      detectedType: u.detected_type,
      validationState: u.validation_state,
      rejectReason: u.reject_reason || undefined,
    })),
  );
});

apiRouter.post("/uploads", requirePerm("mission.upload"), upload.single("file"), (req: AuthedRequest, res) => {
  const section = String(req.query.section || "mission");
  const file = req.file;
  if (!file) return res.status(400).json({ error: "file required" });
  const id = uuid();
  const dir = path.join(config.repoRoot, "deploy", "quarantine");
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, `${id}-${file.originalname}`);
  fs.writeFileSync(stored, file.buffer);
  const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
  getDb()
    .prepare(
      `INSERT INTO uploads(id, uploader_id, section, original_name, stored_path, content_hash, size_bytes, detected_type, validation_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'quarantined')`,
    )
    .run(id, req.user?.id || null, section, file.originalname, stored, hash, file.size, path.extname(file.originalname));
  res.status(201).json({ id });
});

apiRouter.post("/uploads/:id/approve", requirePerm("mission.manage"), (req, res) => {
  getDb().prepare("UPDATE uploads SET validation_state = 'approved', reject_reason = '' WHERE id = ?").run(req.params.id);
  res.json({ status: "ok" });
});

apiRouter.post("/uploads/:id/reject", requirePerm("mission.manage"), (req, res) => {
  getDb()
    .prepare("UPDATE uploads SET validation_state = 'rejected', reject_reason = ? WHERE id = ?")
    .run(String(req.body?.reason || "rejected"), req.params.id);
  res.json({ status: "ok" });
});

apiRouter.post("/uploads/:id/deploy", requirePerm("mission.manage"), async (req: AuthedRequest, res) => {
  const u = getDb().prepare("SELECT * FROM uploads WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!u) return res.status(404).json({ error: "not found" });
  if (u.validation_state !== "approved") return res.status(400).json({ error: "upload must be approved first" });

  const instanceId = String(req.body?.instanceId || "");
  if (!instanceId) return res.status(400).json({ error: "instanceId required" });
  const inst = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(instanceId) as Record<string, unknown> | undefined;
  if (!inst) return res.status(404).json({ error: "instance not found" });
  const hostId = String(inst.host_id);
  const hub = getHub();
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });

  const storedPath = String(u.stored_path || "");
  if (!storedPath || !fs.existsSync(storedPath)) return res.status(404).json({ error: "quarantine file missing on panel" });

  const section = String(u.section || "mission");
  const originalName = String(u.original_name || "file");
  const bytes = fs.readFileSync(storedPath);
  const maxBytes = 80 * 1024 * 1024;
  if (bytes.length > maxBytes) return res.status(413).json({ error: "file too large to push over agent channel (80MB max)" });

  let root = "mpmissions";
  let relativePath = originalName;
  if (section === "key") {
    root = "keys";
  } else if (section === "config") {
    root = "profiles";
    relativePath = path.posix.join(String(inst.profile_dir || "profiles").replace(/\\/g, "/"), originalName);
    // profiles root already includes profiles/; use instance profile subdir name only
    const profileDir = String(inst.profile_dir || "profiles");
    relativePath = path.basename(profileDir) === profileDir ? path.posix.join(profileDir, originalName) : originalName;
  }

  try {
    const result = await hub.dispatch(
      hostId,
      "file.deploy",
      {
        root: section === "config" ? "arma" : root,
        relativePath:
          section === "config"
            ? path.posix.join(String(inst.profile_dir || "profiles").replace(/\\/g, "/"), originalName)
            : relativePath,
        contentBase64: bytes.toString("base64"),
      },
      180_000,
    );
    if (!result.ok) return res.status(502).json({ error: result.error || "deploy failed", result });

    let missionId: string | undefined;
    if (section === "mission") {
      const missionsDir = path.join(config.repoRoot, "deploy", "missions");
      fs.mkdirSync(missionsDir, { recursive: true });
      const pboName = originalName;
      const existing = getDb()
        .prepare("SELECT id, stored_path FROM missions WHERE lower(pbo_filename) = lower(?)")
        .get(pboName) as { id: string; stored_path: string } | undefined;
      missionId = existing?.id || uuid();
      const dest = path.join(missionsDir, `${missionId}-${pboName}`);
      fs.copyFileSync(storedPath, dest);
      if (existing?.stored_path && existing.stored_path !== dest && fs.existsSync(existing.stored_path)) {
        try {
          fs.unlinkSync(existing.stored_path);
        } catch {
          /* ignore */
        }
      }
      if (existing) {
        getDb()
          .prepare(
            `UPDATE missions SET name=?, pbo_filename=?, content_hash=?, stored_path=? WHERE id=?`,
          )
          .run(pboName, pboName, u.content_hash, dest, missionId);
      } else {
        getDb()
          .prepare("INSERT INTO missions(id, name, pbo_filename, content_hash, stored_path) VALUES (?, ?, ?, ?, ?)")
          .run(missionId, pboName, pboName, u.content_hash, dest);
      }
    }

    const jobId = uuid();
    getDb()
      .prepare(
        `INSERT INTO jobs(id, kind, host_id, instance_id, state, stage, progress, requested_by)
         VALUES (?, 'file_deploy', ?, ?, 'done', 'done', ?, ?)`,
      )
      .run(
        jobId,
        hostId,
        instanceId,
        JSON.stringify([
          {
            stage: "done",
            message: `Deployed ${originalName} → ${result.data?.path || relativePath}`,
            at: new Date().toISOString(),
          },
        ]),
        req.user?.id || null,
      );
    pruneInstanceJobs(String(instanceId));

    audit(req, "upload.deploy", req.params.id, "ok");
    res.json({
      status: "ok",
      jobId,
      missionId,
      hostId,
      instanceId,
      deployedPath: result.data?.path,
      bytes: result.data?.bytes,
      section,
      fileName: originalName,
    });
  } catch (e) {
    audit(req, "upload.deploy", req.params.id, "failed");
    res.status(503).json({ error: e instanceof Error ? e.message : "deploy failed" });
  }
});

apiRouter.get("/missions", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM missions ORDER BY name").all() as Record<string, unknown>[];
  res.json(rows.map((m) => ({ id: m.id, name: m.name, pboFilename: m.pbo_filename })));
});

apiRouter.delete("/missions/:id", requirePerm("mission.manage"), (req, res) => {
  getDb().prepare("DELETE FROM missions WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---- schedules ----
apiRouter.get("/schedules", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM schedules ORDER BY run_at").all() as Record<string, unknown>[];
  res.json(
    rows.map((s) => ({
      id: s.id,
      profileId: s.profile_id,
      instanceId: s.instance_id || undefined,
      name: s.name,
      runAt: s.run_at,
      recurrence: s.recurrence,
      reminderOffsets: jsonParse<number[]>(String(s.reminder_offsets), [60, 15]),
      discordChannel: s.discord_channel,
      state: s.state,
    })),
  );
});

apiRouter.post("/schedules", requirePerm("schedule.manage"), (req, res) => {
  const b = req.body || {};
  if (!b.profileId) return res.status(400).json({ error: "profileId required" });
  const instanceId = String(b.instanceId || "").trim();
  if (!instanceId) return res.status(400).json({ error: "instanceId required" });
  const inst = getDb().prepare("SELECT id FROM instances WHERE id = ?").get(instanceId);
  if (!inst) return res.status(400).json({ error: "instance not found" });
  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO schedules(id, profile_id, instance_id, name, run_at, recurrence, reminder_offsets, discord_channel, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
    )
    .run(
      id,
      b.profileId,
      instanceId,
      String(b.name || ""),
      String(b.runAt || new Date().toISOString()),
      String(b.recurrence || "none"),
      JSON.stringify(b.reminderOffsets || [60, 15]),
      String(b.discordChannel || ""),
    );
  res.status(201).json({ id });
});

apiRouter.delete("/schedules/:id", requirePerm("schedule.manage"), (req, res) => {
  getDb().prepare("DELETE FROM schedules WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

apiRouter.post("/schedules/:id/approve", requirePerm("schedule.manage"), (req: AuthedRequest, res) => {
  getDb()
    .prepare("UPDATE schedules SET state = 'approved', approved_by = ? WHERE id = ?")
    .run(req.user?.email || "", req.params.id);
  res.json({ status: "ok" });
});

// ---- admin ----
apiRouter.get("/permissions", (_req, res) => {
  res.json(ALL_PERMISSIONS);
});

apiRouter.get("/users", requirePerm("user.manage"), (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM users ORDER BY approved ASC, created_at DESC").all() as import("../auth/middleware.js").UserRow[];
  const idRows = getDb()
    .prepare("SELECT user_id, provider, subject, email, display_name FROM user_identities")
    .all() as { user_id: string; provider: string; subject: string; email: string; display_name: string }[];
  const byUser = new Map<string, typeof idRows>();
  for (const row of idRows) {
    const list = byUser.get(row.user_id) || [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  res.json(
    rows.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      mfaEnabled: !!u.mfa_enabled,
      disabled: !!u.disabled,
      approved: !!u.approved,
      identities: (byUser.get(u.id) || []).map((i) => ({
        provider: i.provider,
        subject: i.subject,
        email: i.email,
        displayName: i.display_name,
      })),
    })),
  );
});

apiRouter.post("/users/:id/approve", requirePerm("user.manage"), (req: AuthedRequest, res) => {
  const approved = req.body?.approved === false ? 0 : 1;
  getDb().prepare("UPDATE users SET approved = ? WHERE id = ?").run(approved, req.params.id);
  audit(req, approved ? "user.approve" : "user.unapprove", req.params.id);
  res.json({ status: "ok", approved: !!approved });
});

apiRouter.post("/users/:id/disable", requirePerm("user.manage"), (req, res) => {
  getDb().prepare("UPDATE users SET disabled = ? WHERE id = ?").run(req.body?.disabled ? 1 : 0, req.params.id);
  res.json({ status: "ok" });
});

apiRouter.delete("/users/:id", requirePerm("user.manage"), (req: AuthedRequest, res) => {
  const id = req.params.id;
  if (id === req.user?.id) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }
  const row = getDb().prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "user not found" });
  getDb().prepare("DELETE FROM users WHERE id = ?").run(id);
  audit(req, "user.delete", id);
  res.status(204).end();
});

apiRouter.get("/users/:id/roles", (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT ur.id, ur.user_id AS userId, ur.role_id AS roleId, r.name AS roleName, ur.scope_type AS scopeType, COALESCE(ur.scope_id,'') AS scopeId
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
    )
    .all(req.params.id);
  res.json(rows);
});

apiRouter.post("/users/:id/roles", requirePerm("user.manage"), (req, res) => {
  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO user_roles(id, user_id, role_id, scope_type, scope_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(id, req.params.id, req.body?.roleId, String(req.body?.scopeType || "global"), req.body?.scopeId || null);
  res.status(201).json({ id });
});

apiRouter.delete("/users/:id/roles/:assignmentId", requirePerm("user.manage"), (req, res) => {
  getDb().prepare("DELETE FROM user_roles WHERE id = ?").run(req.params.assignmentId);
  res.status(204).end();
});

apiRouter.get("/roles", (_req, res) => {
  const roles = getDb().prepare("SELECT * FROM roles ORDER BY name").all() as Record<string, unknown>[];
  const permStmt = getDb().prepare("SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission");
  res.json(
    roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      builtin: !!r.builtin,
      permissions: (permStmt.all(r.id) as { permission: string }[]).map((p) => p.permission),
    })),
  );
});

apiRouter.post("/roles", requirePerm("user.manage"), (req, res) => {
  const id = uuid();
  getDb()
    .prepare("INSERT INTO roles(id, name, description, builtin) VALUES (?, ?, ?, 0)")
    .run(id, String(req.body?.name || ""), String(req.body?.description || ""));
  for (const p of req.body?.permissions || []) {
    getDb().prepare("INSERT INTO role_permissions(role_id, permission) VALUES (?, ?)").run(id, p);
  }
  res.status(201).json({ id });
});

apiRouter.put("/roles/:id/permissions", requirePerm("user.manage"), (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM role_permissions WHERE role_id = ?").run(req.params.id);
  for (const p of req.body?.permissions || []) {
    db.prepare("INSERT INTO role_permissions(role_id, permission) VALUES (?, ?)").run(req.params.id, p);
  }
  res.json({ status: "ok" });
});

apiRouter.delete("/roles/:id", requirePerm("user.manage"), (req, res) => {
  getDb().prepare("DELETE FROM roles WHERE id = ? AND builtin = 0").run(req.params.id);
  res.status(204).end();
});

apiRouter.get("/steam-accounts", (req: AuthedRequest, res) => {
  const grants = req.grants || [];
  const allowed = grants.some(
    (g) =>
      g.permission === "steam.config" ||
      g.permission === "mod.manage" ||
      g.permission === "profile.apply" ||
      g.permission === "host.add",
  );
  if (!allowed) return res.status(403).json({ error: "forbidden" });
  const rows = getDb().prepare("SELECT id, label, username, guard_cached FROM steam_accounts ORDER BY label").all() as Record<
    string,
    unknown
  >[];
  res.json(rows.map((a) => ({ id: a.id, label: a.label, username: a.username, guardCached: !!a.guard_cached })));
});

apiRouter.post("/steam-accounts", requirePerm("steam.config"), (req, res) => {
  const label = String(req.body?.label || "").trim();
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!label || !username || !password) {
    return res.status(400).json({ error: "label, username, and password are required" });
  }
  const id = uuid();
  getDb()
    .prepare("INSERT INTO steam_accounts(id, label, username, enc_password) VALUES (?, ?, ?, ?)")
    .run(id, label, username, encryptSecret(password));
  res.status(201).json({ id });
});

apiRouter.delete("/steam-accounts/:id", requirePerm("steam.config"), (req, res) => {
  getDb().prepare("DELETE FROM steam_accounts WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

apiRouter.get("/discord/config", requirePerm("discord.config"), (_req, res) => {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'discord'").get() as { value: string } | undefined;
  res.json(jsonParse(row?.value, { enabled: false, token: "", guildId: "", channelId: "", roleId: "" }));
});

apiRouter.put("/discord/config", requirePerm("discord.config"), (req, res) => {
  getDb()
    .prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES ('discord', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(req.body || {}));
  res.json({ status: "ok" });
});

apiRouter.get("/audit", requirePerm("audit.view"), (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT id, actor_email AS actorEmail, action, target_id AS targetId, scope, result, ip, created_at AS createdAt
       FROM audit_log ORDER BY id DESC LIMIT 200`,
    )
    .all();
  res.json(rows);
});

registerHcGroupRoutes(apiRouter, {
  audit,
  resolveProfileWorkshopIds,
  resolveModLaunchPaths,
  resolveInstanceSharedCfg,
  uniqueIds,
  uniqueLaunchPaths,
  writeProfileConfigToHost,
});
