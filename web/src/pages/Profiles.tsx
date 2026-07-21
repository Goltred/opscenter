import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Host, Instance, Mission, MissionProfile, Mod, Modlist, SharedCfgPreset } from "../api";
import { useAuth } from "../auth";
import { ApplyProfileModal, type ApplyProfileOpts } from "../components/ApplyProfileModal";
import { RevisionHistoryModal } from "../components/RevisionHistory";
import { useToast } from "../components/Toast";
import { Modal, useList } from "../components/ui";
import { CREATOR_DLCS } from "../arma/dlcs";
import {
  DIFFICULTY_OPTIONS,
  FORCED_DIFFICULTY_CHOICES,
  mergeCustomDifficulty,
  OPTION_LABELS_2,
  OPTION_LABELS_3_PING,
  OPTION_LABELS_3P,
  type DifficultyPresetName,
} from "../arma/difficultyOptions";

type HistoryTarget =
  | { kind: "profile"; profile: MissionProfile }
  | { kind: "shared-cfg"; preset: SharedCfgPreset };

export function Profiles() {
  const { can } = useAuth();
  const toast = useToast();
  const instances = useList<Instance[]>(() => api.get("/instances"));
  const hosts = useList<Host[]>(() => api.get("/hosts"));
  const profiles = useList<MissionProfile[]>(() => api.get("/profiles"));
  const presets = useList<SharedCfgPreset[]>(() => api.get("/shared-cfg-presets"));
  const [editing, setEditing] = useState<MissionProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [applyTarget, setApplyTarget] = useState<MissionProfile | null>(null);
  const [applyingId, setApplyingId] = useState("");
  const [historyTarget, setHistoryTarget] = useState<HistoryTarget | null>(null);

  const instanceList = instances.data || [];
  const hostList = hosts.data || [];
  const noInstances = !instances.loading && instanceList.length === 0;

  async function runApply(p: MissionProfile, opts: ApplyProfileOpts) {
    setApplyingId(p.id);
    setApplyTarget(null);
    try {
      const r = await api.post<{ jobId: string; instanceId: string; profileName?: string }>(`/profiles/${p.id}/apply`, opts);
      const instId = r.instanceId || opts.instanceId;
      const jobQs = r.jobId ? `?job=${encodeURIComponent(r.jobId)}` : "";
      toast.success(`Apply started — “${r.profileName || p.name}”`, {
        action: { label: "Open instance", to: `/instances/${instId}${jobQs}` },
        ttlMs: 14_000,
      });
      instances.reload();
      profiles.reload();
    } catch (e: any) {
      toast.error("Apply failed", {
        message: e.message,
        action: opts.instanceId ? { label: "Open instance", to: `/instances/${opts.instanceId}` } : undefined,
      });
    } finally {
      setApplyingId("");
    }
  }
  async function del(p: MissionProfile) {
    if (!confirm("Delete profile?")) return;
    await api.del(`/profiles/${p.id}`); profiles.reload();
  }

  return (
    <div>
      <div className="page-head row between">
        <div>
          <h1>Mission Profiles</h1>
          <div className="muted">
            Reusable library of mods, missions, and config. Shared settings below are the global server.cfg baseline; apply merges them with a profile onto any instance.
          </div>
        </div>
        <div className="row">
          {can("profile.edit") && (
            <button className="btn primary" onClick={() => setCreating(true)}>New profile</button>
          )}
        </div>
      </div>

      {noInstances && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="warn">No instances yet.</div>
          <div className="muted" style={{ marginTop: 8 }}>
            You can still create and edit profiles here. To apply one, add a host and instance from the{" "}
            <Link to="/">Dashboard</Link> and connect the agent.
          </div>
        </div>
      )}

      {can("instance.config.edit") && (
        <SharedSettingsCard
          shared={presets.data?.[0] || null}
          loading={presets.loading}
          onChanged={() => {
            presets.reload();
          }}
          onHistory={(preset) => setHistoryTarget({ kind: "shared-cfg", preset })}
        />
      )}

      {can("profile.view") && (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Mission</th><th>Mods / DLCs</th><th>Difficulty</th><th></th></tr></thead>
            <tbody>
              {(profiles.data || []).map((p) => {
                const loadedOn = instanceList.filter((i) => i.currentProfileId === p.id);
                return (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    <span className="muted small" style={{ marginLeft: 8 }}>v{p.version}</span>
                    {loadedOn.length > 0 && (
                      <span className="badge" style={{ marginLeft: 8 }} title={loadedOn.map((i) => i.name).join(", ")}>
                        loaded{loadedOn.length > 1 ? ` · ${loadedOn.length}` : loadedOn[0] ? ` · ${loadedOn[0].name}` : ""}
                      </span>
                    )}
                  </td>
                  <td>{p.missionName || (p.missionId ? <span className="tag">{p.missionId.slice(0, 8)}…</span> : <span className="muted">—</span>)}</td>
                  <td>
                    {(() => {
                      const extra = p.mods.length + p.serverMods.length;
                      if (p.modlistName || p.modlistId) {
                        return (
                          <>
                            {p.modlistName || "modlist"}
                            {extra > 0 ? <span className="muted"> +{extra}</span> : null}
                          </>
                        );
                      }
                      if (extra > 0) return `${p.mods.length} client / ${p.serverMods.length} server`;
                      return <span className="muted">—</span>;
                    })()}
                    {(p.dlcs || []).length > 0 && (
                      <div className="muted small">DLC: {(p.dlcs || []).join(", ")}</div>
                    )}
                  </td>
                  <td className="tag">{String(p.serverCfgOverrides?.forcedDifficulty || "—")}</td>
                  <td>
                    <div className="cell-actions">
                    {can("profile.apply") && (
                      <button
                        className="btn small primary"
                        disabled={!!applyingId || noInstances}
                        onClick={() => setApplyTarget(p)}
                      >
                        {applyingId === p.id ? "Applying…" : "Apply"}
                      </button>
                    )}
                    {can("profile.edit") && <button className="btn small" onClick={() => setEditing(p)}>Edit</button>}
                    <button className="btn small" onClick={() => setHistoryTarget({ kind: "profile", profile: p })}>History</button>
                    {can("profile.delete") && <button className="btn small danger" onClick={() => del(p)}>Delete</button>}
                    </div>
                  </td>
                </tr>
                );
              })}
              {(profiles.data || []).length === 0 && <tr><td colSpan={5} className="muted">No profiles yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <ProfileEditor
          profile={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); profiles.reload(); }}
          onHistory={
            editing
              ? () => {
                  setHistoryTarget({ kind: "profile", profile: editing });
                  setEditing(null);
                  setCreating(false);
                }
              : undefined
          }
        />
      )}
      {applyTarget && (
        <ApplyProfileModal
          profile={applyTarget}
          instances={instanceList}
          hosts={hostList}
          onClose={() => setApplyTarget(null)}
          onConfirm={(opts) => runApply(applyTarget, opts)}
        />
      )}
      {historyTarget?.kind === "profile" && (
        <RevisionHistoryModal
          kind="profile"
          title={`History — ${historyTarget.profile.name}`}
          listPath={`/profiles/${historyTarget.profile.id}/revisions`}
          comparePath={`/profiles/${historyTarget.profile.id}/revisions/compare`}
          restorePath={`/profiles/${historyTarget.profile.id}/restore`}
          canRestore={can("profile.edit")}
          onClose={() => setHistoryTarget(null)}
          onRestored={() => {
            profiles.reload();
            setEditing(null);
          }}
        />
      )}
      {historyTarget?.kind === "shared-cfg" && (
        <RevisionHistoryModal
          kind="shared-cfg"
          title="History — shared settings"
          listPath={`/shared-cfg-presets/${historyTarget.preset.id}/revisions`}
          comparePath={`/shared-cfg-presets/${historyTarget.preset.id}/revisions/compare`}
          restorePath={`/shared-cfg-presets/${historyTarget.preset.id}/restore`}
          canRestore={can("instance.config.edit")}
          onClose={() => setHistoryTarget(null)}
          onRestored={() => {
            presets.reload();
          }}
        />
      )}
    </div>
  );
}

