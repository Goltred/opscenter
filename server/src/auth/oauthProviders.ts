import fs from "node:fs";
import path from "node:path";
import { getDb, jsonParse } from "../db.js";
import { config } from "../config.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secrets.js";

const SETTINGS_KEY = "oauth_providers";

export type OAuthProviderId = "discord" | "google" | "microsoft" | "steam" | "epic";
export type OAuth2ProviderId = Exclude<OAuthProviderId, "steam">;

type PanelOAuth2 = {
  clientId?: string;
  /** Encrypted or legacy plaintext. */
  clientSecret?: string;
  /** Microsoft only. */
  tenant?: string;
  /**
   * When false, hide from login even if credentials exist (panel or env).
   * When true/undefined, show when credentials resolve.
   */
  enabled?: boolean;
};

type PanelSteam = {
  /** When set, overrides env OC_OAUTH_STEAM / API-key enable. */
  enabled?: boolean;
};

export type PanelOAuthStore = {
  discord?: PanelOAuth2;
  google?: PanelOAuth2;
  microsoft?: PanelOAuth2;
  epic?: PanelOAuth2;
  steam?: PanelSteam;
};

export type ResolvedOAuth2 = {
  clientId: string;
  clientSecret: string;
  tenant?: string;
  source: "panel" | "env" | "mixed";
};

export type OAuthProviderPublic = {
  id: OAuthProviderId;
  label: string;
  /** Credentials present (panel and/or env). */
  configured: boolean;
  /** Shown on the login page (configured + not toggled off). */
  enabled: boolean;
  callbackUrl: string;
  /** Effective client id (empty for Steam). */
  clientId: string;
  /** Microsoft tenant when applicable. */
  tenant?: string;
  source: "panel" | "env" | "mixed" | "none";
  hasPanelConfig: boolean;
  hasEnvConfig: boolean;
};

const LABELS: Record<OAuthProviderId, string> = {
  discord: "Discord",
  google: "Google",
  microsoft: "Microsoft",
  steam: "Steam",
  epic: "Epic Games",
};

const OAUTH2_IDS: OAuth2ProviderId[] = ["discord", "google", "microsoft", "epic"];

function readStore(): PanelOAuthStore {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  return jsonParse<PanelOAuthStore>(row.value, {});
}

function writeStore(value: PanelOAuthStore) {
  getDb()
    .prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(SETTINGS_KEY, JSON.stringify(value));
}

