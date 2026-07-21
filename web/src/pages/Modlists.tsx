import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, Modlist, ModlistEntry, setCsrf } from "../api";
import { useAuth } from "../auth";
import { Modal, useList } from "../components/ui";

async function importModlistFile(file: File) {
  // Refresh CSRF from /auth/me then POST multipart (same cookie session).
  const me = await api.get<{ csrfToken: string }>("/auth/me");
  setCsrf(me.csrfToken);
  const fd = new FormData();
  fd.append("file", file);
  fd.append("name", file.name.replace(/\.html?$/i, ""));
  const res = await fetch("/api/modlists/import", {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRF-Token": me.csrfToken },
    body: fd,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data as { id: string; name: string; entryCount: number };
}

function workshopLink(workshopId: string) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`;
}

function WorkshopThumb({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(!src);
  if (failed || !src) {
    return (
      <div
        aria-hidden
        style={{
          width: 40,
          height: 40,
          borderRadius: 4,
          background: "var(--surface-2, #2a2a2a)",
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={40}
      height={40}
      loading="lazy"
      style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  );
}

function WorkshopModRow({
  entry,
  kindControl,
}: {
  entry: ModlistEntry;
  kindControl?: ReactNode;
}) {
  const href = entry.workshopUrl || workshopLink(entry.workshopId);
  const title = entry.name || entry.workshopId;
  return (
    <tr>
      <td>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <WorkshopThumb src={entry.previewUrl} alt={title} />
          <div>
            <a href={href} target="_blank" rel="noreferrer">
              {title}
            </a>
            <div className="muted small tag" style={{ marginTop: 2 }}>{entry.workshopId}</div>
          </div>
        </div>
      </td>
      {kindControl != null && <td>{kindControl}</td>}
    </tr>
  );
}

export function Modlists() {
  const { can } = useAuth();
  const lists = useList<Modlist[]>(() => api.get("/modlists"));
  const [editing, setEditing] = useState<Modlist | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  async function onImport(file: File) {
    setImporting(true);
    try {
      const data = await importModlistFile(file);
      alert(`Imported ${data.entryCount} mods into "${data.name}"`);
      lists.reload();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function del(m: Modlist) {
    if (!confirm(`Delete modlist "${m.name}"?`)) return;
    await api.del(`/modlists/${m.id}`);
    lists.reload();
  }

  return (
    <div>
      <div className="page-head row between">
        <div>
          <h1>Modlists</h1>
          <div className="muted">Import Arma Launcher modlist.html, then attach a list to a mission profile.</div>
        </div>
        <div className="row">
          <Link className="btn" to="/mods">Mod library</Link>
          {can("mod.manage") && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".html,.htm,text/html"
                hidden
                onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
              />
              <button className="btn primary" disabled={importing} onClick={() => fileRef.current?.click()}>
                {importing ? "Importing…" : "Import modlist.html"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Source</th><th>Entries</th><th></th></tr></thead>
          <tbody>
            {(lists.data || []).map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="tag">{m.sourceFilename || "—"}</td>
                <td className="tag">{m.entries.length}</td>
                <td>
                  <div className="cell-actions">
                  <button className="btn small" onClick={() => setEditing(m)}>View / Edit</button>
                  {can("mod.manage") && <button className="btn small danger" onClick={() => del(m)}>Delete</button>}
                  </div>
                </td>
              </tr>
            ))}
            {(lists.data || []).length === 0 && (
              <tr><td colSpan={4} className="muted">No modlists yet. Export one from the Arma Launcher and import it here.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditModlist
          list={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); lists.reload(); }}
        />
      )}
    </div>
  );
}

type WorkshopMetaMap = Record<string, { title?: string; previewUrl?: string; workshopUrl?: string }>;

function EditModlist({ list, onClose, onSaved }: { list: Modlist; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(list.name);
  const [entries, setEntries] = useState<ModlistEntry[]>([...list.entries]);
  const [loadingMeta, setLoadingMeta] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingMeta(true);
      try {
        const ids = list.entries.map((e) => e.workshopId);
        const meta = await api.post<WorkshopMetaMap>("/mods/workshop-meta", { workshopIds: ids });
        if (cancelled) return;
        setEntries((prev) =>
          prev.map((e) => {
            const m = meta[e.workshopId];
            if (!m) return e;
            return {
              ...e,
              name: m.title || e.name,
              previewUrl: m.previewUrl || e.previewUrl,
              workshopUrl: m.workshopUrl || e.workshopUrl || workshopLink(e.workshopId),
            };
          }),
        );
      } catch {
        /* keep cached/imported names */
      } finally {
        if (!cancelled) setLoadingMeta(false);
      }
    })();
    return () => { cancelled = true; };
  }, [list.id, list.entries]);

  function setKind(i: number, kind: "client" | "server") {
    setEntries(entries.map((e, idx) => (idx === i ? { ...e, kind } : e)));
  }

  async function save() {
    try {
      await api.put(`/modlists/${list.id}`, {
        name,
        entries: entries.map(({ workshopId, name: n, kind }) => ({ workshopId, name: n, kind })),
      });
      onSaved();
    } catch (e: any) {
      alert(e.message);
    }
  }

  return (
    <Modal title={`Modlist — ${list.name}`} onClose={onClose}>
      <div className="grid" style={{ gap: 12 }}>
        <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        {loadingMeta && <div className="muted small">Loading Steam Workshop previews…</div>}
        <div className="card" style={{ maxHeight: 420, overflow: "auto", padding: 0 }}>
          <table>
            <thead><tr><th>Mod</th><th>Kind</th></tr></thead>
            <tbody>
              {entries.map((e, i) => (
                <WorkshopModRow
                  key={e.workshopId + "-" + i}
                  entry={e}
                  kindControl={
                    <select value={e.kind} onChange={(ev) => setKind(i, ev.target.value as "client" | "server")}>
                      <option value="client">client</option>
                      <option value="server">server</option>
                    </select>
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
