import type { Host, Instance, Mission, MissionProfile, Mod, Modlist } from "./api";

export const FIRST_MISSION_DISMISS_KEY = "OpsCenter.firstMissionGuide.dismissed";
export const FIRST_MISSION_OPEN_EVENT = "opscenter:open-first-mission-guide";

export type FirstMissionProgress = {
  hostReady: boolean;
  hasInstance: boolean;
  hasMods: boolean;
  hasMission: boolean;
  hasProfile: boolean;
  applied: boolean;
  /** Start requested / process starting or already up. */
  started: boolean;
  /** Process is up (running / has pid). */
  running: boolean;
  /** Host + instance + profile applied — ready to play (start is the last click). */
  complete: boolean;
  primaryHostId?: string;
  primaryInstanceId?: string;
};

export function isFirstMissionGuideDismissed(): boolean {
  try {
    return localStorage.getItem(FIRST_MISSION_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setFirstMissionGuideDismissed(dismissed: boolean) {
  try {
    if (dismissed) localStorage.setItem(FIRST_MISSION_DISMISS_KEY, "1");
    else localStorage.removeItem(FIRST_MISSION_DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

/** Set when open is requested before the Layout listener mounts (e.g. ?guide=mission). */
let pendingGuideOpen = false;

export function consumePendingFirstMissionGuideOpen(): boolean {
  if (!pendingGuideOpen) return false;
  pendingGuideOpen = false;
  return true;
}

/** Open the guide from anywhere (banner, sidebar, setup complete). */
export function openFirstMissionGuide() {
  pendingGuideOpen = true;
  window.dispatchEvent(new CustomEvent(FIRST_MISSION_OPEN_EVENT));
}

export function computeFirstMissionProgress(opts: {
  hosts: Host[];
  instances: Instance[];
  mods?: Mod[];
  modlists?: Modlist[];
  missions?: Mission[];
  profiles?: MissionProfile[];
}): FirstMissionProgress {
  const hosts = opts.hosts || [];
  const instances = opts.instances || [];
  const online = hosts.filter((h) => h.online);
  const readyHost =
    online.find((h) => h.bootstrap?.armaServerPresent !== false) || online[0] || hosts[0];
  const hostReady = online.length > 0;
  const hasInstance = instances.length > 0;
  const hasMods = (opts.mods || []).length > 0 || (opts.modlists || []).length > 0;
  const hasMission =
    (opts.missions || []).length > 0 ||
    (opts.profiles || []).some(
      (p) =>
        (p.missionSource === "mod" && !!(p.missionTemplate || "").trim()) ||
        (!!p.missionId && p.missionSource !== "mod"),
    );
  const hasProfile = (opts.profiles || []).length > 0;
  const appliedInst = instances.find((i) => !!(i.currentProfileId || "").trim());
  const applied = !!appliedInst;
  const started = instances.some((i) => {
    const s = String(i.status?.state || i.state || "").toLowerCase();
    return s === "running" || s === "starting" || !!i.status?.pid;
  });
  const running = instances.some((i) => {
    const s = String(i.status?.state || i.state || "").toLowerCase();
    return s === "running" || !!i.status?.pid;
  });
  return {
    hostReady,
    hasInstance,
    hasMods,
    hasMission,
    hasProfile,
    applied,
    started,
    running,
    complete: hostReady && hasInstance && applied,
    primaryHostId: appliedInst?.hostId || instances[0]?.hostId || readyHost?.id,
    primaryInstanceId: appliedInst?.id || instances[0]?.id,
  };
}

/** Show the dashboard nudge when a host exists but no profile has been applied yet. */
export function shouldShowFirstMissionBanner(opts: {
  hosts: Host[];
  instances: Instance[];
  loading?: boolean;
}): boolean {
  if (opts.loading) return false;
  if (isFirstMissionGuideDismissed()) return false;
  const hosts = opts.hosts || [];
  if (hosts.length === 0) return false;
  const progress = computeFirstMissionProgress({ hosts, instances: opts.instances || [] });
  return !progress.complete;
}
