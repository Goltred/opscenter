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
  formatWorkshopShortList,
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
import { buildSetupStatus, dismissSetup, agentGatewayUrl } from "../setup.js";
import { encryptSecret } from "../secrets.js";
import { saveSteamWebApiKey, steamWebApiKeyPublic } from "../steam/webApiKey.js";
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
  getDifficultyPresetRevision,
  getProfileRevision,
  getOrCreateSharedSettings,
  DEFAULT_SHARED_SERVER_CFG,
  getSharedCfgRevision,
  listDifficultyPresetRevisions,
  listProfileRevisions,
  listSharedCfgRevisions,
  profileSnapshotFromBody,
  recordDifficultyPresetRevision,
  recordProfileRevision,
  recordSharedCfgRevision,
  resolveInstanceSharedCfg,
  restoreDifficultyPresetFromRevision,
  restoreProfileFromRevision,
  restoreSharedCfgFromRevision,
} from "../revisions.js";
import {
  normalizeCustomDifficulty,
  normalizeForcedDifficulty,
  renderArma3Profile,
} from "../arma/difficulty.js";
import { mergeServerCfg, normalizeMissionSource, normalizeMissionTemplateInput, pboToMissionTemplate, renderServerCfg } from "../arma/serverCfg.js";
import { registerHcGroupRoutes } from "./hcGroupsApi.js";
import { effectiveRemoteHcIps, groupsTargetingInstance, parseAdvertiseHost } from "../hcGroups.js";
import {
  registerApplyProfileImpl,
  type ApplyProfileOpts,
  type ApplyProfileStartResult,
} from "../applyProfile.js";
import {
  registerInstanceControlImpl,
  type InstanceControlOpts,
  type InstanceControlResult,
} from "../instanceControl.js";
import { canConfirmSchedule, canFinishSchedule, canStandDownSchedule, confirmSchedule, finishScheduleOperation, standDownScheduleOccurrence, scheduleDto, activeOperationForInstance } from "../schedules/runner.js";
import { discordPublicConfig, saveDiscordSettings } from "../discord/notify.js";
import {
  getDiscordBotRuntimeStatus,
  listDiscordGuildChannels,
  listDiscordGuildRoles,
  listDiscordGuilds,
  restartDiscordBot,
} from "../discord/bot.js";

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
  return agentGatewayUrl();
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

/** Panel first-run setup progress (owners / host admins). */
apiRouter.get("/setup/status", requirePerm("host.add"), (_req, res) => {
  res.json(buildSetupStatus());
});

