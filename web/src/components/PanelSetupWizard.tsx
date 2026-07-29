import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { AgentSetupWizard } from "./AgentSetupWizard";
import { useToast } from "./Toast";
import { BrandMark } from "./BrandMark";
import { notifySteamWebApiChanged } from "../steamWebApiHealth";

export type SetupCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "info";
  detail?: string;
};

export type SetupStatus = {
  checks: SetupCheck[];
  complete: boolean;
  showWizard: boolean;
  dismissed: boolean;
  publicUrl: string;
  agentGatewayUrl: string;
  oauthCallbackExample: string;
  providerCount: number;
  bootstrapOwnersConfigured: boolean;
  steamAccountCount: number;
  steamWebApiKeyConfigured?: boolean;
  steamWebApiKeySource?: "panel" | "env" | "none";
  hostCount: number;
  connectedHostCount: number;
  agentPackageReady: boolean;
  agentPackageMessage: string | null;
};

type SteamAccount = { id: string; label: string; username: string };

type StepId = "welcome" | "panel" | "access" | "urls" | "steam" | "host";

const STEPS: { id: StepId; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "panel", label: "Panel ready" },
  { id: "access", label: "Sign-in" },
  { id: "urls", label: "Addresses" },
  { id: "steam", label: "Steam" },
  { id: "host", label: "First host" },
];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function checkById(checks: SetupCheck[], id: string): SetupCheck | undefined {
  return checks.find((c) => c.id === id);
}

