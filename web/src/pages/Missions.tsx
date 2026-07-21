import { useRef, useState } from "react";
import { api, Host, Instance, Mission, Upload, uploadFile } from "../api";
import { useAuth } from "../auth";
import { useToast } from "../components/Toast";
import { useList } from "../components/ui";

export function Missions() {
  const { can } = useAuth();
  const toast = useToast();
  const uploads = useList<Upload[]>(() => api.get("/uploads"));
  const missions = useList<Mission[]>(() => api.get("/missions"));
  const instances = useList<Instance[]>(() => api.get("/instances"));
  const hosts = useList<Host[]>(() => api.get("/hosts"));
  const [section, setSection] = useState("mission");
  const [instanceId, setInstanceId] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const selectedInstance = (instances.data || []).find((i) => i.id === (instanceId || (instances.data || [])[0]?.id));
  const selectedHost = (hosts.data || []).find((h) => h.id === selectedInstance?.hostId);

  async function doUpload() {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setBusy(true); setErr("");
    try {
      await uploadFile(section, f);
      uploads.reload();
      if (fileRef.current) fileRef.current.value = "";
      toast.success("Uploaded to quarantine", { message: f.name });
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function approve(u: Upload) {
    await api.post(`/uploads/${u.id}/approve`);
    uploads.reload();
    toast.info("Approved", { message: u.originalName });
  }
  async function reject(u: Upload) {
    const reason = prompt("Reject reason?") || "rejected";
    await api.post(`/uploads/${u.id}/reject`, { reason });
    uploads.reload();
  }
  async function deploy(u: Upload) {
    const target = instanceId || (instances.data || [])[0]?.id;
    if (!target) {
      toast.error("No instance available", { message: "Create a host and add an instance on the Dashboard first." });
      return;
    }
    try {
      const r = await api.post<{
        jobId: string;
        instanceId: string;
        deployedPath?: string;
        fileName?: string;
      }>(`/uploads/${u.id}/deploy`, { instanceId: target });
      toast.success("Deployed to host", {
        message: r.deployedPath
          ? `${r.fileName || u.originalName} → ${r.deployedPath}`
          : `${u.originalName} pushed via agent`,
        action: {
          label: "Open instance jobs / files",
          to: `/instances/${r.instanceId || target}`,
        },
        ttlMs: 12_000,
      });
      uploads.reload();
      missions.reload();
    } catch (e: any) {
      toast.error("Deploy failed", { message: e.message });
    }
  }

  async function delMission(m: Mission) {
    if (!confirm(`Remove “${m.name}” from the mission library? Profiles using it will clear the mission field.`)) return;
    try {
      await api.del(`/missions/${m.id}`);
      missions.reload();
      toast.success("Mission removed");
    } catch (e: any) {
      toast.error("Delete failed", { message: e.message });
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Missions & Uploads</h1>
        <div className="muted">Allow-listed Arma 3 files only. Uploads are quarantined and validated before deployment to a host.</div>
      </div>
      {can("mission.upload") && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Upload</h2>
          <div className="row">
            <select style={{ maxWidth: 160 }} value={section} onChange={(e) => setSection(e.target.value)}>
              <option value="mission">Mission (.pbo)</option>
              <option value="key">Key (.bikey)</option>
              <option value="config">Config (.cfg/.hpp/.html/…)</option>
            </select>
            <input ref={fileRef} type="file" style={{ maxWidth: 320 }} />
            <button className="btn primary" disabled={busy} onClick={doUpload}>{busy ? "Uploading…" : "Upload to quarantine"}</button>
          </div>
          {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}
        </div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Deploy target</h2>
        {(instances.data || []).length === 0 ? (
          <div className="muted">No instances yet. Add a host and create an instance on the <a href="/">Dashboard</a> before deploying.</div>
        ) : (
          <div className="row">
            <select value={instanceId || (instances.data || [])[0]?.id || ""} onChange={(e) => setInstanceId(e.target.value)} style={{ maxWidth: 320 }}>
              {(instances.data || []).map((i) => {
                const h = (hosts.data || []).find((x) => x.id === i.hostId);
                return <option key={i.id} value={i.id}>{i.name}{h ? ` · ${h.name}` : ""}{h?.online ? " ●" : " (agent offline)"}</option>;
              })}
            </select>
            {selectedHost && (
              <span className="muted small">
                {selectedHost.online ? "agent connected" : "agent offline — connect the agent before deploy"}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Mission library</h2>
        <div className="muted small" style={{ marginBottom: 8 }}>
          One entry per <code>.pbo</code> filename. Redeploying the same mission updates this row instead of duplicating it.
        </div>
        <table>
          <thead><tr><th>Mission</th><th>PBO</th><th></th></tr></thead>
          <tbody>
            {(missions.data || []).map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="tag">{m.pboFilename || m.name}</td>
                <td>
                  {can("mission.manage") && (
                    <button className="btn small danger" onClick={() => delMission(m)}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
            {(missions.data || []).length === 0 && (
              <tr><td colSpan={3} className="muted">No missions yet — approve and deploy a .pbo from quarantine.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Quarantine queue</h2>
        <table>
          <thead><tr><th>File</th><th>Section</th><th>Detected</th><th>State</th><th></th></tr></thead>
          <tbody>
            {(uploads.data || []).map((u) => (
              <tr key={u.id}>
                <td>{u.originalName}<div className="tag small">{u.contentHash.slice(0, 16)}…</div></td>
                <td><span className="badge">{u.section}</span></td>
                <td className="tag">{u.detectedType || "—"}</td>
                <td>
                  <span className={"badge stage-" + (u.validationState === "approved" ? "done" : u.validationState === "rejected" ? "failed" : "running")}>{u.validationState}</span>
                  {u.rejectReason && <div className="small warn">{u.rejectReason}</div>}
                </td>
                <td>
                  <div className="cell-actions">
                  {can("mission.manage") && u.validationState === "quarantined" && <>
                    <button className="btn small" onClick={() => approve(u)}>Approve</button>
                    <button className="btn small danger" onClick={() => reject(u)}>Reject</button>
                  </>}
                  {can("mission.manage") && u.validationState === "approved" && (
                    <button className="btn small primary" onClick={() => deploy(u)}>Deploy</button>
                  )}
                  </div>
                </td>
              </tr>
            ))}
            {(uploads.data || []).length === 0 && <tr><td colSpan={5} className="muted">No uploads.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