function SharedSettingsCard({
  shared,
  loading,
  onChanged,
  onHistory,
}: {
  shared: SharedCfgPreset | null;
  loading: boolean;
  onChanged: () => void;
  onHistory: (preset: SharedCfgPreset) => void;
}) {
  const toast = useToast();

  useEffect(() => {
    if (window.location.hash !== "#shared-settings") return;
    document.getElementById("shared-settings")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [shared?.id]);

  const [hostname, setHostname] = useState("");
  const [password, setPassword] = useState("");
  const [passwordAdmin, setPasswordAdmin] = useState("");
  const [serverCommandPassword, setServerCommandPassword] = useState("");
  const [admins, setAdmins] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("32");
  const [battlEye, setBattlEye] = useState(true);
  const [verifySignatures, setVerifySignatures] = useState<"0" | "2">("2");
  const [steamProtocolMaxDataSize, setSteamProtocolMaxDataSize] = useState("");
  const [autoSelectMission, setAutoSelectMission] = useState(true);
  const [upnp, setUpnp] = useState(false);
  const [kickDuplicate, setKickDuplicate] = useState(true);
  const [disconnectTimeout, setDisconnectTimeout] = useState("");
  const [maxPing, setMaxPing] = useState("");
  const [maxPacketLoss, setMaxPacketLoss] = useState("");
  const [maxDesync, setMaxDesync] = useState("");
  const [kickOnPing, setKickOnPing] = useState(false);
  const [kickOnLoss, setKickOnLoss] = useState(false);
  const [kickOnDesync, setKickOnDesync] = useState(false);
  const [kickOnTimeout, setKickOnTimeout] = useState(false);
  const [disableVoN, setDisableVoN] = useState(false);
  const [vonCodecQuality, setVonCodecQuality] = useState("");
  const [persistent, setPersistent] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const c = shared?.serverCfg || {};
    const ks = Array.isArray(c.kickClientsOnSlowNetwork) ? (c.kickClientsOnSlowNetwork as number[]) : [0, 0, 0, 0];
    setHostname(String(c.hostname ?? ""));
    setPassword(String(c.password ?? ""));
    setPasswordAdmin(String(c.passwordAdmin ?? ""));
    setServerCommandPassword(String(c.serverCommandPassword ?? ""));
    setAdmins(Array.isArray(c.admins) ? (c.admins as string[]).join("\n") : String(c.admins ?? c.adminIds ?? ""));
    setMaxPlayers(String(c.maxPlayers ?? 32));
    setBattlEye(Number(c.battlEye ?? c.BattlEye ?? 1) !== 0);
    setVerifySignatures(normalizeVerifySignaturesUi(c.verifySignatures));
    setSteamProtocolMaxDataSize(String(c.steamProtocolMaxDataSize ?? ""));
    setAutoSelectMission(c.autoSelectMission == null ? true : Number(c.autoSelectMission) !== 0);
    setUpnp(Number(c.upnp ?? 0) !== 0);
    setKickDuplicate(c.kickDuplicate == null ? true : Number(c.kickDuplicate) !== 0);
    setDisconnectTimeout(String(c.DisconnectTimeout ?? c.disconnectTimeout ?? ""));
    setMaxPing(String(c.MaxPing ?? c.maxPing ?? ""));
    setMaxPacketLoss(String(c.MaxPacketLoss ?? c.maxPacketLoss ?? ""));
    setMaxDesync(String(c.MaxDesync ?? c.maxDesync ?? ""));
    setKickOnPing(Number(ks[0] ?? 0) !== 0);
    setKickOnLoss(Number(ks[1] ?? 0) !== 0);
    setKickOnDesync(Number(ks[2] ?? 0) !== 0);
    setKickOnTimeout(Number(ks[3] ?? 0) !== 0);
    setDisableVoN(Number(c.disableVoN ?? 0) !== 0);
    setVonCodecQuality(String(c.vonCodecQuality ?? ""));
    setPersistent(c.persistent == null ? true : Number(c.persistent) !== 0);
  }, [shared?.id, shared?.serverCfg, shared?.version]);

  function optNum(raw: string): number | undefined {
    const s = raw.trim();
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }

  async function save() {
    if (!shared) return;
    setSaving(true);
    try {
      const adminList = admins
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const verifySig = verifySignatures === "0" ? 0 : 2;
      const serverCfg: Record<string, unknown> = {
        ...(shared.serverCfg || {}),
        hostname: hostname.trim(),
        password,
        passwordAdmin,
        serverCommandPassword,
        maxPlayers: Number(maxPlayers) || 32,
        battlEye: battlEye ? 1 : 0,
        verifySignatures: verifySig,
        autoSelectMission: autoSelectMission ? 1 : 0,
        upnp: upnp ? 1 : 0,
        kickDuplicate: kickDuplicate ? 1 : 0,
        disableVoN: disableVoN ? 1 : 0,
        persistent: persistent ? 1 : 0,
      };

      const kickFlags = [
        kickOnPing ? 1 : 0,
        kickOnLoss ? 1 : 0,
        kickOnDesync ? 1 : 0,
        kickOnTimeout ? 1 : 0,
      ];
      const steam = optNum(steamProtocolMaxDataSize);
      if (steam != null) {
        serverCfg.steamProtocolMaxDataSize = Math.min(Math.max(steam, 1024), 8192);
      } else {
        delete serverCfg.steamProtocolMaxDataSize;
      }

      const setOrClear = (key: string, raw: string, clamp?: (n: number) => number) => {
        const n = optNum(raw);
        if (n == null) {
          delete serverCfg[key];
          return;
        }
        serverCfg[key] = clamp ? clamp(n) : n;
      };
      setOrClear("DisconnectTimeout", disconnectTimeout, (n) => Math.min(90, Math.max(1, Math.floor(n))));
      setOrClear("MaxPing", maxPing, (n) => Math.floor(n));
      setOrClear("MaxPacketLoss", maxPacketLoss, (n) => Math.floor(n));
      setOrClear("MaxDesync", maxDesync, (n) => Math.floor(n));
      setOrClear("vonCodecQuality", vonCodecQuality, (n) => Math.min(30, Math.max(1, Math.floor(n))));

      const hasNetThresholds =
        serverCfg.DisconnectTimeout != null ||
        serverCfg.MaxPing != null ||
        serverCfg.MaxPacketLoss != null ||
        serverCfg.MaxDesync != null;
      if (hasNetThresholds || kickFlags.some((f) => f === 1)) {
        serverCfg.kickClientsOnSlowNetwork = kickFlags;
      } else {
        delete serverCfg.kickClientsOnSlowNetwork;
      }

      for (const k of [
        "disconnectTimeout",
        "maxPing",
        "maxPacketLoss",
        "maxDesync",
        "kickduplicate",
        "disablevon",
      ]) {
        delete serverCfg[k];
      }

      if (adminList.length) serverCfg.admins = adminList;
      else delete serverCfg.admins;
      delete serverCfg.adminIds;

      await api.put(`/shared-cfg-presets/${shared.id}`, { serverCfg });
      toast.success("Shared settings saved");
      onChanged();
    } catch (e: any) {
      toast.error("Save failed", { message: e.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" id="shared-settings" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ marginBottom: 4, gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Shared settings</h2>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {shared && (
            <>
              <span className="muted small">v{shared.version || 1}</span>
              <button type="button" className="btn small" onClick={() => onHistory(shared)}>History</button>
            </>
          )}
        </div>
      </div>
      <div className="muted small" style={{ marginBottom: 12 }}>
        One global server.cfg baseline for every instance. On profile apply, these values are merged with the mission profile (profile overrides win on the same key).
      </div>

      {loading || !shared ? (
        <div className="muted">Loading shared settings…</div>
      ) : (
        <>
          <div className="grid cols-2" style={{ gap: 12 }}>
            <div>
              <label>Default hostname</label>
              <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="Used if profile leaves hostname blank" />
            </div>
            <div>
              <label>Max players</label>
              <input type="number" min={1} max={200} value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)} />
            </div>
            <div>
              <label>Server password</label>
              <input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label>Admin password (<code>passwordAdmin</code>)</label>
              <input value={passwordAdmin} onChange={(e) => setPasswordAdmin(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label>Server command password</label>
              <input value={serverCommandPassword} onChange={(e) => setServerCommandPassword(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label>Signature verification</label>
              <select value={verifySignatures} onChange={(e) => setVerifySignatures(e.target.value === "0" ? "0" : "2")}>
                <option value="2">Verify signatures</option>
                <option value="0">Do not verify</option>
              </select>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label>Admin Steam IDs (<code>admins[]</code>)</label>
              <textarea
                rows={3}
                value={admins}
                onChange={(e) => setAdmins(e.target.value)}
                placeholder="One Steam64 ID per line (or comma-separated)"
              />
            </div>
            <div>
              <label className="row" style={{ margin: 0, gap: 8 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={battlEye} onChange={(e) => setBattlEye(e.target.checked)} />
                <span>BattlEye</span>
              </label>
            </div>
          </div>

          <h3 style={{ marginTop: 20, marginBottom: 12 }}>Networking</h3>
          <div className="grid cols-2" style={{ gap: 12 }}>
            <div>
              <label>
                Steam query packet (<code>steamProtocolMaxDataSize</code>)
              </label>
              <input
                type="number"
                min={1024}
                max={8192}
                step={256}
                value={steamProtocolMaxDataSize}
                onChange={(e) => setSteamProtocolMaxDataSize(e.target.value)}
                placeholder="Auto"
              />
            </div>
            <div>
              <label>
                Disconnect timeout (<code>DisconnectTimeout</code>)
              </label>
              <input
                type="number"
                min={1}
                max={90}
                value={disconnectTimeout}
                onChange={(e) => setDisconnectTimeout(e.target.value)}
                placeholder="15"
              />
            </div>
            <div>
              <label>
                Max ping (<code>MaxPing</code>)
              </label>
              <input
                type="number"
                min={-1}
                value={maxPing}
                onChange={(e) => setMaxPing(e.target.value)}
                placeholder="-1"
              />
            </div>
            <div>
              <label>
                Max packet loss % (<code>MaxPacketLoss</code>)
              </label>
              <input
                type="number"
                min={-1}
                value={maxPacketLoss}
                onChange={(e) => setMaxPacketLoss(e.target.value)}
                placeholder="-1"
              />
            </div>
            <div>
              <label>
                Max desync (<code>MaxDesync</code>)
              </label>
              <input
                type="number"
                min={-1}
                value={maxDesync}
                onChange={(e) => setMaxDesync(e.target.value)}
                placeholder="-1"
              />
            </div>
            <div>
              <label>
                VoN quality (<code>vonCodecQuality</code>)
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={vonCodecQuality}
                onChange={(e) => setVonCodecQuality(e.target.value)}
                placeholder="3"
              />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={{ marginBottom: 6 }}>
                Kick on slow network (<code>kickClientsOnSlowNetwork[]</code>)
              </label>
              <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
                <label className="row" style={{ margin: 0, gap: 8 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={kickOnPing} onChange={(e) => setKickOnPing(e.target.checked)} />
                  <span>MaxPing</span>
                </label>
                <label className="row" style={{ margin: 0, gap: 8 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={kickOnLoss} onChange={(e) => setKickOnLoss(e.target.checked)} />
                  <span>MaxPacketLoss</span>
                </label>
                <label className="row" style={{ margin: 0, gap: 8 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={kickOnDesync} onChange={(e) => setKickOnDesync(e.target.checked)} />
                  <span>MaxDesync</span>
                </label>
                <label className="row" style={{ margin: 0, gap: 8 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={kickOnTimeout} onChange={(e) => setKickOnTimeout(e.target.checked)} />
                  <span>DisconnectTimeout</span>
                </label>
              </div>
            </div>
            <div>
              <label className="row" style={{ margin: 0, gap: 8 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={autoSelectMission} onChange={(e) => setAutoSelectMission(e.target.checked)} />
                <span>Auto-select mission (<code>autoSelectMission</code>)</span>
              </label>
            </div>
            <div>
              <label className="row" style={{ margin: 0, gap: 8 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={kickDuplicate} onChange={(e) => setKickDuplicate(e.target.checked)} />
                <span>Kick duplicate IDs (<code>kickDuplicate</code>)</span>
              </label>
            </div>
            <div>
              <label className="row" style={{ margin: 0, gap: 8 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={upnp} onChange={(e) => setUpnp(e.target.checked)} />
                <span>UPnP port mapping (<code>upnp</code>)</span>
              </label>
            </div>
            <div>
              <label className="row" style={{ margin: 0, gap: 8 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={disableVoN} onChange={(e) => setDisableVoN(e.target.checked)} />
                <span>Disable VoN (<code>disableVoN</code>)</span>
              </label>
            </div>
            <div>
              <label className="row" style={{ margin: 0, gap: 8 }}>
                <input type="checkbox" style={{ width: "auto" }} checked={persistent} onChange={(e) => setPersistent(e.target.checked)} />
                <span>Persistent mission (<code>persistent</code>)</span>
              </label>
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={saving || !shared} onClick={() => void save()}>
              {saving ? "Saving…" : "Save shared settings"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ProfileEditor({
  profile,
  onClose,
  onSaved,
  onHistory,
}: {
  profile: MissionProfile | null;
  onClose: () => void;
  onSaved: () => void;
  onHistory?: () => void;
}) {
  const toast = useToast();
  const mods = useList<Mod[]>(() => api.get("/mods"));
  const missions = useList<Mission[]>(() => api.get("/missions"));
  const modlists = useList<Modlist[]>(() => api.get("/modlists"));
  const [name, setName] = useState(profile?.name || "");
  const [modlistId, setModlistId] = useState(profile?.modlistId || "");
  const [selMods, setSelMods] = useState<string[]>(profile?.mods || []);
  const [selServerMods, setSelServerMods] = useState<string[]>(profile?.serverMods || []);
  const [missionId, setMissionId] = useState(profile?.missionId || "");
  const [hostname, setHostname] = useState((profile?.serverCfgOverrides?.hostname as string) || "");
  const [password, setPassword] = useState((profile?.serverCfgOverrides?.password as string) || "");
  const [passwordAdmin, setPasswordAdmin] = useState((profile?.serverCfgOverrides?.passwordAdmin as string) || "");
  const [serverCommandPassword, setServerCommandPassword] = useState(
    (profile?.serverCfgOverrides?.serverCommandPassword as string) || "",
  );
  const [adminsOverride, setAdminsOverride] = useState(() => {
    const a = profile?.serverCfgOverrides?.admins;
    if (Array.isArray(a)) return (a as string[]).join("\n");
    return String(a || "");
  });
  const [forcedDifficulty, setForcedDifficulty] = useState<DifficultyPresetName | "">(
    (normalizeForcedDifficultyUi(profile?.serverCfgOverrides?.forcedDifficulty) as DifficultyPresetName | "") || "Regular",
  );
  const [customDiff, setCustomDiff] = useState(() => mergeCustomDifficulty(profile?.customDifficulty));
  const [dlcs, setDlcs] = useState<string[]>(profile?.dlcs || []);
  const [extraArgs, setExtraArgs] = useState((profile?.extraArgs || []).join(" "));
  const [recommendedHeadlessCount, setRecommendedHeadlessCount] = useState<string>(
    profile?.recommendedHeadlessCount == null ? "" : String(profile.recommendedHeadlessCount),
  );
  const [basicCfgOverrides] = useState(profile?.basicCfgOverrides || {});
  const [resolvingDeps, setResolvingDeps] = useState(false);
  const [depsPreview, setDepsPreview] = useState<{ added: string[]; titles: Record<string, string> } | null>(null);
  const [modFilter, setModFilter] = useState("");
  const [showListContents, setShowListContents] = useState(false);

  const attached = useMemo(
    () => (modlists.data || []).find((m) => m.id === modlistId) || null,
    [modlists.data, modlistId],
  );
  const modlistClientIds = useMemo(
    () => new Set((attached?.entries || []).filter((e) => e.kind !== "server").map((e) => e.workshopId)),
    [attached],
  );
  const modlistServerIds = useMemo(
    () => new Set((attached?.entries || []).filter((e) => e.kind === "server").map((e) => e.workshopId)),
    [attached],
  );
  const modlistAllIds = useMemo(
    () => new Set([...modlistClientIds, ...modlistServerIds]),
    [modlistClientIds, modlistServerIds],
  );

  const filterQ = modFilter.trim().toLowerCase();
  const clientCatalog = useMemo(() => {
    const list = (mods.data || []).filter((m) => m.kind === "client");
    if (!filterQ) return list;
    return list.filter((m) => m.name.toLowerCase().includes(filterQ) || m.workshopId.includes(filterQ));
  }, [mods.data, filterQ]);
  const serverCatalog = useMemo(() => {
    const list = (mods.data || []).filter((m) => m.kind === "server");
    if (!filterQ) return list;
    return list.filter((m) => m.name.toLowerCase().includes(filterQ) || m.workshopId.includes(filterQ));
  }, [mods.data, filterQ]);

  const extraClientCount = selMods.filter((id) => !modlistAllIds.has(id)).length;
  const extraServerCount = selServerMods.filter((id) => !modlistAllIds.has(id)).length;

  useEffect(() => {
    if (!modlistAllIds.size) return;
    setSelMods((prev) => {
      const next = prev.filter((id) => !modlistAllIds.has(id));
      return next.length === prev.length ? prev : next;
    });
    setSelServerMods((prev) => {
      const next = prev.filter((id) => !modlistAllIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [modlistAllIds]);

  function toggle(list: string[], set: (v: string[]) => void, id: string) {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  function toggleExtra(
    list: string[],
    set: (v: string[]) => void,
    id: string,
    blocked: Set<string>,
  ) {
    if (blocked.has(id)) return;
    toggle(list, set, id);
  }

  function selectModlist(id: string) {
    setModlistId(id);
    setShowListContents(false);
    setDepsPreview(null);
    if (!id) return;
    const ml = (modlists.data || []).find((m) => m.id === id);
    if (!ml) return;
    const ids = new Set(ml.entries.map((e) => e.workshopId));
    setSelMods((prev) => prev.filter((x) => !ids.has(x)));
    setSelServerMods((prev) => prev.filter((x) => !ids.has(x)));
  }

  async function resolveSteamDeps(mergeIntoSelection: boolean) {
    const roots = uniqueIds([
      ...(attached?.entries || []).filter((e) => e.kind !== "server").map((e) => e.workshopId),
      ...selMods.filter((id) => !modlistAllIds.has(id)),
    ]);
    if (!roots.length) {
      toast.info("No client mods selected", { message: "Pick a modlist or at least one extra client mod first." });
      return;
    }
    setResolvingDeps(true);
    try {
      const r = await api.post<{
        added: string[];
        ordered: string[];
        mods: { workshopId: string; title: string; isRoot?: boolean }[];
      }>("/mods/resolve-deps", { workshopIds: roots });
      const titles = Object.fromEntries((r.mods || []).map((m) => [m.workshopId, m.title || m.workshopId]));
      setDepsPreview({ added: r.added || [], titles });
      if (mergeIntoSelection && (r.added || []).length) {
        const toAdd = (r.added || []).filter((id) => !selMods.includes(id) && !modlistAllIds.has(id));
        if (!toAdd.length) {
          toast.info("Deps already covered", {
            message: "Everything Steam requires is already on the modlist or extras.",
          });
        } else {
          setSelMods((prev) => uniqueIds([...prev, ...toAdd]));
          for (const id of toAdd) {
            try {
              await api.post("/mods", { workshopId: id, name: titles[id] || id, kind: "client", bikeys: [] });
            } catch {
              /* already present */
            }
          }
          mods.reload();
          toast.success(`Added ${toAdd.length} Steam required item(s) as extras`, {
            message: "Also expanded automatically on apply/start even if you skip this step.",
          });
        }
      } else if (!(r.added || []).length) {
        toast.info("No extra required items", { message: "Steam lists no workshop dependencies for these mods." });
      } else {
        toast.success(`Found ${r.added.length} required item(s)`, {
          message: "Apply and start expand these automatically — or add them as extras.",
        });
      }
    } catch (e: any) {
      toast.error("Could not resolve deps", { message: e.message });
    } finally {
      setResolvingDeps(false);
    }
  }

  function setOption(key: string, value: number) {
    setCustomDiff((prev) => ({ ...prev, options: { ...prev.options, [key]: value } }));
  }

  async function save() {
    const prevOverrides = { ...(profile?.serverCfgOverrides || {}) };
    const serverCfgOverrides: Record<string, unknown> = { ...prevOverrides };
    if (hostname.trim()) serverCfgOverrides.hostname = hostname.trim();
    else delete serverCfgOverrides.hostname;
    if (password) serverCfgOverrides.password = password;
    else delete serverCfgOverrides.password;
    if (passwordAdmin) serverCfgOverrides.passwordAdmin = passwordAdmin;
    else delete serverCfgOverrides.passwordAdmin;
    if (serverCommandPassword) serverCfgOverrides.serverCommandPassword = serverCommandPassword;
    else delete serverCfgOverrides.serverCommandPassword;
    const adminList = adminsOverride
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (adminList.length) serverCfgOverrides.admins = adminList;
    else delete serverCfgOverrides.admins;
    if (forcedDifficulty) serverCfgOverrides.forcedDifficulty = forcedDifficulty;
    else delete serverCfgOverrides.forcedDifficulty;

    const body = {
      name,
      modlistId: modlistId || null,
      mods: uniqueIds(selMods.filter((id) => !modlistAllIds.has(id))),
      serverMods: uniqueIds(selServerMods.filter((id) => !modlistAllIds.has(id))),
      missionId: missionId || null,
      serverCfgOverrides,
      basicCfgOverrides,
      extraArgs: extraArgs.split(/\s+/).map((s) => s.trim()).filter(Boolean),
      customDifficulty: customDiff,
      dlcs,
      recommendedHeadlessCount:
        recommendedHeadlessCount.trim() === ""
          ? null
          : Math.min(8, Math.max(0, Number(recommendedHeadlessCount) || 0)),
    };
    try {
      if (profile) await api.put(`/profiles/${profile.id}`, body);
      else await api.post("/profiles", body);
      toast.success(profile ? "Profile saved" : "Profile created");
      onSaved();
    } catch (e: any) { toast.error("Save failed", { message: e.message }); }
  }

  const groups = [...new Set(DIFFICULTY_OPTIONS.map((o) => o.group))];

  return (
    <Modal title={profile ? "Edit profile" : "New profile"} onClose={onClose} wide>
      <div className="grid" style={{ gap: 12 }}>
        <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div>
          <label>Server hostname override</label>
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="Blank → shared settings / profile name" />
        </div>
        <div className="card" style={{ padding: 12, margin: 0 }}>
          <strong style={{ display: "block", marginBottom: 4 }}>server.cfg overrides (optional)</strong>
          <div className="muted small" style={{ marginBottom: 10 }}>
            Leave blank to keep values from <strong>shared settings</strong>. On apply, the selected mission PBO is written into <code>class Missions</code>.
          </div>
          <div className="grid cols-2" style={{ gap: 10 }}>
            <div>
              <label>Password override</label>
              <input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label>Admin password override</label>
              <input value={passwordAdmin} onChange={(e) => setPasswordAdmin(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label>Server command password</label>
              <input value={serverCommandPassword} onChange={(e) => setServerCommandPassword(e.target.value)} autoComplete="off" />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label>Admin Steam IDs override</label>
              <textarea
                rows={2}
                value={adminsOverride}
                onChange={(e) => setAdminsOverride(e.target.value)}
                placeholder="Blank → use shared preset admins[]"
              />
            </div>
          </div>
        </div>

        <div>
          <label>Difficulty</label>
          <select value={forcedDifficulty} onChange={(e) => setForcedDifficulty(e.target.value as DifficultyPresetName | "")}>
            {FORCED_DIFFICULTY_CHOICES.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <div className="muted small" style={{ marginTop: 4 }}>
            Written as <code>forcedDifficulty</code> in server.cfg. Custom options go to <code>Users/server/server.Arma3Profile</code> on apply.
          </div>
        </div>

        {forcedDifficulty === "Custom" && (
          <div className="card" style={{ padding: 12, margin: 0 }}>
            <strong style={{ display: "block", marginBottom: 8 }}>Custom difficulty</strong>
            {groups.map((group) => (
              <div key={group} style={{ marginBottom: 12 }}>
                <div className="muted small" style={{ marginBottom: 6 }}>{group}</div>
                <div className="grid" style={{ gap: 8 }}>
                  {DIFFICULTY_OPTIONS.filter((o) => o.group === group).map((o) => (
                    <div key={o.key} className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
                      <label style={{ margin: 0, flex: "1 1 140px" }}>{o.label}</label>
                      {o.max === 1 ? (
                        <label className="row" style={{ margin: 0 }}>
                          <input
                            type="checkbox"
                            style={{ width: "auto" }}
                            checked={!!customDiff.options[o.key]}
                            onChange={(e) => setOption(o.key, e.target.checked ? 1 : 0)}
                          />
                          Enabled
                        </label>
                      ) : (
                        <select
                          style={{ maxWidth: 180 }}
                          value={customDiff.options[o.key] ?? 0}
                          onChange={(e) => setOption(o.key, Number(e.target.value))}
                        >
                          {Array.from({ length: o.max + 1 }, (_, i) => (
                            <option key={i} value={i}>
                              {optionValueLabel(o.key, i, o.max)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="grid cols-3" style={{ gap: 10, marginTop: 8 }}>
              <div>
                <label>AI level preset</label>
                <select
                  value={customDiff.aiLevelPreset}
                  onChange={(e) => setCustomDiff((p) => ({ ...p, aiLevelPreset: Number(e.target.value) }))}
                >
                  <option value={0}>Low</option>
                  <option value={1}>Normal</option>
                  <option value={2}>High</option>
                  <option value={3}>Custom</option>
                </select>
              </div>
              <div>
                <label>skillAI (0–1)</label>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={customDiff.skillAI}
                  disabled={customDiff.aiLevelPreset !== 3}
                  onChange={(e) => setCustomDiff((p) => ({ ...p, skillAI: Number(e.target.value) }))}
                />
              </div>
              <div>
                <label>precisionAI (0–1)</label>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={customDiff.precisionAI}
                  disabled={customDiff.aiLevelPreset !== 3}
                  onChange={(e) => setCustomDiff((p) => ({ ...p, precisionAI: Number(e.target.value) }))}
                />
              </div>
            </div>
          </div>
        )}

        <div>
          <label>Creator DLCs (−mod= codes)</label>
          <div className="muted small" style={{ marginBottom: 6 }}>
            Needs the host on Steam&apos;s <strong>creatordlc</strong> branch. If Arma is not installed yet, Agent setup → Verify host (or apply) downloads creatordlc automatically. If already installed, apply only updates when you are not on that branch (or folders are missing). Official packs (Contact, Apex, etc.) need no flag.
          </div>
          <div className="pill-list">
            {CREATOR_DLCS.map((d) => (
              <span
                key={d.code}
                className="pill"
                style={{ cursor: "pointer", borderColor: dlcs.includes(d.code) ? "var(--accent)" : undefined }}
                onClick={() => toggle(dlcs, setDlcs, d.code)}
              >
                {dlcs.includes(d.code) ? "✓ " : ""}{d.name} ({d.code})
              </span>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 12, margin: 0 }}>
          <strong style={{ display: "block", marginBottom: 4 }}>Mods</strong>
          <div className="muted small" style={{ marginBottom: 12 }}>
            Start from a modlist, then add extras. Mods already on the list stay marked and can’t be selected twice.
          </div>

          <div>
            <label>Base modlist</label>
            <select value={modlistId} onChange={(e) => selectModlist(e.target.value)}>
              <option value="">— none —</option>
              {(modlists.data || []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.entries.length})
                </option>
              ))}
            </select>
            <div className="muted small" style={{ marginTop: 4 }}>
              <Link to="/modlists">Manage modlists</Link>
              {attached
                ? ` · ${modlistClientIds.size} client / ${modlistServerIds.size} server`
                : null}
            </div>
          </div>

          {attached && (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn small"
                onClick={() => setShowListContents((v) => !v)}
              >
                {showListContents ? "Hide list" : "Show list"} ({attached.entries.length})
              </button>
              {showListContents && (
                <div className="pill-list" style={{ marginTop: 8 }}>
                  {attached.entries.map((e) => (
                    <span
                      key={`${e.kind}-${e.workshopId}`}
                      className="pill"
                      title={e.workshopId}
                      style={{ opacity: 0.75 }}
                    >
                      {e.kind === "server" ? "srv · " : ""}
                      {e.name || e.workshopId}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <label>Filter library</label>
            <input
              value={modFilter}
              onChange={(e) => setModFilter(e.target.value)}
              placeholder="Search name or workshop ID"
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <label>
              Extra client mods
              {extraClientCount > 0 ? (
                <span className="muted"> · {extraClientCount} selected</span>
              ) : null}
            </label>
            <div className="pill-list" style={{ marginTop: 6 }}>
              {clientCatalog.map((m) => {
                const inList = modlistAllIds.has(m.workshopId);
                const selected = !inList && selMods.includes(m.workshopId);
                return (
                  <span
                    key={m.id}
                    className="pill"
                    title={inList ? "Already on the modlist" : m.workshopId}
                    style={{
                      cursor: inList ? "default" : "pointer",
                      opacity: inList ? 0.55 : 1,
                      borderColor: selected ? "var(--accent)" : undefined,
                    }}
                    onClick={() => toggleExtra(selMods, setSelMods, m.workshopId, modlistAllIds)}
                  >
                    {inList ? "list · " : selected ? "✓ " : ""}
                    {m.name}
                  </span>
                );
              })}
              {clientCatalog.length === 0 && <span className="muted small">No client mods match.</span>}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label>
              Extra server mods
              {extraServerCount > 0 ? (
                <span className="muted"> · {extraServerCount} selected</span>
              ) : null}
            </label>
            <div className="pill-list" style={{ marginTop: 6 }}>
              {serverCatalog.map((m) => {
                const inList = modlistAllIds.has(m.workshopId);
                const selected = !inList && selServerMods.includes(m.workshopId);
                return (
                  <span
                    key={m.id}
                    className="pill"
                    title={inList ? "Already on the modlist" : m.workshopId}
                    style={{
                      cursor: inList ? "default" : "pointer",
                      opacity: inList ? 0.55 : 1,
                      borderColor: selected ? "var(--accent)" : undefined,
                    }}
                    onClick={() => toggleExtra(selServerMods, setSelServerMods, m.workshopId, modlistAllIds)}
                  >
                    {inList ? "list · " : selected ? "✓ " : ""}
                    {m.name}
                  </span>
                );
              })}
              {serverCatalog.length === 0 && <span className="muted small">No server mods match.</span>}
            </div>
          </div>

          <div className="muted small" style={{ marginTop: 12 }}>
            Launch loadout:{" "}
            {attached
              ? `${attached.entries.length} from “${attached.name}”`
              : "no base list"}
            {(extraClientCount > 0 || extraServerCount > 0) && (
              <>
                {" "}
                + {extraClientCount} client / {extraServerCount} server extra
                {extraClientCount + extraServerCount === 1 ? "" : "s"}
              </>
            )}
          </div>

          <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn small" disabled={resolvingDeps} onClick={() => resolveSteamDeps(false)}>
              {resolvingDeps ? "Resolving…" : "Preview Steam deps"}
            </button>
            <button type="button" className="btn small" disabled={resolvingDeps} onClick={() => resolveSteamDeps(true)}>
              Add deps as extras
            </button>
          </div>
          {depsPreview && depsPreview.added.length > 0 && (
            <div className="muted small" style={{ marginTop: 8 }}>
              Required items ({depsPreview.added.length}):{" "}
              {depsPreview.added.map((id) => depsPreview.titles[id] || id).join(", ")}
            </div>
          )}
        </div>
        <div>
          <label>Mission</label>
          <select value={missionId} onChange={(e) => setMissionId(e.target.value)}>
            <option value="">— none —</option>
            {(missions.data || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {(missions.data || []).length === 0 && (
            <div className="muted small" style={{ marginTop: 4 }}>
              No missions in the library yet. Deploy an approved .pbo from <Link to="/missions">Missions</Link>.
            </div>
          )}
        </div>
        <div>
          <label>Extra launch args (optional)</label>
          <input value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} placeholder="-autoInit" />
        </div>
        <div>
          <label>Recommended local HCs (optional hint)</label>
          <input
            type="number"
            min={0}
            max={8}
            value={recommendedHeadlessCount}
            onChange={(e) => setRecommendedHeadlessCount(e.target.value)}
            placeholder="Blank = no recommendation"
          />
          <div className="muted small" style={{ marginTop: 4 }}>
            Soft hint for operators. Instance page still controls how many HCs actually run.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {profile && onHistory && (
            <button type="button" className="btn" onClick={onHistory}>
              History{profile.version != null ? ` · v${profile.version}` : ""}
            </button>
          )}
          <button className="btn primary" onClick={save}>Save profile</button>
        </div>
      </div>
    </Modal>
  );
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

/** Arma treats 1 as 2; UI only exposes off (0) vs verify (2). */
function normalizeVerifySignaturesUi(raw: unknown): "0" | "2" {
  return Number(raw) === 0 ? "0" : "2";
}

function normalizeForcedDifficultyUi(raw: unknown): string {
  const s = String(raw || "").trim();
  if (s === "Recruit" || s === "Regular" || s === "Veteran" || s === "Custom") return s;
  return "";
}

function optionValueLabel(key: string, value: number, max: number): string {
  if (key === "tacticalPing") return OPTION_LABELS_3_PING[value] || String(value);
  if (key === "thirdPersonView") return OPTION_LABELS_3P[value] || String(value);
  if (max === 2) return OPTION_LABELS_2[value] || String(value);
  return String(value);
}
