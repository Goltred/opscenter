import { getDb, jsonParse } from "../db.js";
import { config } from "../config.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secrets.js";

const SETTINGS_KEY = "steam_web_api";

type Stored = {
  /** Encrypted or legacy plaintext API key. */
  apiKey?: string;
};

function readStored(): Stored {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  return jsonParse<Stored>(row.value, {});
}

function writeStored(value: Stored) {
  getDb()
    .prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(SETTINGS_KEY, JSON.stringify(value));
}

function decryptStoredKey(raw: string): string {
  if (!raw) return "";
  if (isEncryptedSecret(raw)) {
    try {
      return decryptSecret(raw);
    } catch {
      return "";
    }
  }
  return raw;
}

/** Panel-saved key only (decrypted). Empty if unset / undecryptable. */
export function loadPanelSteamWebApiKey(): string {
  return decryptStoredKey(String(readStored().apiKey || "").trim());
}

/**
 * Effective Steam Web API key: Admin (panel) wins, else OC_OAUTH_STEAM_API_KEY.
 * Used for workshop deps / titles enrichment and Steam OAuth display names — not SteamCMD logins.
 */
export function resolveSteamWebApiKey(): string {
  const fromPanel = loadPanelSteamWebApiKey();
  if (fromPanel) return fromPanel;
  return String(config.oauth.steam.apiKey || "").trim();
}

export type SteamWebApiKeyPublic = {
  configured: boolean;
  /** Where the effective key comes from. */
  source: "panel" | "env" | "none";
  /** True when a panel-saved key exists (even if empty after decrypt failure). */
  hasPanelKey: boolean;
  /** Env fallback is present. */
  hasEnvKey: boolean;
};

export function steamWebApiKeyPublic(): SteamWebApiKeyPublic {
  const panel = loadPanelSteamWebApiKey();
  const envKey = String(config.oauth.steam.apiKey || "").trim();
  if (panel) {
    return { configured: true, source: "panel", hasPanelKey: true, hasEnvKey: !!envKey };
  }
  if (envKey) {
    return { configured: true, source: "env", hasPanelKey: false, hasEnvKey: true };
  }
  const rawPanel = String(readStored().apiKey || "").trim();
  return {
    configured: false,
    source: "none",
    hasPanelKey: !!rawPanel,
    hasEnvKey: false,
  };
}

/** Save or clear the panel key. Blank apiKey keeps existing unless clear is true. */
export function saveSteamWebApiKey(body: { apiKey?: string; clear?: boolean }) {
  if (body.clear) {
    writeStored({});
    return steamWebApiKeyPublic();
  }
  const next = String(body.apiKey ?? "").trim();
  if (!next) {
    return steamWebApiKeyPublic();
  }
  writeStored({ apiKey: encryptSecret(next) });
  return steamWebApiKeyPublic();
}
