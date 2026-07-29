import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, Job } from "../api";
import { linkifyText } from "./linkify";
import { useModNameMap } from "../useModNameMap";

const STORAGE_KEY = "OpsCenter.activeActionsOpen";
const POLL_MS = 4000;

function kindLabel(job: Job): string {
  switch (job.kind) {
    case "apply_profile":
      return job.profileName ? `Apply “${job.profileName}”` : "Apply profile";
    case "steamcmd_download":
      return "Mod download";
    case "steamcmd_app_update":
      return "Arma server update";
    case "file_deploy":
      return "Deploy file";
    default:
      return job.kind || "Action";
  }
}

function jobHref(job: Job): string | null {
  if (job.instanceId) {
    return `/instances/${job.instanceId}?job=${encodeURIComponent(job.id)}`;
  }
  if (job.kind.startsWith("steamcmd") && job.hostId) {
    return `/?hostId=${encodeURIComponent(job.hostId)}&steamcmd=1`;
  }
  if (job.hostId) {
    return `/?hostId=${encodeURIComponent(job.hostId)}`;
  }
  return null;
}

function latestMessage(job: Job): string {
  const last = job.progress?.[job.progress.length - 1];
  if (last?.message) return last.message;
  if (job.stage) return job.stage;
  return job.state;
}

function whereLabel(job: Job): string {
  const parts: string[] = [];
  if (job.instanceName) parts.push(job.instanceName);
  else if (job.instanceId) parts.push("instance");
  if (job.hostName) parts.push(job.hostName);
  return parts.join(" · ");
}

export function ActiveActionsPanel() {
  const modNames = useModNameMap();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [list, setList] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const inFlight = useRef(false);
  const prevCount = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const rows = await api.get<Job[]>("/jobs/active");
      const next = Array.isArray(rows) ? rows : [];
      setList(next);
      setError("");
      // Auto-expand when work appears so operators notice without hunting.
      if (prevCount.current === 0 && next.length > 0) setOpen(true);
      prevCount.current = next.length;
    } catch (e: any) {
      setError(e.message || "Could not load actions");
    } finally {
      inFlight.current = false;
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open]);

  const count = list.length;

  return (
    <div className="active-actions">
      <button
        type="button"
        className={"active-actions-toggle" + (open ? " open" : "") + (count > 0 ? " has-items" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="active-actions-toggle-label">
          Actions
          {count > 0 ? <span className="active-actions-count">{count}</span> : null}
        </span>
        <span className="muted small">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="active-actions-panel">
          {!ready && <div className="muted small">Loading…</div>}
          {error && <div className="error small">{error}</div>}
          {ready && !error && count === 0 && (
            <div className="muted small">Idle</div>
          )}
          {count > 0 && (
            <ul className="active-actions-list">
              {list.map((job) => {
                const href = jobHref(job);
                const title = kindLabel(job);
                const where = whereLabel(job);
                const msg = latestMessage(job);
                return (
                  <li key={job.id} className="active-actions-item">
                    <div className="row between" style={{ gap: 6, alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {href ? (
                          <Link to={href} className="active-actions-link">
                            {title}
                          </Link>
                        ) : (
                          <strong className="small">{title}</strong>
                        )}
                        {where ? <div className="muted small">{where}</div> : null}
                        <div className="muted small" style={{ marginTop: 2 }}>
                          {linkifyText(msg, { modNames })}
                        </div>
                      </div>
                      <span className={"badge stage-" + (job.state === "failed" ? "failed" : "running")}>
                        {job.state}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
