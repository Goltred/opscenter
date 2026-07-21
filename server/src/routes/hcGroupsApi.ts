import type { Response, Router } from "express";
import { v4 as uuid } from "uuid";
import { getDb, jsonParse } from "../db.js";
import { AuthedRequest, requirePerm } from "../auth/middleware.js";
import { getHub } from "../agent/hub.js";
import {
  buildHeadlessLaunchSpecs,
  clampHeadlessCount,
  injectHeadlessIntoServerCfg,
  serverCfgPassword,
} from "../arma/headless.js";
import { mergeServerCfg, renderServerCfg } from "../arma/serverCfg.js";
import {
  effectiveRemoteHcIps,
  getHcGroupRow,
  hcGroupBindPortBase,
  hcGroupDto,
  listHcGroupRows,
  parseAdvertiseHost,
  resolveGroupConnectHost,
  resolveWorkerAllowlistIp,
  type HcGroupRow,
} from "../hcGroups.js";
import { normalizeDlcCodes } from "../arma/dlcs.js";
import { modFolderLaunchArg } from "../arma/modsLibrary.js";

export type HcGroupRouteDeps = {
  audit: (req: AuthedRequest, action: string, targetId?: string, result?: string) => void;
  resolveProfileWorkshopIds: (
    profile: Record<string, unknown>,
    opts?: { preferStale?: boolean },
  ) => Promise<{ client: string[]; server: string[] }>;
  resolveModLaunchPaths: (
    hostId: string,
    host: Record<string, unknown>,
    workshopIds: string[],
  ) => Promise<Record<string, string>>;
  resolveInstanceSharedCfg: (inst: Record<string, unknown>) => Record<string, unknown>;
  uniqueIds: (ids: string[]) => string[];
  uniqueLaunchPaths: (paths: string[]) => string[];
  writeProfileConfigToHost: (
    hostId: string,
    inst: Record<string, unknown>,
    profile: Record<string, unknown>,
    pushProgress?: (stage: string, message: string) => void,
    modCountHint?: number,
  ) => Promise<{ missionTemplate: string; serverCfg: string; mergedCfg: Record<string, unknown> }>;
};

