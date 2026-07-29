import { createHash, randomUUID } from "node:crypto";
import { getDb, jsonParse } from "../db.js";
import { config } from "../config.js";

export type WorkshopMeta = {
  workshopId: string;
  title: string;
  previewUrl: string;
};

type SteamPublishedFile = {
  publishedfileid?: string;
  result?: number;
  title?: string;
  preview_url?: string;
  children?: { publishedfileid?: string }[];
};

const BATCH = 50;
/** Titles/previews TTL — expired rows may be refreshed on explicit ensure / force. */
export const META_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Per-mod required-items TTL. */
export const DEPS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Profile-level resolved -mod= list TTL (apply persists; start reuses until expiry). */
export const PROFILE_RESOLVED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEPS_MAX_NODES = 250;

const metaInflight = new Map<string, Promise<Map<string, WorkshopMeta>>>();
const depsBatchInflight = new Map<string, Promise<Map<string, string[]>>>();
const expandInflight = new Map<string, Promise<{ ordered: string[]; added: string[]; roots: string[] }>>();

function isFresh(fetchedAt: string | null | undefined, maxAgeMs: number): boolean {
  if (!fetchedAt) return false;
  const t = Date.parse(fetchedAt.includes("T") ? fetchedAt : fetchedAt.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < maxAgeMs;
}

export function profileModsSourceHash(client: string[], server: string[]): string {
  const payload = JSON.stringify({
    c: [...client].map(String).sort(),
    s: [...server].map(String).sort(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

/**
 * Fetch Steam Workshop titles + preview images via GetPublishedFileDetails.
 * Public POST; batches up to 50 IDs per request.
 */
export async function fetchPublishedFileDetails(ids: string[]): Promise<Map<string, WorkshopMeta>> {
  const out = new Map<string, WorkshopMeta>();
  const unique = [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id)))];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const body = new URLSearchParams();
    body.set("itemcount", String(chunk.length));
    chunk.forEach((id, idx) => body.set(`publishedfileids[${idx}]`, id));

    const res = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      console.warn("steam workshop fetch failed", res.status);
      continue;
    }
    const json = (await res.json()) as {
      response?: { publishedfiledetails?: SteamPublishedFile[] };
    };
    for (const d of json.response?.publishedfiledetails || []) {
      if (!d.publishedfileid || d.result !== 1) continue;
      out.set(d.publishedfileid, {
        workshopId: d.publishedfileid,
        title: (d.title || "").trim(),
        previewUrl: (d.preview_url || "").trim(),
      });
    }
  }
  return out;
}

