import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { AgentSetupWizard } from "./AgentSetupWizard";
import { useToast } from "./Toast";
import { BrandMark } from "./BrandMark";

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
  { id: "steam", label: "Steam account" },
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

  async function dismiss() {
    setDismissing(true);
    try {
      await api.post("/setup/dismiss");
      navigate("/", { replace: true });
    } catch (e: unknown) {
      toast.error("Could not skip setup", { message: errorMessage(e) });
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
          <p className="muted">Your panel is ready. Add mission profiles, mods, and instances from the dashboard.</p>
          <div className="ok-banner" style={{ marginTop: 12 }}>
            {status.connectedHostCount} host{status.connectedHostCount === 1 ? "" : "s"} connected · Steam account saved · Agent
            package available
          </div>
          <button type="button" className="btn primary" style={{ marginTop: 16 }} onClick={finish}>
            Go to dashboard
          </button>
        </div>
      </div>
    );
  }

  const signinCheck = checkById(checks, "signin");
  const agentCheck = checkById(checks, "agent-package");
  const ownersCheck = checkById(checks, "owners");
  const steamCheck = checkById(checks, "steam");
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
          <button type="button" className="btn small" disabled={dismissing} onClick={() => void dismiss()}>
            {dismissing ? "Skipping…" : "Skip for now"}
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
                  A3Panel runs on this machine. Game hosts run a small agent that dials out to the panel — no inbound
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
                      <code>dotnet publish -c Release -o agent-csharp/publish</code> (requires .NET 8 SDK)
                    </li>
                    <li>
                      <strong>Pre-built artifact</strong> — download the agent zip from GitHub Releases, extract to{" "}
                      <code>agent-csharp/publish</code>, or set <code>A3P_AGENT_DIST_DIR</code> in{" "}
                      <code>deploy/control-plane.env</code>
                    </li>
                    <li>
                      <strong>One-click install</strong> — run <code>deploy\install-panel.ps1</code> (builds the agent
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
                  <code>deploy/control-plane.env</code> before going to production.
                </p>
                <div className="kv">
                  <div>Panel URL</div>
                  <div className="tag">{status?.publicUrl}</div>
                  <div>Agent gateway</div>
                  <div className="tag">{status?.agentGatewayUrl}</div>
                  <div>OAuth callback (example)</div>
                  <div className="tag">{status?.oauthCallbackExample}</div>
                </div>
                <p className="muted small" style={{ margin: 0 }}>
                  Register the callback URL in your OAuth app (Discord, Google, etc.). For production, use HTTPS on the
                  panel and <code>wss://</code> for the agent gateway.
                </p>
              </div>
            )}

            {step === "steam" && (
              <div className="grid" style={{ gap: 12 }}>
                <p className="muted small" style={{ margin: 0 }}>
                  Steam credentials stay on the panel (encrypted). The agent receives them only per download job — never
                  stored in the host package.
                </p>
                {steamCheck?.status === "pass" ? (
                  <div className="ok-banner">{steamCheck.detail}</div>
                ) : (
                  <div className="warn-banner">{steamCheck?.detail}</div>
                )}
                {can("steam.config") ? (
                  <div className="grid cols-3" style={{ gap: 10 }}>
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
                ) : (
                  <p className="muted small">You need permission to add Steam accounts. Ask an admin.</p>
                )}
                {can("steam.config") && (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={steamBusy || !steamLabel.trim() || !steamUser.trim() || !steamPass}
                    onClick={() => void addSteamAccount()}
                  >
                    {steamBusy ? "Saving…" : "Save Steam account"}
                  </button>
                )}
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
