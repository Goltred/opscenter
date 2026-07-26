import { getDb, jsonParse } from "../db.js";
import { startApplyProfileJob } from "../applyProfile.js";
import { notifyScheduleChannel } from "../discord/notify.js";

export const DEFAULT_REMINDER_OFFSETS = [1440, 360, 60, 0];
export const CONFIRM_OFFSET_MIN = 60;

function parseReminderOffsets(row: ScheduleRow): number[] {
  return jsonParse<number[]>(String(row.reminder_offsets), DEFAULT_REMINDER_OFFSETS)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => b - a);
}

function parseRemindersSent(row: ScheduleRow): Set<number> {
  return new Set(jsonParse<number[]>(String(row.reminders_sent), []));
}

/** Mark reminder offsets as sent so catch-up ticks do not spam Discord. */
export function markRemindersSent(row: ScheduleRow, offsets: number[]): void {
  const sent = parseRemindersSent(row);
  let changed = false;
  for (const off of offsets) {
    if (!sent.has(off)) {
      sent.add(off);
      changed = true;
    }
  }
  if (!changed) return;
  const next = [...sent];
  getDb().prepare(`UPDATE schedules SET reminders_sent=? WHERE id=?`).run(JSON.stringify(next), row.id);
  row.reminders_sent = JSON.stringify(next);
}

/** Silence every non-zero reminder (used once Confirm is the relevant message). */
export function silenceNonZeroReminders(row: ScheduleRow): void {
  markRemindersSent(
    row,
    parseReminderOffsets(row).filter((o) => o > 0),
  );
}

function formatEtaMinutes(minsUntil: number): string {
  const m = Math.max(1, Math.round(minsUntil));
  if (m >= 1440) return `${Math.round(m / 1440)} day(s)`;
  if (m >= 60) return `${Math.round(m / 60)} hour(s)`;
  return `${m} min`;
}

/**
 * Move into the confirm window: one Discord confirm message, no reminder spam.
 * No-ops the Discord post if a confirm message was already sent (e.g. at create).
 */
export async function enterAwaitingConfirm(row: ScheduleRow): Promise<void> {
  if (String(row.state) !== "awaiting_confirm") {
    getDb().prepare(`UPDATE schedules SET state='awaiting_confirm' WHERE id=?`).run(row.id);
    row.state = "awaiting_confirm";
  }
  silenceNonZeroReminders(row);

  if (String(row.discord_confirm_message_id || "").trim()) return;

  try {
    const { postScheduleConfirmMessage } = await import("../discord/bot.js");
    await postScheduleConfirmMessage(row);
    const refreshed = getDb().prepare("SELECT discord_confirm_message_id FROM schedules WHERE id = ?").get(row.id) as
      | { discord_confirm_message_id?: string }
      | undefined;
    row.discord_confirm_message_id = String(refreshed?.discord_confirm_message_id || "");
  } catch (e) {
    console.warn("[schedules] confirm message failed", e);
    const mins = Math.max(1, Math.round((new Date(row.run_at).getTime() - Date.now()) / 60_000));
    await notifyScheduleChannel(
      row,
      `⏰ **Confirm needed** for **${row.name || "operation"}** in ~${mins} min.\nConfirm in A3Panel → Scheduler.`,
    );
  }
}

export type ScheduleRow = {
  id: string;
  profile_id: string;
  instance_id: string | null;
  name: string;
  run_at: string;
  recurrence: string;
  reminder_offsets: string;
  discord_channel: string;
  requester_discord_id: string;
  state: string;
  approved_by: string | null;
  confirmed_at: string | null;
  confirmed_by: string;
  confirm_source: string;
  reminder_message_id: string;
  discord_confirm_message_id: string;
  discord_finish_message_id: string;
  reminders_sent: string;
  last_job_id: string;
  last_error: string;
  last_fired_at: string | null;
  fallback_profile_id: string | null;
  created_at: string;
};

/** Strip Discord snowflakes from actor labels shown in the panel. */
export function sanitizeActorLabel(raw: string | null | undefined): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  // Mentions
  s = s.replace(/<@!?\d{15,22}>/g, "").trim();
  // "Name (123456789012345678)" anywhere
  s = s.replace(/\s*\(\d{15,22}\)/g, "").trim();
  // Bare snowflake tokens
  s = s.replace(/(^|[\s/])\d{15,22}(?=$|[\s/])/g, "$1").replace(/\s+/g, " ").trim();
  if (/^\d{15,22}$/.test(s)) return "";
  return s;
}