function persistWorkshopMetaRows(fetched: Map<string, WorkshopMeta>) {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO mods(id, workshop_id, name, kind, bikeys, preview_url, workshop_title, workshop_fetched_at)
     VALUES (?, ?, ?, 'client', '[]', ?, ?, datetime('now'))
     ON CONFLICT(workshop_id) DO UPDATE SET
       preview_url=excluded.preview_url,
       workshop_title=CASE WHEN excluded.workshop_title != '' THEN excluded.workshop_title ELSE mods.workshop_title END,
       name=CASE
         WHEN mods.name = mods.workshop_id OR mods.name = '' THEN COALESCE(NULLIF(excluded.workshop_title,''), mods.name)
         ELSE mods.name
       END,
       workshop_fetched_at=datetime('now')`,
  );
  for (const [id, meta] of fetched) {
    upsert.run(randomUUID(), id, meta.title || id, meta.previewUrl || "", meta.title || "");
  }
}

/**
 * Load cached meta; fetch only missing IDs (or all when force).
 * Expired-but-usable rows are served from DB until force / refreshExpiredWorkshopMeta.
 */
export async function ensureWorkshopMeta(
  ids: string[],
  opts: { force?: boolean; maxAgeMs?: number } = {},
): Promise<Map<string, WorkshopMeta>> {
  const maxAgeMs = opts.maxAgeMs ?? META_MAX_AGE_MS;
  const unique = [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id)))];
  if (!unique.length) return new Map();

  const key = `${opts.force ? "f" : "n"}:${maxAgeMs}:${unique.slice().sort().join(",")}`;
  const existing = metaInflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const db = getDb();
    const result = new Map<string, WorkshopMeta>();
    const needFetch: string[] = [];
    const sel = db.prepare(
      `SELECT workshop_id, name, preview_url, workshop_title, workshop_fetched_at FROM mods WHERE workshop_id = ?`,
    );

    for (const id of unique) {
      if (opts.force) {
        needFetch.push(id);
        continue;
      }
      const row = sel.get(id) as
        | {
            workshop_id: string;
            name: string;
            preview_url: string | null;
            workshop_title: string | null;
            workshop_fetched_at: string | null;
          }
        | undefined;

      const cachedTitle = (row?.workshop_title || row?.name || "").trim();
      const cachedPreview = (row?.preview_url || "").trim();
      const usable = !!(cachedTitle || cachedPreview);

      if (usable) {
        // Fresh or expired: serve cache. No background Steam refresh.
        result.set(id, { workshopId: id, title: cachedTitle || id, previewUrl: cachedPreview });
        void maxAgeMs; // TTL enforced by refreshExpiredWorkshopMeta / force
      } else {
        needFetch.push(id);
      }
    }

    if (needFetch.length) {
      try {
        const fetched = await fetchPublishedFileDetails(needFetch);
        persistWorkshopMetaRows(fetched);
        for (const id of needFetch) {
          const meta = fetched.get(id);
          if (meta) result.set(id, meta);
          else if (!result.has(id)) result.set(id, { workshopId: id, title: id, previewUrl: "" });
        }
      } catch (e) {
        console.warn("ensureWorkshopMeta", e);
      }
    }

    return result;
  })().finally(() => {
    metaInflight.delete(key);
  });

  metaInflight.set(key, promise);
  return promise;
}

/**
 * Like ensureWorkshopMeta but also refreshes rows past TTL (still coalesced / batched).
 * Use for explicit “Refresh titles” UI actions.
 */
export async function refreshExpiredWorkshopMeta(
  ids: string[],
  opts: { maxAgeMs?: number; force?: boolean } = {},
): Promise<Map<string, WorkshopMeta>> {
  const maxAgeMs = opts.maxAgeMs ?? META_MAX_AGE_MS;
  const unique = [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id)))];
  if (!unique.length) return new Map();
  if (opts.force) return ensureWorkshopMeta(unique, { force: true, maxAgeMs });

  const db = getDb();
  const sel = db.prepare(`SELECT workshop_id, workshop_fetched_at, workshop_title, preview_url, name FROM mods WHERE workshop_id = ?`);
  const need: string[] = [];
  const result = new Map<string, WorkshopMeta>();
  for (const id of unique) {
    const row = sel.get(id) as
      | { workshop_fetched_at: string | null; workshop_title: string | null; preview_url: string | null; name: string }
      | undefined;
    const title = (row?.workshop_title || row?.name || "").trim();
    const preview = (row?.preview_url || "").trim();
    if (row && title && isFresh(row.workshop_fetched_at, maxAgeMs)) {
      result.set(id, { workshopId: id, title, previewUrl: preview });
    } else {
      need.push(id);
    }
  }
  if (need.length) {
    const fetched = await ensureWorkshopMeta(need, { force: true, maxAgeMs });
    for (const [id, m] of fetched) result.set(id, m);
  }
  return result;
}

export function workshopUrl(workshopId: string): string {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`;
}

export function readCachedWorkshopMeta(ids: string[]): Map<string, WorkshopMeta> {
  const db = getDb();
  const sel = db.prepare(
    `SELECT workshop_id, name, preview_url, workshop_title FROM mods WHERE workshop_id = ?`,
  );
  const out = new Map<string, WorkshopMeta>();
  for (const id of ids) {
    const row = sel.get(id) as
      | { workshop_id: string; name: string; preview_url: string | null; workshop_title: string | null }
      | undefined;
    if (!row) continue;
    out.set(id, {
      workshopId: id,
      title: (row.workshop_title || row.name || id).trim(),
      previewUrl: (row.preview_url || "").trim(),
    });
  }
  return out;
}

