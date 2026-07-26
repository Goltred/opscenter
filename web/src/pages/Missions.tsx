import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, Mission, Upload, uploadMissionFile } from "../api";
import { useAuth } from "../auth";
import { useToast } from "../components/Toast";
import { Modal, useList } from "../components/ui";
import { notifyProfilesHealthChanged } from "../profilesHealth";

type EvictPreview = {
  mission: { id: string; name: string; pboFilename: string; storedPath: string };
  profilesAffected: { id: string; name: string }[];
  blockingInstances: {
    id: string;
    name: string;
    hostId: string;
    hostName: string;
    state: string;
    profileId: string;
    profileName: string;
  }[];
  canEvict: boolean;
};

type LibraryRow =
  | { kind: "pending"; key: string; upload: Upload; label: string }
  | { kind: "approved"; key: string; mission: Mission; label: string };

function missionLabel(name: string, pboFilename?: string) {
  const pbo = (pboFilename || name || "").trim();
  const bare = (name || "").trim();
  if (!pbo) return bare || "mission";
  if (!bare || bare.toLowerCase() === pbo.toLowerCase() || `${bare}.pbo`.toLowerCase() === pbo.toLowerCase()) {
    return pbo;
  }
  return pbo;
}

export function Missions() {
  const { can } = useAuth();
  const toast = useToast();
  const uploads = useList<Upload[]>(() => api.get("/uploads"));
  const missions = useList<Mission[]>(() => api.get("/missions"));
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [evictTarget, setEvictTarget] = useState<Mission | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<Mission | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Upload | null>(null);

  const rows = useMemo(() => {
    const pending = (uploads.data || []).filter(
      (u) => u.section === "mission" && u.validationState === "quarantined",
    );
    const library = missions.data || [];
    const out: LibraryRow[] = [
      ...pending.map((u) => ({
        kind: "pending" as const,
        key: `pending:${u.id}`,
        upload: u,
        label: missionLabel(u.originalName.replace(/\.pbo$/i, ""), u.originalName),
      })),
      ...library.map((m) => ({
        kind: "approved" as const,
        key: `mission:${m.id}`,
        mission: m,
        label: missionLabel(m.name, m.pboFilename),
      })),
    ];
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "pending" ? -1 : 1;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });
    return out;
  }, [uploads.data, missions.data]);

  async function doUpload() {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    setErr("");
    try {
      await uploadMissionFile(f);
      uploads.reload();
      if (fileRef.current) fileRef.current.value = "";
      toast.success("Uploaded — waiting for approval", { message: f.name });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function approve(u: Upload) {
    try {
      const r = await api.post<{ updated?: boolean }>(`/uploads/${u.id}/approve`);
      uploads.reload();
      missions.reload();
      toast.success(r.updated ? "Mission updated" : "Mission approved", {
        message: u.originalName,
        action: { label: "Open Mission Profiles", to: "/profiles" },
        ttlMs: 10_000,
      });
    } catch (e: any) {
      toast.error("Approve failed", { message: e.message });
    }
  }

  function reloadLibrary() {
    missions.reload();
    uploads.reload();
  }

  return (
    <div>
      <div className="page-head">
        <h1>Missions</h1>
        <div className="muted">
          Upload mission PBOs, approve them into the library, then attach on a profile. Apply copies the file onto the host.
        </div>
      </div>
      {can("mission.upload") && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Upload</h2>
          <div className="muted small" style={{ marginBottom: 8 }}>
            Only <code>.pbo</code> mission files. New uploads appear below as Waiting approval until an admin approves them.
          </div>
          <div className="row">
            <input ref={fileRef} type="file" accept=".pbo,application/octet-stream" style={{ maxWidth: 360 }} />
            <button className="btn primary" disabled={busy} onClick={doUpload}>
              {busy ? "Uploading…" : "Upload mission"}
            </button>
          </div>
          {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}
        </div>
      )}
      <div className="card">
        <h2>Mission library</h2>
        <div className="muted small" style={{ marginBottom: 8 }}>
          One approved entry per <code>.pbo</code> filename. Approving the same name again updates that entry.
          Hosts get the file when you Apply a profile that uses it.
        </div>
        <table>
          <thead>
            <tr>
              <th>Mission</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="tag">{row.label}</td>
                <td>
                  {row.kind === "pending" ? (
                    <span className="badge stage-running">Waiting approval</span>
                  ) : (
                    <span className="badge stage-done">Approved</span>
                  )}
                </td>
                <td>
                  <div className="cell-actions">
                    {row.kind === "pending" && can("mission.manage") && (
                      <>
                        <button className="btn small primary" onClick={() => approve(row.upload)}>
                          Approve
                        </button>
                        <button className="btn small danger" onClick={() => setRejectTarget(row.upload)}>
                          Reject
                        </button>
                      </>
                    )}
                    {row.kind === "approved" && can("mission.manage") && (
                      <>
                        <button className="btn small" onClick={() => setWithdrawTarget(row.mission)}>
                          Send back
                        </button>
                        <button className="btn small danger" onClick={() => setEvictTarget(row.mission)}>
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No missions yet — upload a .pbo above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rejectTarget && (
        <RejectUploadModal
          upload={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onDone={() => {
            setRejectTarget(null);
            uploads.reload();
          }}
        />
      )}

      {withdrawTarget && (
        <WithdrawMissionModal
          mission={withdrawTarget}
          onClose={() => setWithdrawTarget(null)}
          onDone={() => {
            setWithdrawTarget(null);
            reloadLibrary();
          }}
        />
      )}

      {evictTarget && (
        <RemoveMissionModal
          mission={evictTarget}
          onClose={() => setEvictTarget(null)}
          onDone={() => {
            setEvictTarget(null);
            reloadLibrary();
          }}
        />
      )}
    </div>
  );
}

function useMissionPreview(missionId: string) {
  const [preview, setPreview] = useState<EvictPreview | null>(null);
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setLoadErr("");
    api
      .get<EvictPreview>(`/missions/${missionId}/evict-preview`)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadErr(e.message || "Could not load preview");
      });
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  return { preview, setPreview, loadErr };
}

