import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, HcGroup, Host, Instance } from "../api";
import { useAuth } from "../auth";
import { AgentSetupWizard } from "../components/AgentSetupWizard";
import { AddHcGroupModal, HcGroupCard } from "../components/HcGroupCard";
import { HostSteamCmdPanel } from "../components/HostSteamCmdPanel";
import { Modal, StatusBadge, useList } from "../components/ui";

function formatLastSeen(iso?: string) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return new Date(t).toLocaleString();
}

export function Dashboard() {
  const { can } = useAuth();
  const [searchParams] = useSearchParams();
  const hosts = useList<Host[]>(() => api.get("/hosts"));
  const instances = useList<Instance[]>(() => api.get("/instances"));
  const hcGroups = useList<HcGroup[]>(() => api.get("/hc-groups"));
  const [setupHost, setSetupHost] = useState<Host | null | undefined>(undefined);
  // undefined = closed; null = add/create wizard; Host = setup existing
  const [editHost, setEditHost] = useState<Host | null>(null);
  const [steamcmdHostId, setSteamcmdHostId] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [moreHostId, setMoreHostId] = useState<string | null>(null);
  const [addHcHostId, setAddHcHostId] = useState<string | null>(null);

  useEffect(() => {
    const hostId = searchParams.get("hostId");
    if (!hostId) return;
    if (searchParams.get("steamcmd") === "1") setSteamcmdHostId(hostId);
    const t = window.setTimeout(() => {
      document.getElementById(`host-${hostId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
    return () => window.clearTimeout(t);
  }, [searchParams, hosts.data]);

  useEffect(() => {
    if (!moreHostId) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(`[data-host-more="${moreHostId}"]`)) return;
      setMoreHostId(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreHostId]);

  useEffect(() => {
    const id = window.setInterval(() => {
      hosts.reload();
      instances.reload();
    }, 8000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function control(inst: Instance, action: string) {
    setBusy(inst.id + action);
    try {
      await api.post(`/instances/${inst.id}/${action}`);
      setTimeout(() => instances.reload(), 800);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy("");
    }
  }

  async function deleteInstance(inst: Instance) {
    if (!confirm(`Delete instance "${inst.name}"? This removes it from the panel (does not uninstall Arma files).`)) return;
    setBusy("del-inst-" + inst.id);
    try {
      await api.del(`/instances/${inst.id}`);
      instances.reload();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy("");
    }
  }

  async function deleteHost(h: Host) {
    if (!confirm(`Delete host "${h.name}" and all of its instances? The agent will no longer be recognized.`)) return;
    setBusy("del-host-" + h.id);
    try {
      await api.del(`/hosts/${h.id}`);
      hosts.reload();
      instances.reload();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div>
      <div className="page-head row between">
        <div>
          <h1>Dashboard</h1>
          <div className="muted">Hosts and Arma 3 server instances — online means the host agent is connected</div>
        </div>
        {can("host.add") && (
          <button className="btn primary" onClick={() => setSetupHost(null)}>
            Add host
          </button>
        )}
      </div>

      {hosts.error && <div className="error">{hosts.error}</div>}
      <div className="grid" style={{ gap: 16 }}>
        {(hosts.data || []).map((h) => {
          const hostInstances = (instances.data || []).filter((i) => i.hostId === h.id);
          const armaInstalled = h.bootstrap?.armaServerPresent === true;
          const needsAgentSetup = !h.online || !armaInstalled;
          const showAgentSetupPrimary = can("host.add") && needsAgentSetup;
          const showAgentSetupInMore = can("host.add") && !needsAgentSetup;
          const moreOpen = moreHostId === h.id;
          const hasMore = showAgentSetupInMore || can("host.remove");

          return (
            <div className="card" key={h.id} id={`host-${h.id}`}>
              <div className="row between">
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                  <strong>{h.name}</strong>
                  <span className="badge">
                    <span className={"dot " + (h.online ? "green" : "")} />
                    {h.online ? "agent connected" : "agent offline"}
                  </span>
                  {h.steamcmdRunning && <span className="badge">File job busy{h.steamcmdPid ? ` · pid ${h.steamcmdPid}` : ""}</span>}
                  <span className="tag">{h.armaRoot}</span>
                  {h.modsLibraryPath ? <span className="tag">mods: {h.modsLibraryPath}</span> : null}
                </div>
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {showAgentSetupPrimary && (
                    <button className="btn small primary" onClick={() => setSetupHost(h)}>
                      Agent setup
                    </button>
                  )}
                  {can("mod.manage") && (
                    <button
                      className={"btn small" + (steamcmdHostId === h.id ? " primary" : "")}
                      disabled={!h.online}
                      title={!h.online ? "Connect the agent first" : undefined}
                      onClick={() => setSteamcmdHostId(steamcmdHostId === h.id ? null : h.id)}
                    >
                      Mods & server
                    </button>
                  )}
                  <Link
                    className={"btn small" + (!h.online ? " disabled" : "")}
                    to={`/files?hostId=${encodeURIComponent(h.id)}`}
                    title={!h.online ? "Connect the agent first" : undefined}
                    style={!h.online ? { pointerEvents: "none", opacity: 0.5 } : undefined}
                  >
                    Browse files
                  </Link>
                  {can("host.add") && (
                    <button className="btn small" onClick={() => setEditHost(h)}>
                      Edit
                    </button>
                  )}
                  {hasMore && (
                    <div className="host-more" data-host-more={h.id}>
                      <button
                        className={"btn small" + (moreOpen ? " primary" : "")}
                        aria-expanded={moreOpen}
                        onClick={() => setMoreHostId(moreOpen ? null : h.id)}
                      >
                        More
                      </button>
                      {moreOpen && (
                        <div className="host-more-menu" role="menu">
                          {showAgentSetupInMore && (
                            <button
                              type="button"
                              onClick={() => {
                                setMoreHostId(null);
                                setSetupHost(h);
                              }}
                            >
                              Agent setup
                            </button>
                          )}
                          {showAgentSetupInMore && can("host.remove") && <div className="host-more-sep" />}
                          {can("host.remove") && (
                            <button
                              type="button"
                              className="danger"
                              disabled={busy === "del-host-" + h.id}
                              onClick={() => {
                                setMoreHostId(null);
                                deleteHost(h);
                              }}
                            >
                              Delete host
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {(h.orphans || []).length > 0 && (
                <div className="warn small" style={{ marginTop: 10 }}>
                  {(h.orphans || []).length} unmatched Arma process{(h.orphans || []).length === 1 ? "" : "es"}
                  {" "}(not linked to a panel instance):{" "}
                  {(h.orphans || [])
                    .map((o) => `pid ${o.pid}${o.port != null ? ` · port ${o.port}` : ""}`)
                    .join("; ")}
                  . Match an instance to that port, or stop the process on the host.
                </div>
              )}
              <div className="muted small" style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: "12px" }}>
                <span>Last seen: {formatLastSeen(h.lastSeenAt)}</span>
                {h.agentVersion && <span>Agent {h.agentVersion}</span>}
                {h.os && <span>{h.os}</span>}
                {(h.capabilities || []).length > 0 && (
                  <span>Caps: {(h.capabilities || []).join(", ")}</span>
                )}
                {h.bootstrap && (
                  <span>
                    SteamCMD {h.bootstrap.steamCmdPresent ? "ok" : "missing"}
                    {" · "}
                    Arma {h.bootstrap.armaServerPresent ? "installed" : "not installed"}
                  </span>
                )}
                <span>{hostInstances.length} instance{hostInstances.length === 1 ? "" : "s"}</span>
              </div>
              <table style={{ marginTop: 12 }}>
                <thead>
                  <tr><th>Instance</th><th>Profile</th><th>Status</th><th>Players</th><th>Port</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {hostInstances.map((i) => {
                    const lifecycle = String(i.status?.state || i.state || "").toLowerCase();
                    const isStarting = lifecycle === "starting" || busy === i.id + "start";
                    const isStopping = lifecycle === "stopping" || busy === i.id + "stop";
                    const isRestarting = busy === i.id + "restart";
                    const isUp = lifecycle === "running" || lifecycle === "starting" || !!i.status?.pid;
                    return (
                    <tr key={i.id}>
                      <td><Link to={`/instances/${i.id}`}>{i.name}</Link></td>
                      <td className="muted small">{i.currentProfileName || "—"}</td>
                      <td>
                        <StatusBadge state={i.status?.state || i.state} online={i.online} />
                        {i.status?.pid ? <span className="muted small"> · pid {i.status.pid}</span> : null}
                        {i.status?.adopted ? <span className="tag" style={{ marginLeft: 4 }}>adopted</span> : null}
                        {(i.headlessCount ?? 0) > 0 || (i.remoteHcGroups || []).length > 0 ? (
                          <div className="muted small">
                            {(i.headlessCount ?? 0) > 0 && (
                              <>
                                HC{" "}
                                {(i.status?.headless || []).filter((h) =>
                                  ["running", "connected", "starting"].includes(String(h.state).toLowerCase()),
                                ).length}
                                /{i.headlessCount} local
                              </>
                            )}
                            {(i.remoteHcGroups || []).length > 0 && (
                              <>
                                {(i.headlessCount ?? 0) > 0 ? " · " : ""}
                                {(i.remoteHcGroups || []).reduce((n, g) => n + (g.desiredCount || 0), 0)} remote
                                {" ("}
                                {(i.remoteHcGroups || []).map((g) => g.name).join(", ")}
                                {")"}
                              </>
                            )}
                          </div>
                        ) : null}
                      </td>
                      <td className="muted small">
                        {i.status?.queryOk ? (
                          <>
                            {i.status.players}/{i.status.maxPlayers}
                            {i.status.map ? <div className="muted small">{i.status.map}</div> : null}
                          </>
                        ) : i.online || i.status?.state === "running" || i.status?.state === "starting" ? (
                          <span title={i.status?.queryError || "A2S not answering yet"}>…</span>
                        ) : (
                          "—"
                        )}
                        {i.status?.uptimeSec != null && i.status.uptimeSec > 0 ? ` · ${Math.floor(i.status.uptimeSec / 60)}m` : ""}
                      </td>
                      <td className="tag">{i.port}</td>
                      <td>
                        <div className="cell-actions">
                        {can("instance.control") && <>
                          <button
                            className="btn small"
                            disabled={!!busy || !h.online || isUp || isStopping}
                            title={isStarting ? "Instance is starting…" : isUp ? "Instance is already running" : undefined}
                            onClick={() => control(i, "start")}
                          >
                            {isStarting ? "Starting…" : "Start"}
                          </button>
                          <button
                            className="btn small"
                            disabled={!!busy || !h.online || (!isUp && !isStopping)}
                            title={isStopping ? "Instance is stopping…" : undefined}
                            onClick={() => control(i, "stop")}
                          >
                            {isStopping ? "Stopping…" : "Stop"}
                          </button>
                          <button
                            className="btn small"
                            disabled={!!busy || !h.online || isStarting || isStopping || isRestarting || (!isUp && lifecycle !== "crashed")}
                            title={isStarting ? "Wait until start finishes" : undefined}
                            onClick={() => control(i, "restart")}
                          >
                            {isRestarting ? "Restarting…" : "Restart"}
                          </button>
                        </>}
                        {can("host.remove") && (
                          <button className="btn small danger" disabled={!!busy} onClick={() => deleteInstance(i)}>Delete</button>
                        )}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                  {hostInstances.length === 0 && <tr><td colSpan={6} className="muted">No game instances</td></tr>}
                </tbody>
              </table>
              <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
                {can("host.add") && <AddInstance hostId={h.id} onAdded={() => instances.reload()} />}
              </div>
              {(() => {
                const hostGroups = (hcGroups.data || []).filter((g) => g.hostId === h.id);
                const canAddHc = can("host.add");
                if (!hostGroups.length && !canAddHc) return null;
                return (
                  <div className="hc-group-list" style={{ marginTop: 12 }}>
                    <div className="row between" style={{ marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
                      <div className="muted small">Headless groups on this host</div>
                      {canAddHc && (
                        <button className="btn small" type="button" onClick={() => setAddHcHostId(h.id)}>
                          Add group
                        </button>
                      )}
                    </div>
                    {hostGroups.length > 0 ? (
                      <div className="grid" style={{ gap: 8 }}>
                        {hostGroups.map((g) => (
                          <HcGroupCard
                            key={g.id}
                            group={g}
                            canControl={can("instance.control")}
                            canEdit={can("instance.config.edit") || can("instance.control")}
                            canDelete={can("host.remove")}
                            onChanged={() => { hcGroups.reload(); instances.reload(); }}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="muted small">
                        No headless groups yet. Use these when HCs run on this host for a game server elsewhere.
                      </div>
                    )}
                  </div>
                );
              })()}
              {can("mod.manage") && steamcmdHostId === h.id && <HostSteamCmdPanel host={h} compact />}
            </div>
          );
        })}
        {(hosts.data || []).length === 0 && !hosts.loading && <div className="muted">No hosts yet. Add one to get started.</div>}
      </div>

      {setupHost !== undefined && (
        <AgentSetupWizard
          host={setupHost}
          onClose={() => setSetupHost(undefined)}
          onHostChanged={() => hosts.reload()}
        />
      )}
      {addHcHostId && (
        <AddHcGroupModal
          hostId={addHcHostId}
          instances={(instances.data || []).map((i) => ({ id: i.id, name: i.name, hostId: i.hostId }))}
          onClose={() => setAddHcHostId(null)}
          onCreated={() => { hcGroups.reload(); setAddHcHostId(null); }}
        />
      )}
      {editHost && (
        <EditHostModal
          host={editHost}
          onClose={() => setEditHost(null)}
          onSaved={() => { setEditHost(null); hosts.reload(); }}
        />
      )}
    </div>
  );
}

function AddInstance({ hostId, onAdded }: { hostId: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [port, setPort] = useState(2302);
  async function add() {
    if (!name) return;
    try {
      await api.post("/instances", { hostId, name, port });
      setName("");
      onAdded();
    } catch (e: any) { alert(e.message); }
  }
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <input style={{ maxWidth: 180 }} placeholder="New instance name" value={name} onChange={(e) => setName(e.target.value)} />
      <input style={{ maxWidth: 100 }} type="number" value={port} onChange={(e) => setPort(+e.target.value)} />
      <button className="btn small" onClick={add}>Add instance</button>
    </div>
  );
}

function EditHostModal({ host, onClose, onSaved }: { host: Host; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(host.name);
  const [armaRoot, setArmaRoot] = useState(host.armaRoot);
  const [modsLibraryPath, setModsLibraryPath] = useState(host.modsLibraryPath || "");
  const [advertiseHost, setAdvertiseHost] = useState(host.advertiseHost || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/hosts/${host.id}`, { name, armaRoot, modsLibraryPath, advertiseHost });
      onSaved();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Edit host — ${host.name}`} onClose={onClose}>
      <div className="grid" style={{ gap: 10 }}>
        <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label>Arma root path (on host)</label><input value={armaRoot} onChange={(e) => setArmaRoot(e.target.value)} /></div>
        <div>
          <label>Shared mods folder</label>
          <input
            value={modsLibraryPath}
            onChange={(e) => setModsLibraryPath(e.target.value)}
            placeholder="Empty = Steam workshop under armaRoot"
          />
          <div className="muted small" style={{ marginTop: 4 }}>
            One folder of mods that every server on this host can share. Leave empty to use Steam&apos;s default
            workshop folder under Arma root.
          </div>
        </div>
        <div>
          <label>Reachable address</label>
          <input
            value={advertiseHost}
            onChange={(e) => setAdvertiseHost(e.target.value)}
            placeholder="e.g. 192.168.1.50"
          />
          <div className="muted small" style={{ marginTop: 4 }}>
            The IP other PCs on your network use to reach this machine. Only needed when a game server and its
            headless clients run on <em>different</em> hosts — leave empty if both stay on this same PC.
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving || !name.trim()} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
