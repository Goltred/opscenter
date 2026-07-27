import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Schedule } from "../api";
import { useAuth } from "../auth";
import { useToast } from "./Toast";
import { formatDateTimeWeekday } from "../formatTime";
import { formatScheduleState } from "../formatScheduleState";
import { FinishScheduleModal, type FinishScheduleTarget } from "./FinishScheduleModal";
import { StandDownScheduleModal, type StandDownScheduleTarget } from "./StandDownScheduleModal";

const PRE_START_STATES = new Set([
  "scheduled",
  "reminded",
  "awaiting_confirm",
  "confirmed",
  "applying",
]);

const LIVE_STATES = new Set(["live", "restoring"]);

const URGENT_PRE_START = new Set(["awaiting_confirm", "confirmed", "applying"]);

/** Upcoming or in-progress ops worth a site-wide banner. */
export function isNotableUpcomingSchedule(s: Schedule, now = Date.now()): boolean {
  if (LIVE_STATES.has(s.state)) return !!s.fallbackProfileId || s.state === "restoring";
  if (!PRE_START_STATES.has(s.state)) return false;
  if (URGENT_PRE_START.has(s.state)) return true;
  const runAt = new Date(s.runAt).getTime();
  if (Number.isNaN(runAt)) return false;
  const ms = runAt - now;
  return ms > -5 * 60_000 && ms <= 24 * 60 * 60_000;
}

export function needsScheduleConfirm(s: Schedule): boolean {
  return ["scheduled", "reminded", "awaiting_confirm"].includes(s.state);
}

/** Pre-start ops that can be stood down (including already confirmed). */
export function canStandDownSchedule(s: Schedule): boolean {
  return ["scheduled", "reminded", "awaiting_confirm", "confirmed"].includes(s.state);
}

function canSeeSchedules(can: (p: string) => boolean) {
  return (
    can("instance.view") ||
    can("schedule.manage") ||
    can("schedule.confirm") ||
    can("profile.apply") ||
    can("instance.control")
  );
}

function canActOnSchedule(can: (p: string) => boolean) {
  return can("schedule.confirm") || can("schedule.manage") || can("profile.apply") || can("instance.control");
}

