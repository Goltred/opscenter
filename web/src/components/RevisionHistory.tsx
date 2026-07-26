import { useEffect, useState } from "react";
import { api, Mod, RevisionChange, RevisionMeta } from "../api";
import { useToast } from "./Toast";
import { Modal } from "./ui";
import { formatDateTime } from "../formatTime";

type Kind = "profile" | "shared-cfg" | "difficulty-preset";

function kindLabel(kind: Kind): string {
  if (kind === "shared-cfg") return "shared settings";
  if (kind === "difficulty-preset") return "difficulty preset";
  return "profile";
}

function formatWhen(raw: string): string {
  if (!raw) return "—";
  const d = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return raw;
  return formatDateTime(d);
}

function formatModList(ids: unknown[], nameByWorkshopId?: Map<string, string>): string {
  if (!ids.length) return "—";
  return ids
    .map((raw) => {
      const id = String(raw || "");
      if (!id) return "—";
      const name = nameByWorkshopId?.get(id);
      return name && name !== id ? name : id;
    })
    .join(", ");
}

function formatValue(path: string, v: unknown, nameByWorkshopId?: Map<string, string>): string {
  if (/password/i.test(path)) {
    if (v == null || v === "") return "—";
    return "••••";
  }
  if (v == null || v === "") return "—";
  if ((path === "mods" || path === "serverMods") && Array.isArray(v)) {
    return formatModList(v, nameByWorkshopId);
  }
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + "…" : s;
  } catch {
    return String(v);
  }
}

function actorLabel(r: RevisionMeta): string {
  if (r.actorEmail) return r.actorEmail;
  if (r.note === "Baseline") return "existing data";
  return "unknown";
}

export function RevisionHistoryModal({
  kind,
  title,
  listPath,
  comparePath,
  restorePath,
  canRestore,
  onClose,
  onRestored,
}: {
  kind: Kind;
  title: string;
  listPath: string;
  comparePath: string;
  restorePath: string;
  canRestore: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const toast = useToast();
  const [list, setList] = useState<RevisionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [compareWith, setCompareWith] = useState<number | null>(null);
  const [changes, setChanges] = useState<RevisionChange[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [modNames, setModNames] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    if (kind !== "profile") {
      setModNames(new Map());
      return;
    }
    let cancelled = false;
    api
      .get<Mod[]>("/mods")
      .then((rows) => {
        if (cancelled) return;
        setModNames(new Map((rows || []).map((m) => [m.workshopId, m.name || m.workshopId])));
      })
      .catch(() => {
        if (!cancelled) setModNames(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const rows = await api.get<RevisionMeta[]>(listPath);
      setList(rows);
      if (rows.length && selected == null) {
        setSelected(rows[0].version);
        if (rows.length > 1) setCompareWith(rows[1].version);
      }
    } catch (e: any) {
      setError(e.message || "Failed to load history");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listPath]);

  useEffect(() => {
    if (selected == null || compareWith == null || selected === compareWith) {
      setChanges(null);
      return;
    }
    let cancelled = false;
    setComparing(true);
    api
      .get<{ changes: RevisionChange[] }>(`${comparePath}?a=${compareWith}&b=${selected}`)
      .then((r) => {
        if (!cancelled) setChanges(r.changes || []);
      })
      .catch((e: any) => {
        if (!cancelled) {
          setChanges(null);
          setError(e.message || "Compare failed");
        }
      })
      .finally(() => {
        if (!cancelled) setComparing(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, compareWith, comparePath]);

  async function restore() {
    if (selected == null || !canRestore) return;
    if (!confirm(`Restore ${kindLabel(kind)} to v${selected}? This creates a new version.`)) {
      return;
    }
    setRestoring(true);
    try {
      await api.post(restorePath, { version: selected });
      toast.success(`Restored v${selected}`);
      onRestored();
      onClose();
    } catch (e: any) {
      toast.error("Restore failed", { message: e.message });
    } finally {
      setRestoring(false);
    }
  }

  const selectedMeta = list.find((r) => r.version === selected);
  const newest = list[0]?.version;

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <div className="modal-footer-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      }
    >
      <div className="revision-history">
        {loading && <div className="muted small">Loading…</div>}
        {error && <div className="error">{error}</div>}
        {!loading && !error && list.length === 0 && (
          <div className="muted">No versions yet.</div>
        )}
        {!loading && list.length > 0 && (
          <div className="revision-history-grid">
            <div className="revision-history-list">
              <div className="muted small" style={{ marginBottom: 8 }}>Versions</div>
              <ul>
                {list.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={"revision-history-item" + (selected === r.version ? " selected" : "")}
                      onClick={() => setSelected(r.version)}
                    >
                      <div className="row between" style={{ gap: 8 }}>
                        <strong>v{r.version}</strong>
                        {r.version === newest && <span className="badge">current</span>}
                      </div>
                      <div className="muted small">{actorLabel(r)}</div>
                      <div className="muted small">{formatWhen(r.createdAt)}</div>
                      {r.note ? <div className="muted small">{r.note}</div> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="revision-history-detail">
              {selectedMeta && (
                <>
                  <div className="row between" style={{ marginBottom: 12, gap: 8 }}>
                    <div>
                      <strong>v{selectedMeta.version}</strong>
                      <div className="muted small">
                        {actorLabel(selectedMeta)} · {formatWhen(selectedMeta.createdAt)}
                      </div>
                    </div>
                    {canRestore && selected !== newest && (
                      <button className="btn primary" disabled={restoring} onClick={() => void restore()}>
                        {restoring ? "Restoring…" : `Restore v${selected}`}
                      </button>
                    )}
                  </div>

                  <div style={{ marginBottom: 10 }}>
                    <label>Compare with</label>
                    <select
                      value={compareWith ?? ""}
                      onChange={(e) => setCompareWith(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">— pick a version —</option>
                      {list
                        .filter((r) => r.version !== selected)
                        .map((r) => (
                          <option key={r.id} value={r.version}>
                            v{r.version} · {actorLabel(r)} · {formatWhen(r.createdAt)}
                          </option>
                        ))}
                    </select>
                  </div>

                  {comparing && <div className="muted small">Comparing…</div>}
                  {!comparing && selected != null && compareWith != null && changes && (
                    <div>
                      <div className="muted small" style={{ marginBottom: 8 }}>
                        Changes from v{compareWith} → v{selected}
                        {changes.length === 0 ? " · identical" : ` · ${changes.length} field${changes.length === 1 ? "" : "s"}`}
                      </div>
                      {changes.length > 0 && (
                        <table className="revision-diff-table">
                          <thead>
                            <tr>
                              <th>Field</th>
                              <th>Before</th>
                              <th>After</th>
                            </tr>
                          </thead>
                          <tbody>
                            {changes.map((c) => (
                              <tr key={c.path}>
                                <td className="tag">{c.path}</td>
                                <td className="revision-diff-before">{formatValue(c.path, c.before, modNames)}</td>
                                <td className="revision-diff-after">{formatValue(c.path, c.after, modNames)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                  {selected != null && (compareWith == null || selected === compareWith) && (
                    <div className="muted small">Pick another version to see what changed.</div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
