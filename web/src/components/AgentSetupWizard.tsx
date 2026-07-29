import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, Host } from "../api";
import { useAuth } from "../auth";
import { useToast } from "./Toast";
import { Modal } from "./ui";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type SetupInfo = {
  hostId: string;
  name?: string;
  controlPlaneUrl: string;
  armaRoot: string;
  modsLibraryPath?: string;
  online?: boolean;
  packageAvailable?: boolean;
  packageMessage?: string | null;
  steamAccountCount?: number;
  armaServerPresent?: boolean;
};

type VerifyCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "info";
  detail?: string;
};

type BootstrapSnap = {
  armaServerPresent?: boolean;
  steamCmdPresent?: boolean;
  armaRootExists?: boolean;
  dirsCreated?: boolean;
  armaRoot?: string;
  steamCmdPath?: string;
  armaServerExe?: string;
  steamCmdHint?: string;
  modsLibraryPath?: string;
};

type SteamAccount = { id: string; label: string; username: string };

type StepId = "host" | "steam" | "package" | "install" | "start";

const STEPS: { id: StepId; label: string }[] = [
  { id: "host", label: "Host settings" },
  { id: "steam", label: "Steam account" },
  { id: "package", label: "Download package" },
  { id: "install", label: "Install & run" },
  { id: "start", label: "Verify" },
];

