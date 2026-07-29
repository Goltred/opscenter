/** Fired when Admin saves/clears the Steam Web API key so nav badges refresh. */
export const STEAM_WEB_API_EVENT = "opscenter:steam-web-api-changed";

export function notifySteamWebApiChanged() {
  window.dispatchEvent(new CustomEvent(STEAM_WEB_API_EVENT));
}
