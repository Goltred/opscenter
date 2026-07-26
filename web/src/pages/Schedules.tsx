import { useEffect, useState } from "react";
import { api, Instance, MissionProfile, Schedule } from "../api";
import { useAuth } from "../auth";
import { FinishScheduleModal, type FinishScheduleTarget } from "../components/FinishScheduleModal";
import { StandDownScheduleModal, type StandDownScheduleTarget } from "../components/StandDownScheduleModal";
import { Modal, useList } from "../components/ui";
import { formatDateTime } from "../formatTime";
import { formatScheduleState } from "../formatScheduleState";

function canSeeSchedules(can: (p: string) => boolean) {
  return can("schedule.manage") || can("schedule.confirm") || can("profile.apply") || can("instance.control");
}

function canConfirm(can: (p: string) => boolean) {
  return can("schedule.confirm") || can("schedule.manage") || can("profile.apply") || can("instance.control");
}

function canStandDownRow(state: string): boolean {
  return ["scheduled", "reminded", "awaiting_confirm", "confirmed"].includes(state);
}

/** ISO → value for datetime-local (local timezone). */
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isEditableState(state: string): boolean {
  return state !== "applying" && state !== "restoring";
}

export function Schedules() {
  const { can } = useAuth();
  const schedules = useList<Schedule[]>(() => api.get("/schedules"));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [finishTarget, setFinishTarget] = useState<FinishScheduleTarget | null>(null);
  const [standDownTarget, setStandDownTarget] = useState<StandDownScheduleTarget | null>(null);

  useEffect(() => {
    const active = (schedules.data || []).some((s) =>
      ["scheduled", "reminded", "awaiting_confirm", "confirmed", "applying", "live", "restoring"].includes(s.state),
    );
    if (!active) return;
    const t = setInterval(() => schedules.reload(), 15_000);
    return () => clearInterval(t);
  }, [schedules.data, schedules.reload]);

  async function confirmSchedule(s: Schedule) {
    await api.post(`/schedules/${s.id}/confirm`);
    schedules.reload();
  }
  async function del(s: Schedule) {
    if (!window.confirm("Delete schedule?")) return;
    await api.del(`/schedules/${s.id}`);
    schedules.reload();
  }

  if (!canSeeSchedules(can)) {
    return <div className="muted">You do not have permission to view schedules.</div>;
  }

  return (
    <div>
      <div className="page-head row between">
        <div>
          <h1>Scheduler</h1>
          <div className="muted">
            Schedules apply a mission profile and start the server at the chosen time. Confirm within 1 hour of start
            (or earlier), or stand down if this run is not happening. Unconfirmed runs are skipped at start time.
            Optional fallback profile restores the server’s normal setup when you finish the operation.
          </div>
        </div>
        {can("schedule.manage") && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            New schedule
          </button>
        )}
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Instance / Profile</th>
              <th>Run at</th>
              <th>Recurrence</th>
              <th>State</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(schedules.data || []).map((s) => (
              <tr key={s.id}>
                <td>
                  {s.name || "(unnamed)"}
                  {s.lastError ? (
                    <div className="muted small" title={s.lastError}>
                      {s.lastError.slice(0, 80)}
                    </div>
                  ) : null}
                </td>
                <td className="muted small">
                  {s.instanceName || s.instanceId || "—"}
                  <br />
                  {s.profileName || s.profileId}
                  {s.fallbackProfileId ? (
                    <>
                      <br />
                      → {s.fallbackProfileName || s.fallbackProfileId}
                    </>
                  ) : null}
                </td>
                <td className="tag">{formatDateTime(s.runAt)}</td>
                <td>
                  <span className="badge">{s.recurrence}</span>
                </td>
                <td>
                  <span
                    className={
                      "badge stage-" +
                      (s.state === "done"
                        ? "done"
                        : s.state === "failed" || s.state === "skipped"
                          ? "failed"
                          : "running")
                    }
                  >
                    {formatScheduleState(s.state)}
                  </span>
                  {s.confirmedBy ? (
                    <div className="muted small">confirmed by {s.confirmedBy}</div>
                  ) : null}
                </td>
                <td>
                  <div className="cell-actions">
                    {canConfirm(can) &&
                      ["scheduled", "reminded", "awaiting_confirm"].includes(s.state) && (
                        <button className="btn small primary" onClick={() => void confirmSchedule(s)}>
                          Confirm
                        </button>
                      )}
                    {canConfirm(can) && canStandDownRow(s.state) && (
                      <button
                        className="btn small"
                        onClick={() =>
                          setStandDownTarget({
                            scheduleId: s.id,
                            name: s.name || "operation",
                            runAt: s.runAt,
                            recurrence: s.recurrence,
                            instanceName: s.instanceName,
                          })
                        }
                      >
                        Stand down
                      </button>
                    )}
                    {canConfirm(can) && s.state === "live" && s.fallbackProfileId && (
                      <button
                        className="btn small primary"
                        onClick={() =>
                          setFinishTarget({
                            scheduleId: s.id,
                            name: s.name || "operation",
                            fallbackProfileName: s.fallbackProfileName,
                            instanceName: s.instanceName,
                          })
                        }
                      >
                        Finish
                      </button>
                    )}
                    {can("schedule.manage") && isEditableState(s.state) && (
                      <button className="btn small" onClick={() => setEditing(s)}>
                        Edit
                      </button>
                    )}
                    {can("schedule.manage") && (
                      <button className="btn small danger" onClick={() => void del(s)}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {(schedules.data || []).length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No schedules.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && (
        <ScheduleForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            schedules.reload();
          }}
        />
      )}
      {editing && (
        <ScheduleForm
          schedule={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            schedules.reload();
          }}
        />
      )}
      {finishTarget && (
        <FinishScheduleModal
          target={finishTarget}
          onClose={() => setFinishTarget(null)}
          onFinished={() => schedules.reload()}
        />
      )}
      {standDownTarget && (
        <StandDownScheduleModal
          target={standDownTarget}
          onClose={() => setStandDownTarget(null)}
          onStoodDown={() => schedules.reload()}
        />
      )}
    </div>
  );
}