/** Title + Steam Workshop URL. Default: DB only (no Steam). Pass network:true to fill gaps. */
export async function describeWorkshopItems(
  ids: string[],
  opts: { network?: boolean } = {},
): Promise<{ workshopId: string; title: string; workshopUrl: string; line: string }[]> {
  const unique = [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id)))];
  if (!unique.length) return [];
  if (opts.network) {
    const missing = unique.filter((id) => {
      const m = readCachedWorkshopMeta([id]).get(id);
      return !m?.title || m.title === id;
    });
    if (missing.length) await ensureWorkshopMeta(missing).catch(() => {});
  }
  const meta = readCachedWorkshopMeta(unique);
  return unique.map((id) => {
    const title = (meta.get(id)?.title || "").trim() || id;
    const url = workshopUrl(id);
    const line = title !== id ? `${title} (${id}) — ${url}` : `${id} — ${url}`;
    return { workshopId: id, title, workshopUrl: url, line };
  });
}

export function formatWorkshopShortList(ids: string[], opts: { network?: boolean } = {}): Promise<string> {
  return describeWorkshopItems(ids, opts).then((items) => {
    if (!items.length) return "";
    return items
      .map((i) => (i.title && i.title !== i.workshopId ? `${i.title} (${i.workshopId})` : i.workshopId))
      .join(", ");
  });
}

export async function formatWorkshopRefList(ids: string[], opts: { network?: boolean } = {}): Promise<string> {
  const items = await describeWorkshopItems(ids, opts);
  if (!items.length) return "";
  return items.map((i) => `• ${i.line}`).join("\n");
}

export function parseWorkshopId(input: string): string | null {
  const raw = String(input || "").trim();
  if (/^\d+$/.test(raw)) return raw;
  const m = raw.match(/[?&]id=(\d+)/i) || raw.match(/filedetails\/(\d+)/i);
  return m ? m[1] : null;
}

/**
 * Text-search Arma 3 workshop via the public community browse page (no API key).
 * Enriches with one GetPublishedFileDetails batch and persists into the mods cache.
 */
export async function searchWorkshop(query: string, page = 1): Promise<WorkshopMeta[]> {
  const q = String(query || "").trim();
  if (!q) return [];
  const url =
    "https://steamcommunity.com/workshop/browse/?appid=107410" +
    `&searchtext=${encodeURIComponent(q)}` +
    "&browsesort=textsearch&section=readytouseitems&actualsort=textsearch" +
    `&p=${Math.max(1, page)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "OpsCenter/0.1 (workshop search)",
      Accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`workshop search failed (${res.status})`);
  const html = await res.text();

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/sharedfiles\/filedetails\/\?id=(\d+)/gi)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 24) break;
  }

  if (!ids.length) return [];
  const meta = await fetchPublishedFileDetails(ids);
  persistWorkshopMetaRows(meta);
  return ids.map((id) => meta.get(id) || { workshopId: id, title: id, previewUrl: "" }).filter((m) => m.title);
}

function persistWorkshopDeps(id: string, deps: string[]) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM mods WHERE workshop_id = ?").get(id) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE mods SET workshop_deps = ?, workshop_deps_fetched_at = datetime('now') WHERE workshop_id = ?`,
    ).run(JSON.stringify(deps), id);
  } else {
    db.prepare(
      `INSERT INTO mods(id, workshop_id, name, kind, bikeys, workshop_deps, workshop_deps_fetched_at)
       VALUES (?, ?, ?, 'client', '[]', ?, datetime('now'))`,
    ).run(randomUUID(), id, id, JSON.stringify(deps));
  }
}

function readCachedDeps(id: string, maxAgeMs = DEPS_MAX_AGE_MS): string[] | null {
  const row = getDb()
    .prepare(`SELECT workshop_deps, workshop_deps_fetched_at FROM mods WHERE workshop_id = ?`)
    .get(id) as { workshop_deps: string; workshop_deps_fetched_at: string | null } | undefined;
  if (!row?.workshop_deps_fetched_at) return null;
  if (!isFresh(row.workshop_deps_fetched_at, maxAgeMs)) return null;
  // Distinguish "never fetched" from "fetched, empty children" — empty array is valid cache.
  return jsonParse<string[]>(row.workshop_deps, []).filter((x) => /^\d+$/.test(x) && x !== id);
}

