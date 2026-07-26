/** Fired when mission-profile health may have changed (missing mission, etc.). */
export const PROFILES_HEALTH_EVENT = "a3panel:profiles-health";

export function notifyProfilesHealthChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROFILES_HEALTH_EVENT));
}