function decryptStoredSecret(raw: string): string {
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

function envOAuth2(id: OAuth2ProviderId): { clientId: string; clientSecret: string; tenant?: string } {
  if (id === "discord") {
    return {
      clientId: config.oauth.discord.clientId || "",
      clientSecret: config.oauth.discord.clientSecret || "",
    };
  }
  if (id === "google") {
    return {
      clientId: config.oauth.google.clientId || "",
      clientSecret: config.oauth.google.clientSecret || "",
    };
  }
  if (id === "microsoft") {
    return {
      clientId: config.oauth.microsoft.clientId || "",
      clientSecret: config.oauth.microsoft.clientSecret || "",
      tenant: config.oauth.microsoft.tenant || "common",
    };
  }
  return {
    clientId: config.oauth.epic.clientId || "",
    clientSecret: config.oauth.epic.clientSecret || "",
  };
}

function oauthCallbackUrl(provider: string): string {
  return `${config.publicUrl.replace(/\/$/, "")}/api/auth/oauth/${provider}/callback`;
}

/** Effective client id + secret for an OAuth2 provider (panel fields merge over env). */
export function resolveOAuth2(id: OAuth2ProviderId): ResolvedOAuth2 | null {
  const panel = readStore()[id];
  const env = envOAuth2(id);
  const panelId = String(panel?.clientId || "").trim();
  const panelSecret = decryptStoredSecret(String(panel?.clientSecret || "").trim());
  const clientId = panelId || env.clientId;
  const clientSecret = panelSecret || env.clientSecret;
  if (!clientId || !clientSecret) return null;

  let source: ResolvedOAuth2["source"] = "env";
  const idFromPanel = !!panelId;
  const secretFromPanel = !!panelSecret;
  if (idFromPanel && secretFromPanel) source = "panel";
  else if (idFromPanel || secretFromPanel) source = "mixed";
  else source = "env";

  const tenantPanel = String(panel?.tenant || "").trim();
  const tenant = id === "microsoft" ? tenantPanel || env.tenant || "common" : undefined;
  return { clientId, clientSecret, tenant, source };
}

/** Login toggle: false hides provider; unset/true keeps it on when configured. */
export function isOAuth2LoginEnabled(id: OAuth2ProviderId): boolean {
  const panel = readStore()[id];
  if (typeof panel?.enabled === "boolean") return panel.enabled;
  return true;
}

export function resolveSteamLoginEnabled(): boolean {
  const panel = readStore().steam;
  if (typeof panel?.enabled === "boolean") return panel.enabled;
  return !!config.oauth.steam.enabled;
}

function hasEnvOAuth2(id: OAuth2ProviderId): boolean {
  const e = envOAuth2(id);
  return !!(e.clientId && e.clientSecret);
}

function hasPanelOAuth2(id: OAuth2ProviderId): boolean {
  const p = readStore()[id];
  if (!p) return false;
  return !!(
    String(p.clientId || "").trim() ||
    String(p.clientSecret || "").trim() ||
    String(p.tenant || "").trim() ||
    typeof p.enabled === "boolean"
  );
}

export function oauthProvidersPublic(): OAuthProviderPublic[] {
  const ids: OAuthProviderId[] = ["discord", "google", "microsoft", "steam", "epic"];
  return ids.map((id) => {
    if (id === "steam") {
      const panel = readStore().steam;
      const hasPanel = typeof panel?.enabled === "boolean";
      const hasEnv = !!config.oauth.steam.enabled;
      const enabled = resolveSteamLoginEnabled();
      let source: OAuthProviderPublic["source"] = "none";
      if (hasPanel) source = "panel";
      else if (hasEnv) source = "env";
      return {
        id,
        label: LABELS.steam,
        configured: hasPanel || hasEnv,
        enabled,
        callbackUrl: oauthCallbackUrl("steam"),
        clientId: "",
        source: hasPanel || hasEnv ? source : "none",
        hasPanelConfig: hasPanel,
        hasEnvConfig: hasEnv,
      };
    }
    const resolved = resolveOAuth2(id);
    const panel = hasPanelOAuth2(id);
    const env = hasEnvOAuth2(id);
    const configured = !!resolved;
    const enabled = configured && isOAuth2LoginEnabled(id);
    return {
      id,
      label: LABELS[id],
      configured,
      enabled,
      callbackUrl: oauthCallbackUrl(id),
      clientId: resolved?.clientId || String(readStore()[id]?.clientId || envOAuth2(id).clientId || "").trim(),
      tenant: id === "microsoft" ? resolved?.tenant || envOAuth2("microsoft").tenant : undefined,
      source: resolved?.source || "none",
      hasPanelConfig: panel,
      hasEnvConfig: env,
    };
  });
}

export type SaveOAuthProviderBody = {
  clear?: boolean;
  clientId?: string;
  clientSecret?: string;
  tenant?: string;
  enabled?: boolean;
};

export function saveOAuthProvider(id: OAuthProviderId, body: SaveOAuthProviderBody): OAuthProviderPublic {
  const store = { ...readStore() };

  if (body.clear) {
    if (id === "steam") delete store.steam;
    else delete store[id];
    writeStore(store);
    return oauthProvidersPublic().find((p) => p.id === id)!;
  }

  if (id === "steam") {
    if (typeof body.enabled !== "boolean") {
      throw new Error("enabled boolean required for Steam (or set clear: true)");
    }
    store.steam = { enabled: body.enabled };
    writeStore(store);
    return oauthProvidersPublic().find((p) => p.id === id)!;
  }

  const prev = { ...(store[id] || {}) };
  const onlyToggle =
    typeof body.enabled === "boolean" &&
    body.clientId === undefined &&
    (body.clientSecret === undefined || String(body.clientSecret).trim() === "") &&
    body.tenant === undefined;

  if (onlyToggle) {
    store[id] = { ...prev, enabled: body.enabled };
    writeStore(store);
    return oauthProvidersPublic().find((p) => p.id === id)!;
  }

  const nextId = body.clientId !== undefined ? String(body.clientId).trim() : String(prev.clientId || "").trim();
  let nextSecret = String(prev.clientSecret || "");
  const incomingSecret = String(body.clientSecret ?? "").trim();
  if (incomingSecret) {
    nextSecret = isEncryptedSecret(incomingSecret) ? incomingSecret : encryptSecret(incomingSecret);
  }

  const next: PanelOAuth2 = {
    clientId: nextId,
    clientSecret: nextSecret,
  };
  if (id === "microsoft") {
    const tenant =
      body.tenant !== undefined ? String(body.tenant).trim() : String(prev.tenant || "").trim();
    if (tenant) next.tenant = tenant;
  }
  if (typeof body.enabled === "boolean") next.enabled = body.enabled;
  else if (typeof prev.enabled === "boolean") next.enabled = prev.enabled;
  else next.enabled = true;

  if (!next.clientId && !next.clientSecret && !next.tenant && typeof next.enabled !== "boolean") {
    delete store[id];
  } else {
    store[id] = next;
  }
  writeStore(store);
  return oauthProvidersPublic().find((p) => p.id === id)!;
}

type BootstrapFile = {
  discord?: { clientId?: string; clientSecret?: string; enabled?: boolean };
  google?: { clientId?: string; clientSecret?: string; enabled?: boolean };
  microsoft?: { clientId?: string; clientSecret?: string; tenant?: string; enabled?: boolean };
  epic?: { clientId?: string; clientSecret?: string; enabled?: boolean };
  steam?: { enabled?: boolean };
};

function defaultBootstrapPath(): string {
  const fromEnv = process.env.OC_OAUTH_BOOTSTRAP_FILE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(config.repoRoot, "deploy", "oauth-bootstrap.json");
}

/**
 * Import one-shot install credentials into encrypted panel settings, then rename the file.
 * Prefer this over leaving OC_OAUTH_* in control-plane.env.
 */
export function importOAuthBootstrapFile(): void {
  const filePath = defaultBootstrapPath();
  if (!fs.existsSync(filePath)) return;

  let raw: BootstrapFile;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as BootstrapFile;
  } catch (e) {
    console.warn("oauth bootstrap: could not parse", filePath, e);
    return;
  }

  const store = { ...readStore() };
  let imported = 0;

  for (const id of OAUTH2_IDS) {
    const entry = raw[id];
    if (!entry) continue;
    const clientId = String(entry.clientId || "").trim();
    const clientSecret = String(entry.clientSecret || "").trim();
    if (!clientId && !clientSecret) continue;
    const prev = store[id] || {};
    const next: PanelOAuth2 = {
      clientId: clientId || String(prev.clientId || "").trim(),
      clientSecret: prev.clientSecret || "",
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : prev.enabled !== false,
    };
    if (clientSecret) next.clientSecret = encryptSecret(clientSecret);
    if (id === "microsoft") {
      const ms = entry as { tenant?: string };
      const tenant = String(ms.tenant || prev.tenant || "common").trim();
      if (tenant) next.tenant = tenant;
    }
    store[id] = next;
    imported += 1;
  }

  if (raw.steam && typeof raw.steam.enabled === "boolean") {
    store.steam = { enabled: raw.steam.enabled };
    imported += 1;
  }

  if (imported > 0) {
    writeStore(store);
    console.log(`oauth bootstrap: imported ${imported} provider(s) from ${filePath}`);
  }

  const donePath = `${filePath}.imported`;
  try {
    fs.renameSync(filePath, donePath);
    console.log(`oauth bootstrap: moved to ${donePath}`);
  } catch {
    try {
      fs.unlinkSync(filePath);
      console.log("oauth bootstrap: deleted bootstrap file after import");
    } catch (e) {
      console.warn("oauth bootstrap: imported but could not remove file", e);
    }
  }
}

export { oauthCallbackUrl };
