import crypto from "node:crypto";
import { config } from "../config.js";
import { resolveSteamWebApiKey } from "../steam/webApiKey.js";
import {
  oauthCallbackUrl,
  resolveOAuth2,
  resolveSteamLoginEnabled,
  isOAuth2LoginEnabled,
  type OAuthProviderId,
} from "./oauthProviders.js";

export type { OAuthProviderId };

export type ProviderPublic = {
  id: OAuthProviderId;
  label: string;
  enabled: boolean;
};

export type NormalizedIdentity = {
  provider: OAuthProviderId;
  subject: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
};

type OAuth2Def = {
  id: OAuthProviderId;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  extraAuthParams?: Record<string, string>;
  profile: (accessToken: string) => Promise<NormalizedIdentity>;
};

function callbackUrl(provider: string): string {
  return oauthCallbackUrl(provider);
}

function discordDef(): OAuth2Def | null {
  const creds = resolveOAuth2("discord");
  if (!creds || !isOAuth2LoginEnabled("discord")) return null;
  return {
    id: "discord",
    label: "Discord",
    authUrl: "https://discord.com/api/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    scopes: ["identify", "email"],
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    profile: async (accessToken) => {
      const r = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error("discord profile failed");
      const u = (await r.json()) as { id: string; username?: string; global_name?: string; email?: string; avatar?: string };
      return {
        provider: "discord",
        subject: u.id,
        email: u.email || `discord_${u.id}@oauth.local`,
        displayName: u.global_name || u.username || `Discord ${u.id}`,
        avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : undefined,
      };
    },
  };
}

function googleDef(): OAuth2Def | null {
  const creds = resolveOAuth2("google");
  if (!creds || !isOAuth2LoginEnabled("google")) return null;
  return {
    id: "google",
    label: "Google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "profile"],
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    extraAuthParams: { access_type: "online", prompt: "select_account" },
    profile: async (accessToken) => {
      const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error("google profile failed");
      const u = (await r.json()) as { sub: string; email?: string; name?: string; picture?: string };
      return {
        provider: "google",
        subject: u.sub,
        email: u.email || `google_${u.sub}@oauth.local`,
        displayName: u.name || u.email || `Google ${u.sub}`,
        avatarUrl: u.picture,
      };
    },
  };
}

function microsoftDef(): OAuth2Def | null {
  const creds = resolveOAuth2("microsoft");
  if (!creds || !isOAuth2LoginEnabled("microsoft")) return null;
  const tenant = creds.tenant || "common";
  return {
    id: "microsoft",
    label: "Microsoft",
    authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scopes: ["openid", "profile", "email", "User.Read"],
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    profile: async (accessToken) => {
      const r = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error("microsoft profile failed");
      const u = (await r.json()) as {
        id: string;
        displayName?: string;
        mail?: string;
        userPrincipalName?: string;
      };
      const email = u.mail || u.userPrincipalName || `microsoft_${u.id}@oauth.local`;
      return {
        provider: "microsoft",
        subject: u.id,
        email,
        displayName: u.displayName || email,
      };
    },
  };
}

