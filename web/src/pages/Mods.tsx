import { useState } from "react";
import { Link } from "react-router-dom";
import { api, Host, Mod } from "../api";
import { useAuth } from "../auth";
import { useToast } from "../components/Toast";
import { useList } from "../components/ui";

type WorkshopHit = {
  workshopId: string;
  title: string;
  previewUrl?: string;
  workshopUrl?: string;
};

export function Mods() {
  const { can } = useAuth();
  const toast = useToast();
  const mods = useList<Mod[]>(() => api.get("/mods"));
  const hosts = useList<Host[]>(() => api.get("/hosts"));
  const [workshopId, setWorkshopId] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("client");
  const [bikeys, setBikeys] = useState("");
  const [hostId, setHostId] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<WorkshopHit[]>([]);

  async function refreshTitles(force = false) {
    try {
      await api.post("/mods/workshop-meta", { refreshExpired: true, force });
      mods.reload();
      toast.success(force ? "Titles refreshed from Steam" : "Expired / missing titles refreshed");
    } catch (e: any) {
      toast.error("Refresh failed", { message: e.message });
    }
  }

  async function add() {
    try {
      await api.post("/mods", { workshopId, name, kind, bikeys: bikeys.split(",").map((s) => s.trim()).filter(Boolean) });
      setWorkshopId(""); setName(""); setBikeys("");
      mods.reload();
      toast.success("Mod added to library");
    } catch (e: any) { toast.error("Add failed", { message: e.message }); }
  }

  async function download(m: { workshopId: string; name?: string }, hid?: string) {
    const target = hid || hostId || (hosts.data || [])[0]?.id;
    if (!target) { toast.error("No host available", { message: "Add and connect an agent first." }); return; }
    try {
      const r = await api.post<{ jobId: string }>(`/mods/${m.workshopId}/download`, { hostId: target });
      toast.success(`Downloading ${m.name || m.workshopId}`, {
        message: "SteamCMD job started on the host.",
        action: { label: "Open Dashboard", to: "/" },
      });
      void r;
    } catch (e: any) { toast.error("Download failed", { message: e.message }); }
  }

  async function del(m: Mod) {
    if (!confirm("Delete mod from library?")) return;
    await api.del(`/mods/${m.id}`); mods.reload();
  }

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const r = await api.get<{ results: WorkshopHit[] }>(`/mods/workshop-search?q=${encodeURIComponent(query.trim())}`);
      setHits(r.results || []);
      if (!(r.results || []).length) toast.info("No workshop results", { message: "Try a different name or paste a workshop ID/URL." });
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
            await api.post("/mods", { workshopId: m.workshopId, name: m.title || m.workshopId, kind: "client", bikeys: [] });
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
        message: withDeps
          ? `${h.title}${depNote}. Profiles also expand deps on apply/start.`
          : h.title,
      });
    } catch (e: any) {
      toast.error("Could not add", { message: e.message });
    }
  }

  return (
    <div>
      <div className="page-head row between">
        <div><h1>Mods</h1><div className="muted">Steam Workshop library — search, look up by ID, and download via the host agent</div></div>
        <div className="row">
          {can("mod.manage") && (
            <button className="btn" onClick={() => refreshTitles(false)} title="Refresh titles older than 30 days or missing">
              Refresh titles
            </button>
          )}
          <Link className="btn" to="/modlists">Import modlist.html</Link>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Workshop browser</h2>
        <div className="row">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Search name, or paste workshop ID / URL"
          />
          <button className="btn primary" disabled={searching} onClick={search}>{searching ? "Searching…" : "Search"}</button>
        </div>
        {hits.length > 0 && (
          <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
            {hits.map((h) => (
              <div key={h.workshopId} className="row between" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10 }}>
                <div className="row" style={{ gap: 10 }}>
                  {h.previewUrl ? (
                    <img src={h.previewUrl} alt="" width={48} height={48} style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4 }} />
                  ) : (
                    <div style={{ width: 48, height: 48, borderRadius: 4, background: "var(--bg3)" }} />
                  )}
                  <div>
                    <a href={h.workshopUrl || `https://steamcommunity.com/sharedfiles/filedetails/?id=${h.workshopId}`} target="_blank" rel="noreferrer">
                      {h.title}
                    </a>
                    <div className="muted small tag">{h.workshopId}</div>
                  </div>
                </div>
                <div className="row">
                  {can("mod.manage") && <>
                    <button className="btn small" onClick={() => addFromHit(h)}>Add</button>
                    <button className="btn small" onClick={() => addFromHit(h, true)} title="Also add Steam Workshop required items to the library">Add + deps</button>
                    <button className="btn small primary" onClick={() => download(h)}>Download</button>
                  </>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {can("mod.manage") && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Add mod manually</h2>
          <div className="grid cols-3" style={{ gap: 10 }}>
            <div><label>Workshop ID</label><input value={workshopId} onChange={(e) => setWorkshopId(e.target.value)} placeholder="450814997" /></div>
            <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="CBA_A3" /></div>
            <div><label>Type</label><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="client">client</option><option value="server">server</option></select></div>
          </div>
          <div style={{ marginTop: 10 }}><label>Bikey filenames (comma separated)</label><input value={bikeys} onChange={(e) => setBikeys(e.target.value)} placeholder="cba_a3.bikey" /></div>
          <div style={{ marginTop: 10 }}>
            <label>Download host</label>
            <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
              <option value="">(first online host)</option>
              {(hosts.data || []).map((h) => <option key={h.id} value={h.id}>{h.name}{h.online ? " ●" : ""}</option>)}
            </select>
          </div>
          <button className="btn primary" style={{ marginTop: 10 }} onClick={add}>Add</button>
        </div>
      )}
      <div className="card">
        <table>
          <thead><tr><th>Mod</th><th>Type</th><th>Bikeys</th><th></th></tr></thead>
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
                        onError={(ev) => { (ev.target as HTMLImageElement).style.display = "none"; }}
                      />
                    ) : (
                      <div style={{ width: 40, height: 40, borderRadius: 4, background: "var(--bg3)" }} />
                    )}
                    <div>
                      <a
                        href={m.workshopUrl || `https://steamcommunity.com/sharedfiles/filedetails/?id=${m.workshopId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {m.name}
                      </a>
                      <div className="muted small tag" style={{ marginTop: 2 }}>{m.workshopId}</div>
                    </div>
                  </div>
                </td>
                <td><span className="badge">{m.kind}</span></td>
                <td className="tag">{(m.bikeys || []).join(", ")}</td>
                <td>
                  <div className="cell-actions">
                  {can("mod.manage") && <>
                    <button className="btn small" onClick={() => download(m)}>Download</button>
                    <button className="btn small danger" onClick={() => del(m)}>Delete</button>
                  </>}
                  </div>
                </td>
              </tr>
            ))}
            {(mods.data || []).length === 0 && <tr><td colSpan={4} className="muted">No mods yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
