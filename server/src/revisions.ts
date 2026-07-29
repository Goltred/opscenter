import { v4 as uuid } from "uuid";
import { getDb, jsonParse } from "./db.js";
import { normalizeCustomDifficulty, normalizeForcedDifficulty } from "./arma/difficulty.js";
import { normalizeDlcCodes } from "./arma/dlcs.js";
import { clampHeadlessCount } from "./arma/headless.js";
import {
  normalizeMissionSource,
  normalizeMissionTemplateInput,
  type MissionSource,
} from "./arma/serverCfg.js";

export const REVISION_KEEP = 50;

export type RevisionActor = { id?: string | null; email?: string | null };

export type ProfileSnapshot = {
  name: string;
  mods: string[];
  serverMods: string[];
  missionSource: MissionSource;
  missionId: string | null;
  missionTemplate: string;
  modlistId: string | null;
  difficultyPresetId: string | null;
  serverCfgOverrides: Record<string, unknown>;
  basicCfgOverrides: Record<string, unknown>;
  extraArgs: string[];
  customDifficulty: ReturnType<typeof normalizeCustomDifficulty>;
  dlcs: string[];
  /** Soft hint for operators; null = unset. */
  recommendedHeadlessCount: number | null;
};

export type SharedCfgSnapshot = Record<string, unknown>;

export type DifficultyPresetSnapshot = {
  name: string;
  difficulty: ReturnType<typeof normalizeCustomDifficulty>;
};

export type RevisionMeta = {
  id: string;
  version: number;
  actorId?: string;
  actorEmail: string;
  note: string;
  createdAt: string;
};

export type RevisionDetail<T> = RevisionMeta & { snapshot: T };

function actorFields(actor?: RevisionActor) {
  return {
    actorId: actor?.id || null,
    actorEmail: String(actor?.email || "").trim(),
  };
}

export function profileSnapshotFromRow(row: Record<string, unknown>): ProfileSnapshot {
  const overrides = jsonParse<Record<string, unknown>>(String(row.server_cfg_overrides || "{}"), {});
  const forced = normalizeForcedDifficulty(overrides.forcedDifficulty);
  if (forced) overrides.forcedDifficulty = forced;
  else delete overrides.forcedDifficulty;
  const missionSource = normalizeMissionSource(row.mission_source);
  return {
    name: String(row.name || ""),
    mods: jsonParse<string[]>(String(row.mods || "[]"), []),
    serverMods: jsonParse<string[]>(String(row.server_mods || "[]"), []),
    missionSource,
    missionId: missionSource === "library" && row.mission_id ? String(row.mission_id) : null,
    missionTemplate: missionSource === "mod" ? normalizeMissionTemplateInput(row.mission_template) : "",
    modlistId: row.modlist_id ? String(row.modlist_id) : null,
    difficultyPresetId: row.difficulty_preset_id ? String(row.difficulty_preset_id) : null,
    serverCfgOverrides: overrides,
    basicCfgOverrides: jsonParse(String(row.basic_cfg_overrides || "{}"), {}),
    extraArgs: jsonParse<string[]>(String(row.extra_args || "[]"), []),
    customDifficulty: normalizeCustomDifficulty(jsonParse(String(row.custom_difficulty || "{}"), {})),
    dlcs: normalizeDlcCodes(jsonParse(String(row.dlcs || "[]"), [])),
    recommendedHeadlessCount:
      row.recommended_headless_count == null || row.recommended_headless_count === ""
        ? null
        : clampHeadlessCount(row.recommended_headless_count),
  };
}

