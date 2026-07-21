/**
 * One-time / idempotent migrations to make mission profiles and shared
 * server.cfg libraries global (reusable across instances).
 */
import { v4 as uuid } from "uuid";
import type Database from "better-sqlite3";

type Db = Database.Database;

function tableHasColumn(database: Db, table: string, column: string): boolean {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function tableExists(database: Db, table: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { name?: string } | undefined;
  return !!row?.name;
}

export function migrateGlobalLibraries(database: Db): void {
  database.exec(`
CREATE TABLE IF NOT EXISTS shared_cfg_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  server_cfg TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shared_cfg_preset_revisions (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES shared_cfg_presets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(preset_id, version)
);
CREATE INDEX IF NOT EXISTS idx_shared_cfg_preset_revisions ON shared_cfg_preset_revisions(preset_id, version DESC);
`);

  if (tableExists(database, "instances") && !tableHasColumn(database, "instances", "shared_cfg_preset_id")) {
    database.exec("ALTER TABLE instances ADD COLUMN shared_cfg_preset_id TEXT REFERENCES shared_cfg_presets(id) ON DELETE SET NULL");
  }

  // Promote per-instance shared_server_cfg blobs into named presets (once).
  if (tableExists(database, "instances") && tableHasColumn(database, "instances", "shared_server_cfg")) {
    const instances = database
      .prepare("SELECT id, name, shared_server_cfg, shared_cfg_version, shared_cfg_preset_id FROM instances")
      .all() as {
      id: string;
      name: string;
      shared_server_cfg: string;
      shared_cfg_version: number;
      shared_cfg_preset_id: string | null;
    }[];

    const emptyKey = "{}";
    let defaultEmptyId: string | null = null;
    const insertPreset = database.prepare(
      `INSERT INTO shared_cfg_presets(id, name, version, server_cfg, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    );
    const link = database.prepare("UPDATE instances SET shared_cfg_preset_id = ? WHERE id = ?");
    const insertRev = database.prepare(
      `INSERT OR IGNORE INTO shared_cfg_preset_revisions(id, preset_id, version, snapshot, actor_email, note, created_at)
       VALUES (?, ?, ?, ?, '', 'Migrated', datetime('now'))`,
    );

    for (const inst of instances) {
      if (inst.shared_cfg_preset_id) continue;
      const cfgRaw = String(inst.shared_server_cfg || "{}").trim() || "{}";
      let normalized = "{}";
      try {
        normalized = JSON.stringify(JSON.parse(cfgRaw));
      } catch {
        normalized = cfgRaw;
      }
      const ver = Number(inst.shared_cfg_version) || 1;

      if (normalized === emptyKey) {
        if (!defaultEmptyId) {
          const existing = database
            .prepare("SELECT id FROM shared_cfg_presets WHERE name = ? AND server_cfg = ?")
            .get("Default", emptyKey) as { id: string } | undefined;
          if (existing) defaultEmptyId = existing.id;
          else {
            defaultEmptyId = uuid();
            insertPreset.run(defaultEmptyId, "Default", 1, emptyKey);
            insertRev.run(uuid(), defaultEmptyId, 1, emptyKey);
          }
        }
        link.run(defaultEmptyId, inst.id);
        continue;
      }

      const presetId = uuid();
      const name = `${inst.name} settings`;
      insertPreset.run(presetId, name, ver, normalized);
      insertRev.run(uuid(), presetId, ver, normalized);
      link.run(presetId, inst.id);

      // Best-effort: copy old instance revisions onto the new preset.
      if (tableExists(database, "instance_shared_cfg_revisions")) {
        const oldRevs = database
          .prepare(
            `SELECT version, snapshot, actor_id, actor_email, note, created_at
             FROM instance_shared_cfg_revisions WHERE instance_id = ?`,
          )
          .all(inst.id) as Record<string, unknown>[];
        const copy = database.prepare(
          `INSERT OR IGNORE INTO shared_cfg_preset_revisions(id, preset_id, version, snapshot, actor_id, actor_email, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const r of oldRevs) {
          copy.run(
            uuid(),
            presetId,
            Number(r.version) || 1,
            String(r.snapshot || normalized),
            r.actor_id || null,
            String(r.actor_email || ""),
            String(r.note || "Migrated"),
            String(r.created_at || new Date().toISOString()),
          );
        }
      }
    }
  }

  // Schedules need an explicit target instance once profiles are global.
  if (tableExists(database, "schedules") && !tableHasColumn(database, "schedules", "instance_id")) {
    database.exec("ALTER TABLE schedules ADD COLUMN instance_id TEXT REFERENCES instances(id) ON DELETE CASCADE");
    if (tableHasColumn(database, "mission_profiles", "instance_id")) {
      database.exec(`
        UPDATE schedules
        SET instance_id = (
          SELECT mission_profiles.instance_id FROM mission_profiles
          WHERE mission_profiles.id = schedules.profile_id
        )
        WHERE instance_id IS NULL
      `);
    }
  }

  // Drop mission_profiles.instance_id (requires table rebuild in SQLite).
  if (tableExists(database, "mission_profiles") && tableHasColumn(database, "mission_profiles", "instance_id")) {
    database.exec(`
CREATE TABLE IF NOT EXISTS mission_profiles_global (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  mods TEXT NOT NULL DEFAULT '[]',
  server_mods TEXT NOT NULL DEFAULT '[]',
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  modlist_id TEXT REFERENCES modlists(id) ON DELETE SET NULL,
  server_cfg_overrides TEXT NOT NULL DEFAULT '{}',
  basic_cfg_overrides TEXT NOT NULL DEFAULT '{}',
  extra_args TEXT NOT NULL DEFAULT '[]',
  custom_difficulty TEXT NOT NULL DEFAULT '{}',
  dlcs TEXT NOT NULL DEFAULT '[]',
  resolved_client_mods TEXT NOT NULL DEFAULT '[]',
  resolved_server_mods TEXT NOT NULL DEFAULT '[]',
  resolved_mods_at TEXT,
  resolved_mods_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
    // Disable FKs briefly so we can rebuild the referenced table.
    database.pragma("foreign_keys = OFF");
    database.exec(`
INSERT INTO mission_profiles_global(
  id, name, version, mods, server_mods, mission_id, modlist_id,
  server_cfg_overrides, basic_cfg_overrides, extra_args, custom_difficulty, dlcs,
  resolved_client_mods, resolved_server_mods, resolved_mods_at, resolved_mods_hash,
  created_at, updated_at
)
SELECT
  id, name, version, mods, server_mods, mission_id, modlist_id,
  server_cfg_overrides, basic_cfg_overrides, extra_args, custom_difficulty, dlcs,
  resolved_client_mods, resolved_server_mods, resolved_mods_at, resolved_mods_hash,
  created_at, updated_at
FROM mission_profiles;

DROP TABLE mission_profiles;
ALTER TABLE mission_profiles_global RENAME TO mission_profiles;
`);
    database.pragma("foreign_keys = ON");
  }

  collapseSharedCfgToSingleton(database);
}

/** Keep exactly one shared settings row; profile apply always merges that set. */
function collapseSharedCfgToSingleton(database: Db): void {
  if (!tableExists(database, "shared_cfg_presets")) return;

  const presets = database
    .prepare("SELECT id, name, version, server_cfg, created_at FROM shared_cfg_presets ORDER BY rowid")
    .all() as {
    id: string;
    name: string;
    version: number;
    server_cfg: string;
    created_at: string;
  }[];

  if (presets.length === 0) {
    const id = uuid();
    database
      .prepare(
        `INSERT INTO shared_cfg_presets(id, name, version, server_cfg, created_at, updated_at)
         VALUES (?, 'Shared settings', 1, '{}', datetime('now'), datetime('now'))`,
      )
      .run(id);
    database
      .prepare(
        `INSERT OR IGNORE INTO shared_cfg_preset_revisions(id, preset_id, version, snapshot, actor_email, note, created_at)
         VALUES (?, ?, 1, '{}', '', 'Created', datetime('now'))`,
      )
      .run(uuid(), id);
    return;
  }

  if (presets.length === 1) {
    // Normalize display name; keep existing cfg.
    if (presets[0].name !== "Shared settings") {
      database.prepare("UPDATE shared_cfg_presets SET name = ? WHERE id = ?").run("Shared settings", presets[0].id);
    }
    return;
  }

  const byName = presets.find((p) => p.name.toLowerCase() === "default" || p.name.toLowerCase() === "shared settings");
  let keepId = byName?.id;
  if (!keepId && tableHasColumn(database, "instances", "shared_cfg_preset_id")) {
    const counts = database
      .prepare(
        `SELECT shared_cfg_preset_id AS id, COUNT(*) AS c
         FROM instances
         WHERE shared_cfg_preset_id IS NOT NULL
         GROUP BY shared_cfg_preset_id
         ORDER BY c DESC`,
      )
      .all() as { id: string; c: number }[];
    if (counts[0]?.id && presets.some((p) => p.id === counts[0].id)) keepId = counts[0].id;
  }
  if (!keepId) keepId = presets[0].id;

  const del = database.prepare("DELETE FROM shared_cfg_presets WHERE id = ?");
  for (const p of presets) {
    if (p.id !== keepId) del.run(p.id);
  }
  database.prepare("UPDATE shared_cfg_presets SET name = ? WHERE id = ?").run("Shared settings", keepId);

  // Instance links are unused once settings are global; clear them.
  if (tableHasColumn(database, "instances", "shared_cfg_preset_id")) {
    database.prepare("UPDATE instances SET shared_cfg_preset_id = NULL").run();
  }
}