function MissionUsageDetails({ preview, blocked }: { preview: EvictPreview; blocked: boolean }) {
  return (
    <>
      {blocked && (
        <div className="error" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>This mission is in use — stop these instances first</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {preview.blockingInstances.map((b) => (
              <li key={b.id} style={{ marginBottom: 4 }}>
                <Link to={`/instances/${b.id}`}>{b.name}</Link>
                <span className="muted">
                  {" "}
                  · {b.hostName || "host"} · {b.state}
                  {b.profileName ? ` · profile “${b.profileName}”` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.profilesAffected.length > 0 && (
        <div className={blocked ? "muted" : "warn-banner"} style={{ marginBottom: 12, padding: 10, borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {preview.profilesAffected.length} profile
            {preview.profilesAffected.length === 1 ? "" : "s"} will be left without a mission
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {preview.profilesAffected.map((p) => (
              <li key={p.id}>
                <Link to="/profiles">{p.name}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.profilesAffected.length === 0 && !blocked && (
        <div className="muted small" style={{ marginBottom: 12 }}>
          No profiles currently use this mission.
        </div>
      )}
    </>
  );
}

function RejectUploadModal({
  upload,
  onClose,
  onDone,
}: {
  upload: Upload;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const label = missionLabel(upload.originalName.replace(/\.pbo$/i, ""), upload.originalName);

  async function confirmReject() {
    setBusy(true);
    try {
      await api.post(`/uploads/${upload.id}/reject`, { reason: reason.trim() || "rejected" });
      toast.info("Rejected", { message: label });
      onDone();
    } catch (e: any) {
      toast.error("Reject failed", { message: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Reject upload" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Reject <strong>{label}</strong>? It will leave Waiting approval and stay out of the library.
      </p>
      <label style={{ display: "block", marginBottom: 16 }}>
        Reason <span className="muted">(optional)</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="rejected"
          disabled={busy}
          style={{ marginTop: 6 }}
        />
      </label>
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn danger" disabled={busy} onClick={confirmReject}>
          {busy ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </Modal>
  );
}

function WithdrawMissionModal({
  mission,
  onClose,
  onDone,
}: {
  mission: Mission;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { preview, setPreview, loadErr } = useMissionPreview(mission.id);
  const [deleteFromHosts, setDeleteFromHosts] = useState(true);
  const [busy, setBusy] = useState(false);
  const label = missionLabel(mission.name, mission.pboFilename);
  const blocked = !!preview && !preview.canEvict;

  async function confirmWithdraw() {
    if (!preview?.canEvict) return;
    setBusy(true);
    try {
      const r = await api.post<{
        profilesCleared: { id: string; name: string }[];
        hostResults: { hostId: string; hostName: string; status: string; detail?: string }[];
      }>(`/missions/${mission.id}/withdraw`, { deleteFromHosts });
      const cleared = r.profilesCleared?.length || 0;
      const failedHosts = (r.hostResults || []).filter((h) => h.status === "failed");
      toast.success("Sent back for approval", {
        message:
          [
            cleared ? `${cleared} profile${cleared === 1 ? "" : "s"} no longer have a mission` : null,
            deleteFromHosts && failedHosts.length
              ? `Host cleanup failed on ${failedHosts.map((h) => h.hostName).join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || label,
        action: cleared ? { label: "Open Mission Profiles", to: "/profiles" } : undefined,
        ttlMs: 10_000,
      });
      notifyProfilesHealthChanged();
      onDone();
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409) {
        const blocking = (e.data?.blockingInstances as EvictPreview["blockingInstances"]) || [];
        toast.error("Stop running instances first", {
          message: blocking.length ? blocking.map((b) => b.name).join(", ") : e.message,
        });
        try {
          setPreview(await api.get<EvictPreview>(`/missions/${mission.id}/evict-preview`));
        } catch {
          /* ignore */
        }
      } else {
        toast.error("Send back failed", { message: e instanceof Error ? e.message : "Unknown error" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Send back for approval" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Move <strong>{label}</strong> back to Waiting approval. Profiles that use it will lose their mission link.
      </p>

      {loadErr && <div className="error">{loadErr}</div>}
      {!preview && !loadErr && <div className="muted">Checking usage…</div>}
      {preview && <MissionUsageDetails preview={preview} blocked={blocked} />}

      <label className="check-option">
        <input
          type="checkbox"
          checked={deleteFromHosts}
          disabled={blocked || busy}
          onChange={(e) => setDeleteFromHosts(e.target.checked)}
        />
        <span>
          <div className="check-title">Also delete the mission file from hosts</div>
          <div className="muted small">
            Removes the file from each host’s mpmissions folder. Leave on unless you want it to stay on disk.
          </div>
        </span>
      </label>

      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!preview || blocked || busy || !!loadErr}
          onClick={confirmWithdraw}
        >
          {busy ? "Sending back…" : "Send back"}
        </button>
      </div>
    </Modal>
  );
}

function RemoveMissionModal({
  mission,
  onClose,
  onDone,
}: {
  mission: Mission;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { preview, setPreview, loadErr } = useMissionPreview(mission.id);
  const [deleteFromHosts, setDeleteFromHosts] = useState(true);
  const [busy, setBusy] = useState(false);
  const label = missionLabel(mission.name, mission.pboFilename);
  const blocked = !!preview && !preview.canEvict;

  async function confirmEvict() {
    if (!preview?.canEvict) return;
    setBusy(true);
    try {
      const r = await api.post<{
        profilesCleared: { id: string; name: string }[];
        hostResults: { hostId: string; hostName: string; status: string; detail?: string }[];
      }>(`/missions/${mission.id}/evict`, { deleteFromHosts });
      const cleared = r.profilesCleared?.length || 0;
      const failedHosts = (r.hostResults || []).filter((h) => h.status === "failed");
      toast.success("Mission removed", {
        message:
          [
            cleared ? `${cleared} profile${cleared === 1 ? "" : "s"} no longer have a mission` : null,
            deleteFromHosts && failedHosts.length
              ? `Host cleanup failed on ${failedHosts.map((h) => h.hostName).join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
        action: cleared ? { label: "Open Mission Profiles", to: "/profiles" } : undefined,
        ttlMs: 12_000,
      });
      notifyProfilesHealthChanged();
      onDone();
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409) {
        const blocking = (e.data?.blockingInstances as EvictPreview["blockingInstances"]) || [];
        toast.error("Stop running instances first", {
          message: blocking.length ? blocking.map((b) => b.name).join(", ") : e.message,
        });
        try {
          setPreview(await api.get<EvictPreview>(`/missions/${mission.id}/evict-preview`));
        } catch {
          /* ignore */
        }
      } else {
        toast.error("Remove failed", { message: e instanceof Error ? e.message : "Unknown error" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Remove mission" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Permanently remove <strong>{label}</strong> from the library. Profiles that use it will lose their mission link.
      </p>

      {loadErr && <div className="error">{loadErr}</div>}
      {!preview && !loadErr && <div className="muted">Checking usage…</div>}
      {preview && <MissionUsageDetails preview={preview} blocked={blocked} />}

      <label className="check-option">
        <input
          type="checkbox"
          checked={deleteFromHosts}
          disabled={blocked || busy}
          onChange={(e) => setDeleteFromHosts(e.target.checked)}
        />
        <span>
          <div className="check-title">Also delete the mission file from hosts</div>
          <div className="muted small">
            Removes the file from each host’s mpmissions folder. Leave on unless you want it to stay on disk.
          </div>
        </span>
      </label>

      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn danger" disabled={!preview || blocked || busy || !!loadErr} onClick={confirmEvict}>
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
    </Modal>
  );
}
