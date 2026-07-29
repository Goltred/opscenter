import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api,
  Host,
  Instance,
  Job,
  Mission,
  MissionProfile,
  Mod,
  Modlist,
  Upload,
  setCsrf,
  uploadMissionFile,
} from "../api";
import { useAuth } from "../auth";
import { formatTimeWithSeconds } from "../formatTime";
import {
  FIRST_MISSION_OPEN_EVENT,
  computeFirstMissionProgress,
  consumePendingFirstMissionGuideOpen,
  openFirstMissionGuide,
  setFirstMissionGuideDismissed,
  shouldShowFirstMissionBanner,
  type FirstMissionProgress,
} from "../firstMissionGuide";
import { parseWorkshopId } from "../workshopId";
import { linkifyText } from "./linkify";
import { useToast } from "./Toast";
import { Modal, useList } from "./ui";
import { useModNameMap } from "../useModNameMap";

type StepId = "host" | "instance" | "mods" | "mission" | "profile" | "apply" | "start";

const STEPS: { id: StepId; label: string; optional?: boolean }[] = [
  { id: "host", label: "Host" },
  { id: "instance", label: "Instance" },
  { id: "mods", label: "Mods", optional: true },
  { id: "mission", label: "Mission", optional: true },
  { id: "profile", label: "Profile" },
  { id: "apply", label: "Apply" },
  { id: "start", label: "Start" },
];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function importModlistFile(file: File) {
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

function stepStatus(
  id: StepId,
  progress: FirstMissionProgress,
  skipped: Partial<Record<"mods" | "mission", boolean>>,
  applyJob?: Job | null,
): "ok" | "pending" {
  switch (id) {
    case "host":
      return progress.hostReady ? "ok" : "pending";
    case "instance":
      return progress.hasInstance ? "ok" : "pending";
    case "mods":
      return progress.hasMods || skipped.mods ? "ok" : "pending";
    case "mission":
      return progress.hasMission || skipped.mission ? "ok" : "pending";
    case "profile":
      return progress.hasProfile ? "ok" : "pending";
    case "apply": {
      const jobState = String(applyJob?.state || "").toLowerCase();
      if (jobState === "done" || progress.applied) return "ok";
      return "pending";
    }
    case "start":
      return progress.running ? "ok" : "pending";
  }
}

function firstIncompleteStep(
  progress: FirstMissionProgress,
  skipped: Partial<Record<"mods" | "mission", boolean>>,
  applyJob?: Job | null,
): StepId {
  for (const s of STEPS) {
    if (stepStatus(s.id, progress, skipped, applyJob) !== "ok") return s.id;
  }
  return "start";
}

function isJobActive(job: Job | null | undefined): boolean {
  const s = String(job?.state || "").toLowerCase();
  return s === "running" || s === "pending" || s === "queued";
}

function isJobDone(job: Job | null | undefined): boolean {
  return String(job?.state || "").toLowerCase() === "done";
}

function isJobFailed(job: Job | null | undefined): boolean {
  return String(job?.state || "").toLowerCase() === "failed";
}

function FirstMissionGuideWizard({ onClose }: { onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const modNames = useModNameMap();
  const hosts = useList<Host[]>(() => api.get("/hosts"));
  const instances = useList<Instance[]>(() => api.get("/instances"));
  const mods = useList<Mod[]>(() => api.get("/mods"));
  const modlists = useList<Modlist[]>(() => api.get("/modlists"));
  const missions = useList<Mission[]>(() => api.get("/missions"));
  const profiles = useList<MissionProfile[]>(() => api.get("/profiles"));
  const uploads = useList<Upload[]>(() => api.get("/uploads"));
  const accounts = useList<{ id: string; label: string; username: string }[]>(() => api.get("/steam-accounts"));

  const [step, setStep] = useState<StepId>("host");
  const [skipped, setSkipped] = useState<Partial<Record<"mods" | "mission", boolean>>>({});
  const [busy, setBusy] = useState("");
  const steppedIn = useRef(false);

  // Instance form
  const [instHostId, setInstHostId] = useState("");
  const [instName, setInstName] = useState("Main");
  const [instPort, setInstPort] = useState(2302);

  // Mods form
  const [workshopInput, setWorkshopInput] = useState("");
  const [steamAccountId, setSteamAccountId] = useState("");
  const [modMsg, setModMsg] = useState("");
  const modlistFileRef = useRef<HTMLInputElement>(null);
  const [selectedModlistId, setSelectedModlistId] = useState("");

  // Mission form
  const fileRef = useRef<HTMLInputElement>(null);
  const [missionMsg, setMissionMsg] = useState("");

  // Profile form
  const [profileName, setProfileName] = useState("First mission");
  const [missionSource, setMissionSource] = useState<"library" | "mod">("library");
  const [missionId, setMissionId] = useState("");
  const [missionTemplate, setMissionTemplate] = useState("");
  const [existingProfileId, setExistingProfileId] = useState("");

  // Apply / start
  const [applyInstanceId, setApplyInstanceId] = useState("");
  const [applyProfileId, setApplyProfileId] = useState("");
  const [applyJobId, setApplyJobId] = useState<string | null>(null);
  const [applyJob, setApplyJob] = useState<Job | null>(null);
  const [applyLogExpanded, setApplyLogExpanded] = useState(false);
  const [startRequested, setStartRequested] = useState(false);
  const [startError, setStartError] = useState("");
  const [startLines, setStartLines] = useState<{ at: string; message: string }[]>([]);
  const lastStartNote = useRef("");

  function pushStartLine(message: string) {
    if (lastStartNote.current === message) return;
    lastStartNote.current = message;
    setStartLines((prev) => [...prev, { at: new Date().toISOString(), message }]);
  }

  const progress = computeFirstMissionProgress({
    hosts: hosts.data || [],
    instances: instances.data || [],
    mods: mods.data || [],
    modlists: modlists.data || [],
    missions: missions.data || [],
    profiles: profiles.data || [],
  });

  const validation = useMemo(() => {
    const v = {} as Record<StepId, "ok" | "pending">;
    for (const s of STEPS) v[s.id] = stepStatus(s.id, progress, skipped, applyJob);
    return v;
  }, [progress, skipped, applyJob]);

  const applyRunning = isJobActive(applyJob) || busy === "apply";
  const applySucceeded = isJobDone(applyJob) || (progress.applied && !isJobFailed(applyJob) && !applyRunning);
  const applyFailed = isJobFailed(applyJob);

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const onlineHosts = (hosts.data || []).filter((h) => h.online);
  const hostList = hosts.data || [];
  const instanceList = instances.data || [];
  const profileList = profiles.data || [];
  const missionList = missions.data || [];
  const modList = mods.data || [];
  const modlistList = modlists.data || [];

  const startTarget =
    instanceList.find((i) => i.id === (applyInstanceId || progress.primaryInstanceId)) || instanceList[0] || null;
  const startState = String(startTarget?.status?.state || startTarget?.state || "").toLowerCase();
  const startUp = !!startTarget && (startState === "running" || !!startTarget.status?.pid);
  const startBusy =
    startRequested && !startUp && (busy === "start" || startState === "starting" || startRequested);
  const startFailed = startState === "crashed" || !!startError;

  useEffect(() => {
    const fast = step === "start" && startRequested && !startUp;
    const id = window.setInterval(() => {
      hosts.reload();
      instances.reload();
      mods.reload();
      modlists.reload();
      missions.reload();
      profiles.reload();
      uploads.reload();
    }, fast ? 2000 : 6000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, startRequested, startUp]);

  // Append lifecycle messages while waiting for the process.
  useEffect(() => {
    if (!startRequested || !startTarget) return;
    if (startUp) {
      const pid = startTarget.status?.pid;
      pushStartLine(pid ? `Server process is up (pid ${pid}).` : "Server process is up.");
      setBusy("");
      return;
    }
    if (startState === "starting") {
      pushStartLine("Agent reports starting…");
    } else if (startState === "crashed") {
      setStartError("Instance crashed while starting.");
      pushStartLine("Instance crashed.");
      setBusy("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startRequested, startUp, startState, startTarget?.status?.pid]);

  useEffect(() => {
    if (!instHostId && onlineHosts[0]) setInstHostId(onlineHosts[0].id);
    else if (!instHostId && hostList[0]) setInstHostId(hostList[0].id);
  }, [instHostId, onlineHosts, hostList]);

  useEffect(() => {
    if (!steamAccountId && accounts.data?.length) setSteamAccountId(accounts.data[0].id);
  }, [accounts.data, steamAccountId]);

  useEffect(() => {
    if (!applyInstanceId && instanceList[0]) setApplyInstanceId(instanceList[0].id);
  }, [applyInstanceId, instanceList]);

  useEffect(() => {
    if (!applyProfileId && profileList[0]) setApplyProfileId(profileList[0].id);
  }, [applyProfileId, profileList]);

  useEffect(() => {
    if (!missionId && missionList[0]) setMissionId(missionList[0].id);
  }, [missionId, missionList]);

  useEffect(() => {
    if (steppedIn.current) return;
    if (hosts.loading || instances.loading) return;
    steppedIn.current = true;
    setStep(firstIncompleteStep(progress, skipped, applyJob));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosts.loading, instances.loading, progress.hostReady, progress.hasInstance, progress.applied]);

  useEffect(() => {
    if (!applyJobId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const job = await api.get<Job>(`/jobs/${applyJobId}`);
        if (cancelled) return;
        setApplyJob(job);
        if (isJobDone(job) || isJobFailed(job)) {
          hosts.reload();
          instances.reload();
          profiles.reload();
          return; // stop scheduling further polls
        }
      } catch {
        /* keep last known job */
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyJobId]);

  // Advance to Start only after apply job finishes successfully.
  useEffect(() => {
    if (!applyJobId || !isJobDone(applyJob)) return;
    if (step !== "apply") return;
    const t = window.setTimeout(() => setStep("start"), 800);
    return () => window.clearTimeout(t);
  }, [applyJobId, applyJob, step]);

  function reloadAll() {
    hosts.reload();
    instances.reload();
    mods.reload();
    modlists.reload();
    missions.reload();
    profiles.reload();
    uploads.reload();
  }

  function goNext() {
    if (stepIndex < STEPS.length - 1) setStep(STEPS[stepIndex + 1].id);
  }

  function goBack() {
    if (stepIndex > 0) setStep(STEPS[stepIndex - 1].id);
  }

  function skipOptional() {
    if (step === "mods" || step === "mission") {
      setSkipped((s) => ({ ...s, [step]: true }));
      goNext();
    }
  }

  async function createInstance() {
    if (!instHostId || !instName.trim()) {
      toast.error("Missing details", { message: "Pick a host and name the instance." });
      return;
    }
    setBusy("instance");
    try {
      await api.post("/instances", { hostId: instHostId, name: instName.trim(), port: instPort });
      toast.success("Instance created");
      reloadAll();
      goNext();
    } catch (e: unknown) {
      toast.error("Could not create instance", { message: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  async function addAndDownloadMod() {
    const workshopId = parseWorkshopId(workshopInput);
    if (!workshopId) {
      toast.error("Invalid workshop ID", { message: "Paste a workshop ID or Steam URL." });
      return;
    }
    const hostId = progress.primaryHostId || instHostId || onlineHosts[0]?.id;
    if (!hostId) {
      toast.error("No host", { message: "Connect a host first." });
      return;
    }
    setBusy("mods");
    setModMsg("");
    try {
      const existing = modList.find((m) => m.workshopId === workshopId);
      if (!existing) {
        let title = workshopId;
        try {
          const meta = await api.post<Record<string, { title?: string }>>("/mods/workshop-meta", {
            workshopIds: [workshopId],
          });
          title = meta[workshopId]?.title || workshopId;
        } catch {
          /* title optional */
        }
        await api.post("/mods", { workshopId, name: title, kind: "client", bikeys: [] });
      }
      setModMsg(`Added ${workshopId} to the library.`);
      if (can("mod.manage") && onlineHosts.some((h) => h.id === hostId)) {
        if (!steamAccountId && (accounts.data || []).length === 0) {
          setModMsg((m) => m + " Add a Steam account under Admin to download onto the host.");
        } else {
          await api.post("/steamcmd/download", {
            hostId,
            workshopId,
            steamAccountId: steamAccountId || undefined,
          });
          setModMsg((m) => m + " Download started on the host — you can continue while it runs.");
        }
      }
      setWorkshopInput("");
      reloadAll();
    } catch (e: unknown) {
      toast.error("Mod step failed", { message: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  async function importModlist(file: File) {
    setBusy("modlist");
    setModMsg("");
    try {
      const data = await importModlistFile(file);
      setSelectedModlistId(data.id);
      setModMsg(
        `Imported “${data.name}” with ${data.entryCount} mod${data.entryCount === 1 ? "" : "s"}. Entries were added to the library — attach this list on the Profile step.`,
      );
      toast.success("Modlist imported", {
        message: `${data.entryCount} mods in “${data.name}”`,
      });
      reloadAll();
    } catch (e: unknown) {
      toast.error("Modlist import failed", { message: errorMessage(e) });
    } finally {
      setBusy("");
      if (modlistFileRef.current) modlistFileRef.current.value = "";
    }
  }

  async function uploadMission(file: File) {
    setBusy("mission");
    setMissionMsg("");
    try {
      const up = await uploadMissionFile(file);
      const uploadId = up?.id as string | undefined;
      if (uploadId && can("mission.manage")) {
        await api.post(`/uploads/${uploadId}/approve`);
        setMissionMsg(`Approved “${file.name}” into the mission library.`);
      } else {
        setMissionMsg(`Uploaded “${file.name}” — waiting for approval.`);
      }
      reloadAll();
    } catch (e: unknown) {
      toast.error("Upload failed", { message: errorMessage(e) });
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function approvePending(u: Upload) {
    setBusy("approve-" + u.id);
    try {
      await api.post(`/uploads/${u.id}/approve`);
      toast.success("Mission approved");
      reloadAll();
    } catch (e: unknown) {
      toast.error("Approve failed", { message: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  async function createProfile() {
    if (existingProfileId) {
      setApplyProfileId(existingProfileId);
      goNext();
      return;
    }
    if (!profileName.trim()) {
      toast.error("Name required");
      return;
    }
    if (missionSource === "library" && !missionId && missionList.length > 0) {
      toast.error("Pick a mission", { message: "Or switch to a mod mission template." });
      return;
    }
    if (missionSource === "mod" && !missionTemplate.trim()) {
      toast.error("Mission template required", {
        message: "Example: Antistasi_Ultimate.Altis (from the mod).",
      });
      return;
    }
    setBusy("profile");
    try {
      const body = {
        name: profileName.trim(),
        modlistId: selectedModlistId || null,
        missionSource,
        missionId: missionSource === "library" ? missionId || null : null,
        missionTemplate: missionSource === "mod" ? missionTemplate.trim() : "",
        mods: [] as string[],
        serverMods: [] as string[],
        serverCfgOverrides: { forcedDifficulty: "Regular" },
        basicCfgOverrides: {},
        extraArgs: [] as string[],
        dlcs: [] as string[],
        recommendedHeadlessCount: null as number | null,
      };
      const created = await api.post<{ id: string }>("/profiles", body);
      toast.success("Profile created");
      if (created?.id) setApplyProfileId(created.id);
      reloadAll();
      goNext();
    } catch (e: unknown) {
      toast.error("Could not create profile", { message: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  async function applyProfile() {
    if (!applyInstanceId || !applyProfileId) {
      toast.error("Pick instance and profile");
      return;
    }
    setBusy("apply");
    setApplyJob(null);
    setApplyJobId(null);
    setApplyLogExpanded(false);
    try {
      const r = await api.post<{ jobId?: string }>(`/profiles/${applyProfileId}/apply`, {
        instanceId: applyInstanceId,
        downloadMods: true,
        updateServer: false,
        validate: false,
        steamAccountId: steamAccountId || undefined,
      });
      if (r.jobId) {
        setApplyJobId(r.jobId);
        setApplyJob({
          id: r.jobId,
          kind: "apply_profile",
          state: "running",
          stage: "starting",
          progress: [{ stage: "starting", message: "Apply job queued…", at: new Date().toISOString() }],
        });
      } else {
        toast.success("Apply requested");
        reloadAll();
        setStep("start");
      }
    } catch (e: unknown) {
      toast.error("Apply failed", { message: errorMessage(e) });
    } finally {
      setBusy("");
    }
  }

  async function startInstance() {
    const id = applyInstanceId || progress.primaryInstanceId || instanceList[0]?.id;
    if (!id) {
      toast.error("No instance");
      return;
    }
    setBusy("start");
    setStartRequested(true);
    setStartError("");
    setStartLines([]);
    lastStartNote.current = "";
    pushStartLine("Start requested…");
    try {
      await api.post(`/instances/${id}/start`);
      pushStartLine("Waiting for the agent to launch the process…");
      instances.reload();
    } catch (e: unknown) {
      const msg = errorMessage(e);
      setStartError(msg);
      pushStartLine(`Start failed: ${msg}`);
      toast.error("Start failed", { message: msg });
      setBusy("");
      setStartRequested(false);
    }
  }

  const pendingUploads = (uploads.data || []).filter(
    (u) =>
      String(u.section || "").toLowerCase() === "mission" &&
      String(u.validationState || "").toLowerCase() === "quarantined",
  );

  const loading = hosts.loading && !hosts.data;

  return (
    <Modal
      title="Set up a mission"
      onClose={onClose}
      wide
      footer={
        <div className="row between" style={{ width: "100%", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn" disabled={stepIndex === 0 || applyRunning || startBusy} onClick={goBack}>
              Back
            </button>
            {(step === "mods" || step === "mission") && validation[step] !== "ok" && (
              <button type="button" className="btn" onClick={skipOptional}>
                Skip for now
              </button>
            )}
            {step === "start" && startUp ? (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setFirstMissionGuideDismissed(true);
                  onClose();
                }}
              >
                Done
              </button>
            ) : step === "start" && startBusy ? (
              <button type="button" className="btn primary" disabled>
                Starting…
              </button>
            ) : step === "start" && (applySucceeded || progress.applied) ? (
              <button type="button" className="btn primary" disabled={!!busy} onClick={() => void startInstance()}>
                {startFailed ? "Retry start" : "Start server"}
              </button>
            ) : step === "apply" && applyRunning ? (
              <button type="button" className="btn primary" disabled>
                Applying…
              </button>
            ) : step === "apply" && applySucceeded ? (
              <button type="button" className="btn primary" onClick={goNext}>
                Next
              </button>
            ) : step !== "start" ? (
              <button
                type="button"
                className="btn primary"
                disabled={
                  (step === "host" && !progress.hostReady) ||
                  (step === "instance" && !progress.hasInstance && !!busy) ||
                  (step === "profile" && !progress.hasProfile && !existingProfileId && !!busy) ||
                  (step === "apply" && !!busy)
                }
                onClick={() => {
                  if (step === "host") {
                    if (progress.hostReady) goNext();
                    return;
                  }
                  if (step === "instance") {
                    if (progress.hasInstance) goNext();
                    else void createInstance();
                    return;
                  }
                  if (step === "mods" || step === "mission") {
                    goNext();
                    return;
                  }
                  if (step === "profile") {
                    if (progress.hasProfile && !existingProfileId && profileList.length) {
                      if (!applyProfileId && profileList[0]) setApplyProfileId(profileList[0].id);
                      goNext();
                      return;
                    }
                    void createProfile();
                    return;
                  }
                  if (step === "apply") {
                    void applyProfile();
                    return;
                  }
                  goNext();
                }}
              >
                {step === "instance" && !progress.hasInstance
                  ? busy === "instance"
                    ? "Creating…"
                    : "Create & continue"
                  : step === "profile" && !progress.hasProfile && !existingProfileId
                    ? busy === "profile"
                      ? "Saving…"
                      : "Save & continue"
                    : step === "apply"
                      ? applyFailed
                        ? "Retry apply"
                        : "Apply profile"
                      : "Next"}
              </button>
            ) : null}
          </div>
        </div>
      }
    >
      {loading ? (
        <div className="muted">Loading…</div>
      ) : (
        <div className="setup-wizard">
          <nav className="setup-wizard-nav" aria-label="Mission setup steps">
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
                      disabled={(applyRunning || startBusy) && s.id !== step}
                      onClick={() => setStep(s.id)}
                    >
                      <span className="setup-wizard-num" title={status === "ok" ? "OK" : "Pending"}>
                        {status === "ok" ? "✓" : i + 1}
                      </span>
                      <span className="setup-wizard-label">
                        {s.label}
                        {s.optional ? <span className="muted"> · opt</span> : null}
                      </span>
                      <span className={"setup-wizard-status " + status}>
                        {status === "ok" ? "OK" : "Pending"}
                      </span>
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
                  The game host agent must be connected before you can create an instance and apply a profile.
                </p>
                {progress.hostReady ? (
                  <div className="ok-banner">
                    {onlineHosts.length} host{onlineHosts.length === 1 ? "" : "s"} connected
                    {onlineHosts[0] ? ` · ${onlineHosts[0].name}` : ""}.
                  </div>
                ) : hostList.length === 0 ? (
                  <div className="warn-banner">
                    No hosts yet. Close this guide and use <strong>Add host</strong> / Agent setup first.
                  </div>
                ) : (
                  <div className="warn-banner">
                    Host is offline. Start <code>opscenter-agent.exe</code> on the game machine, then return here.
                  </div>
                )}
              </div>
            )}

            {step === "instance" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  An instance is one dedicated-server process (name + port) on a host.
                </p>
                {progress.hasInstance ? (
                  <div className="ok-banner">
                    {instanceList.length} instance{instanceList.length === 1 ? "" : "s"} ready
                    {instanceList[0] ? ` · ${instanceList[0].name} · port ${instanceList[0].port}` : ""}.
                  </div>
                ) : (
                  <>
                    <div>
                      <label>Host</label>
                      <select value={instHostId} onChange={(e) => setInstHostId(e.target.value)}>
                        {hostList.map((h) => (
                          <option key={h.id} value={h.id} disabled={!h.online}>
                            {h.name}
                            {!h.online ? " (offline)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label>Instance name</label>
                      <input value={instName} onChange={(e) => setInstName(e.target.value)} placeholder="e.g. Main" />
                    </div>
                    <div>
                      <label>Game port</label>
                      <input
                        type="number"
                        value={instPort}
                        onChange={(e) => setInstPort(Number(e.target.value) || 2302)}
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {step === "mods" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Optional. Import an Arma Launcher modlist, add individual workshop mods, or skip and add mods later.
                </p>
                {(modList.length > 0 || modlistList.length > 0) && (
                  <div className="ok-banner">
                    {modlistList.length > 0 && (
                      <>
                        {modlistList.length} modlist{modlistList.length === 1 ? "" : "s"}
                        {modList.length > 0 ? " · " : ""}
                      </>
                    )}
                    {modList.length > 0 && (
                      <>
                        library has {modList.length} mod{modList.length === 1 ? "" : "s"}
                      </>
                    )}
                    .
                  </div>
                )}
                {can("mod.manage") ? (
                  <>
                    <div className="steam-panel-section" style={{ marginBottom: 0 }}>
                      <h3 style={{ margin: "0 0 4px", fontSize: 13 }}>Import modlist</h3>
                      <p className="muted small" style={{ margin: "0 0 8px" }}>
                        Upload a <code>modlist.html</code> from the Arma Launcher. Mods are added to the library and the
                        list can be attached on the Profile step.
                      </p>
                      <input
                        ref={modlistFileRef}
                        type="file"
                        accept=".html,.htm,text/html"
                        hidden
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void importModlist(f);
                        }}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={!!busy}
                        onClick={() => modlistFileRef.current?.click()}
                      >
                        {busy === "modlist" ? "Importing…" : "Import modlist.html"}
                      </button>
                      {modlistList.length > 0 && (
                        <div style={{ marginTop: 10 }}>
                          <label>Use this modlist on the profile</label>
                          <select value={selectedModlistId} onChange={(e) => setSelectedModlistId(e.target.value)}>
                            <option value="">None — pick later / extras only</option>
                            {modlistList.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name} ({(m.entries || []).length} mods)
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    <div className="steam-panel-section" style={{ marginBottom: 0 }}>
                      <h3 style={{ margin: "0 0 4px", fontSize: 13 }}>Add one workshop mod</h3>
                      <div className="grid" style={{ gap: 8 }}>
                        <div>
                          <label>Workshop ID or URL</label>
                          <input
                            value={workshopInput}
                            onChange={(e) => setWorkshopInput(e.target.value)}
                            placeholder="e.g. 450814997 or Steam workshop link"
                          />
                        </div>
                        {(accounts.data || []).length > 0 && (
                          <div>
                            <label>Steam account for download</label>
                            <select value={steamAccountId} onChange={(e) => setSteamAccountId(e.target.value)}>
                              {(accounts.data || []).map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.label} ({a.username})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <button
                          type="button"
                          className="btn"
                          disabled={!!busy || !workshopInput.trim()}
                          onClick={() => void addAndDownloadMod()}
                        >
                          {busy === "mods" ? "Working…" : "Add & download"}
                        </button>
                      </div>
                    </div>
                    {modMsg && <div className="ok-banner">{modMsg}</div>}
                  </>
                ) : (
                  <div className="muted small">You do not have permission to manage mods — skip this step.</div>
                )}
              </div>
            )}

            {step === "mission" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Optional. Upload a .pbo for the library, or skip and use a mod mission template on the profile step.
                </p>
                {missionList.length > 0 && (
                  <div className="ok-banner">
                    {missionList.length} mission{missionList.length === 1 ? "" : "s"} in the library.
                  </div>
                )}
                {can("mission.manage") ? (
                  <>
                    <div>
                      <label>Upload .pbo</label>
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".pbo"
                        disabled={!!busy}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void uploadMission(f);
                        }}
                      />
                    </div>
                    {missionMsg && <div className="ok-banner">{missionMsg}</div>}
                    {pendingUploads.length > 0 && (
                      <div className="grid" style={{ gap: 6 }}>
                        <div className="muted small">Waiting approval</div>
                        {pendingUploads.map((u) => (
                          <div key={u.id} className="row between" style={{ gap: 8 }}>
                            <span className="small">{u.originalName || u.id}</span>
                            <button
                              type="button"
                              className="btn small"
                              disabled={!!busy}
                              onClick={() => void approvePending(u)}
                            >
                              Approve
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="muted small">No mission-manage permission — skip, or ask an admin to approve a PBO.</div>
                )}
              </div>
            )}

            {step === "profile" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  A profile bundles mission, mods, and difficulty. Create one here, or reuse an existing profile.
                </p>
                {profileList.length > 0 && (
                  <div>
                    <label>Use existing profile</label>
                    <select
                      value={existingProfileId}
                      onChange={(e) => {
                        setExistingProfileId(e.target.value);
                        if (e.target.value) setApplyProfileId(e.target.value);
                      }}
                    >
                      <option value="">Create a new profile below…</option>
                      {profileList.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {!existingProfileId && (
                  <>
                    <div>
                      <label>Profile name</label>
                      <input value={profileName} onChange={(e) => setProfileName(e.target.value)} />
                    </div>
                    <div>
                      <label>Mission source</label>
                      <select
                        value={missionSource}
                        onChange={(e) => setMissionSource(e.target.value as "library" | "mod")}
                      >
                        <option value="library">Library PBO</option>
                        <option value="mod">Mission from a mod</option>
                      </select>
                    </div>
                    {missionSource === "library" ? (
                      <div>
                        <label>Mission</label>
                        {missionList.length === 0 ? (
                          <div className="warn-banner">
                            No library missions yet. Go back to Mission, or switch to “Mission from a mod”.
                          </div>
                        ) : (
                          <select value={missionId} onChange={(e) => setMissionId(e.target.value)}>
                            {missionList.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name || m.pboFilename}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    ) : (
                      <div>
                        <label>Mission template</label>
                        <input
                          value={missionTemplate}
                          onChange={(e) => setMissionTemplate(e.target.value)}
                          placeholder="e.g. MyMission.Altis"
                        />
                        <div className="muted small" style={{ marginTop: 4 }}>
                          Class/template name shipped inside a workshop mod.
                        </div>
                      </div>
                    )}
                    {modlistList.length > 0 && (
                      <div>
                        <label>Modlist</label>
                        <select value={selectedModlistId} onChange={(e) => setSelectedModlistId(e.target.value)}>
                          <option value="">None</option>
                          {modlistList.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} ({(m.entries || []).length} mods)
                            </option>
                          ))}
                        </select>
                        <div className="muted small" style={{ marginTop: 4 }}>
                          Attach a list from the Mods step. You can add extras later under Mission Profiles.
                        </div>
                      </div>
                    )}
                    <div className="muted small">Difficulty defaults to Regular — change later under Mission Profiles.</div>
                  </>
                )}
              </div>
            )}

            {step === "apply" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Apply writes the profile (config, mission, mods) onto the instance on the host. Stay on this step until
                  the job finishes.
                </p>
                {applySucceeded ? (
                  <div className="ok-banner">
                    Profile applied
                    {instanceList.find((i) => i.currentProfileId)?.currentProfileName
                      ? ` · ${instanceList.find((i) => i.currentProfileId)?.currentProfileName}`
                      : ""}
                    .
                  </div>
                ) : (
                  <>
                    <div>
                      <label>Instance</label>
                      <select
                        value={applyInstanceId}
                        onChange={(e) => setApplyInstanceId(e.target.value)}
                        disabled={applyRunning}
                      >
                        {instanceList.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name} · port {i.port}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label>Profile</label>
                      <select
                        value={applyProfileId}
                        onChange={(e) => setApplyProfileId(e.target.value)}
                        disabled={applyRunning}
                      >
                        {profileList.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {(accounts.data || []).length > 0 && (
                      <div>
                        <label>Steam account (for missing mods)</label>
                        <select
                          value={steamAccountId}
                          onChange={(e) => setSteamAccountId(e.target.value)}
                          disabled={applyRunning}
                        >
                          {(accounts.data || []).map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label} ({a.username})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {profileList.length === 0 && (
                      <div className="warn-banner">Create a profile on the previous step first.</div>
                    )}
                  </>
                )}

                {applyJob && (
                  <div
                    className="steam-panel-section"
                    style={{ marginBottom: 0 }}
                  >
                    <div className="row between" style={{ gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                      <strong style={{ fontSize: 13 }}>Apply progress</strong>
                      <span
                        className={
                          "badge stage-" +
                          (isJobDone(applyJob) ? "done" : isJobFailed(applyJob) ? "failed" : "running")
                        }
                      >
                        {applyJob.stage || applyJob.state}
                      </span>
                    </div>
                    {(() => {
                      const items = applyJob.progress || [];
                      const shown = applyLogExpanded ? items : items.slice(-5);
                      const hidden = !applyLogExpanded && items.length > shown.length ? items.length - shown.length : 0;
                      if (!shown.length) {
                        return <div className="muted small">Waiting for the first progress message…</div>;
                      }
                      return (
                        <div>
                          {shown.map((p, idx) => (
                            <div key={`${p.at}-${idx}`} className="muted small" style={{ marginTop: idx ? 4 : 0 }}>
                              <span className="tag" style={{ marginRight: 6 }}>
                                {p.at ? formatTimeWithSeconds(new Date(p.at)) : "--:--:--"}
                              </span>
                              {p.stage ? <span className="tag" style={{ marginRight: 6 }}>{p.stage}</span> : null}
                              {linkifyText(p.message, { modNames })}
                            </div>
                          ))}
                          {(hidden > 0 || (applyLogExpanded && items.length > 5)) && (
                            <button
                              type="button"
                              className="btn small"
                              style={{ marginTop: 8 }}
                              onClick={() => setApplyLogExpanded((v) => !v)}
                            >
                              {applyLogExpanded ? "Show less" : `Show earlier (${hidden})`}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                    {applyJob.error && (
                      <div className="error small" style={{ marginTop: 8 }}>
                        {applyJob.error}
                      </div>
                    )}
                    {applyFailed && (
                      <div className="warn-banner" style={{ marginTop: 8 }}>
                        Apply failed. Fix the issue (Steam Guard, paths, agent) and retry.
                      </div>
                    )}
                    {applyRunning && (
                      <div className="muted small" style={{ marginTop: 8 }}>
                        This can take a while if mods are downloading. The guide advances when apply finishes.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {step === "start" && (
              <div className="grid" style={{ gap: 10 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Start the instance once the profile is applied. You can also start later from the Dashboard.
                </p>
                {!applySucceeded && !progress.applied ? (
                  <div className="warn-banner">Apply a profile first, then come back to start.</div>
                ) : startUp ? (
                  <div className="ok-banner">
                    Server is up
                    {startTarget?.status?.pid ? ` · pid ${startTarget.status.pid}` : ""}
                    {startTarget ? ` · ${startTarget.name}` : ""}. Click Done to return to the dashboard.
                  </div>
                ) : startRequested || startBusy ? (
                  <div className="warn-banner">
                    Starting
                    {startTarget ? ` “${startTarget.name}”` : ""}
                    … waiting for the process to come up.
                  </div>
                ) : startFailed ? (
                  <div className="warn-banner">
                    Start did not succeed{startError ? `: ${startError}` : ""}. Retry when ready.
                  </div>
                ) : (
                  <div className="ok-banner">Profile is on the instance. Start when you are ready.</div>
                )}

                {(startRequested || startLines.length > 0) && (
                  <div className="steam-panel-section" style={{ marginBottom: 0 }}>
                    <div className="row between" style={{ gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                      <strong style={{ fontSize: 13 }}>Start progress</strong>
                      <span
                        className={
                          "badge stage-" + (startUp ? "done" : startFailed ? "failed" : "running")
                        }
                      >
                        {startUp ? "running" : startFailed ? "failed" : startState === "starting" ? "starting" : "pending"}
                      </span>
                    </div>
                    {startLines.length === 0 ? (
                      <div className="muted small">Waiting for status…</div>
                    ) : (
                      startLines.map((line, idx) => (
                        <div key={`${line.at}-${idx}`} className="muted small" style={{ marginTop: idx ? 4 : 0 }}>
                          <span className="tag" style={{ marginRight: 6 }}>
                            {formatTimeWithSeconds(new Date(line.at))}
                          </span>
                          {line.message}
                        </div>
                      ))
                    )}
                    {startBusy && !startUp && (
                      <div className="muted small" style={{ marginTop: 8 }}>
                        Polling the host for process status…
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Listens for open events; mounts the wizard. Place once under Layout. */
export function FirstMissionGuideListener() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);

  const show = can("instance.view") || can("profile.view") || can("profile.edit");

  useLayoutEffect(() => {
    if (!show) return;
    if (consumePendingFirstMissionGuideOpen()) setOpen(true);
    const onOpen = () => {
      consumePendingFirstMissionGuideOpen();
      setOpen(true);
    };
    window.addEventListener(FIRST_MISSION_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(FIRST_MISSION_OPEN_EVENT, onOpen);
  }, [show]);

  if (!show || !open) return null;
  return <FirstMissionGuideWizard onClose={() => setOpen(false)} />;
}

export function FirstMissionGuideBanner({
  hosts,
  instances,
  loading,
}: {
  hosts: Host[];
  instances: Instance[];
  loading?: boolean;
}) {
  const { can } = useAuth();
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  if (!can("instance.view") && !can("profile.view") && !can("profile.edit")) return null;
  if (!shouldShowFirstMissionBanner({ hosts, instances, loading })) return null;

  return (
    <div className="warn-banner row between" style={{ marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
      <div>
        Host is on the panel. Next: create an instance, build a mission profile, apply it, then start.
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn small primary" onClick={() => openFirstMissionGuide()}>
          Set up a mission
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setFirstMissionGuideDismissed(true);
            refresh();
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

export function FirstMissionGuideNavButton({ className }: { className?: string }) {
  const { can } = useAuth();
  if (!can("instance.view") && !can("profile.view") && !can("profile.edit")) return null;
  return (
    <button type="button" className={className || "btn ghost small"} onClick={() => openFirstMissionGuide()}>
      Mission guide
    </button>
  );
}
