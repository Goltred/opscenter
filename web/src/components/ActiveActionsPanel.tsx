import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Job } from "../api";
import { useList } from "./ui";

const STORAGE_KEY = "a3panel.activeActionsOpen";

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
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const jobs = useList<Job[]>(() => api.get("/jobs/active"), []);

  useEffect(() => {
    const t = window.setInterval(() => jobs.reload(), 4000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open]);

  const list = jobs.data || [];
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
          {open ? "Hide" : "Show"} actions
          {count > 0 ? <span className="active-actions-count">{count}</span> : null}
        </span>
        <span className="muted small">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="active-actions-panel">
          {jobs.loading && !jobs.data && <div className="muted small">Loading…</div>}
          {jobs.error && <div className="error small">{jobs.error}</div>}
          {!jobs.loading && count === 0 && (
            <div className="muted small">No pending or running actions.</div>
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
                          {msg}
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
