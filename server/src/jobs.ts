import { getDb, jsonParse } from "./db.js";

/** Max retained rows in instance Job history. */
export const JOBS_HISTORY_LIMIT = 10;

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
  /** Panel user id when a signed-in user started the job. */
  requestedBy?: string;
  /** Display label for who/what triggered the job. */
  actorLabel?: string;
  /** `user` | `schedule` | empty for legacy rows. */
  triggerKind?: string;
  scheduleId?: string;
  scheduleName?: string;
};

function resolveActorLabel(row: Record<string, unknown>): string {
  const stored = String(row.actor_label || "").trim();
  if (stored) return stored;
  const requestedBy = String(row.requested_by || "").trim();
  if (!requestedBy) return "";
  if (requestedBy === "scheduler") return "Scheduler";
  const user = getDb()
    .prepare("SELECT email, display_name FROM users WHERE id = ?")
    .get(requestedBy) as { email?: string; display_name?: string } | undefined;
  if (user) return String(user.display_name || user.email || requestedBy);
  return requestedBy;
}

export function jobDto(row: Record<string, unknown>): JobDto {
  const hostId = row.host_id ? String(row.host_id) : undefined;
  const instanceId = row.instance_id ? String(row.instance_id) : undefined;
  const profileId = row.profile_id ? String(row.profile_id) : undefined;
  const scheduleId = row.schedule_id ? String(row.schedule_id) : undefined;
  const triggerKind = String(row.trigger_kind || "").trim() || undefined;
  const requestedBy = row.requested_by != null && String(row.requested_by).trim() ? String(row.requested_by) : undefined;

  let hostName: string | undefined;
  let instanceName: string | undefined;
  let profileName: string | undefined;
  let scheduleName: string | undefined;

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
  if (scheduleId) {
    const s = db.prepare("SELECT name FROM schedules WHERE id = ?").get(scheduleId) as { name?: string } | undefined;
    scheduleName = s?.name ? String(s.name) : undefined;
  }

  const actorLabel = resolveActorLabel(row) || undefined;

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
    requestedBy,
    actorLabel,
    triggerKind,
    scheduleId,
    scheduleName,
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
