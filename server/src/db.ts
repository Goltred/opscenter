import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { migrateGlobalLibraries } from "./migrateGlobalLibraries.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  mfa_secret TEXT NOT NULL DEFAULT '',
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  mfa_pending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, role_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cert_fingerprint TEXT NOT NULL DEFAULT '',
  enroll_token TEXT NOT NULL DEFAULT '',
  arma_root TEXT NOT NULL DEFAULT 'C:\\\\arma3server',
  mods_library_path TEXT NOT NULL DEFAULT '',
  advertise_host TEXT NOT NULL DEFAULT '',
  allow_reboot INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 2302,
  profile_dir TEXT NOT NULL DEFAULT 'profiles',
  current_profile_id TEXT,
  state TEXT NOT NULL DEFAULT 'stopped',
  shared_server_cfg TEXT NOT NULL DEFAULT '{}',
  shared_cfg_version INTEGER NOT NULL DEFAULT 1,
  shared_cfg_preset_id TEXT,
  headless_count INTEGER NOT NULL DEFAULT 0,
  remote_hc_ips TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mods (
  id TEXT PRIMARY KEY,
  workshop_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'client',
  bikeys TEXT NOT NULL DEFAULT '[]',
  preview_url TEXT NOT NULL DEFAULT '',
  workshop_title TEXT NOT NULL DEFAULT '',
  workshop_fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS modlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_filename TEXT NOT NULL DEFAULT '',
  entries TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pbo_filename TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  stored_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_profiles (
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
  recommended_headless_count INTEGER,
  resolved_client_mods TEXT NOT NULL DEFAULT '[]',
  resolved_server_mods TEXT NOT NULL DEFAULT '[]',
  resolved_mods_at TEXT,
  resolved_mods_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shared_cfg_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  server_cfg TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES mission_profiles(id) ON DELETE CASCADE,
  instance_id TEXT REFERENCES instances(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  run_at TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none',
  reminder_offsets TEXT NOT NULL DEFAULT '[60,15]',
  discord_channel TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'scheduled',
  approved_by TEXT,
  reminder_message_id TEXT NOT NULL DEFAULT '',
  last_fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  host_id TEXT,
  instance_id TEXT,
  profile_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '[]',
  error TEXT NOT NULL DEFAULT '',
  requested_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  uploader_id TEXT,
  section TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  detected_type TEXT NOT NULL DEFAULT '',
  validation_state TEXT NOT NULL DEFAULT 'quarantined',
  reject_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS steam_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  enc_password TEXT NOT NULL DEFAULT '',
  guard_cached INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_email TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_profile_revisions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES mission_profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile_id, version)
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
`;

export type Db = Database.Database;

let db: Db;

export function getDb(): Db {
  if (!db) throw new Error("database not opened");
  return db;
}

export function openDb(): Db {
  const file = config.databaseUrl.replace(/^file:/, "").split("?")[0];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}

function migrateSchema(database: Db) {
  const profileCols = database.prepare("PRAGMA table_info(mission_profiles)").all() as { name: string }[];
  if (profileCols.length && !profileCols.some((c) => c.name === "modlist_id")) {
    database.exec("ALTER TABLE mission_profiles ADD COLUMN modlist_id TEXT REFERENCES modlists(id) ON DELETE SET NULL");
  }
  if (profileCols.length && !profileCols.some((c) => c.name === "custom_difficulty")) {
    database.exec("ALTER TABLE mission_profiles ADD COLUMN custom_difficulty TEXT NOT NULL DEFAULT '{}'");
  }
  if (profileCols.length && !profileCols.some((c) => c.name === "dlcs")) {
    database.exec("ALTER TABLE mission_profiles ADD COLUMN dlcs TEXT NOT NULL DEFAULT '[]'");
  }
  if (profileCols.length && !profileCols.some((c) => c.name === "resolved_client_mods")) {
    database.exec("ALTER TABLE mission_profiles ADD COLUMN resolved_client_mods TEXT NOT NULL DEFAULT '[]'");
  }
  if (profileCols.length && !profileCols.some((c) => c.name === "resolved_server_mods")) {
    database.exec("ALTER TABLE mission_profiles ADD COLUMN resolved_server_mods TEXT NOT NULL DEFAULT '[]'");
  }
  if (profileCols.length && !profileCols.some((c) => c.name === "resolved_mods_at")) {
    database.exec("ALTER TABLE mission_profiles ADD COLUMN resolved_mods_at TEXT");
  }
  if (profileCols.length && !profileCols.some((c) => c.name === "resolved_mods_hash")) {
    database.exec("ALTER TABLE mission_profiles ADD COLUMN resolved_mods_hash TEXT NOT NULL DEFAULT ''");
  }
  if (profileCols.length && !profileCols.some((c) => c.name === "recommended_headless_count")) {
    database.exec("ALTER TABLE mission_profiles ADD COLUMN recommended_headless_count INTEGER");
  }

  const userCols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (userCols.length && !userCols.some((c) => c.name === "approved")) {
    database.exec("ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 0");
    // Existing password-era users keep access until an Owner migrates them to OAuth.
    database.exec("UPDATE users SET approved = 1 WHERE password_hash IS NOT NULL AND password_hash != ''");
  }

  database.exec(`
CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);
`);

  const modCols = database.prepare("PRAGMA table_info(mods)").all() as { name: string }[];
  if (modCols.length) {
    if (!modCols.some((c) => c.name === "preview_url")) {
      database.exec("ALTER TABLE mods ADD COLUMN preview_url TEXT NOT NULL DEFAULT ''");
    }
    if (!modCols.some((c) => c.name === "workshop_title")) {
      database.exec("ALTER TABLE mods ADD COLUMN workshop_title TEXT NOT NULL DEFAULT ''");
    }
    if (!modCols.some((c) => c.name === "workshop_deps")) {
      database.exec("ALTER TABLE mods ADD COLUMN workshop_deps TEXT NOT NULL DEFAULT '[]'");
    }
    if (!modCols.some((c) => c.name === "workshop_deps_fetched_at")) {
      database.exec("ALTER TABLE mods ADD COLUMN workshop_deps_fetched_at TEXT");
    }
  }

  const missionCols = database.prepare("PRAGMA table_info(missions)").all() as { name: string }[];
  if (missionCols.length && !missionCols.some((c) => c.name === "stored_path")) {
    database.exec("ALTER TABLE missions ADD COLUMN stored_path TEXT NOT NULL DEFAULT ''");
  }
  dedupeMissionsByPbo(database);
  try {
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_pbo_filename ON missions(pbo_filename)");
  } catch (e) {
    console.warn("missions unique index", e);
  }

  const hostCols = database.prepare("PRAGMA table_info(hosts)").all() as { name: string }[];
  if (hostCols.length && !hostCols.some((c) => c.name === "mods_library_path")) {
    database.exec("ALTER TABLE hosts ADD COLUMN mods_library_path TEXT NOT NULL DEFAULT ''");
  }
  if (hostCols.length && !hostCols.some((c) => c.name === "advertise_host")) {
    database.exec("ALTER TABLE hosts ADD COLUMN advertise_host TEXT NOT NULL DEFAULT ''");
  }
  // Panel no longer offers host reboot — clear any previously enabled flags.
  try {
    database.exec("UPDATE hosts SET allow_reboot = 0 WHERE allow_reboot != 0");
  } catch {
    /* older DBs without column */
  }

  const instanceCols = database.prepare("PRAGMA table_info(instances)").all() as { name: string }[];
  if (instanceCols.length && !instanceCols.some((c) => c.name === "shared_server_cfg")) {
    database.exec("ALTER TABLE instances ADD COLUMN shared_server_cfg TEXT NOT NULL DEFAULT '{}'");
  }
  if (instanceCols.length && !instanceCols.some((c) => c.name === "shared_cfg_version")) {
    database.exec("ALTER TABLE instances ADD COLUMN shared_cfg_version INTEGER NOT NULL DEFAULT 1");
  }
  if (instanceCols.length && !instanceCols.some((c) => c.name === "headless_count")) {
    database.exec("ALTER TABLE instances ADD COLUMN headless_count INTEGER NOT NULL DEFAULT 0");
  }
  if (instanceCols.length && !instanceCols.some((c) => c.name === "remote_hc_ips")) {
    database.exec("ALTER TABLE instances ADD COLUMN remote_hc_ips TEXT NOT NULL DEFAULT '[]'");
  }

  database.exec(`
CREATE TABLE IF NOT EXISTS hc_groups (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  desired_count INTEGER NOT NULL DEFAULT 0,
  target_instance_id TEXT REFERENCES instances(id) ON DELETE SET NULL,
  profile_dir TEXT NOT NULL DEFAULT '',
  connect_host TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hc_groups_host ON hc_groups(host_id);
CREATE INDEX IF NOT EXISTS idx_hc_groups_target ON hc_groups(target_instance_id);
`);

  database.exec(`
CREATE TABLE IF NOT EXISTS mission_profile_revisions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES mission_profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile_id, version)
);
CREATE INDEX IF NOT EXISTS idx_profile_revisions_profile ON mission_profile_revisions(profile_id, version DESC);
`);

  // Legacy table kept only so migrateGlobalLibraries can copy history once.
  database.exec(`
