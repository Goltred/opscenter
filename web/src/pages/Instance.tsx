import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, Host, Instance, Job, MissionProfile } from "../api";
import { useAuth } from "../auth";
import { ApplyProfileModal, type ApplyProfileOpts } from "../components/ApplyProfileModal";
import { HostSteamCmdPanel } from "../components/HostSteamCmdPanel";
import { InstanceHeadlessPanel } from "../components/InstanceHeadlessPanel";
import { linkifyText } from "../components/linkify";
import { useToast } from "../components/Toast";
import { StatusBadge, useList } from "../components/ui";

export function InstancePage() {
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  const focusJobId = searchParams.get("job") || "";
  const { can } = useAuth();
  const toast = useToast();
  const inst = useList<Instance>(() => api.get(`/instances/${id}`), [id]);
  const hosts = useList<Host[]>(() => api.get("/hosts"));
  const jobs = useList<Job[]>(() => api.get(`/instances/${id}/jobs`), [id]);
  const profiles = useList<MissionProfile[]>(() => api.get("/profiles"));
  const allInstances = useList<Instance[]>(() => api.get("/instances"));
  const [lines, setLines] = useState<string[]>([]);
  const [consoleLive, setConsoleLive] = useState(false);
  const [rcon, setRcon] = useState("");
  const [syncingKeys, setSyncingKeys] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [applyTarget, setApplyTarget] = useState<MissionProfile | null>(null);
  const [applying, setApplying] = useState(false);
  const [controlling, setControlling] = useState("");
  const [lastLaunch, setLastLaunch] = useState<{
    action: string;
    at: string;
    mods: number;
    mission: string | null;
    warning?: string;
    modArg?: string;
    autoInit?: boolean;
  } | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!consoleLive || !id) return;
    const es = new EventSource(`/api/instances/${id}/logs`, { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        const r = JSON.parse(ev.data);
        if (r.logLine || r.line) setLines((l) => [...l.slice(-500), r.logLine || r.line]);
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [id, consoleLive]);

  useEffect(() => {
    consoleRef.current?.scrollTo(0, consoleRef.current.scrollHeight);
  }, [lines]);

  useEffect(() => {
    const t = window.setInterval(() => {
      inst.reload();
      hosts.reload();
      jobs.reload();
      profiles.reload();
    }, 4000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const list = profiles.data || [];
    if (!list.length) {
      setProfileId("");
      return;
    }
    if (profileId && list.some((p) => p.id === profileId)) return;
    const current = inst.data?.currentProfileId;
    if (current && list.some((p) => p.id === current)) {
      setProfileId(current);
      return;
    }
    setProfileId(list[0].id);
  }, [profiles.data, inst.data?.currentProfileId, profileId]);

  useEffect(() => {
    if (!focusJobId) return;
    const t = window.setTimeout(() => {
      document.getElementById(`job-${focusJobId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
    return () => window.clearTimeout(t);
  }, [focusJobId, jobs.data]);

  async function control(action: string) {
    setControlling(action);
    try {
      const r = await api.post<{
        warning?: string;
        launchSummary?: { mods?: number; mission?: string | null; autoInit?: boolean };
        args?: string[];
        result?: { data?: { modCount?: number } };
      }>(`/instances/${id}/${action}`);
      if (action === "start" || action === "restart") {
        const modArg = (r.args || []).find((a) => a.toLowerCase().startsWith("-mod="));
        const mods =
          r.launchSummary?.mods ??
          r.result?.data?.modCount ??
          (modArg ? modArg.split("=")[1]?.split(";").filter(Boolean).length || 0 : 0);
        const mission = r.launchSummary?.mission ?? null;
        const autoInit =
          r.launchSummary?.autoInit ??
          (r.args || []).some((a) => a.toLowerCase() === "-autoinit");
        setLastLaunch({
          action,
          at: new Date().toISOString(),
          mods,
          mission,
          warning: r.warning,
          modArg,
          autoInit,
        });
        if (r.warning) {
          toast.info(`${action} requested`, { message: r.warning, ttlMs: 14_000 });
        } else {
          toast.success(`${action} requested`, {
            message: `${mods} mod path(s)${mission ? ` · mission ${mission}` : " · no mission template"}${
              autoInit ? " · -autoInit" : ""
            }`,
            ttlMs: 12_000,
          });
        }
      } else {
        toast.success(`${action} requested`);
      }
      setTimeout(() => inst.reload(), 800);
    } catch (e: any) {
      toast.error(`${action} failed`, { message: e.message });
    } finally {
      setControlling("");
    }
  }
  async function sendRcon() {
    if (!rcon.trim()) return;
    try {
      await api.post(`/instances/${id}/rcon`, { command: rcon });
      setRcon("");
      toast.info("RCON sent");
    } catch (e: any) { toast.error("RCON failed", { message: e.message }); }
  }

  async function syncKeys() {
    setSyncingKeys(true);
    try {
      const r = await api.post<{
        result?: { message?: string; data?: { copiedCount?: number; unchangedCount?: number; modsWithoutKeys?: string[] } };
      }>(`/instances/${id}/sync-keys`, {});
      const d = r.result?.data;
      toast.success("Mod keys synced", {
        message:
          r.result?.message ||
          `${d?.copiedCount ?? 0} copied, ${d?.unchangedCount ?? 0} already present` +
            (d?.modsWithoutKeys?.length ? `; ${d.modsWithoutKeys.length} mod(s) had no .bikey` : ""),
      });
    } catch (e: any) {
      toast.error("Key sync failed", { message: e.message });
    } finally {
      setSyncingKeys(false);
    }
  }

  async function runApply(p: MissionProfile, opts: ApplyProfileOpts) {
    setApplying(true);
    setApplyTarget(null);
    try {
      const r = await api.post<{ jobId: string; instanceId: string; profileName?: string }>(`/profiles/${p.id}/apply`, opts);
      const jobQs = r.jobId ? `?job=${encodeURIComponent(r.jobId)}` : "";
      toast.success(`Apply started — “${r.profileName || p.name}”`, {
        ttlMs: 10_000,
      });
      if (r.jobId && jobQs) {
        window.history.replaceState(null, "", `/instances/${id}${jobQs}`);
      }
      jobs.reload();
      inst.reload();
      profiles.reload();
    } catch (e: any) {
      toast.error("Apply failed", { message: e.message });
    } finally {
      setApplying(false);
    }
  }

  if (inst.error) return <div className="error">{inst.error}</div>;
  if (!inst.data) return <div className="muted">Loading…</div>;
  const i = inst.data;
  const st = i.status;
  const host = (hosts.data || []).find((h) => h.id === i.hostId);
  const profileList = profiles.data || [];
  const selectedProfile = profileList.find((p) => p.id === profileId) || null;
  const jobList = jobs.data || [];
  const activeApply = jobList.find((j) => j.kind === "apply_profile" && (j.state === "running" || j.state === "pending"));
  const focused = focusJobId ? jobList.find((j) => j.id === focusJobId) : undefined;
  const highlight = focused || activeApply;
  const showSteamFollow =
    !!host &&
    (host.steamcmdRunning ||
      !!activeApply ||
      (focused?.kind === "apply_profile" && (focused.state === "running" || focused.state === "pending")));
  const lifecycle = String(st?.state || i.state || "").toLowerCase();
  const isStarting = lifecycle === "starting" || controlling === "start";
  const isStopping = lifecycle === "stopping" || controlling === "stop";
  const isRestarting = controlling === "restart";
  const isUp = lifecycle === "running" || lifecycle === "starting" || !!st?.pid;
  const controlBusy = !!controlling || !!activeApply;
  const startDisabled = !i.online || controlBusy || isUp || isStopping;
  const stopDisabled = !i.online || controlBusy || (!isUp && !isStopping);
  const restartDisabled = !i.online || controlBusy || isStarting || isStopping || (!isUp && lifecycle !== "crashed");

  return (
    <div>
      <div className="page-head row between">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ margin: 0 }}>{i.name}</h1>
          <StatusBadge state={st?.state || i.state} online={i.online} />
          <span className="tag">port {i.port}</span>
          {st?.pid ? <span className="tag">pid {st.pid}</span> : null}
          {(i.headlessCount ?? 0) > 0 || (st?.headless || []).length > 0 ? (
            <span className="tag" title="Local headless clients">
              HC {(st?.headless || []).filter((h) => ["running", "connected", "starting"].includes(String(h.state).toLowerCase())).length}
              /{i.headlessCount ?? 0}
            </span>
          ) : null}
          <span className="muted small">
            players {st?.players ?? 0}/{st?.maxPlayers ?? 0}
            {st?.uptimeSec != null && st.uptimeSec > 0 ? ` · up ${Math.floor(st.uptimeSec / 60)}m` : ""}
          </span>
          {st?.adopted && (
            <span className="tag" title="Agent reattached to a process that was already running">adopted</span>
          )}
          {i.online && (
            <span
              className="tag"
              title={st?.queryOk ? `A2S ok on UDP ${st.queryPort || i.port + 1}` : st?.queryError || "Waiting for Steam query…"}
            >
              {st?.queryOk || st?.state === "running" ? "browser: up" : st?.state === "starting" ? "browser: …" : "browser: —"}
            </span>
          )}
          {host && (
            <span className="muted small">
              on{" "}
              <Link to={`/?hostId=${encodeURIComponent(host.id)}`} title="Open host on Dashboard">
                <strong>{host.name}</strong>
              </Link>
              {host.online ? " · agent connected" : " · agent offline"}
              {host.steamcmdRunning ? " · file job busy" : ""}
            </span>
          )}
        </div>
        <div className="row">
          {can("instance.control") && (
            <>
              <button
                className="btn"
                disabled={startDisabled}
                title={
                  isStarting
                    ? "Instance is starting…"
                    : isUp
                      ? "Instance is already running"
                      : !i.online
                        ? "Agent offline"
                        : undefined
                }
                onClick={() => void control("start")}
              >
                {isStarting ? "Starting…" : "Start"}
              </button>
              <button
                className="btn"
                disabled={stopDisabled}
                title={isStopping ? "Instance is stopping…" : undefined}
                onClick={() => void control("stop")}
              >
                {isStopping ? "Stopping…" : "Stop"}
              </button>
              <button
                className="btn"
                disabled={restartDisabled}
                title={isStarting ? "Wait until start finishes" : undefined}
                onClick={() => void control("restart")}
              >
                {isRestarting ? "Restarting…" : "Restart"}
              </button>
            </>
          )}
          {can("mod.manage") && (
            <button className="btn" onClick={() => void syncKeys()} disabled={syncingKeys}>
              {syncingKeys ? "Syncing keys…" : "Sync mod keys"}
            </button>
          )}
        </div>
      </div>

      {(can("instance.control") || can("instance.config.edit")) && (
        <InstanceHeadlessPanel
          instance={i}
          host={host || null}
          profile={profiles.data?.find((p) => p.id === i.currentProfileId) || null}
          canControl={can("instance.control")}
          canEdit={can("instance.config.edit")}
          onChanged={() => inst.reload()}
        />
      )}

      {i.online && (st?.state === "running" || st?.state === "starting" || !!st?.pid) && (
        <div className="card" style={{ marginBottom: 16, marginTop: 16 }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ margin: 0 }}>Steam browser view</h2>
            <span className={"badge stage-" + (st?.queryOk || st?.state === "running" ? "done" : "running")}>
              {st?.queryOk || st?.state === "running" ? "reachable" : "starting…"}
            </span>
          </div>
          {st?.queryOk || st?.state === "running" ? (
            <div className="grid cols-2" style={{ gap: 8, marginTop: 10 }}>
              <div>
                <div className="muted small">Hostname</div>
                <div><strong>{st.hostname || "—"}</strong></div>
              </div>
              <div>
                <div className="muted small">Mission / map</div>
                <div><strong>{st.map || "—"}</strong></div>
              </div>
              <div>
                <div className="muted small">Players</div>
                <div>{st.players}/{st.maxPlayers}{st.password ? " · password" : ""}</div>
              </div>
              <div>
                <div className="muted small">Last query</div>
                <div className="muted small">{st.queriedAt ? new Date(st.queriedAt).toLocaleTimeString() : "—"}</div>
              </div>
            </div>
          ) : (
            <div className="muted small" style={{ marginTop: 8 }}>
              {st?.queryError || "Waiting for Steam query…"}
            </div>
          )}
        </div>
      )}

      {lastLaunch && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <div>
              <h2 style={{ marginBottom: 4 }}>Last launch</h2>
              <div className="muted small">
                {lastLaunch.action} · {formatJobWhen(lastLaunch.at)} ·{" "}
                <strong>{lastLaunch.mods}</strong> mod path(s)
                {lastLaunch.mission ? (
                  <>
                    {" "}
                    · mission <code>{lastLaunch.mission}</code>
                  </>
                ) : (
                  " · no mission template"
                )}
                {lastLaunch.autoInit ? " · -autoInit" : ""}
              </div>
            </div>
            <button type="button" className="btn" onClick={() => setLastLaunch(null)}>
              Dismiss
            </button>
          </div>
          {lastLaunch.warning && (
            <div className="error small" style={{ marginTop: 8 }}>
              {lastLaunch.warning}
            </div>
          )}
          {lastLaunch.modArg ? (
            <pre
              className="console"
              style={{ marginTop: 10, maxHeight: 120, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
            >
              {lastLaunch.modArg}
            </pre>
          ) : null}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ flexWrap: "wrap", gap: 12 }}>
          <div style={{ flex: "1 1 220px" }}>
            <h2 style={{ marginBottom: 4 }}>Mission profile</h2>
            {i.currentProfileName ? (
              <div className="muted small">
                Loaded: <strong>{i.currentProfileName}</strong>
              </div>
            ) : (
              <div className="muted small">No profile applied yet.</div>
            )}
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
            {can("profile.apply") && (
              <>
                <div>
                  <label className="small muted" style={{ display: "block", marginBottom: 4 }}>Apply profile</label>
                  <select
                    value={profileId}
                    onChange={(e) => setProfileId(e.target.value)}
                    disabled={!profileList.length || applying || !!activeApply}
                    style={{ minWidth: 200 }}
                  >
                    {profileList.length === 0 && <option value="">No profiles</option>}
                    {profileList.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{i.currentProfileId === p.id ? " (loaded)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  className="btn primary"
                  disabled={!selectedProfile || !host?.online || applying || !!activeApply}
                  onClick={() => selectedProfile && setApplyTarget(selectedProfile)}
                >
                  {applying || activeApply ? "Applying…" : "Apply"}
                </button>
              </>
            )}
            <Link className="btn" to="/profiles">Edit profiles</Link>
            {can("instance.config.edit") && (
              <Link className="btn" to="/profiles#shared-settings">Shared settings</Link>
            )}
          </div>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          Apply merges global <Link to="/profiles#shared-settings">shared settings</Link> with the mission profile.
          Edit shared defaults on the Mission Profiles page — not here.
        </div>
        {can("profile.apply") && !host?.online && (
          <div className="muted small" style={{ marginTop: 8 }}>Agent offline — connect the host agent to apply.</div>
        )}
        {can("profile.apply") && profileList.length === 0 && (
          <div className="muted small" style={{ marginTop: 8 }}>
            No profiles in the library yet. Create one under <Link to="/profiles">Mission Profiles</Link>.
          </div>
        )}
      </div>

      {applyTarget && (
        <ApplyProfileModal
          profile={applyTarget}
          instances={allInstances.data?.length ? allInstances.data : [i]}
          fixedInstanceId={i.id}
          hosts={hosts.data || []}
          onClose={() => setApplyTarget(null)}
          onConfirm={(opts) => void runApply(applyTarget, opts)}
        />
      )}

      {highlight && (
        <div className="card" style={{ marginBottom: 16 }} id={`job-${highlight.id}`}>
          <div className="row between" style={{ marginBottom: 8 }}>
            <div>
              <h2 style={{ margin: 0 }}>
                {highlight.kind === "apply_profile" ? "Profile apply" : highlight.kind}
              </h2>
              <div className="muted small" style={{ marginTop: 4 }}>
                Started {formatJobWhen(highlight.createdAt)}
                {highlight.updatedAt && highlight.state !== "pending" ? ` · updated ${formatJobWhen(highlight.updatedAt)}` : ""}
                <span className="tag" style={{ marginLeft: 8 }}>{highlight.id.slice(0, 8)}…</span>
              </div>
            </div>
            <span className={"badge stage-" + (highlight.state === "done" ? "done" : highlight.state === "failed" ? "failed" : "running")}>
              {highlight.stage || highlight.state}
            </span>
          </div>
          <JobProgressList job={highlight} expanded />
          {highlight.error && (
            <div className="error small" style={{ marginTop: 8 }}>
              {highlight.error.split("\n").map((line, i) => (
                <div key={i} className={i === 0 ? undefined : "muted"} style={{ marginTop: i ? 4 : 0 }}>
                  {linkifyText(line)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showSteamFollow && host && (
        <div className="card" style={{ marginBottom: 16 }}>
          <HostSteamCmdPanel host={host} followOnly compact />
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <div className="row between" style={{ marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ margin: 0 }}>Live console</h2>
            <label className="row" style={{ margin: 0, gap: 8 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={consoleLive}
                onChange={(e) => {
                  const on = e.target.checked;
                  setConsoleLive(on);
                  if (!on) setLines([]);
                }}
              />
              <span className="small">{consoleLive ? "Streaming" : "Off"}</span>
            </label>
          </div>
          <div className="console" ref={consoleRef}>
            {!consoleLive && <div className="muted">Console streaming is off.</div>}
            {consoleLive && lines.length === 0 && <div className="muted">Waiting for output…</div>}
            {consoleLive && lines.map((l, idx) => <div className="ln" key={idx}>{l}</div>)}
          </div>
          {can("instance.rcon") && (
            <div className="row" style={{ marginTop: 10 }}>
              <input placeholder="RCON command (whitelisted, e.g. say -1 hello)" value={rcon}
                onChange={(e) => setRcon(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendRcon()} />
              <button className="btn" onClick={sendRcon}>Send</button>
            </div>
          )}
        </div>

        <JobHistory jobs={jobList} focusJobId={focusJobId} loading={jobs.loading} />
      </div>
    </div>
  );
}

function JobProgressList({
  job,
  expanded,
  onToggle,
}: {
  job: Job;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const items = job.progress || [];
  const shown = expanded ? items : items.slice(-3);
  if (!shown.length) {
    return <div className="muted small" style={{ marginTop: 4 }}>No progress messages yet.</div>;
  }
  const hidden = !expanded && items.length > shown.length ? items.length - shown.length : 0;
  return (
    <div style={{ marginTop: 6 }}>
      {shown.map((p, idx) => (
        <div key={`${p.at}-${idx}`} className="muted small" style={{ marginTop: idx ? 4 : 0 }}>
          <span className="tag" style={{ marginRight: 6 }} title={p.at || undefined}>
            {formatJobClock(p.at)}
          </span>
          {p.stage ? <span className="tag" style={{ marginRight: 6 }}>{p.stage}</span> : null}
          {linkifyText(p.message)}
        </div>
      ))}
      {onToggle && (hidden > 0 || (expanded && items.length > 3)) && (
        <button
          type="button"
          className="btn small"
          style={{ marginTop: 8 }}
          onClick={onToggle}
        >
          {expanded ? "Show less" : `Show ${hidden} earlier line${hidden === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}

function JobHistory({ jobs, focusJobId, loading }: { jobs: Job[]; focusJobId: string; loading: boolean }) {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const ordered = useMemo(() => {
    if (!focusJobId) return jobs;
    const focus = jobs.find((j) => j.id === focusJobId);
    if (!focus) return jobs;
    return [focus, ...jobs.filter((j) => j.id !== focusJobId)];
  }, [jobs, focusJobId]);

  function toggle(id: string) {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="card">
      <h2>Job history</h2>
      {loading && !jobs.length && <div className="muted">Loading…</div>}
      {!loading && jobs.length === 0 && <div className="muted">No jobs yet.</div>}
      {ordered.map((j) => {
        const active = j.state === "running" || j.state === "pending";
        const focused = j.id === focusJobId;
        const expanded = active || focused || !!expandedIds[j.id];
        return (
          <div
            key={j.id}
            id={focused ? undefined : `job-${j.id}`}
            style={{
              borderBottom: "1px solid var(--border)",
              padding: "8px 0",
              background: focused ? "rgba(88, 166, 255, 0.08)" : undefined,
              margin: focused ? "0 -8px" : undefined,
              paddingLeft: focused ? 8 : undefined,
              paddingRight: focused ? 8 : undefined,
              borderRadius: focused ? 6 : undefined,
            }}
          >
            <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
              <div>
                <span className="tag">{j.kind}</span>
                <span className="muted small" style={{ marginLeft: 8 }} title={j.createdAt || undefined}>
                  {formatJobWhen(j.createdAt)}
                </span>
                {(j.progress?.length || 0) > 3 && !active && !focused && (
                  <button
                    type="button"
                    className="btn small"
                    style={{ marginLeft: 8 }}
                    onClick={() => toggle(j.id)}
                  >
                    {expandedIds[j.id] ? "Collapse" : "Expand"}
                  </button>
                )}
              </div>
              <span className={"badge stage-" + (j.state === "done" ? "done" : j.state === "failed" ? "failed" : "running")}>
                {j.stage || j.state}
              </span>
            </div>
            <JobProgressList
              job={j}
              expanded={expanded}
              onToggle={active || focused ? undefined : () => toggle(j.id)}
            />
            {j.error && (
              <div className="error small" style={{ marginTop: 6 }}>
                {j.error.split("\n").map((line, i) => (
                  <div key={i} className={i === 0 ? undefined : "muted"} style={{ marginTop: i ? 4 : 0 }}>
                    {linkifyText(line)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Parse SQLite UTC (`YYYY-MM-DD HH:MM:SS`) or ISO strings. */
function parseJobDate(raw?: string | null): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} /.test(s) && !s.includes("T") ? s.replace(" ", "T") + "Z" : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatJobWhen(raw?: string | null): string {
  const d = parseJobDate(raw);
  if (!d) return "—";
  const now = Date.now();
  const diffSec = Math.round((now - d.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatJobClock(raw?: string | null): string {
  const d = parseJobDate(raw);
  if (!d) return "--:--:--";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
