import { getDb, jsonParse } from "./db.js";

/** Max retained rows in instance Job history. */
export const JOBS_HISTORY_LIMIT = 3;

/** Keep only the newest N jobs for an instance (by created_at). */
export function pruneInstanceJobs(instanceId: string, keep = JOBS_HISTORY_LIMIT): void {
  const id = String(instanceId || "").trim();
  if (!id) return;
  getDb()
    .prepare(
      `DELETE FROM jobs
       WHERE instance_id = ?
         AND id NOT IN (
           SELECT id FROM (
             SELECT id FROM jobs
             WHERE instance_id = ?
             ORDER BY datetime(created_at) DESC, rowid DESC
             LIMIT ?
           )
         )`,
    )
    .run(id, id, keep);
}

export type JobProgressEntry = { stage: string; message: string; at: string };

export type JobDto = {
  id: string;
  kind: string;
  state: string;
  stage: string;
  error?: string;
  progress: JobProgressEntry[];
  createdAt?: string;
  updatedAt?: string;
  hostId?: string;
  hostName?: string;
  instanceId?: string;
  instanceName?: string;
  profileId?: string;
  profileName?: string;
};

export function jobDto(row: Record<string, unknown>): JobDto {
  const hostId = row.host_id ? String(row.host_id) : undefined;
  const instanceId = row.instance_id ? String(row.instance_id) : undefined;
  const profileId = row.profile_id ? String(row.profile_id) : undefined;

  let hostName: string | undefined;
  let instanceName: string | undefined;
  let profileName: string | undefined;

  const db = getDb();
  if (hostId) {
    const h = db.prepare("SELECT name FROM hosts WHERE id = ?").get(hostId) as { name?: string } | undefined;
    hostName = h?.name ? String(h.name) : undefined;
  }
  if (instanceId) {
    const i = db.prepare("SELECT name FROM instances WHERE id = ?").get(instanceId) as { name?: string } | undefined;
    instanceName = i?.name ? String(i.name) : undefined;
  }
  if (profileId) {
    const p = db.prepare("SELECT name FROM mission_profiles WHERE id = ?").get(profileId) as
      | { name?: string }
      | undefined;
    profileName = p?.name ? String(p.name) : undefined;
  }

  return {
    id: String(row.id),
    kind: String(row.kind || ""),
    state: String(row.state || ""),
    stage: String(row.stage || ""),
    error: row.error ? String(row.error) : undefined,
    progress: jsonParse<JobProgressEntry[]>(String(row.progress || "[]"), []),
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
    hostId,
    hostName,
    instanceId,
    instanceName,
    profileId,
    profileName,
  };
}

export function listActiveJobs(limit = 40): JobDto[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM jobs
       WHERE lower(state) IN ('running', 'pending', 'queued')
       ORDER BY datetime(updated_at) DESC, rowid DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(jobDto);
}
