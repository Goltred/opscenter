import { useState } from "react";
import { Link } from "react-router-dom";
import { api, HcGroup } from "../api";
import { useToast } from "./Toast";

function rollupBadge(state: string): string {
  const s = state.toLowerCase();
  if (s === "connected") return "green";
  if (s === "failed" || s === "agent offline") return "red";
  if (s === "degraded" || s === "starting") return "";
  return "";
}

export function HcGroupCard({
  group,
  canControl,
  canEdit,
  canDelete,
  onChanged,
}: {
  group: HcGroup;
  canControl: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function act(path: string, label: string, body?: unknown) {
    if (busy) return;
    setBusy(label);
    setError("");
    try {
      await api.post(`/hc-groups/${group.id}/${path}`, body ?? {});
      onChanged();
    } catch (e: any) {
      setError(e.message || `${label} failed`);
    } finally {
      setBusy("");
    }
  }

  async function scale(delta: number) {
    if (busy) return;
    setBusy(delta > 0 ? "add" : "remove");
    setError("");
    try {
      await api.post(`/hc-groups/${group.id}/scale`, { delta });
      onChanged();
    } catch (e: any) {
      setError(e.message || "Scale failed");
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (busy) return;
    if (!confirm(`Delete HC group "${group.name}"? Running processes will be stopped.`)) return;
    setBusy("delete");
    setError("");
    try {
      await api.del(`/hc-groups/${group.id}`);
      onChanged();
    } catch (e: any) {
      setError(e.message || "Delete failed");
    } finally {
      setBusy("");
    }
  }

  const st = group.status?.state || "stopped";
  const active = group.status?.active ?? 0;
  const desired = group.desiredCount ?? 0;

  return (
    <div className="hc-group-card">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <div>
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="tag">HC</span>
            <strong>{group.name}</strong>
            <span className={"badge"}>
              <span className={"dot " + rollupBadge(st)} />
              {st}
            </span>
            <span className="muted small">
              {active}/{desired}
            </span>
          </div>
          <div className="muted small" style={{ marginTop: 4 }}>
            {group.targetInstanceId && group.targetName ? (
              <>
                → <Link to={`/instances/${group.targetInstanceId}`}>{group.targetName}</Link>
                {group.targetHostName ? ` on ${group.targetHostName}` : ""}
                {group.targetPort != null ? ` :${group.targetPort}` : ""}
              </>
            ) : (
              <span className="warn-inline">No target instance</span>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {canControl && (
            <>
              <button className="btn small" disabled={!!busy || !group.workerOnline || !group.targetInstanceId} onClick={() => void act("start", "start")}>
                {busy === "start" ? "…" : "Start"}
              </button>
              <button className="btn small" disabled={!!busy || !group.workerOnline} onClick={() => void act("stop", "stop")}>
                {busy === "stop" ? "…" : "Stop"}
              </button>
              <button className="btn small" disabled={!!busy || !group.workerOnline || !group.targetInstanceId} onClick={() => void act("restart", "restart")}>
                {busy === "restart" ? "…" : "Restart"}
              </button>
              {canEdit && (
                <>
                  <button className="btn small" disabled={!!busy || desired >= 8} onClick={() => void scale(1)} title="Increase count">
                    +
                  </button>
                  <button className="btn small" disabled={!!busy || desired <= 0} onClick={() => void scale(-1)} title="Decrease count">
                    −
                  </button>
                </>
              )}
            </>
          )}
          {canDelete && (
            <button className="btn small danger" disabled={!!busy} onClick={() => void remove()}>
              {busy === "delete" ? "…" : "Delete"}
            </button>
          )}
        </div>
      </div>
      {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}

export function AddHcGroupModal({
  hostId,
  instances,
  onClose,
  onCreated,
}: {
  hostId: string;
  instances: { id: string; name: string; hostId: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("HC group");
  const [count, setCount] = useState(2);
  const [targetInstanceId, setTargetInstanceId] = useState(instances[0]?.id || "");
  const [connectHost, setConnectHost] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const group = await api.post<HcGroup>("/hc-groups", {
        hostId,
        name: name.trim(),
        desiredCount: count,
        targetInstanceId: targetInstanceId || undefined,
        connectHost: connectHost.trim() || undefined,
      });
      onCreated();
      if (group.targetInstanceId && count > 0) {
        // Optionally start — leave to user Start button to avoid surprise
      }
      onClose();
    } catch (e: unknown) {
      toast.error("Create HC group failed", { message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Add headless group</h2>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div className="grid" style={{ gap: 10, marginTop: 14 }}>
          <p className="muted small" style={{ margin: 0 }}>
            Only needed when this computer runs headless clients for a game server on another computer.
          </p>
          <div>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label>HC count</label>
            <input type="number" min={0} max={8} value={count} onChange={(e) => setCount(Math.min(8, Math.max(0, Number(e.target.value) || 0)))} />
          </div>
          <div>
            <label>Target game instance</label>
            <select value={targetInstanceId} onChange={(e) => setTargetInstanceId(e.target.value)}>
              <option value="">— select —</option>
              {instances.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Connect host override (optional)</label>
            <input
              value={connectHost}
              onChange={(e) => setConnectHost(e.target.value)}
              placeholder="Leave empty unless you need a one-off override"
            />
            <div className="muted small" style={{ marginTop: 4 }}>
              Usually leave empty. The panel uses each host&apos;s Reachable address when the HC runs on a different
              machine than the game server.
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || !name.trim()} onClick={create}>
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
