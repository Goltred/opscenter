import { getDb } from "../db.js";
import { loadGrants } from "../auth/middleware.js";
import { hasPermission, type Grant } from "../rbac.js";
import { canConfirmSchedule } from "../schedules/runner.js";
import { loadDiscordSettings } from "./notify.js";
import type { Client } from "discord.js";

export type DiscordActor = {
  userId: string;
  email: string;
  grants: Grant[];
};

/** Linked, approved panel user for a Discord account — or null. */
export function resolveDiscordActor(discordUserId: string): DiscordActor | null {
  const linked = getDb()
    .prepare(
      `SELECT u.id, u.email, u.approved, u.disabled
       FROM user_identities i
       JOIN users u ON u.id = i.user_id
       WHERE i.provider = 'discord' AND i.subject = ?`,
    )
    .get(discordUserId) as { id: string; email: string; approved: number; disabled: number } | undefined;
  if (!linked || !linked.approved || linked.disabled) return null;
  return {
    userId: linked.id,
    email: linked.email || "",
    grants: loadGrants(linked.id),
  };
}

export function discordActorHasPerm(actor: DiscordActor | null, permission: string): boolean {
  if (!actor) return false;
  return hasPermission(actor.grants, permission);
}

/** Panel-linked users may view (any approved account). */
export function discordMayView(discordUserId: string): DiscordActor | null {
  return resolveDiscordActor(discordUserId);
}

export function discordMayControl(discordUserId: string): DiscordActor | null {
  const actor = resolveDiscordActor(discordUserId);
  if (!actor || !discordActorHasPerm(actor, "instance.control")) return null;
  return actor;
}

export function discordMayApply(discordUserId: string): DiscordActor | null {
  const actor = resolveDiscordActor(discordUserId);
  if (!actor || !discordActorHasPerm(actor, "profile.apply")) return null;
  return actor;
}

/** Schedule confirm / stand-down / finish — linked perms, requester, or Discord staff role. */
export async function discordMayConfirmSchedule(
  discordUserId: string,
  schedule: { requester_discord_id?: string | null },
  client: Client | null,
): Promise<boolean> {
  if (schedule.requester_discord_id && schedule.requester_discord_id === discordUserId) return true;

  const actor = resolveDiscordActor(discordUserId);
  if (actor && canConfirmSchedule(actor.grants)) return true;

  const cfg = loadDiscordSettings();
  if (cfg.authorizedRoleId && client) {
    try {
      const guild = cfg.guildId ? await client.guilds.fetch(cfg.guildId) : null;
      if (guild) {
        const member = await guild.members.fetch(discordUserId);
        if (member.roles.cache.has(cfg.authorizedRoleId)) return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function denyMessage(kind: "view" | "control" | "apply"): string {
  if (kind === "view") {
    return "Link your Discord account in the panel (sign in with Discord) and get approved before using this command.";
  }
  if (kind === "apply") {
    return "You need the **Apply profile** permission on a linked panel account to do this.";
  }
  return "You need the **Control instance** permission on a linked panel account to do this.";
}
