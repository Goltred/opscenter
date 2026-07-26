import { useState } from "react";
import { api, DifficultyPreset } from "../api";
import { useAuth } from "../auth";
import { CustomDifficultyEditor } from "../components/CustomDifficultyEditor";
import { RevisionHistoryModal } from "../components/RevisionHistory";
import { useToast } from "../components/Toast";
import { Modal, useList } from "../components/ui";
import { mergeCustomDifficulty, type CustomDifficulty } from "../arma/difficultyOptions";

export function Difficulties() {
  const { can } = useAuth();
  const toast = useToast();
  const presets = useList<DifficultyPreset[]>(() => api.get("/difficulty-presets"));
  const [editing, setEditing] = useState<DifficultyPreset | null>(null);
  const [creating, setCreating] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<DifficultyPreset | null>(null);

  async function del(p: DifficultyPreset) {
    if (!confirm(`Delete difficulty preset "${p.name}"? Profiles using it will lose the link.`)) return;
    try {
      await api.del(`/difficulty-presets/${p.id}`);
      toast.success("Preset deleted");
      presets.reload();
    } catch (e: any) {
      toast.error("Delete failed", { message: e.message });
    }
  }

  return (
    <div>
      <div className="page-head row between">
        <div>
          <h1>Difficulties</h1>
          <div className="muted">Reusable custom difficulty presets. Attach one when a mission profile uses Custom.</div>
        </div>
        {can("profile.edit") && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            New preset
          </button>
        )}
      </div>

      {presets.loading && <div className="muted">Loading…</div>}
      {!presets.loading && (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Version</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(presets.data || []).map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="muted">v{p.version}</td>
                  <td>
                    <div className="cell-actions">
                      {can("profile.edit") && (
                        <button className="btn small" onClick={() => setEditing(p)}>
                          Edit
                        </button>
                      )}
                      <button className="btn small" onClick={() => setHistoryTarget(p)}>
                        History
                      </button>
                      {can("profile.edit") && (
                        <button className="btn small danger" onClick={() => void del(p)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {(presets.data || []).length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    No custom difficulty presets yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <DifficultyPresetEditor
          preset={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            presets.reload();
          }}
          onHistory={
            editing
              ? () => {
                  setHistoryTarget(editing);
                  setEditing(null);
                  setCreating(false);
                }
              : undefined
          }
        />
      )}

      {historyTarget && (
        <RevisionHistoryModal
          kind="difficulty-preset"
          title={`History — ${historyTarget.name}`}
          listPath={`/difficulty-presets/${historyTarget.id}/revisions`}
          comparePath={`/difficulty-presets/${historyTarget.id}/revisions/compare`}
          restorePath={`/difficulty-presets/${historyTarget.id}/restore`}
          canRestore={can("profile.edit")}
          onClose={() => setHistoryTarget(null)}
          onRestored={() => {
            presets.reload();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function DifficultyPresetEditor({
  preset,
  onClose,
  onSaved,
  onHistory,
}: {
  preset: DifficultyPreset | null;
  onClose: () => void;
  onSaved: () => void;
  onHistory?: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(preset?.name || "");
  const [difficulty, setDifficulty] = useState<CustomDifficulty>(() =>
    mergeCustomDifficulty(preset?.difficulty),
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    const trimmed = name.trim() || "Custom";
    setSaving(true);
    try {
      if (preset) {
        await api.put(`/difficulty-presets/${preset.id}`, { name: trimmed, difficulty });
      } else {
        await api.post("/difficulty-presets", { name: trimmed, difficulty });
      }
      toast.success(preset ? "Preset saved" : "Preset created");
      onSaved();
    } catch (e: any) {
      toast.error("Save failed", { message: e.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={preset ? "Edit difficulty preset" : "New difficulty preset"}
      onClose={onClose}
      wide
      footer={
        <>
          {preset && onHistory && (
            <button type="button" className="btn" onClick={onHistory}>
              History{preset.version != null ? ` · v${preset.version}` : ""}
            </button>
          )}
          <div className="modal-footer-actions">
            <button className="btn primary" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save preset"}
            </button>
          </div>
        </>
      }
    >
      <div className="grid" style={{ gap: 12 }}>
        <div>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hardcore PvE" />
        </div>
        <div>
          <CustomDifficultyEditor value={difficulty} onChange={setDifficulty} />
          <div className="muted small" style={{ marginTop: 10 }}>
            Written to <code>Users/server/server.Arma3Profile</code> when a profile with Custom difficulty is applied.
          </div>
        </div>
      </div>
    </Modal>
  );
}
