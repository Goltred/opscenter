import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Host } from "../api";
import { useToast } from "./Toast";
import { Modal } from "./ui";

type FileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
};

const VIEWABLE_EXT = new Set([
  ".txt", ".cfg", ".rpt", ".html", ".htm", ".log", ".json", ".xml", ".ini", ".sqf", ".hpp", ".ext",
]);

function formatSize(n?: number) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isViewableText(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".arma3profile")) return true;
  const i = lower.lastIndexOf(".");
  if (i < 0) return false;
  return VIEWABLE_EXT.has(lower.slice(i));
}

export function HostFilesModal({
  hosts,
  hostId,
  initialRoot = "mpmissions",
  initialPath = "",
  onClose,
}: {
  hosts: Host[];
  hostId: string;
  initialRoot?: string;
  initialPath?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState(hostId);
  const [root, setRoot] = useState(initialRoot || "mpmissions");
  const [path, setPath] = useState(initialPath || "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [exists, setExists] = useState(true);
  const [viewing, setViewing] = useState<FileEntry | null>(null);
  const [viewContent, setViewContent] = useState("");
  const [viewMeta, setViewMeta] = useState<{ truncated?: boolean; size?: number; path?: string }>({});
  const [viewLoading, setViewLoading] = useState(false);

  const selected = hosts.find((h) => h.id === selectedId) || hosts[0];
  const effectiveHostId = selected?.id || "";

  useEffect(() => {
    setSelectedId(hostId);
    setRoot(initialRoot || "mpmissions");
    setPath(initialPath || "");
  }, [hostId, initialRoot, initialPath]);

  async function load(nextPath = path, nextRoot = root, hid = effectiveHostId) {
    if (!hid) return;
    const host = hosts.find((h) => h.id === hid);
    if (!host?.online) {
      setEntries([]);
      setPath(nextPath);
      setRoot(nextRoot);
      return;
    }
    setLoading(true);
    try {
      const q = new URLSearchParams({ root: nextRoot, path: nextPath });
      const r = await api.get<{ entries?: FileEntry[]; exists?: boolean }>(`/hosts/${hid}/files?${q}`);
      setEntries((r.entries || []) as FileEntry[]);
      setExists(r.exists !== false);
      setPath(nextPath);
      setRoot(nextRoot);
    } catch (e: any) {
      toast.error("Could not list files", { message: e.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (effectiveHostId) void load("", root, effectiveHostId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveHostId]);

  function selectHost(id: string) {
    setSelectedId(id);
    setPath("");
    void load("", root, id);
  }

  function enter(e: FileEntry) {
    if (!e.isDir) return;
    void load(e.path, root);
  }

  function up() {
    if (!path) return;
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    parts.pop();
    void load(parts.join("/"), root);
  }

  async function openFile(e: FileEntry) {
    if (e.isDir || !effectiveHostId) return;
    if (!isViewableText(e.name)) {
      toast.error("Cannot preview", { message: "Only text-like files (.txt, .cfg, .rpt, .html, …) can be opened." });
      return;
    }
    setViewing(e);
    setViewContent("");
    setViewMeta({});
    setViewLoading(true);
    try {
      const q = new URLSearchParams({ root, path: e.path });
      const r = await api.get<{
        content?: string;
        truncated?: boolean;
        size?: number;
        path?: string;
        relativePath?: string;
      }>(`/hosts/${effectiveHostId}/file?${q}`);
      setViewContent(String(r.content ?? ""));
      setViewMeta({ truncated: r.truncated, size: r.size, path: String(r.relativePath || e.path) });
    } catch (err: any) {
      toast.error("Could not read file", { message: err.message });
      setViewing(null);
    } finally {
      setViewLoading(false);
    }
  }

  const title = selected ? `Browse files — ${selected.name}` : "Browse files";

  return (
    <>
      <Modal title={title} onClose={onClose} wide>
        <div className="muted small" style={{ marginTop: 0, marginBottom: 12 }}>
          Browse Arma folders on this host for troubleshooting (shared across instances on that machine).
        </div>

        {hosts.length === 0 ? (
          <div>
            <div className="warn">No hosts yet.</div>
            <div className="muted" style={{ marginTop: 8 }}>
              Add a host and connect an agent from the <Link to="/" onClick={onClose}>Dashboard</Link> first.
            </div>
          </div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
              <div style={{ minWidth: 220 }}>
                <label>Host</label>
                <select value={effectiveHostId} onChange={(e) => selectHost(e.target.value)}>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                      {h.online ? " ●" : " (offline)"}
                    </option>
                  ))}
                </select>
              </div>
              {selected && (
                <span className="muted small" style={{ alignSelf: "end", marginBottom: 8 }}>
                  {selected.online ? "agent connected" : "agent offline — start the agent to browse"}
                  {" · "}
                  <span className="tag">{selected.armaRoot}</span>
                </span>
              )}
            </div>

            {!selected?.online ? (
              <div className="muted">
                Agent offline. Use Dashboard → Agent setup if you need to re-enroll, then reconnect.
              </div>
            ) : (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  <select style={{ maxWidth: 180 }} value={root} onChange={(e) => void load("", e.target.value)}>
                    <option value="mpmissions">mpmissions</option>
                    <option value="keys">keys</option>
                    <option value="profiles">profiles</option>
                    <option value="mods">mods</option>
                    <option value="modsLibrary">mods library</option>
                    <option value="arma">arma root</option>
                    <option value="workshop">workshop content</option>
                  </select>
                  <button className="btn small" disabled={!path} onClick={up}>
                    Up
                  </button>
                  <button className="btn small" disabled={loading} onClick={() => void load(path, root)}>
                    {loading ? "…" : "Refresh"}
                  </button>
                  <span className="tag">
                    {root}/{path || "."}
                  </span>
                </div>
                {!exists && (
                  <div className="warn small" style={{ marginBottom: 8 }}>
                    Directory does not exist on the host yet.
                  </div>
                )}
                <div className="file-browser" style={{ maxHeight: "50vh", overflow: "auto" }}>
                  {entries.map((e) => (
                    <div className="fb-row" key={e.path + e.name}>
                      {e.isDir ? (
                        <button type="button" className="linkish" onClick={() => enter(e)}>
                          📁 {e.name}
                        </button>
                      ) : isViewableText(e.name) ? (
                        <button type="button" className="linkish" onClick={() => void openFile(e)}>
                          📄 {e.name}
                        </button>
                      ) : (
                        <span>📄 {e.name}</span>
                      )}
                      <span className="spacer" />
                      {!e.isDir && isViewableText(e.name) && (
                        <button type="button" className="btn small ghost" onClick={() => void openFile(e)}>
                          View
                        </button>
                      )}
                      <span className="muted">{e.isDir ? "" : formatSize(e.size)}</span>
                    </div>
                  ))}
                  {!loading && entries.length === 0 && <div className="muted">Empty</div>}
                </div>
              </>
            )}
          </>
        )}
      </Modal>

      {viewing && (
        <Modal title={viewing.name} onClose={() => setViewing(null)}>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {root}/{viewMeta.path || viewing.path}
            {viewMeta.size != null && ` · ${formatSize(viewMeta.size)}`}
            {viewMeta.truncated && " · showing first 2 MB"}
          </div>
          {viewLoading ? (
            <div className="muted">Loading…</div>
          ) : (
            <pre
              className="console"
              style={{ maxHeight: "60vh", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {viewContent || "(empty)"}
            </pre>
          )}
        </Modal>
      )}
    </>
  );
}