function hasDepsCacheRow(id: string): { deps: string[]; fresh: boolean } | null {
  const row = getDb()
    .prepare(`SELECT workshop_deps, workshop_deps_fetched_at FROM mods WHERE workshop_id = ?`)
    .get(id) as { workshop_deps: string; workshop_deps_fetched_at: string | null } | undefined;
  if (!row?.workshop_deps_fetched_at) return null;
  const deps = jsonParse<string[]>(row.workshop_deps, []).filter((x) => /^\d+$/.test(x) && x !== id);
  return { deps, fresh: isFresh(row.workshop_deps_fetched_at, DEPS_MAX_AGE_MS) };
}

/** Batch Steam Web API GetDetails (children). Returns null on transport/API failure. */
async function fetchChildrenViaApiBatch(ids: string[], apiKey: string): Promise<Map<string, string[]> | null> {
  const unique = [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id)))];
  const out = new Map<string, string[]>();
  if (!unique.length) return out;

  try {
    for (let i = 0; i < unique.length; i += BATCH) {
      const chunk = unique.slice(i, i + BATCH);
      const u = new URL("https://api.steampowered.com/IPublishedFileService/GetDetails/v1/");
      u.searchParams.set("key", apiKey);
      chunk.forEach((id, idx) => u.searchParams.set(`publishedfileids[${idx}]`, id));
      u.searchParams.set("includechildren", "true");
      u.searchParams.set("includetags", "false");
      u.searchParams.set("includeadditionalpreviews", "false");
      u.searchParams.set("includekvtags", "false");
      u.searchParams.set("includevotes", "false");
      u.searchParams.set("short_description", "true");
      u.searchParams.set("includeforsaledata", "false");
      u.searchParams.set("includemetadata", "false");
      u.searchParams.set("return_playtime_stats", "0");
      u.searchParams.set("appid", "107410");
      u.searchParams.set("strip_description_bbcode", "true");
      u.searchParams.set("admin_query", "false");
      const res = await fetch(u.toString());
      if (!res.ok) {
        console.warn("workshop children api batch", res.status);
        return null;
      }
      const json = (await res.json()) as {
        response?: { publishedfiledetails?: SteamPublishedFile[] };
      };
      for (const d of json.response?.publishedfiledetails || []) {
        const id = String(d.publishedfileid || "").trim();
        if (!id || (d.result != null && d.result !== 1)) continue;
        out.set(
          id,
          (d.children || [])
            .map((c) => String(c.publishedfileid || "").trim())
            .filter((x) => /^\d+$/.test(x) && x !== id),
        );
      }
      // IDs omitted from response → treat as empty children (valid)
      for (const id of chunk) {
        if (!out.has(id)) out.set(id, []);
      }
    }
    return out;
  } catch (e) {
    console.warn("workshop children api batch", e);
    return null;
  }
}

