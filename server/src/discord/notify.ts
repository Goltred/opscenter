import { getDb, jsonParse } from "../db.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secrets.js";
import { config } from "../config.js";
import { resolveOAuth2 } from "../auth/oauthProviders.js";
import type { ScheduleRow } from "../schedules/runner.js";

export type DiscordSettings = {
  enabled: boolean;
  token: string;
  guildId: string;
  commandChannel: string;
  authorizedRoleId: string;
};

/** Bot invite permissions: View Channel, Add Reactions, Send Messages, Embed Links, Read History, Use App Commands */
export const DISCORD_BOT_INVITE_PERMISSIONS = String(
  (1n << 10n) | // VIEW_CHANNEL
    (1n << 6n) | // ADD_REACTIONS
    (1n << 11n) | // SEND_MESSAGES
    (1n << 14n) | // EMBED_LINKS
    (1n << 16n) | // READ_MESSAGE_HISTORY
    (1n << 31n), // USE_APPLICATION_COMMANDS
);

export function loadDiscordSettings(): DiscordSettings {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'discord'").get() as
    | { value: string }
    | undefined;
  const raw = jsonParse<Record<string, unknown>>(row?.value, {});
  let token = String(raw.token || "");
  if (token && isEncryptedSecret(token)) {
    try {
      token = decryptSecret(token);
    } catch {
      token = "";
    }
  }
  return {
    enabled: !!raw.enabled,
    token,
    guildId: String(raw.guildId || ""),
    commandChannel: String(raw.commandChannel || raw.channelId || ""),
    authorizedRoleId: String(raw.authorizedRoleId || raw.roleId || ""),
  };
}

export function discordInviteUrl(clientId: string): string | null {
  const id = String(clientId || "").trim();
  if (!id) return null;
  const u = new URL("https://discord.com/api/oauth2/authorize");
  u.searchParams.set("client_id", id);
  u.searchParams.set("permissions", DISCORD_BOT_INVITE_PERMISSIONS);
  u.searchParams.set("scope", "bot applications.commands");
  return u.toString();
}

export function discordPublicConfig() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'discord'").get() as
    | { value: string }
    | undefined;
  const raw = jsonParse<Record<string, unknown>>(row?.value, {});
  const token = String(raw.token || "");
  const oauthClientId = resolveOAuth2("discord")?.clientId || config.oauth.discord.clientId || "";
  return {
    enabled: !!raw.enabled,
    guildId: String(raw.guildId || ""),
    commandChannel: String(raw.commandChannel || raw.channelId || ""),
    authorizedRoleId: String(raw.authorizedRoleId || raw.roleId || ""),
    hasToken: !!token,
    oauthClientId,
    inviteUrl: discordInviteUrl(oauthClientId),
  };
}

/** Merge PUT body; keep existing token when blank; encrypt token for storage. */
export function saveDiscordSettings(body: Record<string, unknown>) {
  const existing = getDb().prepare("SELECT value FROM settings WHERE key = 'discord'").get() as
    | { value: string }
    | undefined;
  const prev = jsonParse<Record<string, unknown>>(existing?.value, {});
  const nextTokenRaw = String(body.token ?? "").trim();
  let tokenToStore = String(prev.token || "");
  if (nextTokenRaw) {
    tokenToStore = isEncryptedSecret(nextTokenRaw) ? nextTokenRaw : encryptSecret(nextTokenRaw);
  }
  const value = {
    enabled: !!body.enabled,
    guildId: String(body.guildId || ""),
    commandChannel: String(body.commandChannel || body.channelId || ""),
    authorizedRoleId: String(body.authorizedRoleId || body.roleId || ""),
    token: tokenToStore,
  };
  getDb()
    .prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES ('discord', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(value));
}

export async function sendDiscordChannelMessage(channelId: string, content: string): Promise<string | null> {
  const cfg = loadDiscordSettings();
  if (!cfg.enabled || !cfg.token || !channelId) return null;
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.warn(`[discord] message failed ${r.status}: ${t.slice(0, 200)}`);
    return null;
  }
  const json = (await r.json()) as { id?: string };
  return json.id || null;
}

export async function notifyScheduleChannel(row: ScheduleRow, content: string): Promise<void> {
  const cfg = loadDiscordSettings();
  const channel = String(row.discord_channel || "").trim() || cfg.commandChannel;
  if (!channel) return;
  try {
    await sendDiscordChannelMessage(channel, content);
  } catch (e) {
    console.warn("[discord] notify failed", e);
  }
}