function formatCountdown(runAtIso: string, now: number): string {
  const runAt = new Date(runAtIso).getTime();
  if (Number.isNaN(runAt)) return "";
  const ms = runAt - now;
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 48) return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`;
  return formatDateTimeWeekday(runAt);
}

function statusLabel(s: Schedule): { text: string; tone: "warn" | "ok" | "info" } {
  if (s.state === "restoring") return { text: formatScheduleState("restoring"), tone: "info" };
  if (s.state === "live") return { text: "Operation running", tone: "ok" };
  if (s.state === "applying") return { text: formatScheduleState("applying"), tone: "info" };
  if (s.state === "confirmed") return { text: formatScheduleState("confirmed"), tone: "ok" };
  if (s.state === "awaiting_confirm") return { text: formatScheduleState("awaiting_confirm"), tone: "warn" };
  if (s.state === "reminded") return { text: formatScheduleState("reminded"), tone: "warn" };
  return { text: formatScheduleState(s.state), tone: "warn" };
}

function sortKey(s: Schedule): number {
  if (s.state === "restoring") return -2;
  if (s.state === "live") return -1;
  if (s.state === "applying") return 0;
  const t = new Date(s.runAt).getTime();
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

export function useUpcomingSchedules(pollMs = 20_000) {
  const { can, user } = useAuth();
  const allowed = canSeeSchedules(can);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(() => {
    if (!allowed) {
      setSchedules([]);
      return;
    }
    api
      .get<Schedule[]>("/schedules")
      .then((rows) => setSchedules(Array.isArray(rows) ? rows : []))
      .catch(() => {
        /* keep previous */
      });
  }, [allowed]);

  useEffect(() => {
    reload();
    if (!allowed) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      reload();
    }, pollMs);
    const onFocus = () => {
      setNow(Date.now());
      reload();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [allowed, pollMs, reload, user?.id]);

  const notable = useMemo(() => {
    return schedules.filter((s) => isNotableUpcomingSchedule(s, now)).sort((a, b) => sortKey(a) - sortKey(b));
  }, [schedules, now]);

  const needsConfirmCount = useMemo(
    () => notable.filter((s) => needsScheduleConfirm(s)).length,
    [notable],
  );

  return { allowed, notable, needsConfirmCount, now, reload };
}

export function UpcomingScheduleBanner({
  notable,
  now,
  onReload,
}: {
  notable: Schedule[];
  now: number;
  onReload: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [busyId, setBusyId] = useState("");
  const [finishTarget, setFinishTarget] = useState<FinishScheduleTarget | null>(null);
  const [standDownTarget, setStandDownTarget] = useState<StandDownScheduleTarget | null>(null);

  async function confirm(s: Schedule) {
    setBusyId(s.id);
    try {
      await api.post(`/schedules/${s.id}/confirm`);
      onReload();
    } catch (e: unknown) {
      toast.error("Confirm failed", { message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId("");
    }
  }

  if (!notable.length && !finishTarget && !standDownTarget) return null;

  return (
    <>
      {notable.length > 0 && (
        <div className="schedule-site-banners" role="status" aria-live="polite">
          {notable.slice(0, 3).map((s) => {
            const status = statusLabel(s);
            const isLive = s.state === "live" || s.state === "restoring";
            const when = isLive ? null : formatCountdown(s.runAt, now);
            const showConfirm = needsScheduleConfirm(s) && canActOnSchedule(can);
            const showStandDown = canStandDownSchedule(s) && canActOnSchedule(can);
            const showFinish = s.state === "live" && !!s.fallbackProfileId && canActOnSchedule(can);
            const instanceHref = s.instanceId ? `/instances/${s.instanceId}` : "/schedules";

            return (
              <div
                key={s.id}
                className={
                  "schedule-site-banner" +
                  (status.tone === "warn"
                    ? " schedule-site-banner-warn"
                    : status.tone === "ok"
                      ? " schedule-site-banner-ok"
                      : " schedule-site-banner-info")
                }
              >
                <div className="schedule-site-banner-body">
                  <div className="schedule-site-banner-title">
                    {isLive ? "Running operation" : "Scheduled operation"}
                    {s.name ? (
                      <>
                        {" "}
                        <strong>{s.name}</strong>
                      </>
                    ) : null}
                    {when ? <span className="schedule-site-banner-when"> · {when}</span> : null}
                  </div>
                  <div className="schedule-site-banner-meta">
                    <span
                      className={
                        "schedule-site-banner-status" +
                        (status.tone === "warn" ? " is-warn" : status.tone === "ok" ? " is-ok" : "")
                      }
                    >
                      {status.text}
                    </span>
                    {s.instanceName || s.instanceId ? <span> · {s.instanceName || s.instanceId}</span> : null}
                    {s.profileName || s.profileId ? <span> · {s.profileName || s.profileId}</span> : null}
                    {s.state === "live" && s.fallbackProfileName ? (
                      <span> · finish restores {s.fallbackProfileName}</span>
                    ) : null}
                    {s.state === "restoring" && s.fallbackProfileName ? (
                      <span> · {s.fallbackProfileName}</span>
                    ) : null}
                  </div>
                </div>
                <div className="schedule-site-banner-actions">
                  {showConfirm && (
                    <button
                      type="button"
                      className="btn small primary"
                      disabled={busyId === s.id}
                      onClick={() => void confirm(s)}
                    >
                      {busyId === s.id ? "Confirming…" : "Confirm"}
                    </button>
                  )}
                  {showStandDown && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() =>
                        setStandDownTarget({
                          scheduleId: s.id,
                          name: s.name || "operation",
                          runAt: s.runAt,
                          recurrence: s.recurrence,
                          instanceName: s.instanceName,
                        })
                      }
                    >
                      Stand down
                    </button>
                  )}
                  {showFinish && (
                    <button
                      type="button"
                      className="btn small primary"
                      onClick={() =>
                        setFinishTarget({
                          scheduleId: s.id,
                          name: s.name || "operation",
                          fallbackProfileName: s.fallbackProfileName,
                          instanceName: s.instanceName,
                        })
                      }
                    >
                      Finish
                    </button>
                  )}
                  {s.instanceId ? (
                    <Link className="btn small" to={instanceHref}>
                      Instance
                    </Link>
                  ) : null}
                  <Link className="btn small" to="/schedules">
                    Scheduler
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {finishTarget && (
        <FinishScheduleModal
          target={finishTarget}
          onClose={() => setFinishTarget(null)}
          onFinished={onReload}
        />
      )}
      {standDownTarget && (
        <StandDownScheduleModal
          target={standDownTarget}
          onClose={() => setStandDownTarget(null)}
          onStoodDown={onReload}
        />
      )}
    </>
  );
}
