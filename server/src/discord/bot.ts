import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type TextChannel,
} from "discord.js";
import { getDb } from "../db.js";
import { loadDiscordSettings, notifyScheduleChannel } from "./notify.js";
import {
  denyMessage,
  discordMayApply,
  discordMayConfirmSchedule,
  discordMayControl,
  discordMayView,
} from "./authz.js";
import { confirmSchedule, finishScheduleOperation, standDownScheduleOccurrence, activeOperationForInstance, type ScheduleRow } from "../schedules/runner.js";
import { config } from "../config.js";
import { runInstanceControl } from "../instanceControl.js";
import { runHcGroupControl } from "../hcGroupControl.js";
import { startApplyProfileJob } from "../applyProfile.js";
import { getHub } from "../agent/hub.js";
import { getHcGroupRow, groupsTargetingInstance, hcGroupDto, listHcGroupRows } from "../hcGroups.js";

let client: Client | null = null;
let starting = false;

function panelSchedulesUrl(): string {
  return `${config.publicUrl.replace(/\/$/, "")}/schedules`;
}

async function userMayConfirmDiscord(discordUserId: string, schedule: ScheduleRow): Promise<boolean> {
  return discordMayConfirmSchedule(discordUserId, schedule, client);
}

async function registerCommands(token: string, clientId: string, guildId: string) {
  const commands = [
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("What you can do with Ops Control in Discord"),
    new SlashCommandBuilder()
      .setName("schedule")
      .setDescription("Show upcoming operations"),
    new SlashCommandBuilder()
      .setName("instance")
      .setDescription("Query and control game server instances")
      .addSubcommand((s) => s.setName("list").setDescription("List instances and their status"))
      .addSubcommand((s) =>
        s
          .setName("status")
          .setDescription("Show detailed status for one instance")
          .addStringOption((o) => o.setName("instance").setDescription("Instance name or id").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("start")
          .setDescription("Start an instance")
          .addStringOption((o) => o.setName("instance").setDescription("Instance name or id").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("stop")
          .setDescription("Stop an instance")
          .addStringOption((o) => o.setName("instance").setDescription("Instance name or id").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("restart")
          .setDescription("Restart an instance")
          .addStringOption((o) => o.setName("instance").setDescription("Instance name or id").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("apply")
          .setDescription("Apply a mission profile to an instance")
          .addStringOption((o) => o.setName("instance").setDescription("Instance name or id").setRequired(true))
          .addStringOption((o) => o.setName("profile").setDescription("Profile name or id").setRequired(true))
          .addBooleanOption((o) =>
            o.setName("start").setDescription("Start the instance after apply (default true)").setRequired(false),
          )
          .addBooleanOption((o) =>
            o.setName("download_mods").setDescription("Download missing mods (default true)").setRequired(false),
          ),
      ),
    new SlashCommandBuilder()
      .setName("headless")
      .setDescription("Query and control headless client groups")
      .addSubcommand((s) =>
        s
          .setName("list")
          .setDescription("List HC groups")
          .addStringOption((o) =>
            o.setName("instance").setDescription("Filter by target instance name or id").setRequired(false),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("status")
          .setDescription("Show detailed status for one HC group")
          .addStringOption((o) => o.setName("group").setDescription("HC group name or id").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("start")
          .setDescription("Start an HC group")
          .addStringOption((o) => o.setName("group").setDescription("HC group name or id").setRequired(true))
          .addIntegerOption((o) =>
            o.setName("count").setDescription("Desired HC count (1–8)").setRequired(false).setMinValue(1).setMaxValue(8),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("stop")
          .setDescription("Stop an HC group (desired count set to 0)")
          .addStringOption((o) => o.setName("group").setDescription("HC group name or id").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("restart")
          .setDescription("Restart an HC group (use after applying a new profile)")
          .addStringOption((o) => o.setName("group").setDescription("HC group name or id").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("scale")
          .setDescription("Set HC group desired count")
          .addStringOption((o) => o.setName("group").setDescription("HC group name or id").setRequired(true))
          .addIntegerOption((o) =>
            o.setName("count").setDescription("Desired HC count (0–8)").setRequired(true).setMinValue(0).setMaxValue(8),
          ),
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }
}

async function handleHelp(interaction: ChatInputCommandInteraction) {
  const panel = panelSchedulesUrl();
  const content =
    `**Ops Control — what you can do here**\n` +
    `\n` +
    `**Schedules**\n` +
    `• \`/schedule\` — upcoming operations\n` +
    `• Create and edit schedules in the panel: ${panel}\n` +
    `\n` +
    `**Instances** (linked panel account required)\n` +
    `• \`/instance list\` / \`status\` — query servers\n` +
    `• \`/instance start\` / \`stop\` / \`restart\` — needs Control instance permission\n` +
    `• \`/instance apply\` — load a profile (needs Apply profile permission)\n` +
    `\n` +
    `**Headless** (linked panel account required)\n` +
    `• \`/headless list\` / \`status\` — query HC groups\n` +
    `• \`/headless start\` / \`stop\` / \`restart\` / \`scale\` — needs Control instance permission\n` +
    `\n` +
    `**On schedule messages**\n` +
    `• **Confirm** / ✅ — this run will apply at start time\n` +
    `• **Stand down** / ⏹️ — skip this occurrence (schedule stays for next time if recurring)\n` +
    `• **Finish** / 🏁 — end a live op and restore the fallback profile\n` +
    `\n` +
    `**Who can Confirm / Stand down / Finish**\n` +
    `• Panel users signed in with Discord who have schedule permissions\n` +
    `• Members with the staff role configured in the panel (Admin → Discord)\n`;

  await interaction.reply({ content, ephemeral: true });
}

function resolveInstance(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  const byId = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(s) as Record<string, unknown> | undefined;
  if (byId) return byId;
  const byName = getDb()
    .prepare("SELECT * FROM instances WHERE lower(name) = lower(?)")
    .get(s) as Record<string, unknown> | undefined;
  return byName || null;
}

function resolveProfile(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  const byId = getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(s) as
    | Record<string, unknown>
    | undefined;
  if (byId) return byId;
  return (
    (getDb().prepare("SELECT * FROM mission_profiles WHERE lower(name) = lower(?)").get(s) as
      | Record<string, unknown>
      | undefined) || null
  );
}

function resolveHcGroup(raw: string) {
  const s = raw.trim();
  const byId = getHcGroupRow(s);
  if (byId) return byId;
  const byName = getDb()
    .prepare("SELECT id FROM hc_groups WHERE lower(name) = lower(?)")
    .get(s) as { id: string } | undefined;
  return byName ? getHcGroupRow(byName.id) : undefined;
}

function hostNameFor(hostId: string): string {
  const h = getDb().prepare("SELECT name FROM hosts WHERE id = ?").get(hostId) as { name: string } | undefined;
  return h?.name || hostId.slice(0, 8);
}

function profileNameFor(profileId: string | null | undefined): string {
  if (!profileId) return "—";
  const p = getDb().prepare("SELECT name FROM mission_profiles WHERE id = ?").get(profileId) as
    | { name: string }
    | undefined;
  return p?.name || String(profileId).slice(0, 8);
}

function formatUptime(sec: number | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatInstanceSummary(row: Record<string, unknown>): string {
  const hub = getHub();
  const hostId = String(row.host_id);
  const live = hub.getInstanceStatus(hostId, String(row.id));
  const state = String(live?.state || row.state || "stopped");
  const profile = profileNameFor(row.current_profile_id as string | undefined);
  const players =
    live?.queryOk === true ? `${live.players ?? 0}/${live.maxPlayers ?? 0}` : "query n/a";
  const host = hostNameFor(hostId);
  const agent = hub.isOnline(hostId) ? "" : " · agent offline";
  return `• **${row.name}** — ${state}${agent} · ${players} · profile \`${profile}\` · host \`${host}\``;
}

function formatInstanceStatus(row: Record<string, unknown>): string {
  const hub = getHub();
  const hostId = String(row.host_id);
  const live = hub.getInstanceStatus(hostId, String(row.id));
  const state = String(live?.state || row.state || "stopped");
  const lines = [
    `**${row.name}**`,
    `State: \`${state}\`${hub.isOnline(hostId) ? "" : " (agent offline)"}`,
    `Host: \`${hostNameFor(hostId)}\` · port \`${row.port}\``,
    `Profile: \`${profileNameFor(row.current_profile_id as string | undefined)}\``,
  ];
  if (live?.queryOk) {
    lines.push(
      `Players: ${live.players ?? 0}/${live.maxPlayers ?? 0}`,
      `Map: ${live.map || "—"}`,
      `Hostname: ${live.hostname || "—"}`,
      `Uptime: ${formatUptime(live.uptimeSec)}`,
    );
  } else if (live?.queryError) {
    lines.push(`Query: ${live.queryError}`);
  }
  const localHc = Array.isArray(live?.headless) ? live!.headless.length : Number(row.headless_count) || 0;
  lines.push(`Local HC: ${localHc}`);
  const remote = groupsTargetingInstance(String(row.id));
  if (remote.length) {
    lines.push(`Remote HC groups: ${remote.map((g) => `${g.name} (×${g.desired_count})`).join(", ")}`);
  }
  const op = activeOperationForInstance(String(row.id));
  if (op) {
    lines.push(`Active op: **${op.name}** (${op.state}) — ${op.profileName || op.profileId}`);
  }
  return lines.join("\n");
}

async function handleInstanceCommand(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "list" || sub === "status") {
    const actor = discordMayView(interaction.user.id);
    if (!actor) {
      await interaction.reply({ content: denyMessage("view"), ephemeral: true });
      return;
    }
    if (sub === "list") {
      const rows = getDb().prepare("SELECT * FROM instances ORDER BY name").all() as Record<string, unknown>[];
      if (!rows.length) {
        await interaction.reply({ content: "No instances configured.", ephemeral: true });
        return;
      }
      await interaction.reply({
        content: `**Instances**\n${rows.map(formatInstanceSummary).join("\n")}`.slice(0, 1900),
        ephemeral: true,
      });
      return;
    }
    const raw = interaction.options.getString("instance", true);
    const inst = resolveInstance(raw);
    if (!inst) {
      await interaction.reply({ content: `Instance not found: ${raw}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: formatInstanceStatus(inst), ephemeral: true });
    return;
  }

  if (sub === "apply") {
    const actor = discordMayApply(interaction.user.id);
    if (!actor) {
      await interaction.reply({ content: denyMessage("apply"), ephemeral: true });
      return;
    }
    const instRaw = interaction.options.getString("instance", true);
    const profileRaw = interaction.options.getString("profile", true);
    const forceStart = interaction.options.getBoolean("start");
    const downloadMods = interaction.options.getBoolean("download_mods");
    const inst = resolveInstance(instRaw);
    if (!inst) {
      await interaction.reply({ content: `Instance not found: ${instRaw}`, ephemeral: true });
      return;
    }
    const profile = resolveProfile(profileRaw);
    if (!profile) {
      await interaction.reply({ content: `Profile not found: ${profileRaw}`, ephemeral: true });
      return;
    }

    const active = activeOperationForInstance(String(inst.id));
    await interaction.deferReply();
    let warn = "";
    if (active) {
      warn = `\n⚠️ A live operation is active: **${active.name}** (${active.state}).`;
    }
    const remote = groupsTargetingInstance(String(inst.id));
    const hcNote = remote.length
      ? `\nHC groups targeting this instance may need \`/headless restart\` after mods change: ${remote.map((g) => g.name).join(", ")}.`
      : "";

    try {
      const started = await startApplyProfileJob({
        profileId: String(profile.id),
        instanceId: String(inst.id),
        forceStart: forceStart !== false,
        downloadMods: downloadMods !== false,
        matchHeadlessRecommendation: true,
        requestedBy: actor.userId,
        actorLabel: `${interaction.user.tag} (Discord)`,
        triggerKind: "user",
        onProgress: (stage, message) => {
          const notable = ["instance", "config", "mods", "keys", "done", "failed", "server_update"];
          if (!notable.includes(stage)) return;
          void interaction
            .editReply({
              content:
                `Applying **${profile.name}** → **${inst.name}**…${warn}${hcNote}\n` +
                `• **${stage}**: ${message.slice(0, 180)}`,
            })
            .catch(() => undefined);
        },
      });
      if (started.status === "failed") {
        await interaction.editReply({ content: started.error || "Apply failed to start." });
        return;
      }
      await interaction.editReply({
        content:
          `Apply started for **${inst.name}** ← **${profile.name}** (job \`${started.jobId}\`).${warn}${hcNote}\n` +
          `Progress will update here.`,
      });
    } catch (e) {
      await interaction.editReply({ content: e instanceof Error ? e.message : "Apply failed" });
    }
    return;
  }

  const actor = discordMayControl(interaction.user.id);
  if (!actor) {
    await interaction.reply({ content: denyMessage("control"), ephemeral: true });
    return;
  }
  const op =
    sub === "start" ? "instance.start" : sub === "stop" ? "instance.stop" : sub === "restart" ? "instance.restart" : null;
  if (!op) {
    await interaction.reply({ content: "Unknown subcommand.", ephemeral: true });
    return;
  }
  const raw = interaction.options.getString("instance", true);
  const inst = resolveInstance(raw);
  if (!inst) {
    await interaction.reply({ content: `Instance not found: ${raw}`, ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const out = await runInstanceControl({
    instanceId: String(inst.id),
    op,
    actorId: actor.userId,
    actorLabel: `${interaction.user.tag} (Discord)`,
    source: "discord",
  });
  if (!out.ok) {
    await interaction.editReply({ content: out.error || `${sub} failed` });
    return;
  }
  const summary =
    out.launchSummary && typeof out.launchSummary === "object"
      ? ` · mods ${(out.launchSummary as { mods?: number }).mods ?? "?"} · HC ${(out.launchSummary as { headless?: number }).headless ?? "?"}`
      : "";
  const warn = out.warning ? `\n⚠️ ${out.warning}` : "";
  await interaction.editReply({
    content: `**${inst.name}** ${sub} → \`${out.state || "ok"}\`${summary}${warn}`,
  });
}

function formatHcGroupLine(dto: ReturnType<typeof hcGroupDto>): string {
  const st = dto.status?.state || "unknown";
  const active = dto.status?.active ?? 0;
  const desired = dto.status?.desired ?? dto.desiredCount;
  const failed = dto.status?.failed ?? 0;
  const fail = failed ? ` · ${failed} failed` : "";
  const target = dto.targetName || "no target";
  const worker = dto.workerOnline ? dto.hostName : `${dto.hostName} (offline)`;
  return `• **${dto.name}** — ${st} · ${active}/${desired}${fail} · → \`${target}\` · worker \`${worker}\``;
}

async function handleHeadlessCommand(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "list" || sub === "status") {
    const actor = discordMayView(interaction.user.id);
    if (!actor) {
      await interaction.reply({ content: denyMessage("view"), ephemeral: true });
      return;
    }
    if (sub === "list") {
      const instRaw = interaction.options.getString("instance");
      let rows = listHcGroupRows();
      if (instRaw) {
        const inst = resolveInstance(instRaw);
        if (!inst) {
          await interaction.reply({ content: `Instance not found: ${instRaw}`, ephemeral: true });
          return;
        }
        const ids = new Set(groupsTargetingInstance(String(inst.id)).map((g) => g.id));
        rows = rows.filter((r) => ids.has(r.id));
      }
      if (!rows.length) {
        await interaction.reply({ content: "No HC groups found.", ephemeral: true });
        return;
      }
      await interaction.reply({
        content: `**Headless groups**\n${rows.map((r) => formatHcGroupLine(hcGroupDto(r))).join("\n")}`.slice(0, 1900),
        ephemeral: true,
      });
      return;
    }
    const raw = interaction.options.getString("group", true);
    const group = resolveHcGroup(raw);
    if (!group) {
      await interaction.reply({ content: `HC group not found: ${raw}`, ephemeral: true });
      return;
    }
    const dto = hcGroupDto(group);
    const lines = [
      `**${dto.name}**`,
      `State: \`${dto.status?.state || "unknown"}\` · ${dto.status?.active ?? 0}/${dto.status?.desired ?? dto.desiredCount} active`,
      `Worker: \`${dto.hostName}\`${dto.workerOnline ? "" : " (offline)"}`,
      `Target: \`${dto.targetName || "—"}\`${dto.targetPort ? ` :${dto.targetPort}` : ""}`,
      `Connect: \`${dto.connectHost || "auto"}\``,
    ];
    const heads = dto.status?.headless;
    if (Array.isArray(heads) && heads.length) {
      lines.push(
        "Processes:",
        ...heads.slice(0, 8).map((h) => `• ${h.name || "hc"} — ${h.state || "?"}${h.pid ? ` pid ${h.pid}` : ""}`),
      );
    }
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    return;
  }

  const actor = discordMayControl(interaction.user.id);
  if (!actor) {
    await interaction.reply({ content: denyMessage("control"), ephemeral: true });
    return;
  }
  const raw = interaction.options.getString("group", true);
  const group = resolveHcGroup(raw);
  if (!group) {
    await interaction.reply({ content: `HC group not found: ${raw}`, ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const label = `${interaction.user.tag} (Discord)`;
  let out;
  if (sub === "start") {
    const count = interaction.options.getInteger("count");
    out = await runHcGroupControl({
      groupId: group.id,
      forceStart: count == null,
      count: count ?? undefined,
      actorId: actor.userId,
      actorLabel: label,
      source: "discord",
    });
  } else if (sub === "stop") {
    out = await runHcGroupControl({
      groupId: group.id,
      count: 0,
      actorId: actor.userId,
      actorLabel: label,
      source: "discord",
    });
  } else if (sub === "restart") {
    out = await runHcGroupControl({
      groupId: group.id,
      forceRestart: true,
      actorId: actor.userId,
      actorLabel: label,
      source: "discord",
    });
  } else if (sub === "scale") {
    const count = interaction.options.getInteger("count", true);
    out = await runHcGroupControl({
      groupId: group.id,
      count,
      actorId: actor.userId,
      actorLabel: label,
      source: "discord",
    });
  } else {
    await interaction.editReply({ content: "Unknown subcommand." });
    return;
  }

  if (!out.ok) {
    await interaction.editReply({ content: out.error || `${sub} failed` });
    return;
  }
  const dto = out.group as ReturnType<typeof hcGroupDto> | undefined;
  const st = dto?.status?.state || "ok";
  const desired = dto?.desiredCount ?? "?";
  await interaction.editReply({
    content: `**${group.name}** ${sub} → \`${st}\` · desired ${desired}`,
  });
}

function scheduleMinutesUntil(row: ScheduleRow): number {
  const runAt = new Date(row.run_at).getTime();
  if (Number.isNaN(runAt)) return Number.POSITIVE_INFINITY;
  return (runAt - Date.now()) / 60_000;
}

function scheduleAnnounceParts(row: ScheduleRow) {
  const runTs = Math.floor(new Date(row.run_at).getTime() / 1000);
  const inst =
    (getDb().prepare("SELECT name FROM instances WHERE id = ?").get(row.instance_id) as { name?: string } | undefined)
      ?.name || "—";
  const profile =
    (getDb().prepare("SELECT name FROM mission_profiles WHERE id = ?").get(row.profile_id) as
      | { name?: string }
      | undefined)?.name || "—";
  const recurrence = String(row.recurrence || "none").toLowerCase();
  const recur =
    recurrence === "weekly" ? " · weekly" : recurrence === "daily" ? " · daily" : "";
  return { runTs, inst, profile, recur };
}

/** Confirm / Stand down controls — only when the op starts within ~1 hour. */
export async function postScheduleConfirmMessage(row: ScheduleRow): Promise<void> {
  if (!client?.isReady()) {
    const { runTs, inst, profile } = scheduleAnnounceParts(row);
    await notifyScheduleChannel(
      row,
      `⏰ **Confirm needed** for **${row.name || "Operation"}** <t:${runTs}:R>\n` +
        `\`${inst}\` · ${profile}\n` +
        `Confirm or stand down in the panel: ${panelSchedulesUrl()}`,
    );
    return;
  }

  const cfg = loadDiscordSettings();
  const channelId = String(row.discord_channel || "").trim() || cfg.commandChannel;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildStageVoice) return;

  const { runTs, inst, profile, recur } = scheduleAnnounceParts(row);
  const rowBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sched_confirm:${row.id}`).setLabel("Confirm operation").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sched_standdown:${row.id}`).setLabel("Stand down").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel("Open panel").setStyle(ButtonStyle.Link).setURL(panelSchedulesUrl()),
  );
  const msg = await (channel as TextChannel).send({
    content:
      `⏰ **Confirm needed** — **${row.name || "Operation"}** <t:${runTs}:F> (<t:${runTs}:R>)${recur}\n` +
      `\`${inst}\` · ${profile}\n` +
      `Confirm to run it, or stand down if this occurrence is not happening.`,
    components: [rowBtn],
  });
  getDb().prepare(`UPDATE schedules SET discord_confirm_message_id=? WHERE id=?`).run(msg.id, row.id);
  try {
    await msg.react("✅");
    await msg.react("⏹️");
  } catch {
    /* ignore */
  }
}

export async function postScheduleCreatedMessage(row: ScheduleRow): Promise<void> {
  const { enterAwaitingConfirm, CONFIRM_OFFSET_MIN } = await import("../schedules/runner.js");
  const minsUntil = scheduleMinutesUntil(row);
  // Within the confirm window — one confirm message only (runner will not re-post).
  if (minsUntil <= CONFIRM_OFFSET_MIN && minsUntil > -5) {
    await enterAwaitingConfirm(row);
    return;
  }

  const { runTs, inst, profile, recur } = scheduleAnnounceParts(row);
  const content =
    `🗓️ **${row.name || "Operation"}** scheduled <t:${runTs}:F> (<t:${runTs}:R>)${recur}\n` +
    `\`${inst}\` · ${profile}\n` +
    `Details: ${panelSchedulesUrl()}`;

  if (!client?.isReady()) {
    await notifyScheduleChannel(row, content);
    return;
  }

  const cfg = loadDiscordSettings();
  const channelId = String(row.discord_channel || "").trim() || cfg.commandChannel;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildStageVoice) return;

  const rowBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open panel").setStyle(ButtonStyle.Link).setURL(panelSchedulesUrl()),
  );
  await (channel as TextChannel).send({ content, components: [rowBtn] });
}

export async function postOperationFinishMessage(row: ScheduleRow) {
  if (!client) return;
  const cfg = loadDiscordSettings();
  const channelId = String(row.discord_channel || "").trim() || cfg.commandChannel;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.type === ChannelType.GuildStageVoice) return;
  const fallbackName =
    (getDb().prepare("SELECT name FROM mission_profiles WHERE id = ?").get(String(row.fallback_profile_id || "")) as
      | { name?: string }
      | undefined)?.name || "fallback profile";
  const rowBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sched_finish:${row.id}`).setLabel("Finish operation").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel("Open panel").setStyle(ButtonStyle.Link).setURL(panelSchedulesUrl()),
  );
  const msg = await (channel as TextChannel).send({
    content:
      `🎮 **${row.name || "Operation"}** is running.\n` +
      `When the op is over, finish it to restore **${fallbackName}**.`,
    components: [rowBtn],
  });
  getDb().prepare(`UPDATE schedules SET discord_finish_message_id=? WHERE id=?`).run(msg.id, row.id);
  try {
    await msg.react("🏁");
  } catch {
    /* ignore */
  }
}

function formatScheduleStateLabel(state: string): string {
  const s = String(state || "").toLowerCase();
  const map: Record<string, string> = {
    scheduled: "Scheduled",
    reminded: "Reminded",
    awaiting_confirm: "Waiting for Confirmation",
    confirmed: "Confirmed",
    applying: "Applying",
    live: "Live",
    restoring: "Restoring",
    done: "Done",
    failed: "Failed",
    skipped: "Stood down",
  };
  return map[s] || state;
}

async function handleSchedule(interaction: ChatInputCommandInteraction) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM schedules
       WHERE lower(state) NOT IN ('done','failed','skipped')
       ORDER BY run_at LIMIT 15`,
    )
    .all() as ScheduleRow[];
  if (!rows.length) {
    await interaction.reply({
      content: `No upcoming operations.\nSchedule them in the panel: ${panelSchedulesUrl()}`,
      ephemeral: true,
    });
    return;
  }
  const lines = rows.map((s) => {
    const ts = Math.floor(new Date(s.run_at).getTime() / 1000);
    const inst =
      (getDb().prepare("SELECT name FROM instances WHERE id = ?").get(s.instance_id) as { name?: string } | undefined)
        ?.name || "—";
    const profile =
      (getDb().prepare("SELECT name FROM mission_profiles WHERE id = ?").get(s.profile_id) as
        | { name?: string }
        | undefined)?.name || "—";
    const state = formatScheduleStateLabel(String(s.state || ""));
    return `• **${s.name || s.id}** — <t:${ts}:F> (<t:${ts}:R>)\n  \`${inst}\` · ${profile} · ${state}`;
  });
  await interaction.reply({
    content: `**Upcoming operations**\n${lines.join("\n")}\n\nManage in panel: ${panelSchedulesUrl()}`.slice(0, 1900),
  });
}

async function onButton(interaction: ButtonInteraction) {
  const id = interaction.customId;
  if (id.startsWith("sched_confirm:")) {
    const scheduleId = id.slice("sched_confirm:".length);
    const row = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined;
    if (!row) {
      await interaction.reply({ content: "Schedule gone.", ephemeral: true });
      return;
    }
    const ok = await userMayConfirmDiscord(interaction.user.id, row);
    if (!ok) {
      await interaction.reply({
        content: `You are not allowed to confirm this. Open ${panelSchedulesUrl()} if you have panel access.`,
        ephemeral: true,
      });
      return;
    }
    const result = confirmSchedule(scheduleId, {
      label: interaction.user.tag || interaction.user.username,
      source: "discord",
      discordUserId: interaction.user.id,
    });
    if (!result.ok) {
      await interaction.reply({ content: result.error || "failed", ephemeral: true });
      return;
    }
    await interaction.reply({ content: `Confirmed **${row.name || scheduleId}**.` });
    return;
  }

  if (id.startsWith("sched_standdown:")) {
    const scheduleId = id.slice("sched_standdown:".length);
    const row = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined;
    if (!row) {
      await interaction.reply({ content: "Schedule gone.", ephemeral: true });
      return;
    }
    const ok = await userMayConfirmDiscord(interaction.user.id, row);
    if (!ok) {
      await interaction.reply({
        content: `You are not allowed to stand down this schedule. Open ${panelSchedulesUrl()} if you have panel access.`,
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply();
    const result = await standDownScheduleOccurrence(scheduleId, {
      label: interaction.user.tag || interaction.user.username,
      source: "discord",
      discordUserId: interaction.user.id,
    });
    if (!result.ok) {
      await interaction.editReply({ content: result.error || "stand down failed" });
      return;
    }
    await interaction.editReply({
      content: `Stood down **${row.name || scheduleId}** — this run will not apply.`,
    });
    return;
  }

  if (id.startsWith("sched_finish:")) {
    const scheduleId = id.slice("sched_finish:".length);
    const row = getDb().prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined;
    if (!row) {
      await interaction.reply({ content: "Schedule gone.", ephemeral: true });
      return;
    }
    const ok = await userMayConfirmDiscord(interaction.user.id, row);
    if (!ok) {
      await interaction.reply({
        content: `You are not allowed to finish this. Open ${panelSchedulesUrl()} if you have panel access.`,
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply();
    const result = await finishScheduleOperation(scheduleId, {
      label: interaction.user.tag || interaction.user.username,
      source: "discord",
      discordUserId: interaction.user.id,
    });
    if (!result.ok) {
      await interaction.editReply({ content: result.error || "finish failed" });
      return;
    }
    await interaction.editReply({ content: `Finishing **${row.name || scheduleId}** — restoring fallback profile…` });
  }
}

export async function startDiscordBot() {
  if (starting || client) return;
  const cfg = loadDiscordSettings();
  if (!cfg.enabled || !cfg.token) {
    console.log("[discord] bot disabled or no token");
    return;
  }
  starting = true;
  try {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });

    client.once("ready", async () => {
      console.log(`[discord] logged in as ${client?.user?.tag}`);
      try {
        const appId = client!.user!.id;
        await registerCommands(cfg.token, appId, cfg.guildId);
        console.log("[discord] slash commands registered");
      } catch (e) {
        console.warn("[discord] command register failed", e);
      }
    });

    client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          if (interaction.commandName === "help") {
            await handleHelp(interaction);
          } else if (interaction.commandName === "schedule") {
            await handleSchedule(interaction);
          } else if (interaction.commandName === "instance") {
            await handleInstanceCommand(interaction);
          } else if (interaction.commandName === "headless") {
            await handleHeadlessCommand(interaction);
          }
        } else if (interaction.isButton()) {
          await onButton(interaction);
        }
      } catch (e) {
        console.warn("[discord] interaction error", e);
        if (interaction.isRepliable()) {
          const msg = "Something went wrong.";
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: msg, ephemeral: true }).catch(() => undefined);
          } else {
            await interaction.reply({ content: msg, ephemeral: true }).catch(() => undefined);
          }
        }
      }
    });

    client.on("messageReactionAdd", async (reaction, user) => {
      try {
        if (user.bot) return;
        if (reaction.partial) await reaction.fetch();
        const emoji = reaction.emoji.name;
        if (emoji !== "✅" && emoji !== "🏁" && emoji !== "⏹️") return;
        const msgId = reaction.message.id;
        const row = getDb()
          .prepare("SELECT * FROM schedules WHERE discord_confirm_message_id = ?")
          .get(msgId) as ScheduleRow | undefined;

        if (emoji === "✅") {
          if (!row) return;
          const ok = await userMayConfirmDiscord(user.id, row);
          if (!ok) return;
          confirmSchedule(row.id, {
            label: user.tag || user.username || "Discord user",
            source: "discord",
            discordUserId: user.id,
          });
          const ch = reaction.message.channel;
          if ("send" in ch && typeof ch.send === "function") {
            await ch.send(`✅ <@${user.id}> confirmed **${row.name || row.id}**.`);
          }
          return;
        }

        if (emoji === "⏹️") {
          if (!row) return;
          const ok = await userMayConfirmDiscord(user.id, row);
          if (!ok) return;
          // Channel notify is sent by standDownScheduleOccurrence (with a mention).
          await standDownScheduleOccurrence(row.id, {
            label: user.tag || user.username || "Discord user",
            source: "discord",
            discordUserId: user.id,
          });
          return;
        }

        // 🏁 finish — prefer message id, else live schedule in channel
        if (emoji === "🏁") {
          const byFinishMsg = getDb()
            .prepare("SELECT * FROM schedules WHERE discord_finish_message_id = ?")
            .get(msgId) as ScheduleRow | undefined;
          const live = getDb()
            .prepare(
              `SELECT * FROM schedules WHERE lower(state)='live' AND (discord_channel = ? OR discord_channel = '')
               ORDER BY datetime(last_fired_at) DESC LIMIT 1`,
            )
            .get(reaction.message.channelId) as ScheduleRow | undefined;
          const target = byFinishMsg || live;
          if (!target || String(target.state) !== "live") return;
          const ok = await userMayConfirmDiscord(user.id, target);
          if (!ok) return;
          // Channel notify is sent by finishScheduleOperation (with a mention).
          await finishScheduleOperation(target.id, {
            label: user.tag || user.username || "Discord user",
            source: "discord",
            discordUserId: user.id,
          });
        }
      } catch (e) {
        console.warn("[discord] reaction error", e);
      }
    });

    await client.login(cfg.token);
  } catch (e) {
    console.warn("[discord] failed to start bot", e);
    client = null;
  } finally {
    starting = false;
  }
}

export async function stopDiscordBot() {
  if (client) {
    await client.destroy();
    client = null;
  }
}

export function getDiscordBotRuntimeStatus(): {
  connected: boolean;
  botTag: string | null;
  botId: string | null;
} {
  const ready = !!client?.isReady();
  return {
    connected: ready,
    botTag: ready && client?.user?.tag ? client.user.tag : null,
    botId: ready && client?.user?.id ? client.user.id : null,
  };
}

export function listDiscordGuilds(): { id: string; name: string }[] {
  if (!client?.isReady()) return [];
  return [...client.guilds.cache.values()]
    .map((g) => ({ id: g.id, name: g.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listDiscordGuildChannels(guildId: string): Promise<{ id: string; name: string }[]> {
  if (!client?.isReady()) return [];
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return [];
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return [];
  return [...channels.values()]
    .filter((c) => !!c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
    .map((c) => ({ id: c!.id, name: `#${c!.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listDiscordGuildRoles(guildId: string): Promise<{ id: string; name: string }[]> {
  if (!client?.isReady()) return [];
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return [];
  const roles = await guild.roles.fetch().catch(() => null);
  if (!roles) return [];
  return [...roles.values()]
    .filter((r) => r.id !== guild.id && !r.managed) // skip @everyone and bot-managed
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Restart the bot after config changes (no-op if disabled / no token). */
export async function restartDiscordBot(): Promise<{ connected: boolean; botTag: string | null; error?: string }> {
  try {
    await stopDiscordBot();
    await startDiscordBot();
    // login is async; give ready a moment
    for (let i = 0; i < 20; i++) {
      if (client?.isReady()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const st = getDiscordBotRuntimeStatus();
    return { connected: st.connected, botTag: st.botTag };
  } catch (e) {
    return {
      connected: false,
      botTag: null,
      error: e instanceof Error ? e.message : "bot restart failed",
    };
  }
}