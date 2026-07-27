import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, Host, Mod } from "../api";
import { useAuth } from "../auth";
import { parseWorkshopId } from "../workshopId";
import { linkifyText } from "./linkify";
import { useToast } from "./Toast";
import { useList } from "./ui";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
import { formatTimeWithSeconds } from "../formatTime";
import { useModNameMap } from "../useModNameMap";

type SteamStatus = {
  running?: boolean;
  online?: boolean;
  workshopId?: string;
  error?: string;
  jobId?: string;
};

type SteamAccount = { id: string; label: string; username: string };

type ArmaInstall = {
  armaRoot?: string;
  armaServerPresent?: boolean;
  armaServerExe?: string;
  beta?: string;
  onCreatorBranch?: boolean;
  message?: string;
};

type ModPresence = {
  present: string[];
  missing: string[];
  sources?: Record<string, string>;
  message?: string;
};

function stamp() {
  return formatTimeWithSeconds(new Date());
}

function branchLabel(install: ArmaInstall | null): string {
  if (!install?.armaServerPresent) return "Not installed";
  if (install.onCreatorBranch) return "Creator DLC branch";
  if (install.beta) return `Branch: ${install.beta}`;
  return "Installed (branch unknown)";
}

export function HostSteamCmdPanel({
  host,
  compact,
  followOnly,
}: {
  host: Host;
  compact?: boolean;
  /** Logs + status only (no manual download/update controls). */
  followOnly?: boolean;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const modNames = useModNameMap();
  const mods = useList<Mod[]>(() => api.get("/mods"));
  const accounts = useList<SteamAccount[]>(() => api.get("/steam-accounts"));
  const [workshopInput, setWorkshopInput] = useState("");
  const [steamAccountId, setSteamAccountId] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<SteamStatus>({});
  const [install, setInstall] = useState<ArmaInstall | null>(null);
  const [installLoading, setInstallLoading] = useState(false);
  const [installError, setInstallError] = useState("");
  const [presence, setPresence] = useState<ModPresence | null>(null);
  const [presenceLoading, setPresenceLoading] = useState(false);
  const [presenceError, setPresenceError] = useState("");
  const [batchDownloading, setBatchDownloading] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const listId = `mod-workshop-ids-${host.id}`;
  const wasBusy = useRef(false);

  useEffect(() => {
    if (followOnly) return;
    if (!steamAccountId && accounts.data?.length) setSteamAccountId(accounts.data[0].id);
  }, [accounts.data, steamAccountId, followOnly]);

  useEffect(() => {
    if (!host.online) return;
    const es = new EventSource(`/api/steamcmd/logs?hostId=${encodeURIComponent(host.id)}`, { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.line) {
          setLines((prev) => [...prev.slice(-400), `[${stamp()}] ${String(msg.line)}`]);
        }
        if (msg.status) setStatus(msg.status);
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [host.id, host.online]);

  useEffect(() => {
    if (!host.online) return;
    api
      .get<SteamStatus>(`/steamcmd/status?hostId=${encodeURIComponent(host.id)}`)
      .then(setStatus)
      .catch(() => {});
  }, [host.id, host.online]);

  useEffect(() => {
    if (!host.online || followOnly) return;
    let cancelled = false;
    setInstallLoading(true);
    setInstallError("");
    api
      .get<ArmaInstall>(`/hosts/${host.id}/arma-install`)
      .then((data) => {
        if (!cancelled) setInstall(data);
      })
      .catch((e: any) => {
        if (!cancelled) setInstallError(e.message || "Could not read install status");
      })
      .finally(() => {
        if (!cancelled) setInstallLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host.id, host.online, followOnly]);

  async function refreshInstall() {
    if (!host.online || followOnly) return;
    setInstallLoading(true);
    setInstallError("");
    try {
      const data = await api.get<ArmaInstall>(`/hosts/${host.id}/arma-install`);
      setInstall(data);
    } catch (e: any) {
      setInstallError(e.message || "Could not read install status");
    } finally {
      setInstallLoading(false);
    }
  }

  async function refreshPresence() {
    if (!host.online || followOnly) return;
    setPresenceLoading(true);
    setPresenceError("");
    try {
      const data = await api.post<ModPresence>(`/hosts/${host.id}/mods/check`, {});
      setPresence(data);
    } catch (e: any) {
      setPresenceError(e.message || "Could not check mods on this host");
    } finally {
      setPresenceLoading(false);
    }
  }

  const busy = !!status.running || !!host.steamcmdRunning || batchDownloading;

  useEffect(() => {
    if (!wasBusy.current || busy || followOnly || !host.online) {
      wasBusy.current = busy;
      return;
    }
    wasBusy.current = busy;
    void refreshInstall();
    void refreshPresence();
  }, [busy, followOnly, host.online]);

  useEffect(() => {
    if (!host.online || followOnly) return;
    void refreshPresence();
  }, [host.id, host.online, followOnly, mods.data]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  function appendJobMarker(label: string) {
    setLines((prev) => [...prev, `[${stamp()}] --- ${label} ---`]);
  }

  async function startDownload() {
    const workshopId = parseWorkshopId(workshopInput);
    if (!workshopId) {
      toast.error("No workshop item", { message: "Enter a workshop ID or paste a Steam workshop link" });
      return;
    }
    if (!steamAccountId) {
      toast.error("No Steam account", { message: "Add a Steam account under Admin → Steam first" });
      return;
    }
    try {
      await downloadModById(workshopId);
      setWorkshopInput("");
    } catch (e: unknown) {
      toast.error("Download failed", { message: errorMessage(e) });
    }
  }

  async function waitUntilIdle() {
    for (let i = 0; i < 900; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await api.get<SteamStatus>(`/steamcmd/status?hostId=${encodeURIComponent(host.id)}`);
      setStatus(s);
      if (!s.running) return s;
    }
    throw new Error("Timed out waiting for the download job to finish");
  }

  async function downloadModById(workshopId: string) {
    if (!steamAccountId) {
      throw new Error("Add a Steam account under Admin → Steam first");
    }
    const r = await api.post<{ jobId: string }>("/steamcmd/download", {
      hostId: host.id,
      workshopId,
      steamAccountId,
      validate: false,
    });
    setStatus({ running: true, online: true, workshopId, jobId: r.jobId });
    appendJobMarker(`mod download ${workshopId} (${r.jobId})`);
    await waitUntilIdle();
  }

  async function downloadMissingOne(workshopId: string) {
    if (busy || noAccounts) return;
    try {
      setBatchDownloading(true);
      await downloadModById(workshopId);
      await refreshPresence();
    } catch (e: unknown) {
      toast.error("Download failed", { message: errorMessage(e) });
    } finally {
      setBatchDownloading(false);
    }
  }

  async function downloadAllMissing() {
    const ids = presence?.missing || [];
    if (!ids.length || !steamAccountId) return;
    if (!confirm(`Download ${ids.length} missing mod(s) onto this host? Jobs run one after another.`)) return;
    setBatchDownloading(true);
    try {
      for (const id of ids) {
        appendJobMarker(`batch: starting ${id}`);
        await downloadModById(id);
      }
      await refreshPresence();
    } catch (e: unknown) {
      toast.error("Batch download failed", { message: errorMessage(e) });
    } finally {
      setBatchDownloading(false);
    }
  }

  async function runServerUpdate(opts: { beta?: string; validate?: boolean; label: string }) {
    if (!steamAccountId) {
      toast.error("No Steam account", { message: "Add a Steam account under Admin → Steam first" });
      return;
    }
    if (
      !confirm(
        `${opts.label}\n\nStop running game servers on this host first. This can take a while — watch the activity log below.`,
      )
    ) {
      return;
    }
    try {
      const r = await api.post<{ jobId: string }>("/steamcmd/update-server", {
        hostId: host.id,
        steamAccountId,
        validate: !!opts.validate,
        ...(opts.beta ? { beta: opts.beta } : {}),
      });
      setStatus({ running: true, online: true, workshopId: "233780", jobId: r.jobId });
      appendJobMarker(`${opts.label} · ${r.jobId}`);
    } catch (e: unknown) {
      toast.error("Update failed", { message: errorMessage(e) });
    }
  }

  async function cancel() {
    try {
      await api.post("/steamcmd/cancel", { hostId: host.id, jobId: status.jobId });
      const s = await api.get<SteamStatus>(`/steamcmd/status?hostId=${encodeURIComponent(host.id)}`);
      setStatus(s);
    } catch (e: unknown) {
      toast.error("Cancel failed", { message: errorMessage(e) });
    }
  }

  const chip = !host.online
    ? "offline"
    : busy
      ? "busy"
      : status.error
        ? "failed"
        : "idle";

  if (!host.online) {
    return (
      <div
        className="muted small"
        style={{
          marginTop: followOnly ? 0 : 12,
          paddingTop: followOnly ? 0 : 12,
          borderTop: followOnly ? undefined : "1px solid var(--border)",
        }}
      >
        Connect the agent to download mods or manage the Arma server install.
      </div>
    );
  }

  const noAccounts = !accounts.loading && !(accounts.data || []).length;
  const armaPresent = install?.armaServerPresent === true;
  const onCreator = install?.onCreatorBranch === true;
  const missingIds = presence?.missing || [];
  const presentSet = new Set(presence?.present || []);
  const libraryMods = mods.data || [];

  return (
    <div
      style={{
        marginTop: followOnly ? 0 : 12,
        paddingTop: followOnly ? 0 : 12,
        borderTop: followOnly ? undefined : "1px solid var(--border)",
      }}
    >
      <div className="row between" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: compact || followOnly ? 14 : 16 }}>
            {followOnly ? "Host activity" : "Mods & server files"}
          </h2>
          {followOnly && (
            <div className="muted small" style={{ marginTop: 2 }}>
              Live output on <strong>{host.name}</strong>
              {" · "}
              <Link to={`/?hostId=${encodeURIComponent(host.id)}&steamcmd=1`}>Open on Dashboard</Link>
            </div>
          )}
        </div>
        <span
          className={
            "badge " +
            (chip === "busy" ? "stage-running" : chip === "failed" ? "stage-failed" : chip === "offline" ? "warn" : "stage-done")
          }
        >
          {chip}
        </span>
      </div>

      {!followOnly && noAccounts && (
        <div className="warn small" style={{ marginBottom: 10 }}>
          No Steam accounts yet. Add one under <Link to="/admin">Admin → Steam</Link>.
        </div>
      )}

      {!followOnly && (
        <>
          <div className="steam-panel-section">
            <label>Steam account</label>
            <select
              value={steamAccountId}
              onChange={(e) => setSteamAccountId(e.target.value)}
              disabled={noAccounts}
              style={{ marginTop: 4 }}
            >
              {(accounts.data || []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} ({a.username})
                </option>
              ))}
            </select>
            <div className="muted small" style={{ marginTop: 4 }}>
              Used for mod downloads and server install jobs on this host.
            </div>
          </div>

          <div className="steam-panel-section">
            <h3>Download a mod</h3>
            <p className="muted small" style={{ margin: "0 0 8px" }}>
              Paste a Steam workshop link or ID. Files land in this host&apos;s workshop folder under Arma root.
            </p>
            <label>Workshop link or ID</label>
            <input
              list={listId}
              value={workshopInput}
              onChange={(e) => setWorkshopInput(e.target.value)}
              placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=… or 450814997"
              style={{ marginTop: 4 }}
            />
            <datalist id={listId}>
              {(mods.data || []).map((m) => (
                <option key={m.id} value={m.workshopId}>
                  {m.name}
                </option>
              ))}
            </datalist>
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button className="btn small primary" onClick={startDownload} disabled={busy || noAccounts}>
                Download mod
              </button>
            </div>
          </div>

          <div className="steam-panel-section">
            <div className="row between" style={{ alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
              <div>
                <h3 style={{ margin: 0 }}>Library on this host</h3>
                <p className="muted small" style={{ margin: "6px 0 0" }}>
                  Panel library mods and whether they are on disk here.{" "}
                  <Link to="/mods">Manage library</Link>
                </p>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn small ghost"
                  disabled={presenceLoading || busy}
                  onClick={() => void refreshPresence()}
                >
                  {presenceLoading ? "Checking…" : "Refresh"}
                </button>
                {missingIds.length > 0 && (
                  <button
                    type="button"
                    className="btn small primary"
                    disabled={busy || noAccounts}
                    onClick={() => void downloadAllMissing()}
                  >
                    Download all missing ({missingIds.length})
                  </button>
                )}
              </div>
            </div>
            {presenceError && <div className="warn small" style={{ marginTop: 8 }}>{presenceError}</div>}
            {!libraryMods.length ? (
              <div className="muted small" style={{ marginTop: 8 }}>
                Library is empty. Add mods on the <Link to="/mods">Mods</Link> page first.
              </div>
            ) : (
              <div style={{ marginTop: 10, maxHeight: compact ? 180 : 240, overflow: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Mod</th>
                      <th>On host</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {libraryMods.map((m) => {
                      const onHost = presentSet.has(m.workshopId);
                      const known = presence != null;
                      return (
                        <tr key={m.id}>
                          <td>
                            <div>{m.name}</div>
                            <div className="muted small tag">{m.workshopId}</div>
                          </td>
                          <td>
                            {!known ? (
                              <span className="muted small">…</span>
                            ) : onHost ? (
                              <span className="badge stage-done">Present</span>
                            ) : (
                              <span className="badge warn">Missing</span>
                            )}
                          </td>
                          <td>
                            {known && !onHost && (
                              <button
                                type="button"
                                className="btn small"
                                disabled={busy || noAccounts}
                                onClick={() => void downloadMissingOne(m.workshopId)}
                              >
                                Download
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="steam-panel-section">
            <div className="row between" style={{ alignItems: "flex-start", gap: 8 }}>
              <h3 style={{ margin: 0 }}>Arma dedicated server</h3>
              <button type="button" className="btn small ghost" onClick={() => void refreshInstall()} disabled={installLoading || busy}>
                {installLoading ? "Checking…" : "Refresh"}
              </button>
            </div>
            <p className="muted small" style={{ margin: "6px 0 8px" }}>
              Install, update, or change the Steam branch for the dedicated server on this host.
            </p>
            {installError && <div className="warn small" style={{ marginBottom: 8 }}>{installError}</div>}
            <div className="steam-install-status">
              <div>
                <strong>{branchLabel(install)}</strong>
                {armaPresent && onCreator && (
                  <span className="tag" style={{ marginLeft: 8 }}>
                    needed for SOG / Western Sahara / etc.
                  </span>
                )}
              </div>
              {install?.armaRoot ? (
                <div className="muted small" style={{ marginTop: 4 }}>
                  {install.armaRoot}
                  {install.armaServerExe ? ` · ${install.armaServerExe.split(/[/\\]/).pop()}` : ""}
                </div>
              ) : host.armaRoot ? (
                <div className="muted small" style={{ marginTop: 4 }}>{host.armaRoot}</div>
              ) : null}
              {install?.message && !installError ? (
                <div className="muted small" style={{ marginTop: 4 }}>{install.message}</div>
              ) : null}
            </div>
            <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
              {!armaPresent ? (
                <button
                  className="btn small primary"
                  disabled={busy || noAccounts}
                  onClick={() =>
                    void runServerUpdate({
                      beta: "creatordlc",
                      label: "Install Arma dedicated server (Creator DLC)",
                    })
                  }
                >
                  Install server
                </button>
              ) : (
                <button
                  className="btn small primary"
                  disabled={busy || noAccounts}
                  onClick={() =>
                    void runServerUpdate({
                      beta: onCreator ? "creatordlc" : undefined,
                      label: onCreator ? "Update Arma server (Creator DLC)" : "Update Arma server",
                    })
                  }
                >
                  Update
                </button>
              )}
              {armaPresent && !onCreator && (
                <button
                  className="btn small"
                  disabled={busy || noAccounts}
                  onClick={() =>
                    void runServerUpdate({
                      beta: "creatordlc",
                      label: "Switch to Creator DLC branch",
                    })
                  }
                >
                  Switch to Creator DLC
                </button>
              )}
              {armaPresent && onCreator && (
                <button
                  className="btn small"
                  disabled={busy || noAccounts}
                  onClick={() =>
                    void runServerUpdate({
                      beta: "public",
                      label: "Switch to public branch (leave Creator DLC)",
                    })
                  }
                >
                  Leave Creator DLC
                </button>
              )}
              {armaPresent && (
                <button
                  className="btn small"
                  disabled={busy || noAccounts}
                  onClick={() =>
                    void runServerUpdate({
                      beta: onCreator ? "creatordlc" : install?.beta || undefined,
                      validate: true,
                      label: "Check / repair server files",
                    })
                  }
                >
                  Check server files
                </button>
              )}
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>
              To remove an install, delete files under Arma root via Browse files — there is no Steam uninstall button.
            </div>
          </div>
        </>
      )}

      <div className="steam-panel-section">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Activity</h3>
          <div className="row" style={{ gap: 8 }}>
            {can("mod.manage") && (
              <button className="btn small danger" onClick={cancel} disabled={!busy}>
                Cancel
              </button>
            )}
            <button className="btn small ghost" onClick={() => setLines([])}>
              Clear log
            </button>
          </div>
        </div>
        {status.error && (
          <div className="warn small" style={{ marginBottom: 8, whiteSpace: "pre-wrap" }}>
            {status.error.split("\n").map((line, i) => (
              <div key={i} style={{ marginTop: i ? 4 : 0 }}>
                {linkifyText(line, { modNames })}
              </div>
            ))}
          </div>
        )}
        <pre
          ref={logRef}
          className="console"
          style={{ margin: 0, maxHeight: compact || followOnly ? 220 : 280, fontSize: 12 }}
        >
          {lines.length ? lines.join("\n") : busy ? "Waiting for output…" : "No activity yet."}
        </pre>
      </div>
    </div>
  );
}