export function scheduleDto(s: ScheduleRow) {
  const db = getDb();
  const profile = db.prepare("SELECT name FROM mission_profiles WHERE id = ?").get(s.profile_id) as
    | { name?: string }
    | undefined;
  const fallback = s.fallback_profile_id
    ? (db.prepare("SELECT name FROM mission_profiles WHERE id = ?").get(s.fallback_profile_id) as
        | { name?: string }
        | undefined)
    : undefined;
  const inst = s.instance_id
    ? (db.prepare("SELECT name FROM instances WHERE id = ?").get(s.instance_id) as { name?: string } | undefined)
    : undefined;
  const confirmedBy = sanitizeActorLabel(s.confirmed_by) || undefined;
  const lastError = s.last_error ? sanitizeActorLabel(s.last_error) || undefined : undefined;
  return {
    id: s.id,
    profileId: s.profile_id,
    profileName: profile?.name || undefined,
    fallbackProfileId: s.fallback_profile_id || undefined,
    fallbackProfileName: fallback?.name || undefined,
    instanceId: s.instance_id || undefined,
    instanceName: inst?.name || undefined,
    name: s.name,
    runAt: s.run_at,
    recurrence: s.recurrence,
    reminderOffsets: jsonParse<number[]>(String(s.reminder_offsets), DEFAULT_REMINDER_OFFSETS),
    discordChannel: s.discord_channel,
    requesterDiscordId: s.requester_discord_id || "",
    state: s.state,
    approvedBy: sanitizeActorLabel(s.approved_by) || undefined,
    confirmedAt: s.confirmed_at || undefined,
    confirmedBy,
    confirmSource: s.confirm_source || undefined,
    lastJobId: s.last_job_id || undefined,
    lastError: lastError || undefined,
    lastFiredAt: s.last_fired_at || undefined,
  };
}

/** Active scheduled operation on an instance (waiting for Finish → fallback). */
export function activeOperationForInstance(instanceId: string) {
  const row = getDb()
    .prepare(
      `SELECT * FROM schedules
       WHERE instance_id = ? AND lower(state) IN ('live','restoring')
       ORDER BY datetime(last_fired_at) DESC, rowid DESC
       LIMIT 1`,
    )
    .get(instanceId) as ScheduleRow | undefined;
  if (!row) return undefined;
  const dto = scheduleDto(row);
  return {
    scheduleId: row.id,
    name: dto.name || "Scheduled operation",
    state: row.state,
    profileId: dto.profileId,
    profileName: dto.profileName,
    fallbackProfileId: dto.fallbackProfileId,
    fallbackProfileName: dto.fallbackProfileName,
  };
}

export type ScheduleActor = {
  /** Human label for panel / audit (email, Discord tag) — never include a raw Discord snowflake. */
  label: string;
  source: "panel" | "discord";
  /** Panel user id when known. */
  userId?: string | null;
  /** Discord user id when the action came from Discord (or a linked identity). */
  discordUserId?: string | null;
};

/** Discord message mention when possible; otherwise the plain label. */
export function formatScheduleActorForDiscord(who: ScheduleActor): string {
  const discordId = String(who.discordUserId || "").trim();
  if (discordId) return `<@${discordId}>`;
  const userId = String(who.userId || "").trim();
  if (userId) {
    const linked = getDb()
      .prepare(`SELECT subject FROM user_identities WHERE provider = 'discord' AND user_id = ?`)
      .get(userId) as { subject?: string } | undefined;
    const subject = String(linked?.subject || "").trim();
    if (subject) return `<@${subject}>`;
  }
  return who.label || "someone";
}

export function canConfirmSchedule(grants: { permission: string }[] | undefined): boolean {
  if (!grants?.length) return false;
  const set = new Set(grants.map((g) => g.permission));
  return (
    set.has("schedule.confirm") ||
    set.has("schedule.manage") ||
    set.has("profile.apply") ||
    set.has("instance.control")
  );
}

export function canFinishSchedule(grants: { permission: string }[] | undefined): boolean {
  return canConfirmSchedule(grants);
}

export function canStandDownSchedule(grants: { permission: string }[] | undefined): boolean {
  return canConfirmSchedule(grants);
}