function ScheduleForm({
  schedule,
  onClose,
  onSaved,
}: {
  schedule?: Schedule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const instances = useList<Instance[]>(() => api.get("/instances"));
  const profiles = useList<MissionProfile[]>(() => api.get("/profiles"));
  const [instanceId, setInstanceId] = useState(schedule?.instanceId || "");
  const [profileId, setProfileId] = useState(schedule?.profileId || "");
  const [fallbackProfileId, setFallbackProfileId] = useState(schedule?.fallbackProfileId || "");
  const [name, setName] = useState(schedule?.name || "");
  const [runAt, setRunAt] = useState(schedule ? toDatetimeLocalValue(schedule.runAt) : "");
  const [recurrence, setRecurrence] = useState(schedule?.recurrence || "none");
  const [discordChannel, setDiscordChannel] = useState(schedule?.discordChannel || "");
  const [requesterDiscordId, setRequesterDiscordId] = useState(schedule?.requesterDiscordId || "");
  const [saving, setSaving] = useState(false);
  const editing = !!schedule;

  useEffect(() => {
    if (!instanceId && instances.data?.length) setInstanceId(instances.data[0].id);
  }, [instances.data, instanceId]);

  async function save() {
    if (!profileId || !runAt || !instanceId) {
      alert("Instance, profile and run time required");
      return;
    }
    if (fallbackProfileId && fallbackProfileId === profileId) {
      alert("Fallback profile must differ from the operation profile");
      return;
    }
    setSaving(true);
    try {
      const body = {
        instanceId,
        profileId,
        fallbackProfileId: fallbackProfileId || null,
        name,
        runAt: new Date(runAt).toISOString(),
        recurrence,
        reminderOffsets: schedule?.reminderOffsets || [1440, 360, 60, 0],
        discordChannel,
        requesterDiscordId,
      };
      if (editing && schedule) {
        await api.put(`/schedules/${schedule.id}`, body);
      } else {
        await api.post("/schedules", body);
      }
      onSaved();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? "Edit schedule" : "New schedule"} onClose={onClose}>
      <div className="grid" style={{ gap: 12 }}>
        <div>
          <label>Instance</label>
          <select value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
            {(instances.data || []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Operation profile</label>
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">— select —</option>
            {(profiles.data || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Fallback profile (optional)</label>
          <select value={fallbackProfileId} onChange={(e) => setFallbackProfileId(e.target.value)}>
            <option value="">— none —</option>
            {(profiles.data || [])
              .filter((p) => p.id !== profileId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <div className="muted small" style={{ marginTop: 4 }}>
            After the operation profile is applied, Finish restores this profile (the server’s usual setup).
          </div>
        </div>
        <div>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday Op" />
        </div>
        <div>
          <label>Run at</label>
          <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
        </div>
        <div>
          <label>Recurrence</label>
          <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="none">none</option>
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
          </select>
        </div>
        <div>
          <label>Requester Discord ID (optional)</label>
          <input
            value={requesterDiscordId}
            onChange={(e) => setRequesterDiscordId(e.target.value)}
            placeholder="Can confirm via Discord reaction"
          />
        </div>
        <div>
          <label>Discord channel ID (optional)</label>
          <input
            value={discordChannel}
            onChange={(e) => setDiscordChannel(e.target.value)}
            placeholder="Defaults to Admin command channel"
          />
        </div>
        {editing && (
          <div className="muted small">
            Changing the run time re-arms reminders. Confirmation is kept if the new time is still in the future.
            Finished schedules (done / skipped / failed) reopen as upcoming when saved.
          </div>
        )}
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : editing ? "Save" : "Create"}
        </button>
      </div>
    </Modal>
  );
}
