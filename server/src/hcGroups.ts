import { getDb } from "./db.js";
import { clampHeadlessCount, parseRemoteHcIpsColumn } from "./arma/headless.js";
import { getHub } from "./agent/hub.js";
import type { HeadlessHeartbeat } from "./agent/protocol.js";

export type HcGroupRow = {
  id: string;
  host_id: string;
  name: string;
  desired_count: number;
  target_instance_id: string | null;
  profile_dir: string;
  connect_host: string;
};

/** Stable bind-port base so multiple groups on one worker don't collide. */
export function hcGroupBindPortBase(groupId: string): number {
  let h = 0;
  for (let i = 0; i < groupId.length; i++) h = (h * 31 + groupId.charCodeAt(i)) >>> 0;
  return 2500 + (h % 180);
}

export function listHcGroupRows(hostId?: string): HcGroupRow[] {
  if (hostId) {
    return getDb()
      .prepare(
        `SELECT id, host_id, name, desired_count, target_instance_id, profile_dir, connect_host
         FROM hc_groups WHERE host_id = ? ORDER BY name`,
      )
      .all(hostId) as HcGroupRow[];
  }
  return getDb()
    .prepare(
      `SELECT id, host_id, name, desired_count, target_instance_id, profile_dir, connect_host
       FROM hc_groups ORDER BY name`,
    )
    .all() as HcGroupRow[];
}

export function getHcGroupRow(id: string): HcGroupRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, host_id, name, desired_count, target_instance_id, profile_dir, connect_host
       FROM hc_groups WHERE id = ?`,
    )
    .get(id) as HcGroupRow | undefined;
}

/** IPs of worker hosts that have HC groups targeting this instance (for server.cfg allowlist). */
export function managedAllowlistIpsForInstance(instanceId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT g.host_id AS worker_host_id, g.connect_host, i.host_id AS target_host_id,
              wh.advertise_host AS worker_advertise, th.advertise_host AS target_advertise
       FROM hc_groups g
       JOIN instances i ON i.id = g.target_instance_id
       JOIN hosts wh ON wh.id = g.host_id
       JOIN hosts th ON th.id = i.host_id
       WHERE g.target_instance_id = ? AND g.desired_count > 0`,
    )
    .all(instanceId) as {
    worker_host_id: string;
    target_host_id: string;
    worker_advertise: string;
    target_advertise: string;
    connect_host: string;
  }[];

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (ip: string) => {
    const s = String(ip || "").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  for (const r of rows) {
    if (r.worker_host_id === r.target_host_id) {
      add("127.0.0.1");
      continue;
    }
    const workerIp = String(r.worker_advertise || "").trim();
    if (workerIp) add(workerIp);
  }
  return out;
}

