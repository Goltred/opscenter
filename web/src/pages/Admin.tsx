import { useEffect, useState } from "react";
import { api, AuditEntry, Host, Instance, Role, User, UserRole } from "../api";
import { useAuth } from "../auth";
import { useToast } from "../components/Toast";
import { Modal, useList } from "../components/ui";
import { formatDateTime } from "../formatTime";
import { notifySteamWebApiChanged, STEAM_WEB_API_EVENT } from "../steamWebApiHealth";

const tabs = ["Users", "Roles", "Steam", "Discord", "Audit"] as const;
type Tab = (typeof tabs)[number];

type SteamAccountRow = { id: string; label: string; username: string; guardCached?: boolean };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function Admin() {
  const [tab, setTab] = useState<Tab>("Users");
  const [steamWebApiMissing, setSteamWebApiMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .get<{ configured: boolean }>("/steam/web-api-key")
        .then((r) => {
          if (!cancelled) setSteamWebApiMissing(!r.configured);
        })
        .catch(() => {
          /* keep */
        });
    };
    load();
    const onChanged = () => load();
    window.addEventListener(STEAM_WEB_API_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(STEAM_WEB_API_EVENT, onChanged);
    };
  }, [tab]);

  return (
    <div>
      <div className="page-head"><h1>Admin</h1><div className="muted">Users, granular roles, Steam credentials, and audit.</div></div>
      <div className="row" style={{ marginBottom: 16, gap: 8, flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            className={"btn small " + (tab === t ? "primary" : "")}
            onClick={() => setTab(t)}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t}
              {t === "Steam" && steamWebApiMissing && (
                <span
                  className="nav-alert"
                  title="Steam Web API key not set"
                  aria-label="Steam Web API key not set"
                  style={{ position: "static" }}
                >
                  !
                </span>
              )}
            </span>
          </button>
        ))}
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
  const toast = useToast();
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
    } catch (e: unknown) {
      toast.error("Delete failed", { message: errorMessage(e) });
    }
  }

  const pending = (users.data || []).filter((u) => !u.approved);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h2>Access model</h2>
        <div className="muted small">
          Users sign in with OAuth (Discord, Google, Microsoft, Steam, Epic). New accounts stay pending until you approve them and assign a role.
          Owners are seeded via <code>OC_BOOTSTRAP_OWNERS</code> (provider:subject allowlist).
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
  const toast = useToast();
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
    catch (e: unknown) { toast.error("Assign role failed", { message: errorMessage(e) }); }
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
  const toast = useToast();
  const roles = useList<Role[]>(() => api.get("/roles"));
  const perms = useList<string[]>(() => api.get("/permissions"));
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<Role | null>(null);

  async function create() {
    try { await api.post("/roles", { name, description: "", permissions: [] }); setName(""); roles.reload(); }
    catch (e: unknown) { toast.error("Create role failed", { message: errorMessage(e) }); }
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
  const toast = useToast();
  const [sel, setSel] = useState<string[]>(role.permissions);
  function toggle(p: string) { setSel(sel.includes(p) ? sel.filter((x) => x !== p) : [...sel, p]); }
  async function save() { try { await api.put(`/roles/${role.id}/permissions`, { permissions: sel }); onSaved(); } catch (e: unknown) { toast.error("Save failed", { message: errorMessage(e) }); } }
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
  const toast = useToast();
  const { can } = useAuth();
  const accounts = useList<SteamAccountRow[]>(() => api.get("/steam-accounts"));
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  type WebApiStatus = {
    configured: boolean;
    source: "panel" | "env" | "none";
    hasPanelKey: boolean;
    hasEnvKey: boolean;
  };
  const [webApi, setWebApi] = useState<WebApiStatus | null>(null);
  const [webApiKey, setWebApiKey] = useState("");
  const [webApiBusy, setWebApiBusy] = useState(false);

  async function reloadWebApi() {
    try {
      setWebApi(await api.get<WebApiStatus>("/steam/web-api-key"));
    } catch {
      setWebApi(null);
    }
  }

  useEffect(() => {
    void reloadWebApi();
  }, []);

  async function add() {
    try {
      await api.post("/steam-accounts", { label, username, password });
      setLabel("");
      setUsername("");
      setPassword("");
      accounts.reload();
    } catch (e: unknown) {
      toast.error("Add account failed", { message: errorMessage(e) });
    }
  }
  async function del(id: string) {
    await api.del(`/steam-accounts/${id}`);
    accounts.reload();
  }

  async function saveWebApiKey() {
    if (!webApiKey.trim()) {
      toast.error("Enter an API key", { message: "Or clear the panel key if you only want the env fallback." });
      return;
    }
    setWebApiBusy(true);
    try {
      const next = await api.put<WebApiStatus>("/steam/web-api-key", { apiKey: webApiKey.trim() });
      setWebApi(next);
      setWebApiKey("");
      notifySteamWebApiChanged();
      toast.success("Steam Web API key saved", {
        message: "Existing mods are not auto-refreshed (avoids Steam rate limits). On Mods, use Refresh titles for placeholder names; deps refresh on next resolve/apply.",
        action: { label: "Open Mods", to: "/mods" },
        ttlMs: 14_000,
      });
    } catch (e: unknown) {
      toast.error("Save failed", { message: errorMessage(e) });
    } finally {
      setWebApiBusy(false);
    }
  }

  async function clearWebApiKey() {
    if (!confirm("Remove the panel-saved Steam Web API key? Env OC_OAUTH_STEAM_API_KEY still applies if set.")) return;
    setWebApiBusy(true);
    try {
      const next = await api.put<WebApiStatus>("/steam/web-api-key", { clear: true });
      setWebApi(next);
      setWebApiKey("");
      notifySteamWebApiChanged();
      toast.success("Panel API key cleared");
    } catch (e: unknown) {
      toast.error("Clear failed", { message: errorMessage(e) });
    } finally {
      setWebApiBusy(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h2>Steam Web API key</h2>
        <div className="muted small">
          Not your Steam login. This is a free key from{" "}
          <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">
            steamcommunity.com/dev/apikey
          </a>
          . It improves workshop <strong>titles</strong> and <strong>required-item</strong> resolution on Mods /
          Modlists. SteamCMD downloads still use the accounts below.
        </div>
        {webApi && !webApi.configured && (
          <div className="warn-banner" style={{ marginTop: 10 }}>
            No Web API key configured. Modlists may show IDs/URLs instead of names, and dependency expansion is less
            reliable. You can also set <code>OC_OAUTH_STEAM_API_KEY</code> in the environment.
          </div>
        )}
        {webApi?.configured && (
          <div className="ok-banner" style={{ marginTop: 10 }}>
            Key active via {webApi.source === "panel" ? "Admin (panel)" : "environment (OC_OAUTH_STEAM_API_KEY)"}
            {webApi.source === "panel" && webApi.hasEnvKey ? " · env also set (panel wins)" : ""}
            .
          </div>
        )}
        {can("steam.config") && (
          <div className="grid" style={{ gap: 10, marginTop: 10 }}>
            <div>
              <label>API key</label>
              <input
                type="password"
                value={webApiKey}
                onChange={(e) => setWebApiKey(e.target.value)}
                placeholder={webApi?.hasPanelKey ? "•••••••• (enter new to replace)" : "Paste Steam Web API key"}
                autoComplete="off"
              />
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn primary" disabled={webApiBusy || !webApiKey.trim()} onClick={() => void saveWebApiKey()}>
                {webApiBusy ? "Saving…" : "Save API key"}
              </button>
              {webApi?.hasPanelKey && (
                <button type="button" className="btn" disabled={webApiBusy} onClick={() => void clearWebApiKey()}>
                  Clear panel key
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Add Steam account</h2>
        <div className="muted small">
          Passwords are encrypted at rest on the panel (<code>OC_SECRETS_KEY</code>).
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

type DiscordStatus = {
  enabled: boolean;
  guildId: string;
  commandChannel: string;
  authorizedRoleId: string;
  hasToken: boolean;
  oauthClientId?: string;
  inviteUrl?: string | null;
  connected?: boolean;
  botTag?: string | null;
  botId?: string | null;
  restartHint?: boolean;
};

type DiscordOption = { id: string; name: string };

function Discord() {
  const { user } = useAuth();
  const linkedDiscord = (user?.identities || []).find((i) => i.provider === "discord");

  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [guildId, setGuildId] = useState("");
  const [commandChannel, setCommandChannel] = useState("");
  const [authorizedRoleId, setAuthorizedRoleId] = useState("");
  const [token, setToken] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [guilds, setGuilds] = useState<DiscordOption[]>([]);
  const [channels, setChannels] = useState<DiscordOption[]>([]);
  const [roles, setRoles] = useState<DiscordOption[]>([]);
  const [pickersError, setPickersError] = useState("");

  async function reloadStatus() {
    const s = await api.get<DiscordStatus>("/discord/status");
    setStatus(s);
    setEnabled(!!s.enabled);
    setGuildId(s.guildId || "");
    setCommandChannel(s.commandChannel || "");
    setAuthorizedRoleId(s.authorizedRoleId || "");
    return s;
  }

  useEffect(() => {
    void reloadStatus().catch((e: unknown) => setError(errorMessage(e) || "Failed to load Discord settings"));
  }, []);

  useEffect(() => {
    if (!status?.connected) {
      setGuilds([]);
      setChannels([]);
      setRoles([]);
      return;
    }
    let cancelled = false;
    setPickersError("");
    api
      .get<DiscordOption[]>("/discord/guilds")
      .then((rows) => {
        if (!cancelled) setGuilds(Array.isArray(rows) ? rows : []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPickersError(errorMessage(e) || "Could not list servers");
      });
    return () => {
      cancelled = true;
    };
  }, [status?.connected, status?.botId]);

  useEffect(() => {
    if (!status?.connected || !guildId) {
      setChannels([]);
      setRoles([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      api.get<DiscordOption[]>(`/discord/guilds/${encodeURIComponent(guildId)}/channels`),
      api.get<DiscordOption[]>(`/discord/guilds/${encodeURIComponent(guildId)}/roles`),
    ])
      .then(([ch, ro]) => {
        if (cancelled) return;
        setChannels(Array.isArray(ch) ? ch : []);
        setRoles(Array.isArray(ro) ? ro : []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPickersError(errorMessage(e) || "Could not list channels/roles");
      });
    return () => {
      cancelled = true;
    };
  }, [status?.connected, guildId]);

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const r = await api.put<DiscordStatus & { status: string; error?: string }>("/discord/config", {
        enabled,
        guildId,
        commandChannel,
        authorizedRoleId,
        token,
      });
      setToken("");
      await reloadStatus();
      if (r.error) {
        setError(r.error);
      } else if (r.connected) {
        setMessage(r.botTag ? `Connected as ${r.botTag}.` : "Saved and connected.");
      } else if (enabled) {
        setMessage("Saved. Bot is not connected yet — check the token and Developer Portal intents.");
      } else {
        setMessage("Saved. Discord integration is off.");
      }
    } catch (e: unknown) {
      setError(errorMessage(e) || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const connected = !!status?.connected;
  const inviteUrl = status?.inviteUrl || null;

  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <h2>Discord integration</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Ops Control uses a Discord bot for schedule reminders, Confirm / Stand down / Finish,{" "}
        <code>/schedule</code> (upcoming ops), and instance / headless commands. Use <code>/help</code> in Discord to see
        what people can do. Signing in with Discord is separate — it only links your panel user.
      </p>

      <div
        className={"badge " + (connected ? "stage-done" : status?.enabled && status?.hasToken ? "stage-running" : "")}
        style={{ marginBottom: 14 }}
      >
        {connected
          ? `Connected${status?.botTag ? ` as ${status.botTag}` : ""}`
          : status?.enabled && status?.hasToken
            ? "Not connected"
            : "Off"}
      </div>

      {linkedDiscord ? (
        <p className="muted small" style={{ marginTop: 0 }}>
          You are signed in with Discord as{" "}
          <strong>{linkedDiscord.displayName || linkedDiscord.subject}</strong>. With schedule permissions, you can
          Confirm / Stand down / Finish in Discord without a staff role.
        </p>
      ) : (
        <p className="muted small" style={{ marginTop: 0 }}>
          Tip: sign in to the panel with Discord so your account is linked for schedule actions in Discord.
        </p>
      )}

      <div className="grid" style={{ gap: 18 }}>
        <section>
          <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>1. Connect the bot</h3>
          <p className="muted small" style={{ margin: "0 0 10px" }}>
            Paste the bot token from the Discord Developer Portal (same application as Discord login is fine). Then
            invite the bot to your server.
          </p>
          <label className="row" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable Discord bot
          </label>
          <div style={{ marginBottom: 10 }}>
            <label>
              Bot token {status?.hasToken ? <span className="badge stage-done">set</span> : null}
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={status?.hasToken ? "Leave blank to keep current token" : "Paste bot token"}
              autoComplete="off"
            />
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            {inviteUrl ? (
              <a className="btn small primary" href={inviteUrl} target="_blank" rel="noreferrer">
                Invite bot to server
              </a>
            ) : (
              <span className="muted small">
                Set <code>OC_OAUTH_DISCORD_CLIENT_ID</code> to generate an invite link.
              </span>
            )}
          </div>
          <ul className="muted small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            <li>In the Developer Portal, enable Message Content and Server Members intents for the bot.</li>
            <li>Invite uses send messages, reactions, and slash commands.</li>
          </ul>
        </section>

        <section>
          <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>2. Choose server and channel</h3>
          <p className="muted small" style={{ margin: "0 0 10px" }}>
            Where schedule messages go by default. Save with the bot enabled first so these lists can load.
          </p>
          {pickersError ? <div className="error small">{pickersError}</div> : null}
          {connected ? (
            <div className="grid" style={{ gap: 10 }}>
              <div>
                <label>Server</label>
                <select value={guildId} onChange={(e) => setGuildId(e.target.value)}>
                  <option value="">— select server —</option>
                  {guilds.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                  {guildId && !guilds.some((g) => g.id === guildId) ? (
                    <option value={guildId}>Current ({guildId})</option>
                  ) : null}
                </select>
              </div>
              <div>
                <label>Ops channel</label>
                <select
                  value={commandChannel}
                  onChange={(e) => setCommandChannel(e.target.value)}
                  disabled={!guildId}
                >
                  <option value="">— select channel —</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  {commandChannel && !channels.some((c) => c.id === commandChannel) ? (
                    <option value={commandChannel}>Current ({commandChannel})</option>
                  ) : null}
                </select>
                <div className="muted small">Default channel for reminders and confirm messages.</div>
              </div>
              <div>
                <label>Staff role that can confirm ops</label>
                <select
                  value={authorizedRoleId}
                  onChange={(e) => setAuthorizedRoleId(e.target.value)}
                  disabled={!guildId}
                >
                  <option value="">— none (panel users + schedule creator only) —</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                  {authorizedRoleId && !roles.some((r) => r.id === authorizedRoleId) ? (
                    <option value={authorizedRoleId}>Current ({authorizedRoleId})</option>
                  ) : null}
                </select>
                <div className="muted small">
                  Optional. Members with this Discord role can Confirm / Stand down / Finish without a panel account.
                </div>
              </div>
            </div>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              Connect the bot (step 1 + Save) to pick server, channel, and role from dropdowns instead of pasting IDs.
            </p>
          )}
        </section>

        <section>
          <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>3. Who can act in Discord</h3>
          <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>The person who created the schedule in Discord</li>
            <li>Panel users signed in with Discord who have schedule permissions</li>
            <li>Members with the staff role above (if set)</li>
          </ul>
        </section>

        <section>
          <button type="button" className="btn small ghost" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? "Hide advanced" : "Paste IDs manually"}
          </button>
          {advanced && (
            <div className="grid" style={{ gap: 10, marginTop: 10 }}>
              <div>
                <label>Guild ID</label>
                <input value={guildId} onChange={(e) => setGuildId(e.target.value)} placeholder="Server snowflake" />
              </div>
              <div>
                <label>Command channel ID</label>
                <input
                  value={commandChannel}
                  onChange={(e) => setCommandChannel(e.target.value)}
                  placeholder="Channel snowflake"
                />
              </div>
              <div>
                <label>Authorized role ID</label>
                <input
                  value={authorizedRoleId}
                  onChange={(e) => setAuthorizedRoleId(e.target.value)}
                  placeholder="Role snowflake"
                />
              </div>
            </div>
          )}
        </section>

        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => void reloadStatus().catch((e: unknown) => setError(errorMessage(e)))}
          >
            Refresh status
          </button>
        </div>
        {message ? <div className="muted small">{message}</div> : null}
        {error ? <div className="error small">{error}</div> : null}
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
              <td className="tag">{formatDateTime(e.createdAt)}</td>
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
