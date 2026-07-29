import { agentPackageAvailable } from "./agentPackage.js";
import { listPublicProviders, parseBootstrapOwners } from "./auth/oauth.js";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { getHub } from "./agent/hub.js";

export type SetupCheckStatus = "pass" | "fail" | "warn" | "info";

export type SetupCheck = {
  id: string;
  label: string;
  status: SetupCheckStatus;
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

const SETUP_SETTINGS_KEY = "opscenter_setup";

type SetupSettings = {
  dismissed?: boolean;
  dismissedAt?: string;
  dismissedBy?: string;
};

function readSetupSettings(): SetupSettings {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(SETUP_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  try {
    return JSON.parse(row.value) as SetupSettings;
  } catch {
    return {};
  }
}

export function isSetupDismissed(): boolean {
  return readSetupSettings().dismissed === true;
}

export function dismissSetup(userId: string): void {
  const value = JSON.stringify({
    dismissed: true,
    dismissedAt: new Date().toISOString(),
    dismissedBy: userId,
  } satisfies SetupSettings);
  getDb()
    .prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(SETUP_SETTINGS_KEY, value);
}

export function agentGatewayUrl(): string {
  const agentPort = (() => {
    const addr = config.agentAddr || ":8443";
    if (addr.startsWith(":")) return Number(addr.slice(1)) || 8443;
    const i = addr.lastIndexOf(":");
    return i >= 0 ? Number(addr.slice(i + 1)) || 8443 : 8443;
  })();
  let hostPart = "127.0.0.1";
  try {
    hostPart = new URL(config.publicUrl).hostname || "127.0.0.1";
  } catch {
    /* keep localhost */
  }
  const wsScheme = config.publicUrl.startsWith("https://") ? "wss" : "ws";
  return `${wsScheme}://${hostPart}:${agentPort}/agent/connect`;
}

export function buildSetupStatus(): SetupStatus {
  const providers = listPublicProviders();
  const providerCount = providers.length;
  const bootstrapOwnersConfigured = parseBootstrapOwners().length > 0;
  const steamAccountCount = (
    getDb().prepare("SELECT COUNT(*) AS n FROM steam_accounts").get() as { n: number }
  ).n;
  const hostRows = getDb().prepare("SELECT id FROM hosts").all() as { id: string }[];
  const hostCount = hostRows.length;
  const hub = getHub();
  const connectedHostCount = hostRows.filter((h) => hub.getHostLive(h.id).online).length;
  const pkg = agentPackageAvailable();
  const dismissed = isSetupDismissed();

  const checks: SetupCheck[] = [
    {
      id: "signin",
      label: "Sign-in provider configured",
      status: providerCount > 0 ? "pass" : "fail",
      detail:
        providerCount > 0
          ? `${providerCount} provider${providerCount === 1 ? "" : "s"} ready`
          : "Add at least one OAuth provider in deploy/control-plane.env (see docs/INSTALL.md).",
    },
    {
      id: "owners",
      label: "Owner allowlist configured",
      status: bootstrapOwnersConfigured ? "pass" : "warn",
      detail: bootstrapOwnersConfigured
        ? "OC_BOOTSTRAP_OWNERS is set"
        : "Set OC_BOOTSTRAP_OWNERS so the first sign-in becomes Owner.",
    },
    {
      id: "agent-package",
      label: "Host agent package available",
      status: pkg.ok ? "pass" : "fail",
      detail: pkg.ok
        ? "The panel can build host agent download zips."
        : pkg.message || "Build or copy the agent binary (see docs/INSTALL.md).",
    },
    {
      id: "steam",
      label: "Steam account saved on panel",
      status: steamAccountCount > 0 ? "pass" : "fail",
      detail:
        steamAccountCount > 0
          ? `${steamAccountCount} account${steamAccountCount === 1 ? "" : "s"} ready for installs and mod downloads`
          : "Add a Steam account that owns Arma 3 — needed to install the dedicated server and workshop mods.",
    },
    {
      id: "host",
      label: "First host agent connected",
      status: connectedHostCount > 0 ? "pass" : hostCount > 0 ? "warn" : "fail",
      detail:
        connectedHostCount > 0
          ? `${connectedHostCount} host${connectedHostCount === 1 ? "" : "s"} online`
          : hostCount > 0
            ? "Host created — finish agent install on the game machine and wait for agent connected."
            : "Add a game host and run the agent package on that machine.",
    },
  ];

  const complete =
    providerCount > 0 && pkg.ok && steamAccountCount > 0 && connectedHostCount > 0;
  // Once a host row exists, stop forcing the first-run wizard / dashboard nudge.
  // Remaining checks (Steam, agent online, package) live on host/admin surfaces.
  const showWizard = !dismissed && !complete && hostCount === 0;

  return {
    checks,
    complete,
    showWizard,
    dismissed,
    publicUrl: config.publicUrl,
    agentGatewayUrl: agentGatewayUrl(),
    oauthCallbackExample: `${config.publicUrl.replace(/\/$/, "")}/api/auth/oauth/discord/callback`,
    providerCount,
    bootstrapOwnersConfigured,
    steamAccountCount,
    hostCount,
    connectedHostCount,
    agentPackageReady: pkg.ok,
    agentPackageMessage: pkg.message || null,
  };
}
