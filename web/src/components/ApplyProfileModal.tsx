import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Host, Instance, MissionProfile } from "../api";
import { Modal, useList } from "./ui";

export type ApplyProfileOpts = {
  instanceId: string;
  downloadMods: boolean;
  updateServer: boolean;
  validate: boolean;
  steamAccountId?: string;
  refreshDeps?: boolean;
  matchHeadlessRecommendation?: boolean;
};

export function ApplyProfileModal({
  profile,
  instances,
  fixedInstanceId,
  hosts,
  onClose,
  onConfirm,
}: {
  profile: MissionProfile;
  instances: Instance[];
  /** When set (e.g. from Instance page), target is locked. */
  fixedInstanceId?: string;
  hosts: Host[];
  onClose: () => void;
  onConfirm: (opts: ApplyProfileOpts) => void;
}) {
  const accounts = useList<{ id: string; label: string; username: string }[]>(() => api.get("/steam-accounts"));
  const [instanceId, setInstanceId] = useState(fixedInstanceId || instances[0]?.id || "");
  const [downloadMods, setDownloadMods] = useState(true);
  const [updateServer, setUpdateServer] = useState(false);
  const [validate, setValidate] = useState(false);
  const [refreshDeps, setRefreshDeps] = useState(false);
  const [matchHeadlessRecommendation, setMatchHeadlessRecommendation] = useState(false);
  const [steamAccountId, setSteamAccountId] = useState("");
  const [pendingOpts, setPendingOpts] = useState<ApplyProfileOpts | null>(null);

  useEffect(() => {
    if (fixedInstanceId) setInstanceId(fixedInstanceId);
    else if (!instanceId && instances.length) setInstanceId(instances[0].id);
  }, [fixedInstanceId, instances, instanceId]);

  useEffect(() => {
    if (!steamAccountId && accounts.data?.length) setSteamAccountId(accounts.data[0].id);
  }, [accounts.data, steamAccountId]);

  const target = instances.find((i) => i.id === instanceId) || null;
  const host = hosts.find((h) => h.id === target?.hostId) || null;
  const hostOnline = !!host?.online;
  const st = target?.status;
  const instanceRunning =
    !!target &&
    (st?.state === "running" ||
      st?.state === "starting" ||
      target.state === "running" ||
      target.state === "starting" ||
      !!st?.pid);

  const customLibrary = !!(host?.modsLibraryPath || "").trim();
  const hasCdls = (profile.dlcs || []).length > 0;
  const armaMissing = host?.bootstrap?.armaServerPresent === false;
  const recommendedHc = profile.recommendedHeadlessCount;
  const instanceHc = target?.headlessCount ?? 0;
  const showHcHint = recommendedHc != null && recommendedHc !== instanceHc;
  // Steam may be needed for CDLC branch / fresh install even when "Update server" is unchecked.
  const needsSteam = downloadMods || updateServer || hasCdls || armaMissing;
  const noAccounts = !accounts.loading && !(accounts.data || []).length;
  const label = target?.name || "This instance";

  function submit(opts: ApplyProfileOpts) {
    if (instanceRunning) {
      setPendingOpts(opts);
      return;
    }
    onConfirm(opts);
  }

  if (pendingOpts) {
    return (
      <Modal title="Restart required" onClose={onClose}>
        <div className="grid" style={{ gap: 12 }}>
          <div className="warn">
            <strong>{label}</strong> is currently running. Applying “{profile.name}” will stop the server and start it again with this profile.
          </div>
          <div className="muted small">
            Players will be disconnected. Continue only if you are ready to restart.
          </div>
          <div className="row">
            <button className="btn" onClick={() => setPendingOpts(null)}>
              Back
            </button>
            <button className="btn primary" onClick={() => onConfirm(pendingOpts)}>
              Restart &amp; apply
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Apply — ${profile.name}`} onClose={onClose}>
      <div className="grid" style={{ gap: 12 }}>
        <div className="muted small">
          Writes this profile&apos;s config to the chosen instance, copies the mission PBO if needed, and resolves mods.
          {armaMissing ? (
            <>
              {" "}
              The host has no Arma dedicated server under <code>{host?.armaRoot}</code> yet — apply will download the{" "}
              <code>creatordlc</code> branch via SteamCMD first.
            </>
          ) : hasCdls ? (
            <>
              {" "}
              This profile uses Creator DLCs ({(profile.dlcs || []).join(", ")}): apply checks the host and only runs a{" "}
              <code>creatordlc</code> server update if you are not already there.
            </>
          ) : null}
        </div>

        <div>
          <label>Target instance</label>
          {fixedInstanceId ? (
            <div>
              <strong>{target?.name || fixedInstanceId}</strong>
              {host ? <span className="muted small"> · {host.name}</span> : null}
            </div>
          ) : (
            <select value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
              {instances.map((i) => {
                const h = hosts.find((x) => x.id === i.hostId);
                return (
                  <option key={i.id} value={i.id}>
                    {i.name}{h ? ` · ${h.name}` : ""}{h && !h.online ? " (offline)" : ""}
                  </option>
                );
              })}
            </select>
          )}
        </div>

        {instanceRunning && (
          <div className="warn small">
            {label} is up — apply will restart it. You&apos;ll confirm before that happens.
          </div>
        )}
        {customLibrary ? (
          <div className="warn small">
            Shared mods library (read-only): <code>{host?.modsLibraryPath}</code>.
          </div>
        ) : (
          <div className="muted small">
            Mods resolve from local workshop / <code>mods\</code> / <code>@*</code>. Missing items can be pulled via SteamCMD.
          </div>
        )}
        <label className="row">
          <input type="checkbox" style={{ width: "auto" }} checked={refreshDeps} onChange={(e) => setRefreshDeps(e.target.checked)} />
          Refresh Steam Workshop dependencies (bypass 30-day cache)
        </label>
        {showHcHint && (
          <label className="row">
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={matchHeadlessRecommendation}
              onChange={(e) => setMatchHeadlessRecommendation(e.target.checked)}
            />
            Match profile HC recommendation ({recommendedHc}) — instance is currently {instanceHc}
          </label>
        )}
        <label className="row">
          <input type="checkbox" style={{ width: "auto" }} checked={downloadMods} onChange={(e) => setDownloadMods(e.target.checked)} />
          {customLibrary
            ? "Download missing mods via SteamCMD into local armaRoot workshop (shared folder untouched)"
            : "Download missing workshop mods via SteamCMD"}
        </label>
        <label className="row">
          <input type="checkbox" style={{ width: "auto" }} checked={updateServer} onChange={(e) => setUpdateServer(e.target.checked)} />
          Update Arma 3 dedicated server (Steam app 233780)
        </label>
        <label className="row">
          <input type="checkbox" style={{ width: "auto" }} checked={validate} onChange={(e) => setValidate(e.target.checked)} disabled={!needsSteam} />
          Validate SteamCMD downloads (slower, repairs files)
        </label>
        {needsSteam && (
          <div>
            <label>Steam account</label>
            {armaMissing && !downloadMods && !updateServer ? (
              <div className="muted small" style={{ marginBottom: 6 }}>
                Required to download the Arma dedicated server (creatordlc) onto this host.
              </div>
            ) : hasCdls && !downloadMods && !updateServer ? (
              <div className="muted small" style={{ marginBottom: 6 }}>
                Used only if the host still needs a creatordlc branch update.
              </div>
            ) : null}
            {noAccounts ? (
              <div className="warn small">Add an account under <Link to="/admin">Admin → Steam</Link> first.</div>
            ) : (
              <select value={steamAccountId} onChange={(e) => setSteamAccountId(e.target.value)}>
                {(accounts.data || []).map((a) => (
                  <option key={a.id} value={a.id}>{a.label} ({a.username})</option>
                ))}
              </select>
            )}
          </div>
        )}
        {!hostOnline && <div className="error">Agent is offline — connect the host agent before applying.</div>}
        {!instanceId && <div className="error">Select a target instance.</div>}
        <div className="row">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!instanceId || !hostOnline || (needsSteam && (noAccounts || !steamAccountId))}
            onClick={() =>
              submit({
                instanceId,
                downloadMods,
                updateServer,
                validate,
                refreshDeps,
                matchHeadlessRecommendation: showHcHint ? matchHeadlessRecommendation : undefined,
                steamAccountId: needsSteam ? steamAccountId : undefined,
              })
            }
          >
            Apply profile
          </button>
        </div>
      </div>
    </Modal>
  );
}