export function PanelSetupWizard() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<StepId>("welcome");
  const [dismissing, setDismissing] = useState(false);
  const [hostWizardOpen, setHostWizardOpen] = useState(false);

  const [steamLabel, setSteamLabel] = useState("");
  const [steamUser, setSteamUser] = useState("");
  const [steamPass, setSteamPass] = useState("");
  const [steamBusy, setSteamBusy] = useState(false);
  const [webApiKey, setWebApiKey] = useState("");
  const [webApiBusy, setWebApiBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await api.get<SetupStatus>("/setup/status");
      setStatus(data);
      if (data.complete) return data;
    } catch (e: unknown) {
      toast.error("Could not load setup status", { message: errorMessage(e) });
    } finally {
      setLoading(false);
    }
    return null;
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (step !== "host" && !hostWizardOpen) return;
    const t = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(t);
  }, [step, hostWizardOpen, reload]);

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const checks = status?.checks || [];

  const validation = useMemo(() => {
    const signin = checkById(checks, "signin");
    const agentPkg = checkById(checks, "agent-package");
    const owners = checkById(checks, "owners");
    const steam = checkById(checks, "steam");
    const host = checkById(checks, "host");
    return {
      welcome: "ok" as const,
      panel: agentPkg?.status === "pass" ? ("ok" as const) : ("pending" as const),
      access: signin?.status === "pass" ? ("ok" as const) : ("pending" as const),
      urls: owners?.status === "pass" || signin?.status === "pass" ? ("ok" as const) : ("pending" as const),
      steam: steam?.status === "pass" ? ("ok" as const) : ("pending" as const),
      host: host?.status === "pass" ? ("ok" as const) : host?.status === "warn" ? ("ok" as const) : ("pending" as const),
    };
  }, [checks]);

  function goNext() {
    if (stepIndex < STEPS.length - 1) setStep(STEPS[stepIndex + 1].id);
  }

  function goBack() {
    if (stepIndex > 0) setStep(STEPS[stepIndex - 1].id);
  }

  /** Skip this step, or leave the wizard on the last step without finishing setup. */
  async function skipForNow() {
    if (stepIndex < STEPS.length - 1) {
      goNext();
      return;
    }
    setDismissing(true);
    try {
      await api.post("/setup/dismiss");
      navigate("/", { replace: true });
    } catch (e: unknown) {
      toast.error("Could not leave setup", { message: errorMessage(e) });
    } finally {
      setDismissing(false);
    }
  }

  async function addSteamAccount() {
    if (!steamLabel.trim() || !steamUser.trim() || !steamPass) return;
    setSteamBusy(true);
    try {
      await api.post("/steam-accounts", {
        label: steamLabel.trim(),
        username: steamUser.trim(),
        password: steamPass,
      });
      setSteamLabel("");
      setSteamUser("");
      setSteamPass("");
      await reload();
    } catch (e: unknown) {
      toast.error("Save Steam account failed", { message: errorMessage(e) });
    } finally {
      setSteamBusy(false);
    }
  }

  async function saveWebApiKey() {
    if (!webApiKey.trim()) return;
    setWebApiBusy(true);
    try {
      await api.put("/steam/web-api-key", { apiKey: webApiKey.trim() });
      setWebApiKey("");
      notifySteamWebApiChanged();
      toast.success("Steam Web API key saved");
      await reload();
    } catch (e: unknown) {
      toast.error("Save API key failed", { message: errorMessage(e) });
    } finally {
      setWebApiBusy(false);
    }
  }

  function finish() {
    navigate("/", { replace: true });
  }

  if (loading && !status) {
    return (
      <div className="setup-page-wrap">
        <div className="muted">Loading setup…</div>
      </div>
    );
  }

  if (status?.complete) {
    return (
      <div className="setup-page-wrap">
        <div className="card setup-page-card">
          <BrandMark />
          <h1 style={{ marginTop: 16 }}>Setup complete</h1>
          <p className="muted">Your panel is ready. Next, set up a mission on your host — or explore from the dashboard.</p>
          <div className="ok-banner" style={{ marginTop: 12 }}>
            {status.connectedHostCount} host{status.connectedHostCount === 1 ? "" : "s"} connected · Steam account saved · Agent
            package available
          </div>
          <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn primary" onClick={finish}>
              Go to dashboard
            </button>
            <button type="button" className="btn" onClick={() => navigate("/?guide=mission", { replace: true })}>
              Set up a mission
            </button>
          </div>
        </div>
      </div>
    );
  }

  const signinCheck = checkById(checks, "signin");
  const agentCheck = checkById(checks, "agent-package");
  const ownersCheck = checkById(checks, "owners");
  const steamCheck = checkById(checks, "steam");
  const steamWebApiCheck = checkById(checks, "steam-web-api");
  const hostCheck = checkById(checks, "host");

  return (
    <div className="setup-page-wrap">
      <div className="card setup-page-card setup-page-card--wide">
        <div className="row between" style={{ alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div>
            <BrandMark />
            <h1 style={{ marginTop: 12, marginBottom: 4 }}>Panel setup</h1>
            <p className="muted small" style={{ margin: 0 }}>
              Signed in as {user?.displayName || user?.email}. This wizard gets you from a fresh install to your first
              connected game host.
            </p>
          </div>
          <button type="button" className="btn small" disabled={dismissing} onClick={() => void skipForNow()}>
            {dismissing
              ? "Leaving…"
              : stepIndex < STEPS.length - 1
                ? "Skip for now"
                : "Skip and go to dashboard"}
          </button>
        </div>

        <div className="setup-wizard" style={{ marginTop: 20 }}>
          <nav className="setup-wizard-nav" aria-label="Panel setup steps">
            <ul>
              {STEPS.map((s, i) => {
                const st = validation[s.id];
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={
                        "setup-wizard-step" +
                        (s.id === step ? " active" : "") +
                        (st === "ok" ? " done" : " pending")
                      }
                      onClick={() => setStep(s.id)}
                    >
                      <span className="setup-wizard-num" title={st === "ok" ? "OK" : "Pending"}>
                        {st === "ok" ? "✓" : i + 1}
                      </span>
                      <span className="setup-wizard-label">{s.label}</span>
                      <span className={"setup-wizard-status " + st}>{st === "ok" ? "OK" : "Pending"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="setup-wizard-body">
            {step === "welcome" && (
              <div className="grid" style={{ gap: 12 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  OpsCenter runs on this machine. Game hosts run a small agent that dials out to the panel — no inbound
                  ports on your home network.
                </p>
                <p className="muted small" style={{ margin: 0 }}>
                  You will configure sign-in, save a Steam account for installs, then add your first game host.
                </p>
                <ul className="setup-checklist">
                  {checks.map((c) => (
                    <li key={c.id} className={"setup-check setup-check--" + c.status}>
                      <span className="setup-check-label">{c.label}</span>
                      {c.detail && <span className="muted small">{c.detail}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {step === "panel" && (
              <div className="grid" style={{ gap: 12 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  The panel serves a download zip for each game host. The agent binary must exist on this machine first.
                </p>
                {agentCheck?.status === "pass" ? (
                  <div className="ok-banner">Host agent package is ready — you can download zips when adding a host.</div>
                ) : (
                  <div className="warn-banner">
                    {agentCheck?.detail || status?.agentPackageMessage || "Agent binary not found on the panel server."}
                  </div>
                )}
                <div className="card" style={{ padding: 12, background: "var(--bg2)" }}>
                  <div className="muted small" style={{ marginBottom: 8 }}>
                    Choose one:
                  </div>
                  <ol className="setup-instructions" style={{ margin: 0 }}>
                    <li>
                      <strong>Build locally</strong> — from the repo root:{" "}
                      <code>dotnet publish -c Release -o agent-csharp/publish</code> (requires .NET 8 SDK). Recommended
                      for a fresh clone.
                    </li>
                    <li>
                      <strong>Optional pre-built zip</strong> — if you already have an agent zip, extract it to{" "}
                      <code>agent-csharp/publish</code> (must include <code>opscenter-agent.exe</code>), or set{" "}
                      <code>OC_AGENT_DIST_DIR</code> / pass <code>-AgentZip</code> to{" "}
                      <code>deploy\install-opscenter.ps1</code>
                    </li>
                    <li>
                      <strong>One-click install</strong> — run <code>deploy\install-opscenter.ps1</code> (builds the agent
                      unless you pass <code>-AgentZip</code>)
                    </li>
                  </ol>
                </div>
                <button type="button" className="btn" onClick={() => void reload()}>
                  Re-check agent package
                </button>
              </div>
            )}

            {step === "access" && (
              <div className="grid" style={{ gap: 12 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Panel sign-in uses OAuth only — no local passwords. You are signed in, so at least one provider works.
                </p>
                {signinCheck?.status === "pass" ? (
                  <div className="ok-banner">{signinCheck.detail}</div>
                ) : (
                  <div className="error">{signinCheck?.detail}</div>
                )}
                {ownersCheck?.status === "pass" ? (
                  <div className="ok-banner">Owner allowlist is configured — matching logins become Owner automatically.</div>
                ) : (
                  <div className="warn-banner">
                    {ownersCheck?.detail} Edit <code>deploy/control-plane.env</code> and restart the panel.
                  </div>
                )}
                <p className="muted small" style={{ margin: 0 }}>
                  Other users stay pending until you approve them under Admin → Users.
                </p>
              </div>
            )}

            {step === "urls" && (
              <div className="grid" style={{ gap: 12 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  These addresses must match how operators and game hosts reach the panel. Change them in{" "}
                  <code>deploy/control-plane.env</code> and restart before going to production.
                </p>
                <div className="kv">
                  <div>Panel URL</div>
                  <div className="tag">{status?.publicUrl}</div>
                  <div>Agent gateway</div>
                  <div className="tag">{status?.agentGatewayUrl}</div>
                  <div>OAuth callback (example)</div>
                  <div className="tag">{status?.oauthCallbackExample}</div>
                </div>
                {(status?.publicUrl || "").includes("localhost") || (status?.publicUrl || "").includes("127.0.0.1") ? (
                  <div className="warn-banner">
                    Panel URL is localhost — fine when the game host is this same machine. If the agent runs on another
                    PC, set <code>OC_PUBLIC_URL</code> to a hostname or LAN/public IP the game host can reach, restart
                    the panel, and download a new agent package.
                  </div>
                ) : (
                  <p className="muted small" style={{ margin: 0 }}>
                    Game hosts dial this agent gateway (default port 8443). Open that port on the panel firewall; game
                    hosts only need outbound access.
                  </p>
                )}
                <p className="muted small" style={{ margin: 0 }}>
                  Register the callback URL in your OAuth app (Discord, Google, etc.). For production, use HTTPS on the
                  panel and <code>wss://</code> for the agent gateway.
                </p>
              </div>
            )}

            {step === "steam" && (
              <div className="grid" style={{ gap: 12 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Two different Steam settings: a <strong>login account</strong> for downloads on the host, and an optional{" "}
                  <strong>Web API key</strong> for workshop titles and required-item deps in the panel.
                </p>

                <div className="steam-panel-section" style={{ marginBottom: 0 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 13 }}>Steam account (downloads)</h3>
                  <p className="muted small" style={{ margin: "0 0 8px" }}>
                    Encrypted on the panel. Sent to the agent only per SteamCMD job. Workshop mods need an account that
                    owns Arma 3; the dedicated server package itself does not.
                  </p>
                  {steamCheck?.status === "pass" ? (
                    <div className="ok-banner">{steamCheck.detail}</div>
                  ) : (
                    <div className="warn-banner">{steamCheck?.detail}</div>
                  )}
                  {can("steam.config") ? (
                    <>
                      <div className="grid cols-3" style={{ gap: 10, marginTop: 10 }}>
                        <div>
                          <label>Label</label>
                          <input value={steamLabel} onChange={(e) => setSteamLabel(e.target.value)} placeholder="Main" />
                        </div>
                        <div>
                          <label>Steam username</label>
                          <input value={steamUser} onChange={(e) => setSteamUser(e.target.value)} />
                        </div>
                        <div>
                          <label>Password</label>
                          <input type="password" value={steamPass} onChange={(e) => setSteamPass(e.target.value)} />
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn primary"
                        style={{ marginTop: 10 }}
                        disabled={steamBusy || !steamLabel.trim() || !steamUser.trim() || !steamPass}
                        onClick={() => void addSteamAccount()}
                      >
                        {steamBusy ? "Saving…" : "Save Steam account"}
                      </button>
                    </>
                  ) : (
                    <p className="muted small">You need permission to add Steam accounts. Ask an admin.</p>
                  )}
                </div>

                <div className="steam-panel-section" style={{ marginBottom: 0 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 13 }}>Steam Web API key (optional)</h3>
                  <p className="muted small" style={{ margin: "0 0 8px" }}>
                    Not your Steam password. Get a free key at{" "}
                    <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">
                      steamcommunity.com/dev/apikey
                    </a>
                    . Without it, modlists may show IDs/URLs instead of names and workshop dependency expansion is less
                    reliable.
                  </p>
                  {steamWebApiCheck?.status === "pass" ? (
                    <div className="ok-banner">{steamWebApiCheck.detail}</div>
                  ) : (
                    <div className="warn-banner">{steamWebApiCheck?.detail}</div>
                  )}
                  {can("steam.config") && steamWebApiCheck?.status !== "pass" && (
                    <div className="grid" style={{ gap: 8, marginTop: 10 }}>
                      <div>
                        <label>API key</label>
                        <input
                          type="password"
                          value={webApiKey}
                          onChange={(e) => setWebApiKey(e.target.value)}
                          placeholder="Paste Steam Web API key"
                          autoComplete="off"
                        />
                      </div>
                      <button
                        type="button"
                        className="btn"
                        disabled={webApiBusy || !webApiKey.trim()}
                        onClick={() => void saveWebApiKey()}
                      >
                        {webApiBusy ? "Saving…" : "Save Web API key"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {step === "host" && (
              <div className="grid" style={{ gap: 12 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Add a game host, download the agent package, run it on the game machine, then verify the connection.
                </p>
                {hostCheck?.status === "pass" ? (
                  <div className="ok-banner">{hostCheck.detail}</div>
                ) : (
                  <div className={hostCheck?.status === "warn" ? "warn-banner" : "warn-banner"}>{hostCheck?.detail}</div>
                )}
                {can("host.add") ? (
                  <button type="button" className="btn primary" onClick={() => setHostWizardOpen(true)}>
                    {status?.hostCount ? "Continue host setup" : "Add your first host"}
                  </button>
                ) : (
                  <p className="muted small">You need host.add permission to register game hosts.</p>
                )}
                {status?.complete && (
                  <button type="button" className="btn primary" onClick={finish}>
                    Go to dashboard
                  </button>
                )}
              </div>
            )}

            <div className="row between" style={{ marginTop: 20, gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn" disabled={stepIndex === 0} onClick={goBack}>
                Back
              </button>
              <div className="row" style={{ gap: 8 }}>
                {step !== "host" && (
                  <button type="button" className="btn primary" onClick={goNext}>
                    Next
                  </button>
                )}
                {status?.complete && (
                  <button type="button" className="btn primary" onClick={finish}>
                    Finish
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {hostWizardOpen && (
        <AgentSetupWizard
          host={null}
          onClose={() => {
            setHostWizardOpen(false);
            void reload();
          }}
          onHostChanged={() => void reload()}
        />
      )}
    </div>
  );
}
