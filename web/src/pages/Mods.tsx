import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Host, Mod } from "../api";
import { useAuth } from "../auth";
import { useToast } from "../components/Toast";
import { SignatureKeysLibrary } from "../components/SignatureKeys";
import { useList } from "../components/ui";
import { parseWorkshopId } from "../workshopId";

type WorkshopHit = {
  workshopId: string;
  title: string;
  previewUrl?: string;
  workshopUrl?: string;
};

type WorkshopMetaMap = Record<string, { title?: string; previewUrl?: string; workshopUrl?: string }>;

export function Mods() {
  const { can } = useAuth();
  const toast = useToast();
  const mods = useList<Mod[]>(() => api.get("/mods"));
  const hosts = useList<Host[]>(() => api.get("/hosts"));
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [hits, setHits] = useState<WorkshopHit[]>([]);
  const [webApiConfigured, setWebApiConfigured] = useState<boolean | null>(null);

  const onlineHost = (hosts.data || []).find((h) => h.online) || (hosts.data || [])[0];

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ configured: boolean }>("/steam/web-api-key")
      .then((r) => {
        if (!cancelled) setWebApiConfigured(!!r.configured);
      })
      .catch(() => {
        if (!cancelled) setWebApiConfigured(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function refreshTitles(force = false) {
    try {
      await api.post("/mods/workshop-meta", { refreshExpired: true, force });
      mods.reload();
      toast.success(force ? "Titles refreshed from Steam" : "Missing / placeholder / expired titles refreshed");
    } catch (e: any) {
      toast.error("Refresh failed", { message: e.message });
    }
  }

  async function addByInput() {
    const workshopId = parseWorkshopId(query);
    if (!workshopId) {
      toast.error("Need a workshop ID or link", {
        message: "Paste a Steam workshop URL or numeric ID, then Add to library.",
      });
      return;
    }
    setAdding(true);
    try {
      let title = workshopId;
      try {
        const meta = await api.post<WorkshopMetaMap>("/mods/workshop-meta", { workshopIds: [workshopId] });
        title = meta[workshopId]?.title || workshopId;
      } catch {
        /* keep id as name if Steam meta fails */
      }
      await api.post("/mods", { workshopId, name: title, kind: "client", bikeys: [] });
      setQuery("");
      setHits([]);
      mods.reload();
      toast.success("Added to library", { message: title });
    } catch (e: any) {
      toast.error("Add failed", { message: e.message });
    } finally {
      setAdding(false);
    }
  }

  async function del(m: Mod) {
    if (!confirm("Delete mod from library?")) return;
    await api.del(`/mods/${m.id}`);
    mods.reload();
  }

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const r = await api.get<{ results: WorkshopHit[] }>(
        `/mods/workshop-search?q=${encodeURIComponent(query.trim())}`,
      );
      setHits(r.results || []);
      if (!(r.results || []).length) {
        toast.info("No workshop results", { message: "Try a different name or paste a workshop ID/URL." });
      }
    } catch (e: any) {
      toast.error("Search failed", { message: e.message });
    } finally {
      setSearching(false);
    }
  }

  async function addFromHit(h: WorkshopHit, withDeps = false) {
    try {
      await api.post("/mods", { workshopId: h.workshopId, name: h.title, kind: "client", bikeys: [] });
      let depNote = "";
      if (withDeps) {
        const r = await api.post<{
          added: string[];
          mods: { workshopId: string; title: string }[];
        }>("/mods/resolve-deps", { workshopIds: [h.workshopId] });
        for (const m of r.mods || []) {
          if (m.workshopId === h.workshopId) continue;
          try {
            await api.post("/mods", {
              workshopId: m.workshopId,
              name: m.title || m.workshopId,
              kind: "client",
              bikeys: [],
            });
          } catch {
            /* already present */
          }
        }
        depNote = (r.added || []).length
          ? ` + ${(r.added || []).length} required item(s)`
          : " (no Steam required items)";
      }
      mods.reload();
      toast.success("Added to library", {
        message: withDeps ? `${h.title}${depNote}. Profiles also expand deps on apply/start.` : h.title,
      });
    } catch (e: any) {
      toast.error("Could not add", { message: e.message });
    }
  }

  return (
    <div>
      <div className="page-head row between">
        <div>
          <h1>Mods</h1>
          <div className="muted">
            Workshop library for mission profiles. Search or paste an ID to add mods here; client vs server is chosen
            when you attach a mod to a profile. To put files on a machine, use that host&apos;s{" "}
            {onlineHost ? (
              <Link to={`/?hostId=${encodeURIComponent(onlineHost.id)}&steamcmd=1`}>Mods &amp; server</Link>
            ) : (
              "Mods & server"
            )}{" "}
            on the Dashboard (or let Apply download missing ones).
          </div>
        </div>
        <div className="row">
          {can("mod.manage") && (
            <button
              className="btn"
              onClick={() => refreshTitles(false)}
              title="Refresh missing, placeholder (ID/URL), or expired titles from Steam"
            >
              Refresh titles
            </button>
          )}
          <Link className="btn" to="/modlists">
            Import modlist.html
          </Link>
        </div>
      </div>

      {webApiConfigured === false && (
        <div className="warn-banner" style={{ marginBottom: 16 }}>
          No Steam Web API key configured. Workshop titles and required-item deps may be incomplete (modlists often show
          IDs or URLs). Add a key under <Link to="/admin">Admin → Steam</Link>
          {can("steam.config") ? "" : " (ask an owner)"} — not the same as a Steam login account.
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Find or add a mod</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          Search by name, or paste a workshop link / ID and add it to the library. The title comes from Steam.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (parseWorkshopId(query)) void addByInput();
                else void search();
              }
            }}
            placeholder="Search name, or paste workshop ID / URL"
            style={{ flex: 1, minWidth: 220 }}
          />
          <button className="btn" disabled={searching} onClick={search}>
            {searching ? "Searching…" : "Search"}
          </button>
          {can("mod.manage") && (
            <button className="btn primary" disabled={adding} onClick={() => void addByInput()}>
              {adding ? "Adding…" : "Add to library"}
            </button>
          )}
        </div>
        {hits.length > 0 && (
          <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
            {hits.map((h) => (
              <div
                key={h.workshopId}
                className="row between"
                style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10 }}
              >
                <div className="row" style={{ gap: 10 }}>
                  {h.previewUrl ? (
                    <img
                      src={h.previewUrl}
                      alt=""
                      width={48}
                      height={48}
                      style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4 }}
                    />
                  ) : (
                    <div style={{ width: 48, height: 48, borderRadius: 4, background: "var(--bg3)" }} />
                  )}
                  <div>
                    <a
                      href={h.workshopUrl || `https://steamcommunity.com/sharedfiles/filedetails/?id=${h.workshopId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {h.title}
                    </a>
                    <div className="muted small tag">{h.workshopId}</div>
                  </div>
                </div>
                <div className="row">
                  {can("mod.manage") && (
                    <>
                      <button className="btn small" onClick={() => addFromHit(h)}>
                        Add
                      </button>
                      <button
                        className="btn small"
                        onClick={() => addFromHit(h, true)}
                        title="Also add Steam Workshop required items to the library"
                      >
                        Add + deps
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Library</h2>
        <table>
          <thead>
            <tr>
              <th>Mod</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(mods.data || []).map((m) => (
              <tr key={m.id}>
                <td>
                  <div className="row" style={{ gap: 10, alignItems: "center" }}>
                    {m.previewUrl ? (
                      <img
                        src={m.previewUrl}
                        alt=""
                        width={40}
                        height={40}
                        loading="lazy"
                        style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4 }}
                        onError={(ev) => {
                          (ev.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <div style={{ width: 40, height: 40, borderRadius: 4, background: "var(--bg3)" }} />
                    )}
                    <div>
                      <a
                        href={
                          m.workshopUrl || `https://steamcommunity.com/sharedfiles/filedetails/?id=${m.workshopId}`
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        {m.name}
                      </a>
                      <div className="muted small tag" style={{ marginTop: 2 }}>
                        {m.workshopId}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="cell-actions">
                    {can("mod.manage") && (
                      <button className="btn small danger" onClick={() => del(m)}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {(mods.data || []).length === 0 && (
              <tr>
                <td colSpan={2} className="muted">
                  No mods yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {can("mod.manage") && <SignatureKeysLibrary />}
    </div>
  );
}
