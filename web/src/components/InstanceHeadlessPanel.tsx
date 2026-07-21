import { useState } from "react";
import { api, Host, Instance, MissionProfile } from "../api";

const MAX_HC = 8;

function hcBadgeClass(state: string): string {
  const s = state.toLowerCase();
  if (s === "connected") return "green";
  if (s === "running" || s === "starting") return "";
  if (s === "failed") return "red";
  return "";
}

export function InstanceHeadlessPanel({
  instance,
  host,
  profile,
  canControl,
  canEdit,
  onChanged,
}: {
  instance: Instance;
  host: Host | null;
  profile: MissionProfile | null;
  canControl: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [remoteDraft, setRemoteDraft] = useState((instance.remoteHcIps || []).join(", "));
  const [showAdvanced, setShowAdvanced] = useState(!!(instance.remoteHcIps || []).length);
  const [error, setError] = useState("");

  const desired = instance.headlessCount ?? 0;
  const live = instance.status?.headless || [];
  const serverState = String(instance.status?.state || instance.state || "").toLowerCase();
  const serverUp = serverState === "running" || serverState === "starting" || !!instance.status?.pid;
  const serverReady = serverState === "running" && instance.status?.queryOk !== false;
  const recommended = profile?.recommendedHeadlessCount;
  const runningCount = live.filter((h) => {
    const s = h.state.toLowerCase();
    return s === "running" || s === "connected" || s === "starting";
  }).length;

  async function saveCount(next: number) {
    if (!canEdit && !canControl) return;
    setBusy("save");
    setError("");
    try {
      if (serverUp && canControl) {
        await api.post(`/instances/${instance.id}/headless/scale`, { count: next });
      } else if (canEdit) {
        await api.patch(`/instances/${instance.id}`, { headlessCount: next });
      }
      onChanged();
    } catch (e: any) {
      setError(e.message || "Failed to save");
    } finally {
      setBusy("");
    }
  }

  async function scale(delta: number) {
    if (!canControl) return;
    setBusy(delta > 0 ? "add" : "remove");
    setError("");
    try {
      await api.post(`/instances/${instance.id}/headless/scale`, { delta });
      onChanged();
    } catch (e: any) {
      setError(e.message || "Scale failed");
    } finally {
      setBusy("");
    }
  }

  async function restartHc(name: string) {
    if (!canControl) return;
    setBusy("restart-" + name);
    setError("");
    try {
      await api.post(`/instances/${instance.id}/headless/${encodeURIComponent(name)}/restart`, {});
      onChanged();
    } catch (e: any) {
      setError(e.message || "Restart failed");
    } finally {
      setBusy("");
    }
  }

  async function stopHc(name: string) {
    if (!canControl) return;
    setBusy("stop-" + name);
    setError("");
    try {
      await api.post(`/instances/${instance.id}/headless/${encodeURIComponent(name)}/stop`, {});
      onChanged();
    } catch (e: any) {
      setError(e.message || "Stop failed");
    } finally {
      setBusy("");
    }
  }

  async function saveRemoteIps() {
    if (!canEdit) return;
    setBusy("remote");
    setError("");
    try {
      const ips = remoteDraft
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await api.patch(`/instances/${instance.id}`, { remoteHcIps: ips });
      onChanged();
    } catch (e: any) {
      setError(e.message || "Failed to save remote IPs");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row between" style={{ marginBottom: 8 }}>
        <div>
          <strong>Headless clients</strong>
          <div className="muted small">
            Same-host processes managed by the agent on {host?.name || "this host"}. Mission must transfer AI to HCs.
          </div>
        </div>
        <span className="tag">
          HC {runningCount}/{desired}
        </span>
      </div>

      {recommended != null && recommended !== desired && (
        <div className="muted small" style={{ marginBottom: 8 }}>
          Loaded profile recommends {recommended} local HC{recommended === 1 ? "" : "s"} (instance is set to {desired}).
        </div>
      )}

      <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <label className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className="muted small">Desired local HCs</span>
          <input
            type="number"
            min={0}
            max={MAX_HC}
            style={{ width: 72 }}
            value={desired}
            disabled={!canEdit || !!busy}
            onChange={(e) => {
              const n = Math.min(MAX_HC, Math.max(0, Number(e.target.value) || 0));
              void saveCount(n);
            }}
          />
        </label>
        {canControl && (
          <>
            <button
              className="btn small"
              disabled={!!busy || !serverUp || !serverReady || desired >= MAX_HC}
              title={!serverReady ? "Wait until the server is running" : "Start one more HC"}
              onClick={() => scale(1)}
            >
              {busy === "add" ? "Adding…" : "Add HC"}
            </button>
            <button
              className="btn small"
              disabled={!!busy || desired <= 0}
              title={serverUp ? "Stop one HC and lower desired count" : "Lower desired count"}
              onClick={() => scale(-1)}
            >
              {busy === "remove" ? "Removing…" : "Remove HC"}
            </button>
          </>
        )}
      </div>

      {desired > 0 || live.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>PID</th>
              <th>Port</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: Math.max(desired, live.length) }, (_, i) => {
              const name = `hc${i}`;
              const row = live.find((h) => h.name.toLowerCase() === name) || {
                name,
                state: serverUp ? "stopped" : "stopped",
              };
              return (
                <tr key={name}>
                  <td>
                    <code>{row.name}</code>
                  </td>
                  <td>
                    <span className={"badge " + hcBadgeClass(row.state)}>
                      <span className={"dot " + hcBadgeClass(row.state)} />
                      {row.state}
                    </span>
                    {row.error ? (
                      <div className="muted small" title={row.error}>
                        {row.error.slice(0, 80)}
                      </div>
                    ) : null}
                  </td>
                  <td className="muted small">{row.pid || "—"}</td>
                  <td className="muted small">{row.port || "—"}</td>
                  <td>
                    {canControl && (
                      <div className="row" style={{ gap: 6 }}>
                        <button
                          className="btn small"
                          disabled={!!busy || !serverUp}
                          onClick={() => restartHc(name)}
                        >
                          Restart
                        </button>
                        <button
                          className="btn small danger"
                          disabled={!!busy}
                          onClick={() => stopHc(name)}
                        >
                          Stop
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="muted small">No local headless clients configured. Raise the count or click Add HC when the server is up.</div>
      )}

      <div style={{ marginTop: 12 }}>
        <button className="btn small" type="button" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? "Hide" : "Show"} remote HC allowlist
        </button>
        {showAdvanced && (
          <div style={{ marginTop: 8 }}>
            <div className="muted small" style={{ marginBottom: 6 }}>
              Extra IPs written to <code>headlessClients[]</code> / <code>localClient[]</code> for unmanaged remote HCs.
              Panel-managed HC groups add their worker advertise IPs automatically.
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <input
                style={{ flex: 1, minWidth: 220 }}
                value={remoteDraft}
                disabled={!canEdit || !!busy}
                placeholder="192.168.1.10, 10.0.0.5"
                onChange={(e) => setRemoteDraft(e.target.value)}
              />
              {canEdit && (
                <button className="btn small" disabled={!!busy} onClick={() => saveRemoteIps()}>
                  Save IPs
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

      {(instance.remoteHcGroups || []).length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted small" style={{ marginBottom: 6 }}>Remote HC groups targeting this instance</div>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {(instance.remoteHcGroups || []).map((g) => (
              <li key={g.id}>
                <strong>{g.name}</strong>{" "}
                <span className="muted small">×{g.desiredCount} (managed on another host card)</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
