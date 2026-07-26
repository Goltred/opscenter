/** Friendly labels for schedule machine states (internal ids stay snake_case). */
const SCHEDULE_STATE_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  reminded: "Reminded",
  awaiting_confirm: "Waiting for Confirmation",
  confirmed: "Confirmed",
  applying: "Applying",
  live: "Live",
  restoring: "Restoring",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

export function formatScheduleState(state: string | undefined | null): string {
  const key = String(state || "").trim();
  if (!key) return "—";
  return SCHEDULE_STATE_LABELS[key] || key.replace(/_/g, " ");
}