apiRouter.post("/setup/dismiss", requirePerm("host.add"), (req: AuthedRequest, res) => {
  dismissSetup(req.user!.id);
  audit(req, "setup.dismiss", "panel", "ok");
  res.json({ status: "ok", ...buildSetupStatus() });
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
            "Arma dedicated server is not installed, and SteamCMD is missing on the host. Install SteamCMD on the game host, set the SteamCMD path in Agent setup, then Verify host again to download the dedicated server (Creator DLC branch).",
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
            " Add one under Admin → Steam so Verify host can download the dedicated server (Creator DLC branch).",
        });
      }
      const jobId = startCreatorDlcServerInstall(req, hostId, creds, !!req.body?.validate, "prepare");
      return res.json({
        status: "installing",
        jobId,
        result: {
          ...result,
          message:
            "Folders ready; downloading Arma 3 dedicated server (Creator DLC branch) into armaRoot…",
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
    activeOperation: activeOperationForInstance(String(row.id)),
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

function writeControlAudit(
  actorId: string | null | undefined,
  actorLabel: string | null | undefined,
  source: string | null | undefined,
  action: string,
  targetId: string,
  result: string,
) {
  getDb()
    .prepare(
      `INSERT INTO audit_log(actor_id, actor_email, action, target_id, result, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(actorId || null, actorLabel || "", action, targetId, result, source || "");
}

async function runInstanceControlCore(opts: InstanceControlOpts): Promise<InstanceControlResult> {
  const op = opts.op;
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(opts.instanceId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { ok: false, status: 404, error: "not found" };
  const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(row.host_id) as Record<string, unknown> | undefined;
  const hub = getHub();
  const hostId = String(row.host_id);
  if (!hub.isOnline(hostId)) return { ok: false, status: 503, error: "agent offline" };

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
        return {
          ok: false,
          status: 409,
          error:
            `Arma 3 dedicated server is not installed at ${String(host.arma_root || "armaRoot")}. ` +
            "Use Verify host (or Apply a Mission Profile) to download the dedicated server (Creator DLC branch).",
        };
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
        return {
          ok: false,
          status: 502,
          error: e instanceof Error ? e.message : "failed to prepare profile for launch",
        };
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
    writeControlAudit(opts.actorId, opts.actorLabel, opts.source, op, String(row.id), result.ok ? "ok" : "failed");
    if (!result.ok) {
      return { ok: false, status: 502, error: result.error || result.message || "agent error", state };
    }
    return {
      ok: true,
      status: 200,
      state,
      result,
      warning: payload.warning as string | undefined,
      launchSummary: payload.launchSummary,
      args: payload.args as string[] | undefined,
    };
  } catch (e) {
    writeControlAudit(opts.actorId, opts.actorLabel, opts.source, op, String(row.id), "failed");
    return { ok: false, status: 503, error: e instanceof Error ? e.message : "dispatch failed" };
  }
}

registerInstanceControlImpl(runInstanceControlCore);

async function dispatchInstanceOp(
  req: AuthedRequest,
  res: import("express").Response,
  op: "instance.start" | "instance.stop" | "instance.restart",
) {
  const out = await runInstanceControlCore({
    instanceId: String(req.params.id),
    op,
    actorId: req.user?.id || null,
    actorLabel: req.user?.email || "",
    source: clientIp(req),
  });
  if (!out.ok) return res.status(out.status).json({ error: out.error || "failed" });
  res.json({
    status: "ok",
    state: out.state,
    result: out.result,
    warning: out.warning,
    launchSummary: out.launchSummary,
    args: out.args,
  });
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

  // While Arma is up, server.cfg is often locked and a disk rewrite would not affect the
  // already-loaded allowlist. Skip rewrite and only start/stop HC processes.
  // When the server is down, keep cfg in sync for the next start.
  if (!serverUp) {
    try {
      await rewriteInstanceServerCfgForHeadless(hostId, updated, host);
    } catch (e) {
      return res.status(502).json({ error: e instanceof Error ? e.message : "failed to update server.cfg" });
    }
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

const MAX_BIKEY_BYTES = 64 * 1024;

function signatureKeyDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    filename: String(row.filename),
    contentHash: String(row.content_hash || ""),
    sizeBytes: Number(row.size_bytes) || 0,
    createdAt: String(row.created_at || ""),
  };
}

/** Panel library of .bikey files for manual push to host keys\ (advanced). */
apiRouter.get("/signature-keys", requirePerm("mod.manage"), (_req, res) => {
  const rows = getDb()
    .prepare("SELECT * FROM signature_keys ORDER BY lower(filename), created_at DESC")
    .all() as Record<string, unknown>[];
  res.json(rows.map(signatureKeyDto));
});

apiRouter.post(
  "/signature-keys",
  requirePerm("mod.manage"),
  upload.single("file"),
  (req: AuthedRequest, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "file required" });
    const originalName = String(file.originalname || "").trim();
    if (!/\.bikey$/i.test(originalName)) {
      return res.status(400).json({ error: "Only .bikey signature key files are allowed" });
    }
    if (/[\\/]/.test(originalName) || originalName.includes("..")) {
      return res.status(400).json({ error: "invalid filename" });
    }
    if (file.size <= 0 || file.size > MAX_BIKEY_BYTES) {
      return res.status(400).json({ error: `Key file must be 1–${MAX_BIKEY_BYTES} bytes` });
    }
    const filename = path.basename(originalName);
    const existing = getDb()
      .prepare("SELECT id FROM signature_keys WHERE lower(filename) = lower(?)")
      .get(filename) as { id: string } | undefined;
    const id = existing?.id || uuid();
    const dir = path.join(config.repoRoot, "deploy", "keys");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${id}-${filename}`);
    if (existing) {
      const prev = getDb().prepare("SELECT stored_path FROM signature_keys WHERE id = ?").get(id) as
        | { stored_path: string }
        | undefined;
      if (prev?.stored_path && prev.stored_path !== dest && fs.existsSync(prev.stored_path)) {
        try {
          fs.unlinkSync(prev.stored_path);
        } catch {
          /* ignore */
        }
      }
    }
    fs.writeFileSync(dest, file.buffer);
    const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
    if (existing) {
      getDb()
        .prepare(
          `UPDATE signature_keys SET filename=?, stored_path=?, content_hash=?, size_bytes=?, uploaded_by=?, created_at=datetime('now') WHERE id=?`,
        )
        .run(filename, dest, hash, file.size, req.user?.id || null, id);
    } else {
      getDb()
        .prepare(
          `INSERT INTO signature_keys(id, filename, stored_path, content_hash, size_bytes, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, filename, dest, hash, file.size, req.user?.id || null);
    }
    audit(req, "signature_key.upload", id, existing ? "replaced" : "ok");
    const row = getDb().prepare("SELECT * FROM signature_keys WHERE id = ?").get(id) as Record<string, unknown>;
    res.status(existing ? 200 : 201).json(signatureKeyDto(row));
  },
);

apiRouter.delete("/signature-keys/:id", requirePerm("mod.manage"), (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM signature_keys WHERE id = ?").get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const stored = String(row.stored_path || "");
  if (stored && fs.existsSync(stored)) {
    try {
      fs.unlinkSync(stored);
    } catch {
      /* ignore */
    }
  }
  getDb().prepare("DELETE FROM signature_keys WHERE id = ?").run(req.params.id);
  audit(req, "signature_key.delete", req.params.id);
  res.status(204).end();
});

/** Push selected panel signature keys into this instance host's armaRoot\\keys. */
apiRouter.post("/instances/:id/keys/deploy", requirePerm("mod.manage"), async (req: AuthedRequest, res) => {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  const hostId = String(row.host_id || "");
  const hub = getHub();
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });

  const keyIds = Array.isArray(req.body?.keyIds)
    ? (req.body.keyIds as unknown[]).map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  if (!keyIds.length) return res.status(400).json({ error: "keyIds required" });

  const results: { id: string; filename: string; ok: boolean; skipped?: boolean; error?: string }[] = [];
  for (const keyId of keyIds) {
    const key = getDb().prepare("SELECT * FROM signature_keys WHERE id = ?").get(keyId) as
      | Record<string, unknown>
      | undefined;
    if (!key) {
      results.push({ id: keyId, filename: "", ok: false, error: "not found" });
      continue;
    }
    const filename = String(key.filename || "");
    const stored = String(key.stored_path || "");
    if (!stored || !fs.existsSync(stored)) {
      results.push({ id: keyId, filename, ok: false, error: "file missing on panel" });
      continue;
    }
    try {
      const bytes = fs.readFileSync(stored);
      const dep = await hub.dispatch(
        hostId,
        "file.deploy",
        {
          root: "keys",
          relativePath: filename,
          contentBase64: bytes.toString("base64"),
          skipIfExists: false,
        },
        60_000,
      );
      if (!dep.ok) {
        results.push({ id: keyId, filename, ok: false, error: dep.error || dep.message || "deploy failed" });
      } else {
        results.push({ id: keyId, filename, ok: true, skipped: !!dep.data?.skipped });
      }
    } catch (e) {
      results.push({
        id: keyId,
        filename,
        ok: false,
        error: e instanceof Error ? e.message : "deploy failed",
      });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  audit(req, "signature_key.deploy", String(row.id), `${okCount}/${results.length}`);
  if (!okCount) {
    return res.status(502).json({ error: "no keys deployed", results });
  }
  res.json({
    status: "ok",
    deployed: okCount,
    failed: results.length - okCount,
    results,
  });
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
          ? "[OpsCenter] live console on — waiting for Arma RPT lines…"
          : "[OpsCenter] agent offline — connect the host agent to stream logs",
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
  let difficultyPresetName: string | undefined;
  const missionSource = normalizeMissionSource(row.mission_source);
  const missionTemplate =
    missionSource === "mod" ? normalizeMissionTemplateInput(row.mission_template) : "";
  if (missionSource === "library" && row.mission_id) {
    const m = getDb().prepare("SELECT name FROM missions WHERE id = ?").get(row.mission_id) as { name: string } | undefined;
    missionName = m?.name;
  }
  if (row.modlist_id) {
    const ml = getDb().prepare("SELECT name FROM modlists WHERE id = ?").get(row.modlist_id) as { name: string } | undefined;
    modlistName = ml?.name;
  }
  if (row.difficulty_preset_id) {
    const dp = getDb()
      .prepare("SELECT name FROM difficulty_presets WHERE id = ?")
      .get(row.difficulty_preset_id) as { name: string } | undefined;
    difficultyPresetName = dp?.name;
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    mods: jsonParse<string[]>(String(row.mods), []),
    serverMods: jsonParse<string[]>(String(row.server_mods), []),
    missionSource,
    missionId: missionSource === "library" ? row.mission_id || undefined : undefined,
    missionName,
    missionTemplate: missionTemplate || undefined,
    modlistId: row.modlist_id || undefined,
    modlistName,
    difficultyPresetId: row.difficulty_preset_id || undefined,
    difficultyPresetName,
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

/** Resolve Arma mission template from a profile row (library PBO or mod-shipped template). */
function resolveProfileMissionTemplate(profile: Record<string, unknown>): string {
  const source = normalizeMissionSource(profile.mission_source);
  if (source === "mod") {
    return normalizeMissionTemplateInput(profile.mission_template);
  }
  if (profile.mission_id) {
    const mission = getDb().prepare("SELECT pbo_filename, name FROM missions WHERE id = ?").get(profile.mission_id) as
      | { pbo_filename: string; name: string }
      | undefined;
    return pboToMissionTemplate(mission?.pbo_filename || mission?.name || "");
  }
  return "";
}

function profileHasMission(profile: Record<string, unknown>): boolean {
  const source = normalizeMissionSource(profile.mission_source);
  if (source === "mod") return !!normalizeMissionTemplateInput(profile.mission_template);
  return !!(profile.mission_id && String(profile.mission_id).trim());
}

function difficultyPresetDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    difficulty: normalizeCustomDifficulty(jsonParse(String(row.difficulty), {})),
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  };
}

apiRouter.get("/profiles", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM mission_profiles ORDER BY name").all() as Record<string, unknown>[];
  res.json(rows.map(profileDto));
});

/** Profiles with no mission (library PBO or mod template). Must be before /profiles/:id. */
apiRouter.get("/profiles/health", requirePerm("profile.view"), (_req, res) => {
  const rows = getDb().prepare("SELECT id, name, mission_id, mission_source, mission_template FROM mission_profiles ORDER BY name").all() as Record<
    string,
    unknown
  >[];
  const missingMission = rows
    .filter((r) => !profileHasMission(r))
    .map((r) => ({ id: String(r.id), name: String(r.name || "") }));
  res.json({ missingMission, count: missingMission.length });
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
      `INSERT INTO mission_profiles(id, name, version, mods, server_mods, mission_id, mission_source, mission_template, modlist_id, difficulty_preset_id, server_cfg_overrides, basic_cfg_overrides, extra_args, custom_difficulty, dlcs, recommended_headless_count)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      snapshot.name || "profile",
      JSON.stringify(snapshot.mods),
      JSON.stringify(snapshot.serverMods),
      snapshot.missionId,
      snapshot.missionSource,
      snapshot.missionTemplate,
      snapshot.modlistId,
      snapshot.difficultyPresetId,
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
      `INSERT INTO mission_profiles(id, name, version, mods, server_mods, mission_id, mission_source, mission_template, modlist_id, difficulty_preset_id, server_cfg_overrides, basic_cfg_overrides, extra_args, custom_difficulty, dlcs, recommended_headless_count)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      snapshot.name || "profile",
      JSON.stringify(snapshot.mods),
      JSON.stringify(snapshot.serverMods),
      snapshot.missionId,
      snapshot.missionSource,
      snapshot.missionTemplate,
      snapshot.modlistId,
      snapshot.difficultyPresetId,
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
  const existing = getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!existing) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  const snapshot = profileSnapshotFromBody(b);
  // Keep legacy inline custom_difficulty; UI no longer edits it (presets library owns Custom options).
  snapshot.customDifficulty = normalizeCustomDifficulty(
    jsonParse(String(existing.custom_difficulty || "{}"), {}),
  );
  getDb()
    .prepare(
      `UPDATE mission_profiles SET name=?, version=version+1, mods=?, server_mods=?, mission_id=?,
       mission_source=?, mission_template=?, modlist_id=?,
       difficulty_preset_id=?,
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
      snapshot.missionSource,
      snapshot.missionTemplate,
      snapshot.modlistId,
      snapshot.difficultyPresetId,
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
    req.body?.serverCfg && typeof req.body.serverCfg === "object" && Object.keys(req.body.serverCfg).length
      ? (req.body.serverCfg as Record<string, unknown>)
      : { ...DEFAULT_SHARED_SERVER_CFG };
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

// ---- difficulty presets ----
apiRouter.get("/difficulty-presets", requirePerm("profile.view"), (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM difficulty_presets ORDER BY name").all() as Record<string, unknown>[];
  res.json(rows.map(difficultyPresetDto));
});

apiRouter.get("/difficulty-presets/:id", requirePerm("profile.view"), (req, res) => {
  const row = getDb().prepare("SELECT * FROM difficulty_presets WHERE id = ?").get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(difficultyPresetDto(row));
});

apiRouter.post("/difficulty-presets", requirePerm("profile.edit"), (req: AuthedRequest, res) => {
  const id = uuid();
  const name = String(req.body?.name || "").trim() || "Custom";
  const difficulty = normalizeCustomDifficulty(req.body?.difficulty);
  getDb()
    .prepare(
      `INSERT INTO difficulty_presets(id, name, version, difficulty, created_at, updated_at)
       VALUES (?, ?, 1, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, name, JSON.stringify(difficulty));
  recordDifficultyPresetRevision(
    id,
    1,
    { name, difficulty },
    { id: req.user?.id, email: req.user?.email },
  );
  audit(req, "difficulty_preset.create", id);
  res.status(201).json({ id });
});

apiRouter.put("/difficulty-presets/:id", requirePerm("profile.edit"), (req: AuthedRequest, res) => {
  const existing = getDb().prepare("SELECT id FROM difficulty_presets WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const name = String(req.body?.name || "").trim() || "Custom";
  const difficulty = normalizeCustomDifficulty(req.body?.difficulty);
  getDb()
    .prepare(
      `UPDATE difficulty_presets SET name=?, difficulty=?, version=version+1, updated_at=datetime('now') WHERE id=?`,
    )
    .run(name, JSON.stringify(difficulty), req.params.id);
  const updated = getDb().prepare("SELECT version FROM difficulty_presets WHERE id = ?").get(req.params.id) as {
    version: number;
  };
  recordDifficultyPresetRevision(
    String(req.params.id),
    Number(updated.version),
    { name, difficulty },
    { id: req.user?.id, email: req.user?.email },
  );
  audit(req, "difficulty_preset.update", String(req.params.id));
  res.json({ status: "ok", version: Number(updated.version) });
});

apiRouter.delete("/difficulty-presets/:id", requirePerm("profile.edit"), (req: AuthedRequest, res) => {
  getDb().prepare("DELETE FROM difficulty_presets WHERE id = ?").run(req.params.id);
  audit(req, "difficulty_preset.delete", String(req.params.id));
  res.status(204).end();
});

apiRouter.get("/difficulty-presets/:id/revisions", requirePerm("profile.view"), (req, res) => {
  const row = getDb().prepare("SELECT id FROM difficulty_presets WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(listDifficultyPresetRevisions(String(req.params.id)));
});

apiRouter.get("/difficulty-presets/:id/revisions/compare", requirePerm("profile.view"), (req, res) => {
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return res.status(400).json({ error: "a and b version query params required" });
  }
  const left = getDifficultyPresetRevision(String(req.params.id), a);
  const right = getDifficultyPresetRevision(String(req.params.id), b);
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

apiRouter.get("/difficulty-presets/:id/revisions/:version", requirePerm("profile.view"), (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isFinite(version)) return res.status(400).json({ error: "invalid version" });
  const rev = getDifficultyPresetRevision(String(req.params.id), version);
  if (!rev) return res.status(404).json({ error: "not found" });
  res.json(rev);
});

apiRouter.post("/difficulty-presets/:id/restore", requirePerm("profile.edit"), (req: AuthedRequest, res) => {
  const version = Number(req.body?.version);
  if (!Number.isFinite(version)) return res.status(400).json({ error: "version required" });
  const result = restoreDifficultyPresetFromRevision(String(req.params.id), version, {
    id: req.user?.id,
    email: req.user?.email,
  });
  if ("error" in result) return res.status(404).json({ error: result.error });
  audit(req, "difficulty_preset.restore", String(req.params.id));
  res.json({ status: "ok", version: result.newVersion });
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
    const msg = `${pboFilename} missing on host and not accessible on the panel — re-upload and approve the mission first`;
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
    mergedCfg.hostname = String(profile.name || "OpsCenter Server");
  }
  const forcedDifficulty = normalizeForcedDifficulty(mergedCfg.forcedDifficulty);
  const missionTemplate = resolveProfileMissionTemplate(profile);
  const serverCfg = renderServerCfg(mergedCfg, {
    missionTemplate: missionTemplate || undefined,
    missionDifficulty: forcedDifficulty || undefined,
    modCountHint,
  });
  const files: { relativePath: string; content: string }[] = [{ relativePath: "server.cfg", content: serverCfg }];
  if (forcedDifficulty === "Custom") {
    let custom: ReturnType<typeof normalizeCustomDifficulty> | null = null;
    const presetId = profile.difficulty_preset_id ? String(profile.difficulty_preset_id) : "";
    if (presetId) {
      const preset = getDb()
        .prepare("SELECT difficulty FROM difficulty_presets WHERE id = ?")
        .get(presetId) as { difficulty: string } | undefined;
      if (preset) custom = normalizeCustomDifficulty(jsonParse(String(preset.difficulty), {}));
    }
    if (!custom) {
      const raw = profile.custom_difficulty;
      if (raw != null && String(raw).trim() !== "") {
        custom = normalizeCustomDifficulty(jsonParse(String(raw), {}));
      }
    }
    if (custom) {
      files.push({
        relativePath: "Users/server/server.Arma3Profile",
        content: renderArma3Profile(custom),
      });
    } else {
      pushProgress?.(
        "warn",
        "Custom difficulty is set but no preset or saved options were found; skipping Arma3Profile",
      );
    }
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

  // Library missions are copied to host mpmissions; mod-shipped templates are not.
  if (normalizeMissionSource(profile.mission_source) === "library" && profile.mission_id) {
    await ensureMissionOnHost(hostId, profile.mission_id as string, pushProgress || (() => {}), {
      required: true,
    });
  } else if (normalizeMissionSource(profile.mission_source) === "mod" && missionTemplate) {
    pushProgress?.(
      "config",
      `Using mod mission template “${missionTemplate}” (no PBO deploy)`,
    );
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

  const missionTemplate = resolveProfileMissionTemplate(profile);
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
  // Library PBOs: auto-start for dedicated. Mod-shipped missions (e.g. Antistasi) often
  // wait for admin start/load — forcing -autoInit with persistent=1 causes a restart loop
  // if the mission ends or fails to init. Operators can still add -autoInit in extra args.
  const missionSource = normalizeMissionSource(profile.mission_source);
  if (missionTemplate && !hasAutoInit && missionSource === "library") {
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
  try {
    const result = await runApplyProfileJob({
      profileId: String(req.params.id),
      instanceId: String(req.body?.instanceId || "").trim(),
      downloadMods: req.body?.downloadMods !== false,
      updateServer: !!req.body?.updateServer,
      validate: !!req.body?.validate,
      matchHeadlessRecommendation: !!req.body?.matchHeadlessRecommendation,
      forceStart: !!req.body?.forceStart,
      steamAccountId: req.body?.steamAccountId,
      requestedBy: req.user?.id || null,
      actorLabel: req.user?.email || req.user?.id || "panel user",
      triggerKind: "user",
      refreshDeps: !!req.body?.refreshDeps,
      auditActorEmail: req.user?.email || "",
    });
    if (result.status === "failed") {
      return res.status(result.error === "agent offline" ? 503 : 400).json({ error: result.error, jobId: result.jobId });
    }
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "apply failed";
    if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
    if (/required|Steam account/i.test(msg)) return res.status(400).json({ error: msg });
    res.status(500).json({ error: msg });
  }
});

type ApplyJobInternalOpts = ApplyProfileOpts & {
  refreshDeps?: boolean;
  auditActorEmail?: string;
};

async function runApplyProfileJob(opts: ApplyJobInternalOpts): Promise<ApplyProfileStartResult> {
  const profileId = String(opts.profileId || "").trim();
  const profile = getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(profileId) as
    | Record<string, unknown>
    | undefined;
  if (!profile) throw new Error("profile not found");
  const targetInstanceId = String(opts.instanceId || "").trim();
  if (!targetInstanceId) throw new Error("instanceId required");
  const inst = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(targetInstanceId) as
    | Record<string, unknown>
    | undefined;
  if (!inst) throw new Error("instance not found");
  const hostRow = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(inst.host_id) as Record<string, unknown> | undefined;
  if (!hostRow) throw new Error("host not found");

  const downloadMods = opts.downloadMods !== false;
  const updateServer = !!opts.updateServer;
  const validate = !!opts.validate;
  const matchHeadlessRecommendation = !!opts.matchHeadlessRecommendation;
  const forceStart = !!opts.forceStart;
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
    steamPayload = steamCredsPayload(resolveSteamAccount(opts.steamAccountId));
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
    try {
      opts.onProgress?.(stage, message);
    } catch {
      /* ignore progress hook errors */
    }
  };

  const triggerKind = opts.triggerKind || (opts.scheduleId ? "schedule" : opts.requestedBy ? "user" : "");
  const actorLabel =
    String(opts.actorLabel || "").trim() ||
    (triggerKind === "schedule" ? "Scheduler" : "") ||
    String(opts.auditActorEmail || opts.requestedBy || "").trim();
  getDb()
    .prepare(
      `INSERT INTO jobs(id, kind, host_id, instance_id, profile_id, state, stage, progress, requested_by, actor_label, trigger_kind, schedule_id)
       VALUES (?, 'apply_profile', ?, ?, ?, 'running', 'start', ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      hostId,
      String(inst.id),
      profileId,
      JSON.stringify(progress),
      opts.requestedBy || null,
      actorLabel,
      triggerKind,
      opts.scheduleId || null,
    );
  pruneInstanceJobs(String(inst.id));

  const baseResult: ApplyProfileStartResult = {
    jobId,
    status: "started",
    instanceId: String(inst.id),
    hostId,
    profileId,
    profileName: String(profile.name || ""),
    downloadedMods: downloadMods,
    updatedServer: updateServer,
    modsLibraryPath: libraryPath || undefined,
  };

  if (!hub.isOnline(hostId)) {
    pushProgress("failed", "agent offline");
    getDb().prepare("UPDATE jobs SET error=? WHERE id=?").run("agent offline", jobId);
    return { ...baseResult, status: "failed", error: "agent offline" };
  }

  // Return immediately; SteamCMD can take a long time. Client polls job / SteamCMD logs.
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
          steamPayload = steamCredsPayload(resolveSteamAccount(opts.steamAccountId));
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
        force: !!opts.refreshDeps,
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
          const labeled = await formatWorkshopShortList(noKeys);
          pushProgress(
            "keys",
            `No .bikey in: ${labeled || noKeys.slice(0, 12).join(", ")}${!labeled && noKeys.length > 12 ? "…" : ""} (unsigned / server-only).`,
          );
        }
        if (missing.length) {
          const labeled = await formatWorkshopShortList(missing);
          pushProgress(
            "keys",
            `Could not resolve folder for: ${labeled || missing.slice(0, 12).join(", ")}${!labeled && missing.length > 12 ? "…" : ""}`,
          );
        }
      }

      getDb().prepare("UPDATE instances SET current_profile_id = ? WHERE id = ?").run(profileId, inst.id);

      const shouldStart = wasRunning || forceStart;
      if (shouldStart) {
        pushProgress("instance", forceStart && !wasRunning ? "Starting instance with the applied profile…" : "Starting instance with the applied profile…");
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
            `Profile applied, but start failed: ${start.error || start.message || "instance.start failed"}`,
          );
        }
        const state = String(start.data?.state || "running");
        getDb().prepare("UPDATE instances SET state = ? WHERE id = ?").run(state, inst.id);
        pushProgress(
          "instance",
          headless.length
            ? `Instance started with applied profile (${headless.length} headless client(s))`
            : "Instance started with applied profile",
        );
      }

      pushProgress("done", shouldStart ? "Profile applied and instance started" : "Profile applied");
      getDb().prepare("UPDATE jobs SET state='done', stage='done', error='', updated_at=datetime('now') WHERE id=?").run(jobId);
      getDb()
        .prepare(
          `INSERT INTO audit_log(actor_email, action, target_type, target_id, result) VALUES (?, 'profile.apply', 'profile', ?, 'ok')`,
        )
        .run(opts.auditActorEmail || opts.actorLabel || opts.requestedBy || "system", profileId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "apply failed";
      pushProgress("failed", msg);
      getDb().prepare("UPDATE jobs SET state='failed', error=?, updated_at=datetime('now') WHERE id=?").run(msg, jobId);
      getDb()
        .prepare(
          `INSERT INTO audit_log(actor_email, action, target_type, target_id, result) VALUES (?, 'profile.apply', 'profile', ?, 'failed')`,
        )
        .run(opts.auditActorEmail || opts.actorLabel || opts.requestedBy || "system", profileId);
    }
  })();

  return baseResult;
}

registerApplyProfileImpl((opts) => runApplyProfileJob(opts));

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
function isReadableModName(name: unknown, workshopId: string): boolean {
  const s = String(name || "").trim();
  if (!s || s === workshopId) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (/steamcommunity\.com/i.test(s)) return false;
  return true;
}

function modlistDto(row: Record<string, unknown>) {
  const entries = jsonParse(String(row.entries), [] as { workshopId: string; name?: string; kind: string }[]);
  const meta = readCachedWorkshopMeta(entries.map((e) => e.workshopId));
  return {
    id: row.id,
    name: row.name,
    sourceFilename: row.source_filename || "",
    entries: entries.map((e) => {
      const m = meta.get(e.workshopId);
      const stored = isReadableModName(e.name, e.workshopId) ? String(e.name).trim() : "";
      const title = isReadableModName(m?.title, e.workshopId) ? String(m?.title).trim() : "";
      return {
        workshopId: e.workshopId,
        name: stored || title || e.workshopId,
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

/** Panel library workshop IDs vs what is present on this host (agent mod.check). */
apiRouter.post("/hosts/:id/mods/check", requirePerm("mod.manage"), async (req: AuthedRequest, res) => {
  const hostId = req.params.id;
  const hub = getHub();
  if (!hub.isOnline(hostId)) return res.status(503).json({ error: "agent offline" });
  const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(hostId) as Record<string, unknown> | undefined;
  if (!host) return res.status(404).json({ error: "host not found" });

  let workshopIds: string[] = Array.isArray(req.body?.workshopIds)
    ? (req.body.workshopIds as unknown[]).map((x) => String(x || "").trim()).filter((id) => /^\d+$/.test(id))
    : [];
  if (!workshopIds.length) {
    workshopIds = (
      getDb().prepare("SELECT workshop_id FROM mods ORDER BY name").all() as { workshop_id: string }[]
    ).map((r) => String(r.workshop_id));
  }
  if (!workshopIds.length) {
    return res.json({ present: [], missing: [], sources: {}, paths: {}, message: "Library is empty" });
  }

  const configured = String(host.mods_library_path || "").trim();
  const payload: Record<string, unknown> = { workshopIds, ensureLocalLinks: false };
  if (configured) {
    payload.libraryPath = resolveModsLibraryPath(String(host.arma_root || ""), configured);
  }

  try {
    const result = await hub.dispatch(hostId, "mod.check", payload, 60_000);
    if (!result.ok) {
      return res.status(502).json({ error: result.error || result.message || "mod check failed" });
    }
    const data = (result.data || {}) as Record<string, unknown>;
    const present = Array.isArray(data.present) ? data.present.map(String) : [];
    const missing = Array.isArray(data.missing) ? data.missing.map(String) : [];
    const sources =
      data.sources && typeof data.sources === "object" ? (data.sources as Record<string, string>) : {};
    const paths = data.paths && typeof data.paths === "object" ? (data.paths as Record<string, string>) : {};
    res.json({
      present,
      missing,
      sources,
      paths,
      message: result.message || "",
    });
  } catch (e) {
    res.status(503).json({ error: e instanceof Error ? e.message : "mods check failed" });
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
  const section = String(req.query.section || "mission").toLowerCase();
  if (section !== "mission") {
    return res.status(400).json({
      error: "Only mission .pbo uploads are supported — keys and configs are not managed here",
    });
  }
  const file = req.file;
  if (!file) return res.status(400).json({ error: "file required" });
  const originalName = String(file.originalname || "").trim();
  if (!/\.pbo$/i.test(originalName)) {
    return res.status(400).json({ error: "Only .pbo mission files are allowed" });
  }
  // Reject path tricks in the stored filename
  if (/[\\/]/.test(originalName) || originalName.includes("..")) {
    return res.status(400).json({ error: "invalid filename" });
  }
  const id = uuid();
  const dir = path.join(config.repoRoot, "deploy", "quarantine");
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, `${id}-${path.basename(originalName)}`);
  fs.writeFileSync(stored, file.buffer);
  const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
  getDb()
    .prepare(
      `INSERT INTO uploads(id, uploader_id, section, original_name, stored_path, content_hash, size_bytes, detected_type, validation_state)
       VALUES (?, ?, 'mission', ?, ?, ?, ?, ?, 'quarantined')`,
    )
    .run(id, req.user?.id || null, path.basename(originalName), stored, hash, file.size, ".pbo");
  res.status(201).json({ id });
});

/** Copy an approved/quarantined mission upload into the panel mission library. */
function promoteMissionUploadToLibrary(u: Record<string, unknown>): { missionId: string; updated: boolean } {
  const storedPath = String(u.stored_path || "");
  if (!storedPath || !fs.existsSync(storedPath)) {
    throw new Error("quarantine file missing on panel");
  }
  const pboName = String(u.original_name || "mission.pbo");
  const missionsDir = path.join(config.repoRoot, "deploy", "missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  const existing = getDb()
    .prepare("SELECT id, stored_path FROM missions WHERE lower(pbo_filename) = lower(?)")
    .get(pboName) as { id: string; stored_path: string } | undefined;
  const missionId = existing?.id || uuid();
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
      .prepare(`UPDATE missions SET name=?, pbo_filename=?, content_hash=?, stored_path=? WHERE id=?`)
      .run(pboName, pboName, u.content_hash, dest, missionId);
  } else {
    getDb()
      .prepare("INSERT INTO missions(id, name, pbo_filename, content_hash, stored_path) VALUES (?, ?, ?, ?, ?)")
      .run(missionId, pboName, pboName, u.content_hash, dest);
  }
  return { missionId, updated: !!existing };
}

apiRouter.post("/uploads/:id/approve", requirePerm("mission.manage"), (req: AuthedRequest, res) => {
  const u = getDb().prepare("SELECT * FROM uploads WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!u) return res.status(404).json({ error: "not found" });
  if (u.validation_state !== "quarantined") {
    return res.status(400).json({ error: "upload is not waiting for approval" });
  }
  if (String(u.section || "") !== "mission") {
    return res.status(400).json({ error: "only mission uploads can be approved into the library" });
  }
  try {
    const { missionId, updated } = promoteMissionUploadToLibrary(u);
    getDb()
      .prepare("UPDATE uploads SET validation_state = 'library', reject_reason = '' WHERE id = ?")
      .run(req.params.id);
    audit(req, "upload.approve", req.params.id, updated ? "library-updated" : "library");
    res.json({ status: "ok", section: "mission", missionId, library: true, updated });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "could not add to library" });
  }
});

apiRouter.post("/uploads/:id/reject", requirePerm("mission.manage"), (req, res) => {
  getDb()
    .prepare("UPDATE uploads SET validation_state = 'rejected', reject_reason = ? WHERE id = ?")
    .run(String(req.body?.reason || "rejected"), req.params.id);
  res.json({ status: "ok" });
});

/** Push an approved key/config upload to a host. Missions go to the library on approve; Apply copies PBOs. */
apiRouter.post("/uploads/:id/deploy", requirePerm("mission.manage"), (_req, res) => {
  res.status(410).json({
    error: "Key/config upload deploy was removed — use Host files for ad-hoc host files; missions use Approve + Apply",
  });
});

apiRouter.get("/missions", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM missions ORDER BY name").all() as Record<string, unknown>[];
  res.json(rows.map((m) => ({ id: m.id, name: m.name, pboFilename: m.pbo_filename })));
});

function missionBlockingInstances(missionId: string) {
  const hub = getHub();
  const rows = getDb()
    .prepare(
      `SELECT i.id, i.name, i.host_id, i.state, i.current_profile_id, h.name AS host_name, p.name AS profile_name
       FROM instances i
       JOIN hosts h ON h.id = i.host_id
       JOIN mission_profiles p ON p.id = i.current_profile_id
       WHERE p.mission_id = ?`,
    )
    .all(missionId) as {
    id: string;
    name: string;
    host_id: string;
    state: string;
    current_profile_id: string;
    host_name: string;
    profile_name: string;
  }[];

  const blocking: {
    id: string;
    name: string;
    hostId: string;
    hostName: string;
    state: string;
    profileId: string;
    profileName: string;
  }[] = [];

  for (const row of rows) {
    const live = hub.getInstanceStatus(String(row.host_id), String(row.id));
    const state = String(live?.state || row.state || "stopped").toLowerCase();
    const active = state === "running" || state === "starting" || !!live?.pid;
    if (!active) continue;
    blocking.push({
      id: String(row.id),
      name: String(row.name),
      hostId: String(row.host_id),
      hostName: String(row.host_name || ""),
      state,
      profileId: String(row.current_profile_id),
      profileName: String(row.profile_name || ""),
    });
  }
  return blocking;
}

apiRouter.get("/missions/:id/evict-preview", requirePerm("mission.manage"), (req, res) => {
  const mission = getDb().prepare("SELECT * FROM missions WHERE id = ?").get(req.params.id) as
    | Record<string, unknown>
    | undefined;
  if (!mission) return res.status(404).json({ error: "not found" });

  const profilesAffected = getDb()
    .prepare(`SELECT id, name FROM mission_profiles WHERE mission_id = ? ORDER BY name`)
    .all(req.params.id) as { id: string; name: string }[];

  const blockingInstances = missionBlockingInstances(req.params.id);

  res.json({
    mission: {
      id: mission.id,
      name: mission.name,
      pboFilename: mission.pbo_filename,
      storedPath: mission.stored_path || "",
    },
    profilesAffected,
    blockingInstances,
    canEvict: blockingInstances.length === 0,
  });
});

/**
 * Send an approved library mission back to Waiting approval.
 * Optionally deletes the PBO from hosts (default on). Profiles lose the mission link.
 */
async function deleteMissionPboFromHosts(pboFilename: string) {
  const hostResults: { hostId: string; hostName: string; status: string; detail?: string }[] = [];
  if (!pboFilename) return hostResults;
  const hub = getHub();
  const hosts = getDb().prepare("SELECT id, name FROM hosts").all() as { id: string; name: string }[];
  for (const h of hosts) {
    if (!hub.isOnline(h.id)) {
      hostResults.push({ hostId: h.id, hostName: h.name, status: "skipped", detail: "agent offline" });
      continue;
    }
    try {
      const result = await hub.dispatch(
        h.id,
        "file.delete",
        { root: "mpmissions", relativePath: pboFilename },
        30_000,
      );
      if (!result.ok) {
        hostResults.push({
          hostId: h.id,
          hostName: h.name,
          status: "failed",
          detail: result.error || result.message || "delete failed",
        });
      } else if (result.data?.skipped) {
        hostResults.push({ hostId: h.id, hostName: h.name, status: "absent" });
      } else {
        hostResults.push({ hostId: h.id, hostName: h.name, status: "deleted" });
      }
    } catch (e) {
      hostResults.push({
        hostId: h.id,
        hostName: h.name,
        status: "failed",
        detail: e instanceof Error ? e.message : "delete failed",
      });
    }
  }
  return hostResults;
}

apiRouter.post("/missions/:id/withdraw", requirePerm("mission.manage"), async (req: AuthedRequest, res) => {
  const missionId = req.params.id;
  const mission = getDb().prepare("SELECT * FROM missions WHERE id = ?").get(missionId) as
    | Record<string, unknown>
    | undefined;
  if (!mission) return res.status(404).json({ error: "not found" });

  const blockingInstances = missionBlockingInstances(missionId);
  if (blockingInstances.length) {
    return res.status(409).json({
      error: "Mission is in use by a running instance — stop those instances first",
      blockingInstances,
    });
  }

  const pboName = String(mission.pbo_filename || mission.name || "").trim();
  if (!pboName) return res.status(400).json({ error: "mission has no filename" });

  const deleteFromHosts = req.body?.deleteFromHosts !== false;
  const profilesCleared = getDb()
    .prepare(`SELECT id, name FROM mission_profiles WHERE mission_id = ? ORDER BY name`)
    .all(missionId) as { id: string; name: string }[];

  const stored = String(mission.stored_path || "").trim();
  if (!stored || !fs.existsSync(stored)) {
    return res.status(400).json({ error: "mission file missing on panel — re-upload instead" });
  }

  const hostResults = deleteFromHosts ? await deleteMissionPboFromHosts(pboName) : [];

  const pending = getDb()
    .prepare(
      `SELECT id FROM uploads
       WHERE section = 'mission' AND validation_state = 'quarantined' AND lower(original_name) = lower(?)
       LIMIT 1`,
    )
    .get(pboName) as { id: string } | undefined;

  let uploadId = pending?.id;
  if (!uploadId) {
    const libraryUpload = getDb()
      .prepare(
        `SELECT id, stored_path FROM uploads
         WHERE section = 'mission' AND validation_state = 'library' AND lower(original_name) = lower(?)
         ORDER BY datetime(created_at) DESC LIMIT 1`,
      )
      .get(pboName) as { id: string; stored_path: string } | undefined;

    const quarantineDir = path.join(config.repoRoot, "deploy", "quarantine");
    fs.mkdirSync(quarantineDir, { recursive: true });

    if (libraryUpload) {
      uploadId = libraryUpload.id;
      const dest = path.join(quarantineDir, `${uploadId}-${path.basename(pboName)}`);
      fs.copyFileSync(stored, dest);
      getDb()
        .prepare(
          `UPDATE uploads SET validation_state = 'quarantined', reject_reason = '', stored_path = ?, content_hash = ?, size_bytes = ?
           WHERE id = ?`,
        )
        .run(dest, String(mission.content_hash || ""), fs.statSync(dest).size, uploadId);
    } else {
      uploadId = uuid();
      const dest = path.join(quarantineDir, `${uploadId}-${path.basename(pboName)}`);
      fs.copyFileSync(stored, dest);
      getDb()
        .prepare(
          `INSERT INTO uploads(id, uploader_id, section, original_name, stored_path, content_hash, size_bytes, detected_type, validation_state)
           VALUES (?, ?, 'mission', ?, ?, ?, ?, '.pbo', 'quarantined')`,
        )
        .run(
          uploadId,
          req.user?.id || null,
          path.basename(pboName),
          dest,
          String(mission.content_hash || ""),
          fs.statSync(dest).size,
        );
    }
  }

  // Quarantine holds the bytes for re-approval; drop the library copy.
  if (stored && fs.existsSync(stored)) {
    try {
      fs.unlinkSync(stored);
    } catch {
      /* ignore */
    }
  }
  getDb().prepare("DELETE FROM missions WHERE id = ?").run(missionId);
  audit(req, "mission.withdraw", missionId, deleteFromHosts ? "with-hosts" : "panel-only");

  res.json({
    status: "ok",
    uploadId,
    profilesCleared,
    hostResults,
    deleteFromHosts,
  });
});

async function performMissionEvict(
  req: AuthedRequest,
  missionId: string,
  deleteFromHosts: boolean,
): Promise<
  | { ok: true; profilesCleared: { id: string; name: string }[]; hostResults: { hostId: string; hostName: string; status: string; detail?: string }[]; deleteFromHosts: boolean }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const mission = getDb().prepare("SELECT * FROM missions WHERE id = ?").get(missionId) as
    | Record<string, unknown>
    | undefined;
  if (!mission) return { ok: false, status: 404, body: { error: "not found" } };

  const blockingInstances = missionBlockingInstances(missionId);
  if (blockingInstances.length) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "Mission is in use by a running instance — stop those instances first",
        blockingInstances,
      },
    };
  }

  const pboFilename = String(mission.pbo_filename || mission.name || "").trim();
  const profilesAffected = getDb()
    .prepare(`SELECT id, name FROM mission_profiles WHERE mission_id = ? ORDER BY name`)
    .all(missionId) as { id: string; name: string }[];

  const hostResults = deleteFromHosts ? await deleteMissionPboFromHosts(pboFilename) : [];

  const stored = String(mission.stored_path || "").trim();
  if (stored && fs.existsSync(stored)) {
    try {
      fs.unlinkSync(stored);
    } catch {
      /* ignore panel file cleanup errors */
    }
  }

  // FK ON DELETE SET NULL clears mission_profiles.mission_id
  getDb().prepare("DELETE FROM missions WHERE id = ?").run(missionId);
  audit(req, "mission.evict", missionId, deleteFromHosts ? "with-hosts" : "library-only");

  return {
    ok: true,
    profilesCleared: profilesAffected,
    hostResults,
    deleteFromHosts,
  };
}

apiRouter.post("/missions/:id/evict", requirePerm("mission.manage"), async (req: AuthedRequest, res) => {
  const result = await performMissionEvict(req, req.params.id, req.body?.deleteFromHosts !== false);
  if (!result.ok) return res.status(result.status).json(result.body);
  res.json({
    status: "ok",
    profilesCleared: result.profilesCleared,
    hostResults: result.hostResults,
    deleteFromHosts: result.deleteFromHosts,
  });
});

apiRouter.delete("/missions/:id", requirePerm("mission.manage"), async (req: AuthedRequest, res) => {
  const result = await performMissionEvict(req, req.params.id, true);
  if (!result.ok) return res.status(result.status).json(result.body);
  res.status(204).end();
});

// ---- schedules ----
apiRouter.get("/schedules", (_req, res) => {
  const rows = getDb().prepare("SELECT * FROM schedules ORDER BY run_at").all() as import("../schedules/runner.js").ScheduleRow[];
  res.json(rows.map((s) => scheduleDto(s)));
});

apiRouter.post("/schedules", requirePerm("schedule.manage"), (req, res) => {
  const b = req.body || {};
  if (!b.profileId) return res.status(400).json({ error: "profileId required" });
  const instanceId = String(b.instanceId || "").trim();
  if (!instanceId) return res.status(400).json({ error: "instanceId required" });
  const inst = getDb().prepare("SELECT id FROM instances WHERE id = ?").get(instanceId);
  if (!inst) return res.status(400).json({ error: "instance not found" });
  const id = uuid();
  const fallbackProfileId = String(b.fallbackProfileId || "").trim() || null;
  if (fallbackProfileId) {
    const fb = getDb().prepare("SELECT id FROM mission_profiles WHERE id = ?").get(fallbackProfileId);
    if (!fb) return res.status(400).json({ error: "fallback profile not found" });
    if (fallbackProfileId === String(b.profileId)) {
      return res.status(400).json({ error: "fallback profile must differ from the operation profile" });
    }
  }
  getDb()
    .prepare(
      `INSERT INTO schedules(id, profile_id, instance_id, name, run_at, recurrence, reminder_offsets, discord_channel, requester_discord_id, fallback_profile_id, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
    )
    .run(
      id,
      b.profileId,
      instanceId,
      String(b.name || ""),
      String(b.runAt || new Date().toISOString()),
      String(b.recurrence || "none"),
      JSON.stringify(b.reminderOffsets || [1440, 360, 60, 0]),
      String(b.discordChannel || ""),
      String(b.requesterDiscordId || "").trim(),
      fallbackProfileId,
    );
  const created = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as
    | import("../schedules/runner.js").ScheduleRow
    | undefined;
  if (created) {
    void import("../discord/bot.js")
      .then(({ postScheduleCreatedMessage }) => postScheduleCreatedMessage(created))
      .catch((e) => console.warn("[schedules] discord create notify failed", e));
  }
  res.status(201).json({ id });
});

apiRouter.put("/schedules/:id", requirePerm("schedule.manage"), (req, res) => {
  const existing = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(req.params.id) as
    | import("../schedules/runner.js").ScheduleRow
    | undefined;
  if (!existing) return res.status(404).json({ error: "not found" });
  const st = String(existing.state || "").toLowerCase();
  if (st === "applying" || st === "restoring") {
    return res.status(409).json({ error: "cannot edit a schedule while it is applying or restoring" });
  }

  const b = req.body || {};
  const profileId = String(b.profileId ?? existing.profile_id).trim();
  const instanceId = String(b.instanceId ?? existing.instance_id ?? "").trim();
  if (!profileId) return res.status(400).json({ error: "profileId required" });
  if (!instanceId) return res.status(400).json({ error: "instanceId required" });
  const profile = getDb().prepare("SELECT id FROM mission_profiles WHERE id = ?").get(profileId);
  if (!profile) return res.status(400).json({ error: "profile not found" });
  const inst = getDb().prepare("SELECT id FROM instances WHERE id = ?").get(instanceId);
  if (!inst) return res.status(400).json({ error: "instance not found" });

  let fallbackProfileId: string | null =
    b.fallbackProfileId !== undefined
      ? String(b.fallbackProfileId || "").trim() || null
      : existing.fallback_profile_id || null;
  if (fallbackProfileId) {
    const fb = getDb().prepare("SELECT id FROM mission_profiles WHERE id = ?").get(fallbackProfileId);
    if (!fb) return res.status(400).json({ error: "fallback profile not found" });
  }
  if (fallbackProfileId && fallbackProfileId === profileId) {
    return res.status(400).json({ error: "fallback profile must differ from the operation profile" });
  }

  const name = b.name != null ? String(b.name) : String(existing.name || "");
  const runAt = b.runAt != null ? String(b.runAt) : String(existing.run_at);
  const recurrence = b.recurrence != null ? String(b.recurrence) : String(existing.recurrence || "none");
  const discordChannel = b.discordChannel != null ? String(b.discordChannel) : String(existing.discord_channel || "");
  const requesterDiscordId =
    b.requesterDiscordId != null ? String(b.requesterDiscordId).trim() : String(existing.requester_discord_id || "");
  const reminderOffsets =
    b.reminderOffsets != null
      ? JSON.stringify(b.reminderOffsets)
      : String(existing.reminder_offsets || "[1440,360,60,0]");

  const runAtChanged = runAt !== existing.run_at;
  let nextState = existing.state;
  let confirmedAt = existing.confirmed_at;
  let confirmedBy = existing.confirmed_by;
  let confirmSource = existing.confirm_source;
  let approvedBy = existing.approved_by;
  let remindersSent = existing.reminders_sent;
  if (st === "live") {
    // Live ops: only allow metadata / fallback changes; keep live.
    nextState = "live";
  } else if (runAtChanged) {
    remindersSent = "[]";
    const stillFuture = new Date(runAt).getTime() > Date.now();
    const wasConfirmed = st === "confirmed" || !!existing.confirmed_at;
    if (wasConfirmed && stillFuture) {
      nextState = "confirmed";
    } else {
      nextState = "scheduled";
      confirmedAt = null;
      confirmedBy = "";
      confirmSource = "";
      approvedBy = null;
    }
  } else if (["done", "failed", "skipped"].includes(st)) {
    nextState = "scheduled";
    remindersSent = "[]";
    confirmedAt = null;
    confirmedBy = "";
    confirmSource = "";
    approvedBy = null;
  }

  getDb()
    .prepare(
      `UPDATE schedules SET
         profile_id=?, instance_id=?, name=?, run_at=?, recurrence=?, reminder_offsets=?,
         discord_channel=?, requester_discord_id=?, fallback_profile_id=?, state=?,
         confirmed_at=?, confirmed_by=?, confirm_source=?, approved_by=?,
         reminders_sent=?, last_error=''
       WHERE id=?`,
    )
    .run(
      profileId,
      instanceId,
      name,
      runAt,
      recurrence,
      reminderOffsets,
      discordChannel,
      requesterDiscordId,
      fallbackProfileId,
      nextState,
      confirmedAt,
      confirmedBy,
      confirmSource,
      approvedBy,
      remindersSent,
      existing.id,
    );

  const updated = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(existing.id) as import("../schedules/runner.js").ScheduleRow;
  res.json(scheduleDto(updated));
});

apiRouter.delete("/schedules/:id", requirePerm("schedule.manage"), (req, res) => {
  getDb().prepare("DELETE FROM schedules WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

apiRouter.post("/schedules/:id/confirm", (req: AuthedRequest, res) => {
  if (!canConfirmSchedule(req.grants)) return res.status(403).json({ error: "forbidden" });
  const result = confirmSchedule(req.params.id, {
    label: req.user?.email || "panel",
    source: "panel",
    userId: req.user?.id || null,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ status: "ok" });
});

apiRouter.post("/schedules/:id/stand-down", async (req: AuthedRequest, res) => {
  if (!canStandDownSchedule(req.grants)) return res.status(403).json({ error: "forbidden" });
  try {
    const result = await standDownScheduleOccurrence(req.params.id, {
      label: req.user?.email || "panel",
      source: "panel",
      userId: req.user?.id || null,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "stand down failed" });
  }
});

apiRouter.post("/schedules/:id/finish", async (req: AuthedRequest, res) => {
  if (!canFinishSchedule(req.grants)) return res.status(403).json({ error: "forbidden" });
  try {
    const result = await finishScheduleOperation(req.params.id, {
      label: req.user?.email || "panel",
      source: "panel",
      userId: req.user?.id || null,
    });
    if (!result.ok) return res.status(400).json({ error: result.error, jobId: result.jobId });
    res.json({ status: "ok", jobId: result.jobId });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "finish failed" });
  }
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

apiRouter.get("/steam/web-api-key", (req: AuthedRequest, res) => {
  const grants = req.grants || [];
  const allowed = grants.some(
    (g) =>
      g.permission === "steam.config" ||
      g.permission === "mod.manage" ||
      g.permission === "profile.apply" ||
      g.permission === "host.add" ||
      g.permission === "instance.view" ||
      g.permission === "user.manage",
  );
  if (!allowed) return res.status(403).json({ error: "forbidden" });
  res.json(steamWebApiKeyPublic());
});

apiRouter.put("/steam/web-api-key", requirePerm("steam.config"), (req: AuthedRequest, res) => {
  const clear = !!req.body?.clear;
  const apiKey = String(req.body?.apiKey ?? "");
  if (!clear && !apiKey.trim()) {
    return res.status(400).json({ error: "apiKey required (or set clear: true)" });
  }
  const status = saveSteamWebApiKey({ apiKey, clear });
  audit(req, clear ? "steam.web_api_key.clear" : "steam.web_api_key.save", "settings", "ok");
  res.json(status);
});

apiRouter.get("/discord/config", requirePerm("discord.config"), (_req, res) => {
  res.json(discordPublicConfig());
});

apiRouter.get("/discord/status", requirePerm("discord.config"), (_req, res) => {
  const cfg = discordPublicConfig();
  const runtime = getDiscordBotRuntimeStatus();
  res.json({
    ...cfg,
    connected: runtime.connected,
    botTag: runtime.botTag,
    botId: runtime.botId,
    restartHint: cfg.enabled && cfg.hasToken && !runtime.connected,
  });
});

apiRouter.get("/discord/guilds", requirePerm("discord.config"), (_req, res) => {
  const runtime = getDiscordBotRuntimeStatus();
  if (!runtime.connected) return res.status(503).json({ error: "bot not connected" });
  res.json(listDiscordGuilds());
});

apiRouter.get("/discord/guilds/:id/channels", requirePerm("discord.config"), async (req, res) => {
  const runtime = getDiscordBotRuntimeStatus();
  if (!runtime.connected) return res.status(503).json({ error: "bot not connected" });
  try {
    res.json(await listDiscordGuildChannels(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "failed to list channels" });
  }
});

apiRouter.get("/discord/guilds/:id/roles", requirePerm("discord.config"), async (req, res) => {
  const runtime = getDiscordBotRuntimeStatus();
  if (!runtime.connected) return res.status(503).json({ error: "bot not connected" });
  try {
    res.json(await listDiscordGuildRoles(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "failed to list roles" });
  }
});

apiRouter.put("/discord/config", requirePerm("discord.config"), async (req, res) => {
  saveDiscordSettings(req.body || {});
  audit(req, "discord.config", "settings", "ok");
  try {
    const restarted = await restartDiscordBot();
    res.json({
      status: "ok",
      ...discordPublicConfig(),
      connected: restarted.connected,
      botTag: restarted.botTag,
      error: restarted.error,
    });
  } catch (e) {
    res.json({
      status: "ok",
      ...discordPublicConfig(),
      connected: false,
      botTag: null,
      error: e instanceof Error ? e.message : "bot restart failed",
    });
  }
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