export function profileSnapshotFromBody(b: Record<string, unknown>): ProfileSnapshot {
  const overrides = { ...((b.serverCfgOverrides as Record<string, unknown>) || {}) };
  // Shared-settings-only keys — never store as profile overrides
  for (const k of [
    "password",
    "passwordAdmin",
    "passwordadmin",
    "serverCommandPassword",
    "servercommandpassword",
    "admins",
    "adminIds",
  ]) {
    delete overrides[k];
  }
  const forced = normalizeForcedDifficulty(overrides.forcedDifficulty);
  if (forced) overrides.forcedDifficulty = forced;
  else delete overrides.forcedDifficulty;
  const missionSource = normalizeMissionSource(b.missionSource);
  const missionId = missionSource === "library" && b.missionId ? String(b.missionId) : null;
  const missionTemplate =
    missionSource === "mod" ? normalizeMissionTemplateInput(b.missionTemplate) : "";
  return {
    name: String(b.name || ""),
    mods: Array.isArray(b.mods) ? (b.mods as string[]) : [],
    serverMods: Array.isArray(b.serverMods) ? (b.serverMods as string[]) : [],
    missionSource,
    missionId,
    missionTemplate,
    modlistId: b.modlistId ? String(b.modlistId) : null,
    difficultyPresetId: b.difficultyPresetId ? String(b.difficultyPresetId) : null,
    serverCfgOverrides: overrides,
    basicCfgOverrides: (b.basicCfgOverrides as Record<string, unknown>) || {},
    extraArgs: Array.isArray(b.extraArgs) ? (b.extraArgs as string[]) : [],
    customDifficulty: normalizeCustomDifficulty(b.customDifficulty),
    dlcs: normalizeDlcCodes(b.dlcs),
    recommendedHeadlessCount:
      b.recommendedHeadlessCount == null || b.recommendedHeadlessCount === ""
        ? null
        : clampHeadlessCount(b.recommendedHeadlessCount),
  };
}

export function recordProfileRevision(
  profileId: string,
  version: number,
  snapshot: ProfileSnapshot,
  actor?: RevisionActor,
  note = "",
): void {
  const { actorId, actorEmail } = actorFields(actor);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO mission_profile_revisions(id, profile_id, version, snapshot, actor_id, actor_email, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(uuid(), profileId, version, JSON.stringify(snapshot), actorId, actorEmail, note || "");
  pruneProfileRevisions(profileId);
}

function pruneProfileRevisions(profileId: string): void {
  getDb()
    .prepare(
      `DELETE FROM mission_profile_revisions
       WHERE profile_id = ?
         AND id NOT IN (
           SELECT id FROM (
             SELECT id FROM mission_profile_revisions
             WHERE profile_id = ?
             ORDER BY version DESC
             LIMIT ?
           )
         )`,
    )
    .run(profileId, profileId, REVISION_KEEP);
}

export function ensureProfileRevisionBaseline(profileId: string): void {
  const db = getDb();
  const n = db.prepare("SELECT COUNT(*) AS c FROM mission_profile_revisions WHERE profile_id = ?").get(profileId) as {
    c: number;
  };
  if (Number(n?.c) > 0) return;
  const row = db.prepare("SELECT * FROM mission_profiles WHERE id = ?").get(profileId) as Record<string, unknown> | undefined;
  if (!row) return;
  recordProfileRevision(
    profileId,
    Number(row.version) || 1,
    profileSnapshotFromRow(row),
    { email: "" },
    "Baseline",
  );
}

export function listProfileRevisions(profileId: string): RevisionMeta[] {
  ensureProfileRevisionBaseline(profileId);
  const rows = getDb()
    .prepare(
      `SELECT id, version, actor_id, actor_email, note, created_at
       FROM mission_profile_revisions
       WHERE profile_id = ?
       ORDER BY version DESC`,
    )
    .all(profileId) as Record<string, unknown>[];
  return rows.map(revisionMetaDto);
}

export function getProfileRevision(profileId: string, version: number): RevisionDetail<ProfileSnapshot> | null {
  ensureProfileRevisionBaseline(profileId);
  const row = getDb()
    .prepare(
      `SELECT id, version, snapshot, actor_id, actor_email, note, created_at
       FROM mission_profile_revisions
       WHERE profile_id = ? AND version = ?`,
    )
    .get(profileId, version) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...revisionMetaDto(row),
    snapshot: jsonParse<ProfileSnapshot>(String(row.snapshot), profileSnapshotFromRow({})),
  };
}

