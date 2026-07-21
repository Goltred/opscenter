import { useState } from "react";
import { api, AuditEntry, Host, Instance, Role, User, UserRole } from "../api";
import { Modal, useList } from "../components/ui";

const tabs = ["Users", "Roles", "Steam", "Discord", "Audit"] as const;
type Tab = (typeof tabs)[number];

export function Admin() {
  const [tab, setTab] = useState<Tab>("Users");
  return (
    <div>
      <div className="page-head"><h1>Admin</h1><div className="muted">Users, granular roles, Steam credentials, and audit.</div></div>
      <div className="row" style={{ marginBottom: 16 }}>
        {tabs.map((t) => <button key={t} className={"btn small " + (tab === t ? "primary" : "")} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      {tab === "Users" && <Users />}
      {tab === "Roles" && <Roles />}
      {tab === "Steam" && <Steam />}
      {tab === "Discord" && <Discord />}
      {tab === "Audit" && <Audit />}
    </div>
  );
}

function Users() {
  const users = useList<User[]>(() => api.get("/users"));
  const [managing, setManaging] = useState<User | null>(null);

  async function toggle(u: User) { await api.post(`/users/${u.id}/disable`, { disabled: !u.disabled }); users.reload(); }
  async function approve(u: User, approved: boolean) {
    await api.post(`/users/${u.id}/approve`, { approved });
    users.reload();
  }
  async function removeUser(u: User) {
    if (!confirm(`Delete ${u.displayName || u.email}? They can sign in again later (pending approval).`)) return;
    try {
      await api.del(`/users/${u.id}`);
      users.reload();
    } catch (e: any) {
      alert(e.message || "Delete failed");
    }
  }

  const pending = (users.data || []).filter((u) => !u.approved);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h2>Access model</h2>
        <div className="muted small">
          Users sign in with OAuth (Discord, Google, Microsoft, Steam, Epic). New accounts stay pending until you approve them and assign a role.
          Owners are seeded via <code>A3P_BOOTSTRAP_OWNERS</code> (provider:subject allowlist).
        </div>
      </div>
      {pending.length > 0 && (
        <div className="card">
          <h2>Pending approval ({pending.length})</h2>
          <table>
            <thead><tr><th>Name</th><th>Identity</th><th></th></tr></thead>
            <tbody>
              {pending.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td>
                  <td className="tag">{(u.identities || []).map((i) => `${i.provider}:${i.subject}`).join(", ") || u.email}</td>
                  <td>
                    <div className="cell-actions">
                      <button className="btn small primary" onClick={() => approve(u, true)}>Approve</button>
                      <button className="btn small" onClick={() => setManaging(u)}>Roles</button>
                      <button className="btn small danger" onClick={() => removeUser(u)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Identities</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {(users.data || []).map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}<div className="muted small tag">{u.email}</div></td>
                <td className="tag">{(u.identities || []).map((i) => i.provider).join(", ") || "—"}</td>
                <td>
                  {!u.approved ? <span className="badge warn">pending</span>
                    : u.disabled ? <span className="badge stage-failed">disabled</span>
                      : <span className="badge stage-done">active</span>}
                </td>
                <td>
                  <div className="cell-actions">
                    {!u.approved && <button className="btn small primary" onClick={() => approve(u, true)}>Approve</button>}
                    {u.approved && <button className="btn small" onClick={() => approve(u, false)}>Revoke approval</button>}
                    <button className="btn small" onClick={() => setManaging(u)}>Roles</button>
                    <button className="btn small" onClick={() => toggle(u)}>{u.disabled ? "Enable" : "Disable"}</button>
                    <button className="btn small danger" onClick={() => removeUser(u)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {managing && <ManageRoles user={managing} onClose={() => { setManaging(null); users.reload(); }} />}
    </div>
  );
}

function ManageRoles({ user, onClose }: { user: User; onClose: () => void }) {
  const assignments = useList<UserRole[]>(() => api.get(`/users/${user.id}/roles`), [user.id]);
  const roles = useList<Role[]>(() => api.get("/roles"));
  const hosts = useList<Host[]>(() => api.get("/hosts"));
  const instances = useList<Instance[]>(() => api.get("/instances"));
  const [roleId, setRoleId] = useState("");
  const [scopeType, setScopeType] = useState("global");
  const [scopeId, setScopeId] = useState("");

  async function assign() {
    if (!roleId) return;
    try { await api.post(`/users/${user.id}/roles`, { roleId, scopeType, scopeId: scopeType === "global" ? "" : scopeId }); assignments.reload(); }
    catch (e: any) { alert(e.message); }
  }
  async function remove(a: UserRole) { await api.del(`/users/${user.id}/roles/${a.id}`); assignments.reload(); }

  return (
    <Modal title={`Roles — ${user.displayName || user.email}`} onClose={onClose}>
      <div className="grid" style={{ gap: 12 }}>
        <div className="card">
          <h2>Assign role</h2>
          <div className="row">
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)}><option value="">— role —</option>{(roles.data || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            <select value={scopeType} onChange={(e) => setScopeType(e.target.value)}><option value="global">global</option><option value="host">host</option><option value="instance">instance</option></select>
            {scopeType === "host" && <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}><option value="">— host —</option>{(hosts.data || []).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>}
            {scopeType === "instance" && <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}><option value="">— instance —</option>{(instances.data || []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>}
            <button className="btn" onClick={assign}>Assign</button>
          </div>
        </div>
        <table>
          <thead><tr><th>Role</th><th>Scope</th><th></th></tr></thead>
          <tbody>
            {(assignments.data || []).map((a) => (
              <tr key={a.id}><td>{a.roleName}</td><td className="tag">{a.scopeType}{a.scopeId ? ":" + a.scopeId.slice(0, 8) : ""}</td><td><button className="btn small danger" onClick={() => remove(a)}>Remove</button></td></tr>
            ))}
            {(assignments.data || []).length === 0 && <tr><td colSpan={3} className="muted">No roles assigned.</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function Roles() {
  const roles = useList<Role[]>(() => api.get("/roles"));
  const perms = useList<string[]>(() => api.get("/permissions"));
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<Role | null>(null);

  async function create() {
    try { await api.post("/roles", { name, description: "", permissions: [] }); setName(""); roles.reload(); }
    catch (e: any) { alert(e.message); }
  }
  async function del(r: Role) { if (!confirm("Delete role?")) return; await api.del(`/roles/${r.id}`); roles.reload(); }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h2>Create role</h2>
        <div className="row"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Role name" style={{ maxWidth: 260 }} /><button className="btn primary" onClick={create}>Create</button></div>
      </div>
      <div className="grid cols-2">
        {(roles.data || []).map((r) => (
          <div className="card" key={r.id}>
            <div className="row between">
              <div><strong>{r.name}</strong> {r.builtin && <span className="badge">builtin</span>}</div>
              <div className="row">
                <button className="btn small" onClick={() => setEditing(r)}>Edit permissions</button>
                {!r.builtin && <button className="btn small danger" onClick={() => del(r)}>Delete</button>}
              </div>
            </div>
            <div className="muted small">{r.description}</div>
            <div className="pill-list" style={{ marginTop: 8 }}>{r.permissions.map((p) => <span className="pill" key={p}>{p}</span>)}</div>
          </div>
        ))}
      </div>
      {editing && <EditPerms role={editing} all={perms.data || []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); roles.reload(); }} />}
    </div>
  );
}

function EditPerms({ role, all, onClose, onSaved }: { role: Role; all: string[]; onClose: () => void; onSaved: () => void }) {
  const [sel, setSel] = useState<string[]>(role.permissions);
  function toggle(p: string) { setSel(sel.includes(p) ? sel.filter((x) => x !== p) : [...sel, p]); }
  async function save() { try { await api.put(`/roles/${role.id}/permissions`, { permissions: sel }); onSaved(); } catch (e: any) { alert(e.message); } }
  return (
    <Modal title={`Permissions — ${role.name}`} onClose={onClose}>
      <div className="grid cols-2" style={{ gap: 6 }}>
        {all.map((p) => (
          <label key={p} className="row" style={{ gap: 6 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={sel.includes(p)} onChange={() => toggle(p)} /> <span className="tag">{p}</span>
          </label>
        ))}
      </div>
      <button className="btn primary" style={{ marginTop: 12 }} onClick={save}>Save</button>
    </Modal>
  );
}

function Steam() {
  const accounts = useList<any[]>(() => api.get("/steam-accounts"));
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  async function add() {
    try { await api.post("/steam-accounts", { label, username, password }); setLabel(""); setUsername(""); setPassword(""); accounts.reload(); }
    catch (e: any) { alert(e.message); }
  }
  async function del(id: string) { await api.del(`/steam-accounts/${id}`); accounts.reload(); }
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h2>Add Steam account</h2>
        <div className="muted small">
          Passwords are encrypted at rest on the panel (<code>A3P_SECRETS_KEY</code>).
          The agent receives them only for each SteamCMD job over the WebSocket — nothing needs to go in <code>agent.json</code>.
          Prefer <code>wss://</code> for the agent gateway in production.
        </div>
        <div className="grid cols-3" style={{ gap: 10, marginTop: 10 }}>
          <div><label>Label</label><input value={label} onChange={(e) => setLabel(e.target.value)} /></div>
          <div><label>Username</label><input value={username} onChange={(e) => setUsername(e.target.value)} /></div>
          <div><label>Password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        </div>
        <button className="btn primary" style={{ marginTop: 10 }} onClick={add}>Add</button>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Label</th><th>Username</th><th>Guard cached</th><th></th></tr></thead>
          <tbody>
            {(accounts.data || []).map((a) => (
              <tr key={a.id}><td>{a.label}</td><td className="tag">{a.username}</td><td>{a.guardCached ? "yes" : "no"}</td><td><button className="btn small danger" onClick={() => del(a.id)}>Delete</button></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Discord() {
  const cfg = useList<any>(() => api.get("/discord/config"));
  const [enabled, setEnabled] = useState(false);
  const [guildId, setGuildId] = useState("");
  const [commandChannel, setCommandChannel] = useState("");
  const [authorizedRoleId, setAuthorizedRoleId] = useState("");
  const [token, setToken] = useState("");
  const [loaded, setLoaded] = useState(false);

  if (cfg.data && !loaded) {
    setEnabled(cfg.data.enabled); setGuildId(cfg.data.guildId || ""); setCommandChannel(cfg.data.commandChannel || ""); setAuthorizedRoleId(cfg.data.authorizedRoleId || ""); setLoaded(true);
  }

  async function save() {
    try { await api.put("/discord/config", { enabled, guildId, commandChannel, authorizedRoleId, token }); setToken(""); alert("Saved. Restart control plane to (re)connect the bot."); cfg.reload(); }
    catch (e: any) { alert(e.message); }
  }
  return (
    <div className="card">
      <h2>Discord integration</h2>
      <div className="grid" style={{ gap: 10, maxWidth: 480 }}>
        <label className="row"><input type="checkbox" style={{ width: "auto" }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
        <div><label>Bot token {cfg.data?.hasToken && <span className="badge stage-done">set</span>}</label><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cfg.data?.hasToken ? "•••• (leave blank to keep)" : "paste token"} /></div>
        <div><label>Guild ID</label><input value={guildId} onChange={(e) => setGuildId(e.target.value)} /></div>
        <div><label>Command channel ID</label><input value={commandChannel} onChange={(e) => setCommandChannel(e.target.value)} /></div>
        <div><label>Authorized role ID</label><input value={authorizedRoleId} onChange={(e) => setAuthorizedRoleId(e.target.value)} /></div>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </div>
  );
}

function Audit() {
  const entries = useList<AuditEntry[]>(() => api.get("/audit"));
  return (
    <div className="card">
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Result</th><th>IP</th></tr></thead>
        <tbody>
          {(entries.data || []).map((e) => (
            <tr key={e.id}>
              <td className="tag">{new Date(e.createdAt).toLocaleString()}</td>
              <td>{e.actorEmail}</td>
              <td className="tag">{e.action}</td>
              <td className="tag">{e.targetId?.slice(0, 12)}</td>
              <td><span className={"badge " + (e.result === "ok" ? "stage-done" : e.result === "denied" || e.result === "failed" ? "stage-failed" : "")}>{e.result}</span></td>
              <td className="tag">{e.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
