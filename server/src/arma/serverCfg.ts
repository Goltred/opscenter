import { normalizeForcedDifficulty } from "./difficulty.js";

/** Flattened server.cfg key/value map used in the panel (before Arma syntax render). */
export type ServerCfgMap = Record<string, unknown>;

/**
 * Strip .pbo → Arma mission template (e.g. MyMission.Altis.pbo → MyMission.Altis).
 */
export function pboToMissionTemplate(pboFilename: string): string {
  return String(pboFilename || "")
    .trim()
    .replace(/\.pbo$/i, "");
}

/** How a profile selects its mission for server.cfg. */
export type MissionSource = "library" | "mod";

export function normalizeMissionSource(raw: unknown): MissionSource {
  return String(raw || "").trim().toLowerCase() === "mod" ? "mod" : "library";
}

/** Freeform / stored template string (also strips accidental .pbo suffix). */
export function normalizeMissionTemplateInput(raw: unknown): string {
  return pboToMissionTemplate(String(raw || ""));
}

function missionClassName(template: string): string {
  const base = (template.split(".")[0] || "Mission").trim() || "Mission";
  const cleaned = base.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!cleaned) return "Mission";
  return /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
}

function escStr(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeAdmins(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Parse optional numeric fields; blank / null / NaN → undefined (omit from cfg). */
export function optionalNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** {MaxPing, MaxPacketLoss, MaxDesync, DisconnectTimeout} kick flags — 0=log, 1=kick. */
export function normalizeKickClientsOnSlowNetwork(raw: unknown): [number, number, number, number] | undefined {
  if (raw == null || raw === "") return undefined;
  let parts: unknown[] = [];
  if (Array.isArray(raw)) {
    parts = raw;
  } else if (typeof raw === "string") {
    parts = raw.split(/[,\s;]+/).filter(Boolean);
  } else if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    parts = [o.ping ?? o[0], o.packetLoss ?? o[1], o.desync ?? o[2], o.timeout ?? o[3]];
  } else {
    return undefined;
  }
  if (!parts.length) return undefined;
  const flags = [0, 1, 2, 3].map((i) => (Number(parts[i]) ? 1 : 0)) as [number, number, number, number];
  return flags;
}

function pickFirst(cfg: ServerCfgMap, keys: string[]): unknown {
  for (const k of keys) {
    if (cfg[k] !== undefined && cfg[k] !== null && String(cfg[k]).trim() !== "") return cfg[k];
  }
  return undefined;
}

function canonicalizeNetworkingKeys(cfg: ServerCfgMap): void {
  const alias = (canonical: string, ...alts: string[]) => {
    if (cfg[canonical] != null && String(cfg[canonical]).trim() !== "") {
      for (const a of alts) delete cfg[a];
      return;
    }
    for (const a of alts) {
      if (cfg[a] != null && String(cfg[a]).trim() !== "") {
        cfg[canonical] = cfg[a];
        break;
      }
    }
    for (const a of alts) delete cfg[a];
  };
  alias("MaxPing", "maxPing", "maxping");
  alias("MaxPacketLoss", "maxPacketLoss", "maxpacketloss");
  alias("MaxDesync", "maxDesync", "maxdesync");
  alias("DisconnectTimeout", "disconnectTimeout", "disconnecttimeout");
  alias("kickDuplicate", "kickduplicate");
  alias("disableVoN", "disablevon", "disableVon");
  alias("vonCodecQuality", "voncodecquality");
  alias("vonCodec", "voncodec");
  alias("kickClientsOnSlowNetwork", "kickClientsOnSlowNetwork[]", "kickclientsonslownetwork");
}

/** Shared instance defaults, then profile overrides (profile wins on same key). */
export function mergeServerCfg(shared: ServerCfgMap, profile: ServerCfgMap): ServerCfgMap {
  const out: ServerCfgMap = { ...shared };
  // Passwords / admins live only in shared settings — ignore legacy profile overrides
  const sharedOnly = new Set([
    "password",
    "passwordAdmin",
    "passwordadmin",
    "serverCommandPassword",
    "servercommandpassword",
    "admins",
    "adminIds",
  ]);
  for (const [k, v] of Object.entries(profile || {})) {
    if (v === undefined) continue;
    if (sharedOnly.has(k)) continue;
    out[k] = v;
  }
  // Canonicalize common aliases onto one key
  if (out.passwordadmin != null && out.passwordAdmin == null) {
    out.passwordAdmin = out.passwordadmin;
    delete out.passwordadmin;
  }
  if (out.servercommandpassword != null && out.serverCommandPassword == null) {
    out.serverCommandPassword = out.servercommandpassword;
    delete out.servercommandpassword;
  }
  if (out.maxplayers != null && out.maxPlayers == null) {
    out.maxPlayers = out.maxplayers;
    delete out.maxplayers;
  }
  if (out.admins != null || out.adminIds != null) {
    const admins = normalizeAdmins(out.admins ?? out.adminIds);
    delete out.adminIds;
    if (admins.length) out.admins = admins;
    else delete out.admins;
  }
  canonicalizeNetworkingKeys(out);
  return out;
}

export type RenderServerCfgOpts = {
  /** Mission template without .pbo (e.g. coop_foo.Altis). Injects class Missions when set. */
  missionTemplate?: string | null;
  /** Difficulty name for the Missions class (defaults to forcedDifficulty or Regular). */
  missionDifficulty?: string | null;
  /** Client-facing mod count — used to pick a safe steamProtocolMaxDataSize when unset. */
  modCountHint?: number;
};

/** Recommend Steam query packet size for a given client mod count (BI default 1024 overflows quickly). */
export function recommendSteamProtocolMaxDataSize(modCount: number): number {
  const n = Number.isFinite(modCount) ? Math.max(0, Math.floor(modCount)) : 0;
  // Roughly ~50–80 bytes of query payload per workshop mod; keep headroom under 8192.
  const estimated = 1024 + n * 80;
  const stepped = Math.ceil(estimated / 256) * 256;
  return Math.min(8192, Math.max(4096, stepped));
}

/**
 * Render an Arma 3 dedicated server.cfg from a flat map + optional mission.
 */
export function renderServerCfg(cfg: ServerCfgMap, opts: RenderServerCfgOpts = {}): string {
  // cfg is already shared⊕profile. Pass it as the shared side so password/admins are kept
  // (mergeServerCfg strips those keys from the profile argument).
  const merged = mergeServerCfg(cfg, {});
  const hostname = String(merged.hostname ?? "A3Panel Server");
  const maxPlayers = Number(merged.maxPlayers ?? 32);
  const password = String(merged.password ?? "");
  const passwordAdmin = String(merged.passwordAdmin ?? "");
  const serverCommandPassword = String(merged.serverCommandPassword ?? "");
  const verifySignaturesRaw = Number(merged.verifySignatures ?? merged.verifysignatures ?? 2);
  // Engine treats 1 as 2; only write 0 (off) or 2 (verify).
  const verifySignatures = Number.isFinite(verifySignaturesRaw) && verifySignaturesRaw === 0 ? 0 : 2;
  const battlEye = Number(merged.battlEye ?? merged.BattlEye ?? 1);
  const hasExplicitSteamSize =
    merged.steamProtocolMaxDataSize != null && String(merged.steamProtocolMaxDataSize).trim() !== "";
  const steamDefault = recommendSteamProtocolMaxDataSize(opts.modCountHint ?? 0);
  const steamProtocolRaw = Number(hasExplicitSteamSize ? merged.steamProtocolMaxDataSize : steamDefault);
  const steamProtocolMaxDataSize =
    Number.isFinite(steamProtocolRaw) && steamProtocolRaw >= 1024
      ? Math.min(Math.floor(steamProtocolRaw), 8192)
      : steamDefault;
  const forcedDifficulty = normalizeForcedDifficulty(merged.forcedDifficulty);
  const admins = normalizeAdmins(merged.admins);
  const templateEarly = String(opts.missionTemplate || merged.missionTemplate || "").trim();
  // Default on so the launcher/browser can show the loaded mission (BI: autoSelectMission).
  const autoSelectMission = merged.autoSelectMission == null ? true : Number(merged.autoSelectMission) !== 0;
  // -autoInit is a no-op unless persistent=1 (BI startup params). When we have a Missions
  // template, default persistent on unless the admin explicitly set 0.
  let persistent: number | undefined;
  if (merged.persistent != null && String(merged.persistent).trim() !== "") {
    persistent = Number(merged.persistent) !== 0 ? 1 : 0;
  } else if (templateEarly) {
    persistent = 1;
  }

  const lines: string[] = [
    `// Generated by A3Panel`,
    `hostname = "${escStr(hostname)}";`,
    `maxPlayers = ${Number.isFinite(maxPlayers) ? maxPlayers : 32};`,
    `password = "${escStr(password)}";`,
    `passwordAdmin = "${escStr(passwordAdmin)}";`,
    `serverCommandPassword = "${escStr(serverCommandPassword)}";`,
    `verifySignatures = ${Number.isFinite(verifySignatures) ? verifySignatures : 2};`,
    `BattlEye = ${Number.isFinite(battlEye) ? battlEye : 1};`,
    `steamProtocolMaxDataSize = ${steamProtocolMaxDataSize};`,
    `autoSelectMission = ${autoSelectMission ? 1 : 0};`,
  ];
  if (persistent != null) {
    lines.push(`persistent = ${persistent};`);
  }

  // --- Networking (server.cfg) ---
  const upnp = pickFirst(merged, ["upnp"]);
  if (upnp != null) lines.push(`upnp = ${Number(upnp) !== 0 ? 1 : 0};`);

  const kickDuplicate = pickFirst(merged, ["kickDuplicate"]);
  if (kickDuplicate != null) lines.push(`kickDuplicate = ${Number(kickDuplicate) !== 0 ? 1 : 0};`);

  const disconnectTimeout = optionalNumber(pickFirst(merged, ["DisconnectTimeout"]));
  if (disconnectTimeout != null) {
    lines.push(`DisconnectTimeout = ${Math.min(90, Math.max(1, Math.floor(disconnectTimeout)))};`);
  }

  const maxPing = optionalNumber(pickFirst(merged, ["MaxPing"]));
  if (maxPing != null) lines.push(`MaxPing = ${Math.floor(maxPing)};`);

  const maxPacketLoss = optionalNumber(pickFirst(merged, ["MaxPacketLoss"]));
  if (maxPacketLoss != null) lines.push(`MaxPacketLoss = ${Math.floor(maxPacketLoss)};`);

  const maxDesync = optionalNumber(pickFirst(merged, ["MaxDesync"]));
  if (maxDesync != null) lines.push(`MaxDesync = ${Math.floor(maxDesync)};`);

  const kickSlow = normalizeKickClientsOnSlowNetwork(pickFirst(merged, ["kickClientsOnSlowNetwork"]));
  if (kickSlow) {
    lines.push(`kickClientsOnSlowNetwork[] = {${kickSlow.join(", ")}};`);
  }

  const disableVoN = pickFirst(merged, ["disableVoN"]);
  if (disableVoN != null) lines.push(`disableVoN = ${Number(disableVoN) !== 0 ? 1 : 0};`);

  const vonCodecQuality = optionalNumber(pickFirst(merged, ["vonCodecQuality"]));
  if (vonCodecQuality != null) {
    lines.push(`vonCodecQuality = ${Math.min(30, Math.max(1, Math.floor(vonCodecQuality)))};`);
  }

  const vonCodec = optionalNumber(pickFirst(merged, ["vonCodec"]));
  if (vonCodec != null) lines.push(`vonCodec = ${vonCodec !== 0 ? 1 : 0};`);

  // persistent already emitted above when set / inferred from mission template

  if (admins.length) {
    lines.push(`admins[] = {${admins.map((id) => `"${escStr(id)}"`).join(", ")}};`);
  }

  if (forcedDifficulty) {
    lines.push(`forcedDifficulty = "${escStr(forcedDifficulty)}";`);
  }

  const skip = new Set([
    "hostname",
    "maxPlayers",
    "maxplayers",
    "password",
    "passwordAdmin",
    "passwordadmin",
    "serverCommandPassword",
    "servercommandpassword",
    "verifySignatures",
    "verifysignatures",
    "battlEye",
    "BattlEye",
    "steamProtocolMaxDataSize",
    "autoSelectMission",
    "forcedDifficulty",
    "admins",
    "adminIds",
    // Networking (emitted above with BI casing)
    "upnp",
    "kickDuplicate",
    "kickduplicate",
    "DisconnectTimeout",
    "disconnectTimeout",
    "MaxPing",
    "maxPing",
    "MaxPacketLoss",
    "maxPacketLoss",
    "MaxDesync",
    "maxDesync",
    "kickClientsOnSlowNetwork",
    "kickClientsOnSlowNetwork[]",
    "disableVoN",
    "vonCodecQuality",
    "vonCodec",
    "persistent",
    // Injected separately
    "Missions",
    "missionTemplate",
    "missionDifficulty",
  ]);

  for (const [k, v] of Object.entries(merged)) {
    if (skip.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      const items = v.map((x) => {
        if (typeof x === "number" || typeof x === "boolean") return String(x);
        return `"${escStr(String(x))}"`;
      });
      // Arma array form: key[] = { ... };
      const key = k.endsWith("[]") ? k.slice(0, -2) : k;
      lines.push(`${key}[] = {${items.join(", ")}};`);
    } else if (typeof v === "string") {
      if (!v.trim() && ["motd"].includes(k)) continue;
      lines.push(`${k} = "${escStr(v)}";`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k} = ${v};`);
    } else if (typeof v === "object") {
      // Skip nested objects except we handle Missions below
      continue;
    }
  }

  const template = String(opts.missionTemplate || merged.missionTemplate || "").trim();
  if (template) {
    const diff =
      normalizeForcedDifficulty(opts.missionDifficulty || merged.missionDifficulty || forcedDifficulty) ||
      "Regular";
    const cls = missionClassName(template);
    lines.push("");
    lines.push("class Missions");
    lines.push("{");
    lines.push(`\tclass ${cls}`);
    lines.push("\t{");
    lines.push(`\t\ttemplate = "${escStr(template)}";`);
    lines.push(`\t\tdifficulty = "${escStr(diff)}";`);
    lines.push("\t};");
    lines.push("};");
  }

  return lines.join("\n") + "\n";
}