CREATE TABLE IF NOT EXISTS instance_shared_cfg_revisions (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(instance_id, version)
);
`);

  migrateGlobalLibraries(database);
}

/** Keep newest row per pbo_filename; re-point profiles; drop duplicates. */
function dedupeMissionsByPbo(database: Db) {
  const rows = database
    .prepare("SELECT id, pbo_filename, created_at FROM missions ORDER BY datetime(created_at) DESC, rowid DESC")
    .all() as { id: string; pbo_filename: string; created_at: string }[];
  const keepByPbo = new Map<string, string>();
  const remove: { oldId: string; keepId: string }[] = [];
  for (const r of rows) {
    const key = String(r.pbo_filename || "").trim().toLowerCase();
    if (!key) continue;
    const keepId = keepByPbo.get(key);
    if (!keepId) keepByPbo.set(key, r.id);
    else remove.push({ oldId: r.id, keepId });
  }
  if (!remove.length) return;
  const upd = database.prepare("UPDATE mission_profiles SET mission_id = ? WHERE mission_id = ?");
  const del = database.prepare("DELETE FROM missions WHERE id = ?");
  const tx = database.transaction(() => {
    for (const { oldId, keepId } of remove) {
      upd.run(keepId, oldId);
      del.run(oldId);
    }
  });
  tx();
}

export function jsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