function epicDef(): OAuth2Def | null {
  const creds = resolveOAuth2("epic");
  if (!creds || !isOAuth2LoginEnabled("epic")) return null;
  return {
    id: "epic",
    label: "Epic Games",
    authUrl: "https://www.epicgames.com/id/authorize",
    tokenUrl: "https://api.epicgames.dev/epic/oauth/v2/token",
    scopes: ["basic_profile"],
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    profile: async (accessToken) => {
      const r = await fetch("https://api.epicgames.dev/epic/oauth/v2/userInfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error("epic profile failed");
      const u = (await r.json()) as { sub?: string; accountId?: string; preferred_username?: string; name?: string; email?: string };
      const subject = String(u.sub || u.accountId || "");
      if (!subject) throw new Error("epic profile missing subject");
      return {
        provider: "epic",
        subject,
        email: u.email || `epic_${subject}@oauth.local`,
        displayName: u.preferred_username || u.name || `Epic ${subject}`,
      };
    },
  };
}

export function listOAuth2Providers(): OAuth2Def[] {
  return [discordDef(), googleDef(), microsoftDef(), epicDef()].filter(Boolean) as OAuth2Def[];
}

export function getOAuth2Provider(id: string): OAuth2Def | null {
  return listOAuth2Providers().find((p) => p.id === id) || null;
}

export function steamEnabled(): boolean {
  // Steam OpenID works without API key; key only enriches display name.
  return resolveSteamLoginEnabled();
}

export function listPublicProviders(): ProviderPublic[] {
  const out: ProviderPublic[] = [
    { id: "discord", label: "Discord", enabled: !!discordDef() },
    { id: "google", label: "Google", enabled: !!googleDef() },
    { id: "microsoft", label: "Microsoft", enabled: !!microsoftDef() },
    { id: "steam", label: "Steam", enabled: steamEnabled() },
    { id: "epic", label: "Epic Games", enabled: !!epicDef() },
  ];
  return out.filter((p) => p.enabled);
}

export function buildAuthorizeUrl(provider: OAuth2Def, state: string): string {
  const u = new URL(provider.authUrl);
  u.searchParams.set("client_id", provider.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", callbackUrl(provider.id));
  u.searchParams.set("scope", provider.scopes.join(" "));
  u.searchParams.set("state", state);
  for (const [k, v] of Object.entries(provider.extraAuthParams || {})) u.searchParams.set(k, v);
  return u.toString();
}

export async function exchangeCode(provider: OAuth2Def, code: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(provider.id),
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
  });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  // Epic expects Basic auth for some endpoints
  if (provider.id === "epic") {
    headers.Authorization = `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString("base64")}`;
  }
  const r = await fetch(provider.tokenUrl, { method: "POST", headers, body });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${provider.id} token exchange failed: ${t.slice(0, 200)}`);
  }
  const json = (await r.json()) as { access_token?: string };
  if (!json.access_token) throw new Error(`${provider.id} token missing`);
  return json.access_token;
}

/** Steam OpenID 2.0 */
export function buildSteamAuthorizeUrl(state: string): string {
  const returnTo = `${callbackUrl("steam")}?state=${encodeURIComponent(state)}`;
  const u = new URL("https://steamcommunity.com/openid/login");
  u.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
  u.searchParams.set("openid.mode", "checkid_setup");
  u.searchParams.set("openid.return_to", returnTo);
  u.searchParams.set("openid.realm", config.publicUrl.replace(/\/$/, ""));
  u.searchParams.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");
  u.searchParams.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");
  return u.toString();
}

export async function verifySteamOpenId(query: Record<string, unknown>): Promise<NormalizedIdentity> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith("openid.") && typeof v === "string") params.set(k, v);
  }
  params.set("openid.mode", "check_authentication");
  const r = await fetch("https://steamcommunity.com/openid/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const text = await r.text();
  if (!text.includes("is_valid:true")) throw new Error("steam openid validation failed");

  const claimed = String(query["openid.claimed_id"] || "");
  const m = claimed.match(/\/openid\/id\/(\d+)$/);
  if (!m) throw new Error("steam id not found in claim");
  const steamId = m[1];

  let displayName = `Steam ${steamId}`;
  const steamApiKey = resolveSteamWebApiKey();
  if (steamApiKey) {
    try {
      const sum = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(steamApiKey)}&steamids=${steamId}`,
      );
      if (sum.ok) {
        const data = (await sum.json()) as { response?: { players?: { personaname?: string; avatarfull?: string }[] } };
        const p = data.response?.players?.[0];
        if (p?.personaname) displayName = p.personaname;
        return {
          provider: "steam",
          subject: steamId,
          email: `steam_${steamId}@oauth.local`,
          displayName,
          avatarUrl: p?.avatarfull,
        };
      }
    } catch {
      /* ignore enrichment errors */
    }
  }
  return {
    provider: "steam",
    subject: steamId,
    email: `steam_${steamId}@oauth.local`,
    displayName,
  };
}

export function newOAuthState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function parseBootstrapOwners(): { provider: string; subject: string }[] {
  const raw = config.bootstrapOwners || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx <= 0) return null;
      return { provider: entry.slice(0, idx).toLowerCase(), subject: entry.slice(idx + 1) };
    })
    .filter(Boolean) as { provider: string; subject: string }[];
}

export function isBootstrapOwner(provider: string, subject: string): boolean {
  return parseBootstrapOwners().some((o) => o.provider === provider && o.subject === subject);
}

export { callbackUrl };