const DEFAULT_ARMA = "C:\\arma3server";
const DEFAULT_STEAMCMD = "C:\\steamcmd\\steamcmd.exe";

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function AgentSetupWizard({
  host: initialHost = null,
  onClose,
  onHostChanged,
}: {
  /** Existing host to set up, or null to create a new host in step 1. */
  host?: Host | null;
  onClose: () => void;
  onHostChanged?: (host?: Host) => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const isCreate = !initialHost;
  const [activeHost, setActiveHost] = useState<Host | null>(initialHost);
  const [step, setStep] = useState<StepId>("host");
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!!initialHost);

  const [name, setName] = useState(initialHost?.name || "");
  const [armaRoot, setArmaRoot] = useState(initialHost?.armaRoot || DEFAULT_ARMA);
  const [modsLibraryPath, setModsLibraryPath] = useState(initialHost?.modsLibraryPath || "");
  const [steamCmdPath, setSteamCmdPath] = useState(DEFAULT_STEAMCMD);
  const [hostSaving, setHostSaving] = useState(false);
  const [hostSaved, setHostSaved] = useState(!!initialHost);

  const [packageAvailable, setPackageAvailable] = useState<boolean | null>(null);
  const [packageMessage, setPackageMessage] = useState<string | null>(null);

  const [steamAccounts, setSteamAccounts] = useState<SteamAccount[]>([]);
  const [steamAccountId, setSteamAccountId] = useState("");
  const [steamLabel, setSteamLabel] = useState("");
  const [steamUser, setSteamUser] = useState("");
  const [steamPass, setSteamPass] = useState("");
  const [steamBusy, setSteamBusy] = useState(false);
  const [showAddSteam, setShowAddSteam] = useState(false);

  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const [prepareBusy, setPrepareBusy] = useState(false);
  const [prepareMsg, setPrepareMsg] = useState("");
  const [prepareDone, setPrepareDone] = useState(false);
  const [verifyChecks, setVerifyChecks] = useState<VerifyCheck[] | null>(null);

  const [liveOnline, setLiveOnline] = useState(!!initialHost?.online);
  const [armaPresent, setArmaPresent] = useState(initialHost?.bootstrap?.armaServerPresent === true);

  async function loadPackageStatus() {
    try {
      const s = await api.get<{ packageAvailable: boolean; packageMessage: string | null }>("/agent-package/status");
      setPackageAvailable(s.packageAvailable);
      setPackageMessage(s.packageMessage);
    } catch {
      setPackageAvailable(false);
    }
  }

  async function loadSetup(hostId: string) {
    setLoading(true);
    try {
      const data = await api.get<SetupInfo>(`/hosts/${hostId}/agent-setup`);
      setInfo(data);
      setLiveOnline(!!data.online);
      setArmaPresent(!!data.armaServerPresent);
      if (data.name) setName(data.name);
      if (data.armaRoot) setArmaRoot(data.armaRoot);
      if (data.modsLibraryPath != null) setModsLibraryPath(data.modsLibraryPath);
      if (data.packageAvailable != null) setPackageAvailable(data.packageAvailable);
      if (data.packageMessage !== undefined) setPackageMessage(data.packageMessage);
      setError("");
    } catch (e: any) {
      setError(e.message || "failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function loadSteam() {
    try {
      const rows = await api.get<SteamAccount[]>("/steam-accounts");
      setSteamAccounts(rows || []);
      setInfo((prev) => (prev ? { ...prev, steamAccountCount: (rows || []).length } : prev));
      setSteamAccountId((prev) => {
        if (prev && rows?.some((a) => a.id === prev)) return prev;
        return rows?.[0]?.id || "";
      });
      if (!(rows || []).length) setShowAddSteam(true);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadPackageStatus();
    loadSteam();
    if (initialHost) void loadSetup(initialHost.id);
    else setLoading(false);
  }, [initialHost?.id]);

  useEffect(() => {
    if (!activeHost) return;
    if (step !== "install" && step !== "start") return;
    const t = setInterval(async () => {
      try {
        const data = await api.get<SetupInfo>(`/hosts/${activeHost.id}/agent-setup`);
        setInfo((prev) => (prev ? { ...prev, ...data } : data));
        setLiveOnline(!!data.online);
        setArmaPresent(!!data.armaServerPresent);
        if (data.online) onHostChanged?.(activeHost);
      } catch {
        /* ignore */
      }
    }, 2500);
    return () => clearInterval(t);
  }, [step, activeHost?.id]);

  const hostFieldsOk =
    name.trim().length > 0 && armaRoot.trim().length > 0 && steamCmdPath.trim().length > 0;

  const steamCount = steamAccounts.length || info?.steamAccountCount || 0;
  const packageOk = packageAvailable === true || info?.packageAvailable === true;
  const stepIndex = STEPS.findIndex((s) => s.id === step);

  const validation = useMemo(() => {
    const hostStatus: "ok" | "pending" = hostFieldsOk && (hostSaved || !!activeHost) ? "ok" : hostFieldsOk ? "ok" : "pending";
    const steamStatus: "ok" | "pending" = steamCount > 0 ? "ok" : "pending";
    const packageStatus: "ok" | "pending" =
      downloaded || stepIndex > STEPS.findIndex((s) => s.id === "package") ? "ok" : "pending";
    const installStatus: "ok" | "pending" = liveOnline ? "ok" : "pending";
    const startStatus: "ok" | "pending" = armaPresent || prepareDone ? "ok" : "pending";
    return {
      host: hostStatus,
      steam: steamStatus,
      package: packageStatus,
      install: installStatus,
      start: startStatus,
    };
  }, [hostFieldsOk, hostSaved, activeHost, steamCount, downloaded, stepIndex, liveOnline, armaPresent, prepareDone]);

  /** Create host if needed, or patch existing. Returns the host id. */
  async function ensureHostSaved(): Promise<Host> {
    if (!hostFieldsOk) {
      throw new Error("Name, Arma root, and SteamCMD path are required");
    }
    if (!activeHost) {
      const created = await api.post<Host>("/hosts", {
        name: name.trim(),
        armaRoot: armaRoot.trim(),
        modsLibraryPath: modsLibraryPath.trim(),
      });
      const host: Host = {
        ...created,
        online: false,
        status: created.status || "offline",
        allowReboot: false,
      };
      setActiveHost(host);
      setHostSaved(true);
      await loadSetup(host.id);
      onHostChanged?.(host);
      return host;
    }
    await api.patch(`/hosts/${activeHost.id}`, {
      name: name.trim(),
      armaRoot: armaRoot.trim(),
      modsLibraryPath: modsLibraryPath.trim(),
    });
    const updated = {
      ...activeHost,
      name: name.trim(),
      armaRoot: armaRoot.trim(),
      modsLibraryPath: modsLibraryPath.trim(),
    };
    setActiveHost(updated);
    setHostSaved(true);
    await loadSetup(activeHost.id);
    onHostChanged?.(updated);
    return updated;
  }

  async function goNext() {
    if (step === "host") {
      if (!hostFieldsOk) {
        toast.error("Missing host settings", { message: "Name, Arma root, and SteamCMD path are required" });
        return;
      }
      setHostSaving(true);
      try {
        await ensureHostSaved();
      } catch (e: unknown) {
        toast.error("Save host failed", { message: errorMessage(e) });
        setHostSaving(false);
        return;
      }
      setHostSaving(false);
    }
    if (stepIndex < STEPS.length - 1) setStep(STEPS[stepIndex + 1].id);
  }

  async function jumpToStep(id: StepId) {
    const targetIndex = STEPS.findIndex((s) => s.id === id);
    if (targetIndex > 0 && !activeHost) {
      if (!hostFieldsOk) {
        toast.error("Missing host settings", { message: "Fill host settings first (name, Arma root, SteamCMD path)." });
        setStep("host");
        return;
      }
      setHostSaving(true);
      try {
        await ensureHostSaved();
      } catch (e: unknown) {
        toast.error("Save host failed", { message: errorMessage(e) });
        setHostSaving(false);
        return;
      }
      setHostSaving(false);
    }
    setStep(id);
  }

  async function addSteamAccount() {
    if (!steamLabel.trim() || !steamUser.trim() || !steamPass) {
      toast.error("Missing details", { message: "Label, username, and password are required" });
      return;
    }
    setSteamBusy(true);
    try {
      const created = await api.post<{ id: string }>("/steam-accounts", {
        label: steamLabel.trim(),
        username: steamUser.trim(),
        password: steamPass,
      });
      setSteamLabel("");
      setSteamUser("");
      setSteamPass("");
      setShowAddSteam(false);
      await loadSteam();
      if (created?.id) setSteamAccountId(created.id);
      if (activeHost) await loadSetup(activeHost.id);
    } catch (e: unknown) {
      toast.error("Add account failed", { message: errorMessage(e) });
    } finally {
      setSteamBusy(false);
    }
  }

  async function downloadPackage() {
    if (!hostFieldsOk) {
      toast.error("Missing host settings", { message: "Fill host settings first (name, Arma root, SteamCMD path)." });
      setStep("host");
      return;
    }
    setDownloading(true);
    try {
      const host = await ensureHostSaved();
      const { blob, filename } = await api.downloadPost(`/hosts/${host.id}/agent-package`, {
        steamCmdPath: steamCmdPath.trim(),
      });
      triggerBlobDownload(blob, filename || `opscenter-agent-${name}.zip`);
      setDownloaded(true);
      await loadSetup(host.id);
    } catch (e: unknown) {
      toast.error("Download failed", { message: errorMessage(e) });
    } finally {
      setDownloading(false);
    }
  }

  function buildVerifyChecks(opts: {
    online: boolean;
    steamOk: boolean;
    bootstrap?: BootstrapSnap | null;
    status?: string;
    error?: string;
    installing?: boolean;
  }): VerifyCheck[] {
    const b = opts.bootstrap || {};
    const checks: VerifyCheck[] = [
      {
        id: "agent",
        label: "Agent connected",
        status: opts.online ? "pass" : "fail",
        detail: opts.online ? undefined : "Finish Install & run first",
      },
      {
        id: "steam",
        label: "Steam account on panel",
        status: opts.steamOk ? "pass" : "warn",
        detail: opts.steamOk ? undefined : "Needed only if Arma must be downloaded",
      },
    ];

    if (b.armaRoot != null || b.armaRootExists != null || b.dirsCreated != null) {
      const rootOk = b.armaRootExists === true || b.dirsCreated === true;
      checks.push({
        id: "dirs",
        label: "Arma root / folders",
        status: rootOk ? "pass" : "fail",
        detail: b.armaRoot ? String(b.armaRoot) : b.dirsCreated ? "Created" : "Missing",
      });
    }

    if (b.steamCmdPresent != null || b.steamCmdPath) {
      checks.push({
        id: "steamcmd",
        label: "SteamCMD on host",
        status: b.steamCmdPresent === true ? "pass" : "fail",
        detail:
          b.steamCmdPresent === true
            ? String(b.steamCmdPath || "")
            : String(b.steamCmdHint || b.steamCmdPath || "Not found at steamCmdPath"),
      });
    }

    if (b.armaServerPresent != null) {
      checks.push({
        id: "arma",
        label: "Arma dedicated server",
        status: b.armaServerPresent === true ? "pass" : opts.installing ? "info" : "warn",
        detail:
          b.armaServerPresent === true
            ? String(b.armaServerExe || "Found under armaRoot")
            : opts.installing
              ? "Install started (Creator DLC server build)"
              : "Not installed under armaRoot yet",
      });
    }

    if (opts.installing) {
      checks.push({
        id: "install",
        label: "Server install job",
        status: "info",
        detail: "Downloading Creator DLC server build — open Mods & server on the host card for the log",
      });
    }

    if (opts.error || opts.status === "failed") {
      checks.push({
        id: "error",
        label: "Verify result",
        status: "fail",
        detail: opts.error || "Bootstrap checks did not complete successfully",
      });
    } else if (opts.status === "ok" || opts.status === "installing") {
      checks.push({
        id: "result",
        label: "Verify result",
        status: "pass",
        detail: opts.installing ? "Bootstrap OK; install in progress" : "All checks completed",
      });
    }

    return checks;
  }

  async function startHostAction() {
    if (!activeHost) return;
    setPrepareBusy(true);
    setPrepareMsg("");
    setVerifyChecks(null);
    try {
      const res = await api.post<{
        status: string;
        jobId?: string;
        result?: { message?: string; error?: string; data?: BootstrapSnap };
        error?: string;
        bootstrap?: BootstrapSnap;
      }>(`/hosts/${activeHost.id}/prepare`, {
        ensureSteamCmd: true,
        ensureDirs: true,
        installServer: true,
        steamAccountId: steamAccountId || undefined,
      });
      const bootstrap = res.bootstrap || res.result?.data || null;
      const installing = res.status === "installing";
      setVerifyChecks(
        buildVerifyChecks({
          online: true,
          steamOk: steamCount > 0,
          bootstrap,
          status: res.status,
          error: res.status === "failed" ? res.error || res.result?.error || res.result?.message : undefined,
          installing,
        }),
      );
      if (installing) {
        setPrepareMsg(
          res.result?.message ||
            "Downloading Arma dedicated server (Creator DLC build) — open Mods & server on the host card for the log.",
        );
      } else {
        setPrepareMsg(res.result?.message || "");
      }
      if (bootstrap?.armaServerPresent === true) setArmaPresent(true);
      if (res.status === "ok" || installing) setPrepareDone(true);
      await loadSetup(activeHost.id);
      onHostChanged?.(activeHost);
    } catch (e: any) {
      const data = e instanceof ApiError ? e.data : undefined;
      const bootstrap = (data?.bootstrap || (data?.result as { data?: BootstrapSnap } | undefined)?.data) as
        | BootstrapSnap
        | undefined;
      setVerifyChecks(
        buildVerifyChecks({
          online: liveOnline,
          steamOk: steamCount > 0,
          bootstrap: bootstrap || null,
          error: e.message || "Verify failed",
        }),
      );
      setPrepareMsg(e.message);
    } finally {
      setPrepareBusy(false);
    }
  }

  function goBack() {
    if (stepIndex > 0) setStep(STEPS[stepIndex - 1].id);
  }

  const title = activeHost
    ? `Agent setup — ${name || activeHost.name}`
    : "Add host";

  const showBody = !loading || !!info || isCreate;

  return (
    <Modal title={title} onClose={onClose} wide>
      {error && <div className="error">{error}</div>}
      {loading && !info && initialHost && <div className="muted">Loading…</div>}
      {showBody && (
        <div className="setup-wizard">
          <nav className="setup-wizard-nav" aria-label="Setup steps">
            <ul>
              {STEPS.map((s, i) => {
                const status = validation[s.id];
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={
                        "setup-wizard-step" +
                        (s.id === step ? " active" : "") +
                        (status === "ok" ? " done" : " pending")
                      }
                      onClick={() => void jumpToStep(s.id)}
                    >
                      <span className="setup-wizard-num" title={status === "ok" ? "OK" : "Pending"}>
                        {status === "ok" ? "✓" : i + 1}
                      </span>
                      <span className="setup-wizard-label">{s.label}</span>
                      <span className={"setup-wizard-status " + status}>{status === "ok" ? "OK" : "Pending"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="setup-wizard-body">
            {step === "host" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  {isCreate && !activeHost
                    ? "Fill in the paths below, then click Next to create the host and continue."
                    : "Update paths below, then click Next to save and continue. These paths go into the agent package when you download it."}
                </p>
                <div>
                  <label>Name</label>
                  <input value={name} onChange={(e) => { setName(e.target.value); setHostSaved(false); }} placeholder="e.g. Game box" />
                </div>
                <div>
                  <label>Arma root (on game host)</label>
                  <input value={armaRoot} onChange={(e) => { setArmaRoot(e.target.value); setHostSaved(false); }} />
                </div>
                <div>
                  <label>SteamCMD path (on game host)</label>
                  <input
                    value={steamCmdPath}
                    onChange={(e) => { setSteamCmdPath(e.target.value); setHostSaved(false); }}
                    placeholder={DEFAULT_STEAMCMD}
                  />
                  <div className="muted small" style={{ marginTop: 4 }}>
                    Path to <code>steamcmd.exe</code> on the game host (not the panel). Install from{" "}
                    <a href="https://developer.valvesoftware.com/wiki/SteamCMD" target="_blank" rel="noreferrer">
                      Valve SteamCMD
                    </a>{" "}
                    if needed — Verify does not download SteamCMD itself.
                  </div>
                </div>
                <div>
                  <label>Shared mods folder (optional)</label>
                  <input
                    value={modsLibraryPath}
                    onChange={(e) => { setModsLibraryPath(e.target.value); setHostSaved(false); }}
                    placeholder="Empty = Steam workshop under armaRoot"
                  />
                  <div className="muted small" style={{ marginTop: 4 }}>
                    One folder of mods that every server on this host can share. Leave empty to use Steam&apos;s
                    default workshop folder under Arma root.
                  </div>
                </div>
                {activeHost && info && (
                  <div className="muted small">
                    Host ID <span className="tag">{info.hostId}</span> · Gateway{" "}
                    <span className="tag">{info.controlPlaneUrl}</span>
                  </div>
                )}
                {!hostFieldsOk && <div className="warn-banner">Name, Arma root, and SteamCMD path are required.</div>}
              </div>
            )}

            {step === "steam" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Steam credentials stay on the panel. Needed later to install/update Arma and mods.
                </p>
                {steamCount > 0 ? (
                  <>
                    <div className="ok-banner">
                      {steamCount} account{steamCount === 1 ? "" : "s"} available.
                    </div>
                    <div>
                      <label>Account for installs and downloads</label>
                      <select value={steamAccountId} onChange={(e) => setSteamAccountId(e.target.value)}>
                        {steamAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label} ({a.username})
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <div className="warn-banner">No Steam account yet — add one before Verify can install Arma.</div>
                )}

                {can("steam.config") ? (
                  <div className="grid" style={{ gap: 8 }}>
                    {!showAddSteam ? (
                      <button type="button" className="btn" onClick={() => setShowAddSteam(true)}>
                        Add another Steam account
                      </button>
                    ) : (
                      <>
                        <div className="muted small">New account</div>
                        <input placeholder="Label" value={steamLabel} onChange={(e) => setSteamLabel(e.target.value)} />
                        <input placeholder="Steam username" value={steamUser} onChange={(e) => setSteamUser(e.target.value)} />
                        <input
                          type="password"
                          placeholder="Steam password"
                          value={steamPass}
                          onChange={(e) => setSteamPass(e.target.value)}
                        />
                        <div className="row" style={{ gap: 8 }}>
                          {steamCount > 0 && (
                            <button type="button" className="btn" onClick={() => setShowAddSteam(false)}>
                              Cancel
                            </button>
                          )}
                          <button type="button" className="btn primary" disabled={steamBusy} onClick={addSteamAccount}>
                            {steamBusy ? "Saving…" : "Save Steam account"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="muted small">
                    You need permission to add Steam accounts. Ask an admin, or open{" "}
                    <Link to="/admin">Admin → Steam</Link>.
                  </p>
                )}
              </div>
            )}

            {step === "package" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Download a zip with the agent program and a config file that already has your paths and enroll token.
                </p>
                {!packageOk && (
                  <div className="error">{packageMessage || info?.packageMessage || "Agent binary not available on the panel server."}</div>
                )}
                <div className="kv">
                  <div>Arma root</div>
                  <div className="tag">{armaRoot}</div>
                  <div>SteamCMD</div>
                  <div className="tag">{steamCmdPath}</div>
                  <div>Shared mods</div>
                  <div className="tag">{modsLibraryPath.trim() || "(Steam workshop under armaRoot)"}</div>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={downloading || !packageOk || !hostFieldsOk}
                  onClick={downloadPackage}
                >
                  {downloading ? "Building zip…" : "Download agent package (.zip)"}
                </button>
                {downloaded && (
                  <div className="ok-banner">Package downloaded. Continue to Install & run on the game host.</div>
                )}
              </div>
            )}

            {step === "install" && (
              <div className="grid" style={{ gap: 10 }}>
                <ol className="setup-instructions">
                  <li>
                    Copy the zip to the game host and extract it (e.g. <span className="tag">C:\opscenter-agent</span>).
                  </li>
                  <li>Check that the Arma root and SteamCMD paths in the config match this host.</li>
                  <li>
                    Install{" "}
                    <a href="https://developer.valvesoftware.com/wiki/SteamCMD" target="_blank" rel="noreferrer">
                      SteamCMD
                    </a>{" "}
                    at that path if it is not already there.
                  </li>
                  <li>
                    Run <span className="tag">opscenter-agent.exe</span>.
                  </li>
                  <li>Optional: install as a Windows service (see README.txt in the zip).</li>
                </ol>
                {info?.controlPlaneUrl && (
                  <p className="muted small" style={{ margin: 0 }}>
                    The agent dials <span className="tag">{info.controlPlaneUrl}</span>. On the panel firewall, allow
                    inbound on the agent port (default 8443). Game hosts only need outbound access. If this URL says
                    localhost but the game host is another PC, fix <code>OC_PUBLIC_URL</code> and download a new
                    package.
                  </p>
                )}
                <div className="row" style={{ gap: 10, alignItems: "center", marginTop: 4 }}>
                  <span className="badge" style={{ fontSize: 14 }}>
                    <span className={"dot " + (liveOnline ? "green" : "")} />
                    {liveOnline ? "agent connected" : "waiting for agent…"}
                  </span>
                  {activeHost && (
                    <button type="button" className="btn small" onClick={() => loadSetup(activeHost.id)}>
                      Refresh now
                    </button>
                  )}
                </div>
                {liveOnline ? (
                  <div className="ok-banner">Connected. Continue to Verify when you are ready.</div>
                ) : (
                  <div className="warn-banner">Start the agent on the game host — this step polls until it connects.</div>
                )}
              </div>
            )}

            {step === "start" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Check folders and SteamCMD on the host. If Arma is missing, this step also starts downloading the
                  dedicated server (Creator DLC build — needed for SOG, Western Sahara, and similar).
                </p>
                <button
                  type="button"
                  className="btn primary"
                  disabled={prepareBusy || !liveOnline || !activeHost}
                  title={!liveOnline ? "Agent must be connected first" : undefined}
                  onClick={startHostAction}
                >
                  {prepareBusy ? "Verifying…" : "Verify host"}
                </button>
                {!liveOnline && (
                  <div className="muted small">Agent is offline — finish Install & run before verifying.</div>
                )}
                {verifyChecks && verifyChecks.length > 0 && (
                  <div className="setup-check-list">
                    <div className="muted small" style={{ marginBottom: 6 }}>
                      Check results
                    </div>
                    <ul>
                      {verifyChecks.map((c) => (
                        <li key={c.id} className={"setup-check setup-check-" + c.status}>
                          <span className="setup-check-mark" aria-hidden>
                            {c.status === "pass" ? "✓" : c.status === "fail" ? "✕" : c.status === "warn" ? "!" : "i"}
                          </span>
                          <span className="setup-check-body">
                            <strong>{c.label}</strong>
                            <span className="setup-check-status">
                              {c.status === "pass"
                                ? "Passed"
                                : c.status === "fail"
                                  ? "Failed"
                                  : c.status === "warn"
                                    ? "Warning"
                                    : "Info"}
                            </span>
                            {c.detail ? <div className="muted small">{c.detail}</div> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {prepareMsg && !verifyChecks && <div className="muted small">{prepareMsg}</div>}
              </div>
            )}

            <div className="row" style={{ marginTop: 16, flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn" disabled={stepIndex === 0} onClick={goBack}>
                Back
              </button>
              {stepIndex < STEPS.length - 1 ? (
                <button type="button" className="btn primary" disabled={hostSaving} onClick={() => void goNext()}>
                  {step === "host" && !activeHost ? "Create & next" : "Next"}
                </button>
              ) : (
                <button type="button" className="btn primary" onClick={onClose}>
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