export function confirmSchedule(id: string, who: ScheduleActor): { ok: boolean; error?: string } {
  const row = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
  if (!row) return { ok: false, error: "not found" };
  const st = String(row.state || "");
  if (["done", "failed", "skipped", "applying", "live", "restoring"].includes(st)) {
    return { ok: false, error: `cannot confirm schedule in state ${st}` };
  }
  if (st === "confirmed") return { ok: true };
  getDb()
    .prepare(
      `UPDATE schedules SET state='confirmed', confirmed_at=?, confirmed_by=?, confirm_source=?, approved_by=? WHERE id=?`,
    )
    .run(new Date().toISOString(), who.label, who.source, who.label, id);
  return { ok: true };
}

/**
 * Skip this occurrence before it applies — does not delete the schedule.
 * Recurring schedules advance to the next run_at.
 */
export async function standDownScheduleOccurrence(
  id: string,
  who: ScheduleActor,
): Promise<{ ok: boolean; error?: string }> {
  const row = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
  if (!row) return { ok: false, error: "not found" };
  const st = String(row.state || "");
  if (!["scheduled", "reminded", "awaiting_confirm", "confirmed"].includes(st)) {
    return { ok: false, error: `cannot stand down schedule in state ${st}` };
  }
  const actor = formatScheduleActorForDiscord(who);
  const whoLabel = sanitizeActorLabel(who.label) || who.label || "someone";
  const reason = `Stood down by ${whoLabel}`;
  await markTerminal(row, "skipped", reason);
  await notifyScheduleChannel(
    row,
    `⏹️ **${row.name || "operation"}** stood down by ${actor} — this run will not apply.`,
  );
  return { ok: true };
}