/** Wire HC worker-group routes onto the main API router. */
export function registerHcGroupRoutes(apiRouter: Router, deps: HcGroupRouteDeps) {
  const { audit } = deps;

  apiRouter.get("/hc-groups", (_req, res) => {
    res.json(listHcGroupRows().map(hcGroupDto));
  });

  apiRouter.get("/hosts/:id/hc-groups", (req, res) => {
    const host = getDb().prepare("SELECT id FROM hosts WHERE id = ?").get(req.params.id);
    if (!host) return res.status(404).json({ error: "host not found" });
    res.json(listHcGroupRows(req.params.id).map(hcGroupDto));
  });

  apiRouter.get("/hc-groups/:id", (req, res) => {
    const row = getHcGroupRow(req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(hcGroupDto(row));
  });

  apiRouter.post("/hc-groups", requirePerm("host.add"), (req: AuthedRequest, res) => {
    const hostId = String(req.body?.hostId || "").trim();
    const name = String(req.body?.name || "").trim();
    if (!hostId || !name) return res.status(400).json({ error: "hostId and name required" });
    const host = getDb().prepare("SELECT id FROM hosts WHERE id = ?").get(hostId);
    if (!host) return res.status(404).json({ error: "host not found" });

    const targetInstanceId = String(req.body?.targetInstanceId || "").trim() || null;
    if (targetInstanceId) {
      const inst = getDb().prepare("SELECT id FROM instances WHERE id = ?").get(targetInstanceId);
      if (!inst) return res.status(400).json({ error: "target instance not found" });
    }

    const id = uuid();
    const desired = clampHeadlessCount(req.body?.desiredCount ?? req.body?.count ?? 1);
    const profileDir = String(req.body?.profileDir || `hc-groups/${id}`).trim() || `hc-groups/${id}`;
    const connectHost = parseAdvertiseHost(req.body?.connectHost);

    getDb()
      .prepare(
        `INSERT INTO hc_groups(id, host_id, name, desired_count, target_instance_id, profile_dir, connect_host)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, hostId, name, desired, targetInstanceId, profileDir, connectHost);

    audit(req, "hcgroup.create", id);
    res.status(201).json(hcGroupDto(getHcGroupRow(id)!));
  });

  apiRouter.patch("/hc-groups/:id", requirePerm("instance.config.edit"), async (req: AuthedRequest, res) => {
    const row = getHcGroupRow(req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });

    const name = req.body?.name != null ? String(req.body.name).trim() : row.name;
    if (!name) return res.status(400).json({ error: "name required" });

    let targetInstanceId = row.target_instance_id;
    if (req.body?.targetInstanceId !== undefined) {
      const next = String(req.body.targetInstanceId || "").trim();
      targetInstanceId = next || null;
      if (targetInstanceId) {
        const inst = getDb().prepare("SELECT id FROM instances WHERE id = ?").get(targetInstanceId);
        if (!inst) return res.status(400).json({ error: "target instance not found" });
      }
    }

    const desired =
      req.body?.desiredCount != null || req.body?.count != null
        ? clampHeadlessCount(req.body?.desiredCount ?? req.body?.count)
        : clampHeadlessCount(row.desired_count);

    const connectHost =
      req.body?.connectHost !== undefined ? parseAdvertiseHost(req.body.connectHost) : row.connect_host;

    const profileDir =
      req.body?.profileDir != null
        ? String(req.body.profileDir).trim() || row.profile_dir
        : row.profile_dir;

    getDb()
      .prepare(
        `UPDATE hc_groups SET name=?, desired_count=?, target_instance_id=?, profile_dir=?, connect_host=?,
         updated_at=datetime('now') WHERE id=?`,
      )
      .run(name, desired, targetInstanceId, profileDir, connectHost, row.id);

    const updated = getHcGroupRow(row.id)!;
    if (updated.target_instance_id) {
      try {
        await syncTargetAllowlist(updated.target_instance_id, deps);
      } catch (e) {
        return res.status(502).json({
          error: e instanceof Error ? e.message : "failed to update target server.cfg allowlist",
          group: hcGroupDto(updated),
        });
      }
    }

    audit(req, "hcgroup.update", row.id);
    res.json(hcGroupDto(updated));
  });

  apiRouter.delete("/hc-groups/:id", requirePerm("host.remove"), async (req: AuthedRequest, res) => {
    const row = getHcGroupRow(req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });

    const hub = getHub();
    if (hub.isOnline(row.host_id)) {
      try {
        await hub.dispatch(row.host_id, "hcgroup.stop", { groupId: row.id }, 60_000);
      } catch {
        /* best-effort */
      }
    }

    const targetId = row.target_instance_id;
    getDb().prepare("DELETE FROM hc_groups WHERE id = ?").run(row.id);
    if (targetId) {
      try {
        await syncTargetAllowlist(targetId, deps);
      } catch {
        /* ignore */
      }
    }
    audit(req, "hcgroup.delete", row.id);
    res.status(204).end();
  });

  apiRouter.post("/hc-groups/:id/scale", requirePerm("instance.control"), async (req: AuthedRequest, res) => {
    await runHcGroupScale(req, res, deps);
  });

  apiRouter.post("/hc-groups/:id/start", requirePerm("instance.control"), async (req: AuthedRequest, res) => {
    await runHcGroupScale(req, res, deps, { forceStart: true });
  });

  apiRouter.post("/hc-groups/:id/stop", requirePerm("instance.control"), async (req: AuthedRequest, res) => {
    const row = getHcGroupRow(req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    const hub = getHub();
    if (!hub.isOnline(row.host_id)) return res.status(503).json({ error: "worker agent offline" });
    try {
      const result = await hub.dispatch(row.host_id, "hcgroup.stop", { groupId: row.id }, 60_000);
      audit(req, "hcgroup.stop", row.id, result.ok ? "ok" : "failed");
      if (!result.ok) return res.status(502).json({ error: result.error || "stop failed", result });
      res.json({ status: "ok", result, group: hcGroupDto(row) });
    } catch (e) {
      res.status(503).json({ error: e instanceof Error ? e.message : "stop failed" });
    }
  });

  apiRouter.post("/hc-groups/:id/restart", requirePerm("instance.control"), async (req: AuthedRequest, res) => {
    await runHcGroupScale(req, res, deps, { forceRestart: true });
  });
}

async function syncTargetAllowlist(instanceId: string, deps: HcGroupRouteDeps) {
  const inst = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(instanceId) as
    | Record<string, unknown>
    | undefined;
  if (!inst) return;
  const host = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(inst.host_id) as
    | Record<string, unknown>
    | undefined;
  if (!host) return;
  const hostId = String(inst.host_id);
  const hub = getHub();
  if (!hub.isOnline(hostId)) return;

  let profile: Record<string, unknown> | null = null;
  if (inst.current_profile_id) {
    profile =
      (getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(inst.current_profile_id) as
        | Record<string, unknown>
        | undefined) || null;
  }

  if (profile) {
    const expanded = await deps.resolveProfileWorkshopIds(profile, { preferStale: true });
    await deps.writeProfileConfigToHost(hostId, inst, profile, undefined, expanded.client.length);
    return;
  }

  const sharedCfg = deps.resolveInstanceSharedCfg(inst);
  const mergedCfg = injectHeadlessIntoServerCfg(
    sharedCfg,
    clampHeadlessCount(inst.headless_count),
    effectiveRemoteHcIps(inst),
  );
  const serverCfg = renderServerCfg(mergedCfg, {});
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

async function buildGroupHeadlessPayload(group: HcGroupRow, deps: HcGroupRouteDeps) {
  if (!group.target_instance_id) {
    throw new Error("HC group has no target instance — set one before starting");
  }
  const targetInst = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(group.target_instance_id) as
    | Record<string, unknown>
    | undefined;
  if (!targetInst) throw new Error("target instance not found");

  const workerHost = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(group.host_id) as
    | Record<string, unknown>
    | undefined;
  const targetHost = getDb().prepare("SELECT * FROM hosts WHERE id = ?").get(targetInst.host_id) as
    | Record<string, unknown>
    | undefined;
  if (!workerHost || !targetHost) throw new Error("host not found");

  const connect = resolveGroupConnectHost(group, workerHost, targetInst, targetHost);
  if (connect.error || !connect.host) throw new Error(connect.error || "connect host required");

  const allow = resolveWorkerAllowlistIp(workerHost, String(targetInst.host_id));
  if (allow.error) throw new Error(allow.error);

  let profile: Record<string, unknown> | null = null;
  if (targetInst.current_profile_id) {
    profile =
      (getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(targetInst.current_profile_id) as
        | Record<string, unknown>
        | undefined) || null;
  }

  let modParts: string[] = [];
  let mergedCfg: Record<string, unknown> = {};
  if (profile) {
    const expanded = await deps.resolveProfileWorkshopIds(profile, { preferStale: true });
    const workshopIds = deps.uniqueIds([...expanded.client, ...expanded.server]);
    const resolvedPaths = await deps.resolveModLaunchPaths(String(workerHost.id), workerHost, workshopIds);
    const armaRoot = String(workerHost.arma_root || "").replace(/[/\\]+$/, "");
    const libPath = String(workerHost.mods_library_path || "");
    const dlcs = normalizeDlcCodes(jsonParse(String(profile.dlcs), []));
    const pathFor = (id: string) => {
      const resolved = resolvedPaths?.[id];
      if (resolved && String(resolved).trim()) return String(resolved).trim();
      return modFolderLaunchArg(armaRoot, libPath, id);
    };
    modParts = deps.uniqueLaunchPaths([...dlcs, ...expanded.client.map(pathFor)]);
    const sharedCfg = deps.resolveInstanceSharedCfg(targetInst);
    const profileCfg = jsonParse<Record<string, unknown>>(String(profile.server_cfg_overrides), {});
    mergedCfg = injectHeadlessIntoServerCfg(
      mergeServerCfg(sharedCfg, profileCfg),
      clampHeadlessCount(targetInst.headless_count),
      effectiveRemoteHcIps(targetInst),
    );
  } else {
    mergedCfg = injectHeadlessIntoServerCfg(
      deps.resolveInstanceSharedCfg(targetInst),
      clampHeadlessCount(targetInst.headless_count),
      effectiveRemoteHcIps(targetInst),
    );
  }

  const count = clampHeadlessCount(group.desired_count);
  const profileDir = group.profile_dir || `hc-groups/${group.id}`;
  const specs = buildHeadlessLaunchSpecs({
    count,
    serverPort: Number(targetInst.port) || 2302,
    instanceProfileDir: profileDir,
    password: serverCfgPassword(mergedCfg),
    modParts,
    connectHost: connect.host,
    namePrefix: "hc",
    bindPortBase: hcGroupBindPortBase(group.id),
  });

  return {
    workerHost,
    specs: specs.map((s) => ({
      name: s.name,
      args: s.args,
      profileDir: s.profileDir,
      port: s.port,
    })),
  };
}

async function runHcGroupScale(
  req: AuthedRequest,
  res: Response,
  deps: HcGroupRouteDeps,
  opts?: { forceStart?: boolean; forceRestart?: boolean },
) {
  const { audit } = deps;
  const row = getHcGroupRow(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });

  let target = clampHeadlessCount(row.desired_count);
  if (req.body?.count != null) target = clampHeadlessCount(req.body.count);
  else if (req.body?.delta != null) target = clampHeadlessCount(target + Number(req.body.delta));
  else if (opts?.forceStart) target = Math.max(1, target);

  getDb()
    .prepare(`UPDATE hc_groups SET desired_count=?, updated_at=datetime('now') WHERE id=?`)
    .run(target, row.id);
  const updated = getHcGroupRow(row.id)!;

  const hub = getHub();
  if (!hub.isOnline(updated.host_id)) {
    return res.status(503).json({ error: "worker agent offline", group: hcGroupDto(updated) });
  }

  try {
    if (updated.target_instance_id) {
      await syncTargetAllowlist(updated.target_instance_id, deps);
    }

    if (opts?.forceRestart) {
      await hub.dispatch(updated.host_id, "hcgroup.stop", { groupId: updated.id }, 60_000);
    }

    if (target <= 0) {
      const result = await hub.dispatch(updated.host_id, "hcgroup.stop", { groupId: updated.id }, 60_000);
      audit(req, "hcgroup.scale", updated.id, result.ok ? "ok" : "failed");
      return res.json({ status: "ok", group: hcGroupDto(updated), result });
    }

    const built = await buildGroupHeadlessPayload(updated, deps);
    const result = await hub.dispatch(
      updated.host_id,
      "hcgroup.scale",
      {
        groupId: updated.id,
        armaRoot: String(built.workerHost.arma_root || ""),
        headless: built.specs,
        desiredCount: target,
      },
      120_000,
    );
    audit(req, "hcgroup.scale", updated.id, result.ok ? "ok" : "failed");
    if (!result.ok) {
      return res.status(502).json({ error: result.error || "scale failed", result, group: hcGroupDto(updated) });
    }
    res.json({ status: "ok", group: hcGroupDto(getHcGroupRow(updated.id)!), result });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "scale failed", group: hcGroupDto(updated) });
  }
}
