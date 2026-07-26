/** Registered by api routes so the schedule runner can start the same apply job without circular imports. */

export type ApplyProfileOpts = {
  profileId: string;
  instanceId: string;
  downloadMods?: boolean;
  updateServer?: boolean;
  validate?: boolean;
  matchHeadlessRecommendation?: boolean;
  /** Start the instance after apply even if it was already stopped. */
  forceStart?: boolean;
  steamAccountId?: string | null;
  /** Panel user id when a signed-in user started the job. */
  requestedBy?: string | null;
  /** Human-readable actor for job history (email, Discord tag, schedule name). */
  actorLabel?: string | null;
  /** Who/what started this apply: panel user or schedule runner. */
  triggerKind?: "user" | "schedule" | "system";
  /** Set when the apply was started by (or finishes) a schedule. */
  scheduleId?: string | null;
  /** Optional hook for Discord / schedule progress posts. */
  onProgress?: (stage: string, message: string) => void;
};

export type ApplyProfileStartResult = {
  jobId: string;
  status: "started" | "failed";
  instanceId: string;
  hostId: string;
  profileId: string;
  profileName: string;
  downloadedMods: boolean;
  updatedServer: boolean;
  modsLibraryPath?: string;
  error?: string;
};

type Impl = (opts: ApplyProfileOpts) => Promise<ApplyProfileStartResult>;

let impl: Impl | null = null;

export function registerApplyProfileImpl(fn: Impl) {
  impl = fn;
}

export async function startApplyProfileJob(opts: ApplyProfileOpts): Promise<ApplyProfileStartResult> {
  if (!impl) throw new Error("Apply profile job is not registered yet");
  return impl(opts);
}