/** Manual remote_hc_ips + managed worker IPs for an instance. */
export function effectiveRemoteHcIps(inst: Record<string, unknown>): string[] {
  const manual = parseRemoteHcIpsColumn(inst);
  const managed = managedAllowlistIpsForInstance(String(inst.id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ip of [...manual, ...managed]) {
    const s = ip.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function groupsTargetingInstance(instanceId: string): HcGroupRow[] {
  return getDb()
    .prepare(
      `SELECT id, host_id, name, desired_count, target_instance_id, profile_dir, connect_host
       FROM hc_groups WHERE target_instance_id = ? ORDER BY name`,
    )
    .all(instanceId) as HcGroupRow[];
}

/**
 * Resolve -connect= host for a group.
 * Same host as target → 127.0.0.1; else group.connect_host or target host advertise_host.
 */
export function resolveGroupConnectHost(
  group: HcGroupRow,
  workerHost: Record<string, unknown>,
  targetInst: Record<string, unknown>,
  targetHost: Record<string, unknown>,
): { host: string; error?: string } {
  const override = String(group.connect_host || "").trim();
  if (override) return { host: override };

  if (String(workerHost.id) === String(targetInst.host_id)) {
    return { host: "127.0.0.1" };
  }

  const advertise = String(targetHost.advertise_host || "").trim();
  if (advertise) return { host: advertise };

  return {
    host: "",
      error:
        "Set a reachable address on the game server's host (Edit host → Reachable address), or set a connect host override on this HC group — remote HCs need an address to reach the dedicated server.",
  };
}

/** Worker host IP that must appear in the game server's headlessClients allowlist. */
export function resolveWorkerAllowlistIp(
  workerHost: Record<string, unknown>,
  targetHostId: string,
): { ip: string; error?: string } {
  if (String(workerHost.id) === String(targetHostId)) {
    return { ip: "127.0.0.1" };
  }
  const advertise = String(workerHost.advertise_host || "").trim();
  if (advertise) return { ip: advertise };
  return {
    ip: "",
    error:
      "Set a reachable address on the HC worker host (Edit host → Reachable address) so the game server can allowlist the HC connection source IP.",
  };
}

export function hcGroupLiveHeadless(groupId: string, workerHostId: string): HeadlessHeartbeat[] {
  const live = getHub().getHcGroupStatus(workerHostId, groupId);
  return Array.isArray(live?.headless) ? live!.headless! : [];
}

export function hcGroupRollup(desired: number, live: HeadlessHeartbeat[]) {
  const active = live.filter((h) =>
    ["running", "connected", "starting"].includes(String(h.state || "").toLowerCase()),
  ).length;
  const failed = live.filter((h) => String(h.state || "").toLowerCase() === "failed").length;
  let state = "stopped";
  if (desired <= 0) state = "idle";
  else if (failed > 0 && active === 0) state = "failed";
  else if (failed > 0) state = "degraded";
  else if (active >= desired) state = "connected";
  else if (active > 0) state = "starting";
  else state = "stopped";
  return { active, failed, desired, state };
}

export function hcGroupDto(row: HcGroupRow) {
  const hub = getHub();
  const workerOnline = hub.isOnline(row.host_id);
  const live = hcGroupLiveHeadless(row.id, row.host_id);
  const rollup = hcGroupRollup(clampHeadlessCount(row.desired_count), live);

  let targetName: string | undefined;
  let targetHostId: string | undefined;
  let targetHostName: string | undefined;
  let targetPort: number | undefined;
  if (row.target_instance_id) {
    const inst = getDb()
      .prepare(
        `SELECT i.id, i.name, i.port, i.host_id, h.name AS host_name
         FROM instances i JOIN hosts h ON h.id = i.host_id WHERE i.id = ?`,
      )
      .get(row.target_instance_id) as
      | { id: string; name: string; port: number; host_id: string; host_name: string }
      | undefined;
    if (inst) {
      targetName = inst.name;
      targetHostId = inst.host_id;
      targetHostName = inst.host_name;
      targetPort = Number(inst.port) || 2302;
    }
  }

  const worker = getDb().prepare("SELECT name, advertise_host FROM hosts WHERE id = ?").get(row.host_id) as
    | { name: string; advertise_host: string }
    | undefined;

  return {
    id: row.id,
    hostId: row.host_id,
    hostName: worker?.name,
    name: row.name,
    desiredCount: clampHeadlessCount(row.desired_count),
    targetInstanceId: row.target_instance_id || undefined,
    targetName,
    targetHostId,
    targetHostName,
    targetPort,
    profileDir: row.profile_dir || `hc-groups/${row.id}`,
    connectHost: row.connect_host || "",
    workerAdvertiseHost: String(worker?.advertise_host || ""),
    workerOnline,
    status: {
      state: !workerOnline ? "agent offline" : rollup.state,
      active: rollup.active,
      failed: rollup.failed,
      desired: rollup.desired,
      headless: live,
    },
  };
}

export function parseAdvertiseHost(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/[\\/\s]/.test(s) || s.length > 64) return "";
  return s;
}