export function restoreProfileFromRevision(
  profileId: string,
  version: number,
  actor?: RevisionActor,
): { newVersion: number } | { error: string } {
  const rev = getProfileRevision(profileId, version);
  if (!rev) return { error: "revision not found" };
  const row = getDb().prepare("SELECT * FROM mission_profiles WHERE id = ?").get(profileId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { error: "profile not found" };

  const s = rev.snapshot;
  getDb()
    .prepare(
      `UPDATE mission_profiles SET name=?, version=version+1, mods=?, server_mods=?, mission_id=?,
       mission_source=?, mission_template=?, modlist_id=?,
       difficulty_preset_id=?,
       server_cfg_overrides=?, basic_cfg_overrides=?, extra_args=?, custom_difficulty=?, dlcs=?,
       recommended_headless_count=?,
       resolved_client_mods='[]', resolved_server_mods='[]', resolved_mods_at=NULL, resolved_mods_hash='',
       updated_at=datetime('now') WHERE id=?`,
    )
    .run(
      s.name,
      JSON.stringify(s.mods || []),
      JSON.stringify(s.serverMods || []),
      s.missionId || null,
      s.missionSource || "library",
      s.missionTemplate || "",
      s.modlistId || null,
      s.difficultyPresetId || null,
      JSON.stringify(s.serverCfgOverrides || {}),
      JSON.stringify(s.basicCfgOverrides || {}),
      JSON.stringify(s.extraArgs || []),
      JSON.stringify(normalizeCustomDifficulty(s.customDifficulty)),
      JSON.stringify(normalizeDlcCodes(s.dlcs)),
      s.recommendedHeadlessCount,
      profileId,
    );

  const updated = getDb().prepare("SELECT version FROM mission_profiles WHERE id = ?").get(profileId) as {
    version: number;
  };
  const newVersion = Number(updated.version);
  recordProfileRevision(profileId, newVersion, s, actor, `Restored from v${version}`);
  return { newVersion };
}

export function recordSharedCfgRevision(
  presetId: string,
  version: number,
  snapshot: SharedCfgSnapshot,
  actor?: RevisionActor,
  note = "",
): void {
  const { actorId, actorEmail } = actorFields(actor);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO shared_cfg_preset_revisions(id, preset_id, version, snapshot, actor_id, actor_email, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(uuid(), presetId, version, JSON.stringify(snapshot || {}), actorId, actorEmail, note || "");
  pruneSharedCfgRevisions(presetId);
}

function pruneSharedCfgRevisions(presetId: string): void {
  getDb()
    .prepare(
      `DELETE FROM shared_cfg_preset_revisions
       WHERE preset_id = ?
         AND id NOT IN (
           SELECT id FROM (
             SELECT id FROM shared_cfg_preset_revisions
             WHERE preset_id = ?
             ORDER BY version DESC
             LIMIT ?
           )
         )`,
    )
    .run(presetId, presetId, REVISION_KEEP);
}

export function ensureSharedCfgRevisionBaseline(presetId: string): void {
  const db = getDb();
  const n = db.prepare("SELECT COUNT(*) AS c FROM shared_cfg_preset_revisions WHERE preset_id = ?").get(presetId) as {
    c: number;
  };
  if (Number(n?.c) > 0) return;
  const row = db.prepare("SELECT server_cfg, version FROM shared_cfg_presets WHERE id = ?").get(presetId) as
    | { server_cfg: string; version: number }
    | undefined;
  if (!row) return;
  recordSharedCfgRevision(
    presetId,
    Number(row.version) || 1,
    jsonParse<SharedCfgSnapshot>(String(row.server_cfg || "{}"), {}),
    { email: "" },
    "Baseline",
  );
}

export function listSharedCfgRevisions(presetId: string): RevisionMeta[] {
  ensureSharedCfgRevisionBaseline(presetId);
  const rows = getDb()
    .prepare(
      `SELECT id, version, actor_id, actor_email, note, created_at
       FROM shared_cfg_preset_revisions
       WHERE preset_id = ?
       ORDER BY version DESC`,
    )
    .all(presetId) as Record<string, unknown>[];
  return rows.map(revisionMetaDto);
}

export function getSharedCfgRevision(presetId: string, version: number): RevisionDetail<SharedCfgSnapshot> | null {
  ensureSharedCfgRevisionBaseline(presetId);
  const row = getDb()
    .prepare(
      `SELECT id, version, snapshot, actor_id, actor_email, note, created_at
       FROM shared_cfg_preset_revisions
       WHERE preset_id = ? AND version = ?`,
    )
    .get(presetId, version) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...revisionMetaDto(row),
    snapshot: jsonParse<SharedCfgSnapshot>(String(row.snapshot), {}),
  };
}

export function restoreSharedCfgFromRevision(
  presetId: string,
  version: number,
  actor?: RevisionActor,
): { newVersion: number; snapshot: SharedCfgSnapshot } | { error: string } {
  const rev = getSharedCfgRevision(presetId, version);
  if (!rev) return { error: "revision not found" };
  const row = getDb().prepare("SELECT id FROM shared_cfg_presets WHERE id = ?").get(presetId);
  if (!row) return { error: "preset not found" };

  getDb()
    .prepare(
      `UPDATE shared_cfg_presets SET server_cfg=?, version=version+1, updated_at=datetime('now') WHERE id=?`,
    )
    .run(JSON.stringify(rev.snapshot || {}), presetId);

  const updated = getDb().prepare("SELECT version FROM shared_cfg_presets WHERE id = ?").get(presetId) as {
    version: number;
  };
  const newVersion = Number(updated.version);
  recordSharedCfgRevision(presetId, newVersion, rev.snapshot, actor, `Restored from v${version}`);
  return { newVersion, snapshot: rev.snapshot };
}

/** Default shared server.cfg keys for a fresh panel (before the admin edits Shared settings). */
export const DEFAULT_SHARED_SERVER_CFG: Record<string, unknown> = {
  autoSelectMission: 0,
  persistent: 1,
};

/** The single global shared settings row (created on demand). */
export function getOrCreateSharedSettings(): {
  id: string;
  name: string;
  version: number;
  serverCfg: Record<string, unknown>;
} {
  const db = getDb();
  let row = db.prepare("SELECT id, name, version, server_cfg FROM shared_cfg_presets ORDER BY rowid LIMIT 1").get() as
    | { id: string; name: string; version: number; server_cfg: string }
    | undefined;
  if (!row) {
    const id = uuid();
    const seed = { ...DEFAULT_SHARED_SERVER_CFG };
    db.prepare(
      `INSERT INTO shared_cfg_presets(id, name, version, server_cfg, created_at, updated_at)
       VALUES (?, 'Shared settings', 1, ?, datetime('now'), datetime('now'))`,
    ).run(id, JSON.stringify(seed));
    recordSharedCfgRevision(id, 1, seed, undefined, "Created");
    row = { id, name: "Shared settings", version: 1, server_cfg: JSON.stringify(seed) };
  }
  return {
    id: String(row.id),
    name: String(row.name || "Shared settings"),
    version: Number(row.version) || 1,
    serverCfg: jsonParse<Record<string, unknown>>(String(row.server_cfg || "{}"), {}),
  };
}

export function recordDifficultyPresetRevision(
  presetId: string,
  version: number,
  snapshot: DifficultyPresetSnapshot,
  actor?: RevisionActor,
  note = "",
): void {
  const { actorId, actorEmail } = actorFields(actor);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO difficulty_preset_revisions(id, preset_id, version, snapshot, actor_id, actor_email, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(uuid(), presetId, version, JSON.stringify(snapshot || {}), actorId, actorEmail, note || "");
  pruneDifficultyPresetRevisions(presetId);
}

function pruneDifficultyPresetRevisions(presetId: string): void {
  getDb()
    .prepare(
      `DELETE FROM difficulty_preset_revisions
       WHERE preset_id = ?
         AND id NOT IN (
           SELECT id FROM (
             SELECT id FROM difficulty_preset_revisions
             WHERE preset_id = ?
             ORDER BY version DESC
             LIMIT ?
           )
         )`,
    )
    .run(presetId, presetId, REVISION_KEEP);
}

export function ensureDifficultyPresetRevisionBaseline(presetId: string): void {
  const db = getDb();
  const n = db.prepare("SELECT COUNT(*) AS c FROM difficulty_preset_revisions WHERE preset_id = ?").get(presetId) as {
    c: number;
  };
  if (Number(n?.c) > 0) return;
  const row = db.prepare("SELECT name, difficulty, version FROM difficulty_presets WHERE id = ?").get(presetId) as
    | { name: string; difficulty: string; version: number }
    | undefined;
  if (!row) return;
  recordDifficultyPresetRevision(
    presetId,
    Number(row.version) || 1,
    {
      name: String(row.name || ""),
      difficulty: normalizeCustomDifficulty(jsonParse(String(row.difficulty || "{}"), {})),
    },
    { email: "" },
    "Baseline",
  );
}

export function listDifficultyPresetRevisions(presetId: string): RevisionMeta[] {
  ensureDifficultyPresetRevisionBaseline(presetId);
  const rows = getDb()
    .prepare(
      `SELECT id, version, actor_id, actor_email, note, created_at
       FROM difficulty_preset_revisions
       WHERE preset_id = ?
       ORDER BY version DESC`,
    )
    .all(presetId) as Record<string, unknown>[];
  return rows.map(revisionMetaDto);
}

export function getDifficultyPresetRevision(
  presetId: string,
  version: number,
): RevisionDetail<DifficultyPresetSnapshot> | null {
  ensureDifficultyPresetRevisionBaseline(presetId);
  const row = getDb()
    .prepare(
      `SELECT id, version, snapshot, actor_id, actor_email, note, created_at
       FROM difficulty_preset_revisions
       WHERE preset_id = ? AND version = ?`,
    )
    .get(presetId, version) as Record<string, unknown> | undefined;
  if (!row) return null;
  const snap = jsonParse<DifficultyPresetSnapshot>(String(row.snapshot), {
    name: "",
    difficulty: normalizeCustomDifficulty({}),
  });
  return {
    ...revisionMetaDto(row),
    snapshot: {
      name: String(snap.name || ""),
      difficulty: normalizeCustomDifficulty(snap.difficulty),
    },
  };
}

export function restoreDifficultyPresetFromRevision(
  presetId: string,
  version: number,
  actor?: RevisionActor,
): { newVersion: number; snapshot: DifficultyPresetSnapshot } | { error: string } {
  const rev = getDifficultyPresetRevision(presetId, version);
  if (!rev) return { error: "revision not found" };
  const row = getDb().prepare("SELECT id FROM difficulty_presets WHERE id = ?").get(presetId);
  if (!row) return { error: "preset not found" };

  const snap = {
    name: String(rev.snapshot.name || "Custom"),
    difficulty: normalizeCustomDifficulty(rev.snapshot.difficulty),
  };
  getDb()
    .prepare(
      `UPDATE difficulty_presets SET name=?, difficulty=?, version=version+1, updated_at=datetime('now') WHERE id=?`,
    )
    .run(snap.name, JSON.stringify(snap.difficulty), presetId);

  const updated = getDb().prepare("SELECT version FROM difficulty_presets WHERE id = ?").get(presetId) as {
    version: number;
  };
  const newVersion = Number(updated.version);
  recordDifficultyPresetRevision(presetId, newVersion, snap, actor, `Restored from v${version}`);
  return { newVersion, snapshot: snap };
}

/** Shared settings merged under every profile apply (instance links ignored). */
export function resolveInstanceSharedCfg(_inst?: Record<string, unknown>): Record<string, unknown> {
  return getOrCreateSharedSettings().serverCfg;
}

function revisionMetaDto(row: Record<string, unknown>): RevisionMeta {
  return {
    id: String(row.id),
    version: Number(row.version) || 0,
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    actorEmail: String(row.actor_email || ""),
    note: String(row.note || ""),
    createdAt: String(row.created_at || ""),
  };
}

/** Flat key/value changes for a simple compare UI. */
export function diffSnapshots(
  before: Record<string, unknown> | ProfileSnapshot,
  after: Record<string, unknown> | ProfileSnapshot,
): { path: string; before: unknown; after: unknown }[] {
  const a = flatten("", before as Record<string, unknown>);
  const b = flatten("", after as Record<string, unknown>);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const changes: { path: string; before: unknown; after: unknown }[] = [];
  for (const path of keys) {
    const left = a[path];
    const right = b[path];
    if (stableString(left) === stableString(right)) continue;
    changes.push({ path, before: left ?? null, after: right ?? null });
  }
  return changes;
}

function flatten(prefix: string, value: unknown, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value == null || typeof value !== "object") {
    out[prefix || "(root)"] = value;
    return out;
  }
  if (Array.isArray(value)) {
    out[prefix || "(root)"] = value;
    return out;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (!keys.length) {
    out[prefix || "(root)"] = {};
    return out;
  }
  for (const k of keys) {
    const next = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v != null && typeof v === "object" && !Array.isArray(v)) flatten(next, v, out);
    else out[next] = v;
  }
  return out;
}

function stableString(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
