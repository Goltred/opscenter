import { useEffect, useState } from "react";
import { api, Instance, MissionProfile, Schedule } from "../api";
import { useAuth } from "../auth";
import { Modal, useList } from "../components/ui";

export function Schedules() {
  const { can } = useAuth();
  const schedules = useList<Schedule[]>(() => api.get("/schedules"));
  const [creating, setCreating] = useState(false);

  async function approve(s: Schedule) { await api.post(`/schedules/${s.id}/approve`); schedules.reload(); }
  async function del(s: Schedule) { if (!confirm("Delete schedule?")) return; await api.del(`/schedules/${s.id}`); schedules.reload(); }

  return (
    <div>
      <div className="page-head row between">
        <div><h1>Scheduler</h1><div className="muted">Schedule a profile onto a specific instance; Discord posts approval-gated reminders.</div></div>
        {can("schedule.manage") && <button className="btn primary" onClick={() => setCreating(true)}>New schedule</button>}
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Run at</th><th>Recurrence</th><th>State</th><th></th></tr></thead>
          <tbody>
            {(schedules.data || []).map((s) => (
              <tr key={s.id}>
                <td>{s.name || "(unnamed)"}</td>
                <td className="tag">{new Date(s.runAt).toLocaleString()}</td>
                <td><span className="badge">{s.recurrence}</span></td>
                <td><span className={"badge stage-" + (s.state === "done" ? "done" : s.state === "failed" ? "failed" : "running")}>{s.state}</span></td>
                <td>
                  <div className="cell-actions">
                  {can("schedule.manage") && (s.state === "scheduled" || s.state === "reminded") && <button className="btn small primary" onClick={() => approve(s)}>Approve</button>}
                  {can("schedule.manage") && <button className="btn small danger" onClick={() => del(s)}>Delete</button>}
                  </div>
                </td>
              </tr>
            ))}
            {(schedules.data || []).length === 0 && <tr><td colSpan={5} className="muted">No schedules.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <CreateSchedule onClose={() => setCreating(false)} onSaved={() => { setCreating(false); schedules.reload(); }} />}
    </div>
  );
}

function CreateSchedule({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const instances = useList<Instance[]>(() => api.get("/instances"));
  const profiles = useList<MissionProfile[]>(() => api.get("/profiles"));
  const [instanceId, setInstanceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [name, setName] = useState("");
  const [runAt, setRunAt] = useState("");
  const [recurrence, setRecurrence] = useState("none");
  const [discordChannel, setDiscordChannel] = useState("");

  useEffect(() => {
    if (!instanceId && instances.data?.length) setInstanceId(instances.data[0].id);
  }, [instances.data, instanceId]);

  async function save() {
    if (!profileId || !runAt || !instanceId) { alert("Instance, profile and run time required"); return; }
    try {
      await api.post("/schedules", {
        instanceId,
        profileId,
        name,
        runAt: new Date(runAt).toISOString(),
        recurrence,
        reminderOffsets: [60, 15],
        discordChannel,
      });
      onSaved();
    } catch (e: any) { alert(e.message); }
  }

  return (
    <Modal title="New schedule" onClose={onClose}>
      <div className="grid" style={{ gap: 12 }}>
        <div>
          <label>Instance</label>
          <select value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
            {(instances.data || []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
        <div>
          <label>Profile</label>
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">— select —</option>
            {(profiles.data || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday Op" /></div>
        <div><label>Run at</label><input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} /></div>
        <div><label>Recurrence</label><select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}><option value="none">none</option><option value="daily">daily</option><option value="weekly">weekly</option></select></div>
        <div><label>Discord channel ID (optional)</label><input value={discordChannel} onChange={(e) => setDiscordChannel(e.target.value)} /></div>
        <button className="btn primary" onClick={save}>Create</button>
      </div>
    </Modal>
  );
}