function advanceRunAt(iso: string, recurrence: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const r = String(recurrence || "none").toLowerCase();
  if (r === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (r === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else return null;
  return d.toISOString();
}

function resetForNextOccurrence(row: ScheduleRow, nextRunAt: string) {
  getDb()
    .prepare(
      `UPDATE schedules SET
         run_at=?, state='scheduled', confirmed_at=NULL, confirmed_by='', confirm_source='',
         approved_by=NULL, reminders_sent='[]', reminder_message_id='', discord_confirm_message_id='',
         discord_finish_message_id='', last_error='', last_job_id=''
       WHERE id=?`,
    )
    .run(nextRunAt, row.id);
}

async function markTerminal(row: ScheduleRow, state: "done" | "failed" | "skipped", error = "") {
  getDb()
    .prepare(`UPDATE schedules SET state=?, last_error=?, last_fired_at=? WHERE id=?`)
    .run(state, error, new Date().toISOString(), row.id);

  const next = advanceRunAt(row.run_at, row.recurrence);
  if (next) {
    resetForNextOccurrence(row, next);
    await notifyScheduleChannel(
      row,
      `Schedule **${row.name || row.id}** ${state}${error ? ` (${error})` : ""}. Next run: <t:${Math.floor(new Date(next).getTime() / 1000)}:F>.`,
    );
  }
}

async function enterLiveOperation(row: ScheduleRow) {
  getDb()
    .prepare(`UPDATE schedules SET state='live', last_error='', last_fired_at=? WHERE id=?`)
    .run(new Date().toISOString(), row.id);
  await notifyScheduleChannel(
    row,
    `✅ **${row.name || "operation"}** is live. Finish the operation when done to restore the fallback profile.`,
  );
  try {
    const { postOperationFinishMessage } = await import("../discord/bot.js");
    await postOperationFinishMessage(row);
  } catch (e) {
    console.warn("[schedules] finish message failed", e);
  }
}

/**
 * End a live operation: apply fallback profile + start, then mark done / advance recurrence.
 */
export async function finishScheduleOperation(
  id: string,
  who: ScheduleActor,
): Promise<{ ok: boolean; error?: string; jobId?: string }> {
  const row = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
  if (!row) return { ok: false, error: "not found" };
  if (String(row.state) !== "live") return { ok: false, error: `schedule is ${row.state}, not live` };
  const fallbackId = String(row.fallback_profile_id || "").trim();
  if (!fallbackId) return { ok: false, error: "no fallback profile configured" };
  if (!row.instance_id) return { ok: false, error: "missing instance" };

  const actor = formatScheduleActorForDiscord(who);
  getDb().prepare(`UPDATE schedules SET state='restoring', last_error='' WHERE id=?`).run(row.id);
  await notifyScheduleChannel(
    row,
    `↩️ **${row.name || "operation"}** finishing (by ${actor}) — restoring fallback profile…`,
  );

  try {
    const result = await startApplyProfileJob({
      profileId: fallbackId,
      instanceId: row.instance_id,
      downloadMods: true,
      updateServer: false,
      validate: false,
      matchHeadlessRecommendation: true,
      forceStart: true,
      requestedBy: who.userId || null,
      actorLabel: who.label,
      triggerKind: "schedule",
      scheduleId: row.id,
      onProgress: (stage, message) => {
        const notable = ["instance", "config", "mods", "keys", "done", "failed"];
        if (!notable.includes(stage)) return;
        void notifyScheduleChannel(row, `• **${stage}**: ${message.slice(0, 180)}`);
      },
    });
    getDb().prepare(`UPDATE schedules SET last_job_id=? WHERE id=?`).run(result.jobId, row.id);
    if (result.status === "failed") {
      getDb().prepare(`UPDATE schedules SET state='live', last_error=? WHERE id=?`).run(result.error || "restore failed", row.id);
      return { ok: false, error: result.error || "restore failed to start", jobId: result.jobId };
    }
    return { ok: true, jobId: result.jobId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "restore failed";
    getDb().prepare(`UPDATE schedules SET state='live', last_error=? WHERE id=?`).run(msg, row.id);
    return { ok: false, error: msg };
  }
}

export async function processScheduleTick(now = new Date()): Promise<void> {
  const rows = getDb()
    .prepare(
      `SELECT * FROM schedules
       WHERE lower(state) IN ('scheduled','reminded','awaiting_confirm','confirmed','applying','restoring')
       ORDER BY datetime(run_at) ASC`,
    )
    .all() as ScheduleRow[];

  for (const row of rows) {
    try {
      await processOneSchedule(row, now);
    } catch (e) {
      console.error(`[schedules] tick error ${row.id}:`, e);
    }
  }
}

async function watchApplyingJob(row: ScheduleRow) {
  const jobId = String(row.last_job_id || "").trim();
  if (!jobId) {
    await markTerminal(row, "failed", "applying without job id");
    return;
  }
  const job = getDb().prepare("SELECT state, error FROM jobs WHERE id = ?").get(jobId) as
    | { state: string; error: string }
    | undefined;
  const st = String(job?.state || "").toLowerCase();
  if (st === "done") {
    const fallback = String(row.fallback_profile_id || "").trim();
    if (fallback) {
      await enterLiveOperation(row);
    } else {
      await markTerminal(row, "done");
      await notifyScheduleChannel(row, `✅ **${row.name || "operation"}** is live.`);
    }
    return;
  }
  if (st === "failed") {
    await markTerminal(row, "failed", job?.error || "apply failed");
    await notifyScheduleChannel(row, `❌ **${row.name || "operation"}** apply failed: ${job?.error || "unknown"}`);
  }
}

async function watchRestoringJob(row: ScheduleRow) {
  const jobId = String(row.last_job_id || "").trim();
  if (!jobId) {
    getDb().prepare(`UPDATE schedules SET state='live', last_error=? WHERE id=?`).run("restoring without job id", row.id);
    return;
  }
  const job = getDb().prepare("SELECT state, error FROM jobs WHERE id = ?").get(jobId) as
    | { state: string; error: string }
    | undefined;
  const st = String(job?.state || "").toLowerCase();
  if (st === "done") {
    await markTerminal(row, "done");
    await notifyScheduleChannel(row, `🏠 **${row.name || "operation"}** finished — fallback profile restored.`);
    return;
  }
  if (st === "failed") {
    getDb()
      .prepare(`UPDATE schedules SET state='live', last_error=? WHERE id=?`)
      .run(job?.error || "restore failed", row.id);
    await notifyScheduleChannel(
      row,
      `❌ Fallback restore failed: ${job?.error || "unknown"}. Operation stays live — try Finish again.`,
    );
  }
}

async function processOneSchedule(row: ScheduleRow, now: Date) {
  if (row.state === "applying") {
    await watchApplyingJob(row);
    return;
  }
  if (row.state === "restoring") {
    await watchRestoringJob(row);
    return;
  }

  const runAt = new Date(row.run_at);
  if (Number.isNaN(runAt.getTime())) {
    await markTerminal(row, "failed", "invalid run_at");
    return;
  }

  const msUntil = runAt.getTime() - now.getTime();
  const minsUntil = msUntil / 60_000;
  const offsets = parseReminderOffsets(row);
  const sent = parseRemindersSent(row);

  if (
    (row.state === "scheduled" || row.state === "reminded") &&
    minsUntil <= CONFIRM_OFFSET_MIN &&
    minsUntil > 0
  ) {
    await enterAwaitingConfirm(row);
    // Confirm message is the only Discord ping in this window.
    if (msUntil > 0) return;
  }

  // Catch-up: if several reminder offsets are already due, send one ETA — not one per offset.
  if (row.state === "scheduled" || row.state === "reminded") {
    const due = offsets.filter((off) => off > 0 && !sent.has(off) && minsUntil <= off && minsUntil > -1);
    if (due.length) {
      for (const off of due) sent.add(off);
      getDb()
        .prepare(
          `UPDATE schedules SET reminders_sent=?, state=CASE WHEN state='scheduled' THEN 'reminded' ELSE state END WHERE id=?`,
        )
        .run(JSON.stringify([...sent]), row.id);
      row.reminders_sent = JSON.stringify([...sent]);
      if (row.state === "scheduled") row.state = "reminded";
      await notifyScheduleChannel(
        row,
        `📣 Reminder: **${row.name || "operation"}** starts in ~${formatEtaMinutes(minsUntil)} (<t:${Math.floor(runAt.getTime() / 1000)}:R>).`,
      );
    }
  }

  if (msUntil > 0) return;

  const confirmed = row.state === "confirmed" || !!row.confirmed_at;
  if (!confirmed) {
    if (!sent.has(0)) {
      sent.add(0);
      getDb().prepare(`UPDATE schedules SET reminders_sent=? WHERE id=?`).run(JSON.stringify([...sent]), row.id);
    }
    await markTerminal(row, "skipped", "not confirmed before run time");
    await notifyScheduleChannel(
      row,
      `⏭️ **${row.name || "operation"}** was **skipped** — no confirmation before start time.`,
    );
    return;
  }

  if (!row.instance_id || !row.profile_id) {
    await markTerminal(row, "failed", "missing instance or profile");
    return;
  }

  getDb().prepare(`UPDATE schedules SET state='applying', last_error='' WHERE id=?`).run(row.id);
  if (!sent.has(0)) {
    sent.add(0);
    getDb().prepare(`UPDATE schedules SET reminders_sent=? WHERE id=?`).run(JSON.stringify([...sent]), row.id);
  }
  await notifyScheduleChannel(row, `🚀 **${row.name || "operation"}** confirmed — applying profile and starting server…`);

  try {
    const scheduleName = row.name || "Scheduled operation";
    const result = await startApplyProfileJob({
      profileId: row.profile_id,
      instanceId: row.instance_id,
      downloadMods: true,
      updateServer: false,
      validate: false,
      matchHeadlessRecommendation: true,
      forceStart: true,
      requestedBy: null,
      actorLabel: scheduleName,
      triggerKind: "schedule",
      scheduleId: row.id,
      onProgress: (stage, message) => {
        const notable = ["instance", "config", "mods", "keys", "done", "failed", "server_update"];
        if (!notable.includes(stage)) return;
        void notifyScheduleChannel(row, `• **${stage}**: ${message.slice(0, 180)}`);
      },
    });
    getDb().prepare(`UPDATE schedules SET last_job_id=? WHERE id=?`).run(result.jobId, row.id);
    if (result.status === "failed") {
      await markTerminal(row, "failed", result.error || "apply failed to start");
      await notifyScheduleChannel(row, `❌ **${row.name || "operation"}** failed: ${result.error || "unknown"}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "apply failed";
    await markTerminal(row, "failed", msg);
    await notifyScheduleChannel(row, `❌ **${row.name || "operation"}** failed: ${msg}`);
  }
}

let ticking = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startScheduleRunner(intervalMs = 20_000) {
  if (timer) return;
  console.log(`[schedules] runner started (every ${intervalMs}ms)`);
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await processScheduleTick();
    } finally {
      ticking = false;
    }
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
}