/** Scrape workshop page “Required items” — last resort when no API key. */
async function fetchChildrenViaHtml(id: string): Promise<string[]> {
  try {
    const res = await fetch(workshopUrl(id), {
      headers: {
        "User-Agent": "OpsCenter/0.1 (workshop deps)",
        Accept: "text/html",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const requiredBlock =
      html.match(/id=["']RequiredItems["'][\s\S]*?(?=<div[^>]+id=["']|$)/i)?.[0] ||
      html.match(/Required items[\s\S]{0,8000}/i)?.[0] ||
      html.match(/requiredItemsContainer[\s\S]{0,8000}/i)?.[0] ||
      "";
    const scope = requiredBlock || "";
    if (!scope) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const m of scope.matchAll(/sharedfiles\/filedetails\/\?id=(\d+)/gi)) {
      const dep = m[1];
      if (dep === id || seen.has(dep)) continue;
      seen.add(dep);
      ids.push(dep);
    }
    return ids;
  } catch (e) {
    console.warn("workshop children html", id, e);
    return [];
  }
}

/**
 * Resolve required items for many IDs (cache → batched API → HTML only if no key / API failed).
 */
export async function getWorkshopDependenciesBatch(
  ids: string[],
  opts: { force?: boolean } = {},
): Promise<Map<string, string[]>> {
  const unique = [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id)))];
  const out = new Map<string, string[]>();
  if (!unique.length) return out;

  const key = `${opts.force ? "f" : "n"}:${unique.slice().sort().join(",")}`;
  const inflight = depsBatchInflight.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const needNetwork: string[] = [];
    for (const id of unique) {
      if (!opts.force) {
        const cached = readCachedDeps(id);
        if (cached) {
          out.set(id, cached);
          continue;
        }
      }
      needNetwork.push(id);
    }

    if (!needNetwork.length) return out;

    const apiKey = config.oauth.steam.apiKey;
    if (apiKey) {
      const fromApi = await fetchChildrenViaApiBatch(needNetwork, apiKey);
      if (fromApi) {
        for (const id of needNetwork) {
          const deps = fromApi.get(id) || [];
          persistWorkshopDeps(id, deps);
          out.set(id, deps);
        }
        return out;
      }
      // API failed — fall through to HTML only for these IDs
    }

    // No API key, or API transport failed: scrape only when no key. Prefer stale cache over empty.
    for (const id of needNetwork) {
      const stale = hasDepsCacheRow(id);
      if (stale && !opts.force) {
        out.set(id, stale.deps);
        continue;
      }
      if (!apiKey) {
        const deps = await fetchChildrenViaHtml(id);
        persistWorkshopDeps(id, deps);
        out.set(id, deps);
      } else {
        // API key set but batch failed — do not HTML-scrape or wipe cache.
        out.set(id, stale?.deps || []);
        console.warn("workshop deps: API failed; using stale/empty for", id);
      }
    }
    return out;
  })().finally(() => {
    depsBatchInflight.delete(key);
  });

  depsBatchInflight.set(key, promise);
  return promise;
}

/** Direct required items for one workshop id (cached). */
export async function getWorkshopDependencies(id: string, opts: { force?: boolean } = {}): Promise<string[]> {
  const map = await getWorkshopDependenciesBatch([id], opts);
  return map.get(String(id)) || [];
}

/**
 * Recursively expand Steam Workshop required items.
 * BFS with batched child fetches. Each ID once; deps before parents.
 */
export async function expandWorkshopDependencies(
  rootIds: string[],
  opts: { force?: boolean } = {},
): Promise<{ ordered: string[]; added: string[]; roots: string[] }> {
  const roots = [...new Set(rootIds.map(String).filter((id) => /^\d+$/.test(id)))];
  const expandKey = `${opts.force ? "f" : "n"}:${roots.slice().sort().join(",")}`;
  const existing = expandInflight.get(expandKey);
  if (existing) return existing;

  const promise = (async () => {
    const childrenOf = new Map<string, string[]>();
    let frontier = [...roots];
    const seen = new Set<string>();

    while (frontier.length && seen.size < DEPS_MAX_NODES) {
      const batch = frontier.filter((id) => !seen.has(id));
      frontier = [];
      if (!batch.length) break;
      for (const id of batch) seen.add(id);
      const kidsMap = await getWorkshopDependenciesBatch(batch, opts);
      for (const id of batch) {
        const kids = kidsMap.get(id) || [];
        childrenOf.set(id, kids);
        for (const k of kids) {
          if (!seen.has(k)) frontier.push(k);
        }
      }
    }

    const ordered: string[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string) => {
      if (done.has(id) || visiting.has(id)) return;
      visiting.add(id);
      for (const c of childrenOf.get(id) || []) visit(c);
      visiting.delete(id);
      done.add(id);
      ordered.push(id);
    };
    for (const id of roots) visit(id);
    for (const id of seen) visit(id);

    const rootSet = new Set(roots);
    const added = ordered.filter((id) => !rootSet.has(id));
    return { ordered, added, roots };
  })().finally(() => {
    expandInflight.delete(expandKey);
  });

  expandInflight.set(expandKey, promise);
  return promise;
}

export { isFresh };
