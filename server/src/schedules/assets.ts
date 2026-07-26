import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { parseArmaModlistHtml } from "../modlist/parseArmaModlistHtml.js";

/** Download a Discord attachment URL into the mission library and create/update a mission row. */
export async function ingestMissionPboFromUrl(
  url: string,
  filename: string,
): Promise<{ missionId: string; pboFilename: string }> {
  const name = path.basename(String(filename || "mission.pbo"));
  if (!/\.pbo$/i.test(name)) throw new Error("mission file must be a .pbo");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to download .pbo (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const missionsDir = path.join(config.repoRoot, "deploy", "missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  const existing = getDb()
    .prepare("SELECT id, stored_path FROM missions WHERE lower(pbo_filename) = lower(?)")
    .get(name) as { id: string; stored_path: string } | undefined;
  const missionId = existing?.id || uuid();
  const dest = path.join(missionsDir, `${missionId}-${name}`);
  fs.writeFileSync(dest, buf);
  if (existing?.stored_path && existing.stored_path !== dest && fs.existsSync(existing.stored_path)) {
    try {
      fs.unlinkSync(existing.stored_path);
    } catch {
      /* ignore */
    }
  }
  if (existing) {
    getDb()
      .prepare(`UPDATE missions SET name=?, pbo_filename=?, content_hash=?, stored_path=? WHERE id=?`)
      .run(name, name, hash, dest, missionId);
  } else {
    getDb()
      .prepare("INSERT INTO missions(id, name, pbo_filename, content_hash, stored_path) VALUES (?, ?, ?, ?, ?)")
      .run(missionId, name, name, hash, dest);
  }
  return { missionId, pboFilename: name };
}

export async function ingestModlistFromUrl(url: string, filenameHint = "modlist.html"): Promise<{
  modlistId: string;
  clientIds: string[];
  serverIds: string[];
}> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to download modlist (${r.status})`);
  const text = await r.text();
  const entries = parseArmaModlistHtml(text);
  if (!entries.length) throw new Error("no workshop mods found in modlist");
  const clientIds: string[] = [];
  const serverIds: string[] = [];
  for (const e of entries) {
    const id = String(e.workshopId || "").trim();
    if (!/^\d+$/.test(id)) continue;
    if (e.kind === "server") serverIds.push(id);
    else clientIds.push(id);
    const existing = getDb().prepare("SELECT id FROM mods WHERE workshop_id = ?").get(id) as
      | { id: string }
      | undefined;
    const mid = existing?.id || uuid();
    getDb()
      .prepare(
        `INSERT INTO mods(id, workshop_id, name, kind, bikeys) VALUES (?, ?, ?, ?, '[]')
         ON CONFLICT(workshop_id) DO UPDATE SET kind=excluded.kind`,
      )
      .run(mid, id, e.name || id, e.kind === "server" ? "server" : "client");
  }
  const modlistId = uuid();
  getDb()
    .prepare(
      `INSERT INTO modlists(id, name, source_filename, entries) VALUES (?, ?, ?, ?)`,
    )
    .run(
      modlistId,
      `Discord ${new Date().toISOString().slice(0, 10)}`,
      path.basename(filenameHint),
      JSON.stringify(
        entries.map((e) => ({
          workshopId: e.workshopId,
          name: e.name,
          kind: e.kind === "server" ? "server" : "client",
        })),
      ),
    );
  return { modlistId, clientIds: [...new Set(clientIds)], serverIds: [...new Set(serverIds)] };
}

export function createProfileFromAssets(opts: {
  name: string;
  missionId: string;
  modlistId: string;
  clientIds: string[];
  serverIds: string[];
}): string {
  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO mission_profiles(id, name, version, mods, server_mods, mission_id, mission_source, mission_template, modlist_id, difficulty_preset_id, server_cfg_overrides, basic_cfg_overrides, extra_args, custom_difficulty, dlcs, recommended_headless_count)
       VALUES (?, ?, 1, ?, ?, ?, 'library', '', ?, NULL, '{}', '{}', '[]', NULL, '[]', NULL)`,
    )
    .run(
      id,
      opts.name,
      JSON.stringify(opts.clientIds),
      JSON.stringify(opts.serverIds),
      opts.missionId,
      opts.modlistId,
    );
  return id;
}
