import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  httpAddr: env("A3P_HTTP_ADDR", ":8080"),
  publicUrl: env("A3P_PUBLIC_URL", "http://localhost:8080"),
  devMode: envBool("A3P_DEV_MODE", true),
  webOrigin: env("A3P_WEB_ORIGIN", "http://localhost:5173"),
  webDir: env("A3P_WEB_DIR", path.join(repoRoot, "web", "dist")),
  databaseUrl: env("A3P_DATABASE_URL", path.join(repoRoot, "deploy", "a3panel.sqlite")),
  sessionTtlHours: envInt("A3P_SESSION_TTL_HOURS", 12),
  /** Comma-separated provider:subject — e.g. discord:123,steam:7656… */
  bootstrapOwners: env("A3P_BOOTSTRAP_OWNERS", ""),
  agentAddr: env("A3P_AGENT_ADDR", ":8443"),
  secretsKey: env("A3P_SECRETS_KEY", ""),
  secretsKeyFile: env("A3P_SECRETS_KEY_FILE", ""),
  /** Folder with published a3panel-agent.exe (default: <repo>/agent-csharp/publish). */
  agentDistDir: env("A3P_AGENT_DIST_DIR", path.join(repoRoot, "agent-csharp", "publish")),
  oauth: {
    discord: {
      clientId: env("A3P_OAUTH_DISCORD_CLIENT_ID"),
      clientSecret: env("A3P_OAUTH_DISCORD_CLIENT_SECRET"),
    },
    google: {
      clientId: env("A3P_OAUTH_GOOGLE_CLIENT_ID"),
      clientSecret: env("A3P_OAUTH_GOOGLE_CLIENT_SECRET"),
    },
    microsoft: {
      clientId: env("A3P_OAUTH_MICROSOFT_CLIENT_ID"),
      clientSecret: env("A3P_OAUTH_MICROSOFT_CLIENT_SECRET"),
      tenant: env("A3P_OAUTH_MICROSOFT_TENANT", "common"),
    },
    steam: {
      /** When true (default if unset and STEAM path used) — set A3P_OAUTH_STEAM=1 to enable */
      enabled: envBool("A3P_OAUTH_STEAM", false) || !!env("A3P_OAUTH_STEAM_API_KEY"),
      apiKey: env("A3P_OAUTH_STEAM_API_KEY"),
    },
    epic: {
      clientId: env("A3P_OAUTH_EPIC_CLIENT_ID"),
      clientSecret: env("A3P_OAUTH_EPIC_CLIENT_SECRET"),
    },
  },
  repoRoot,
};

export function listenPort(): number {
  const addr = config.httpAddr;
  if (addr.startsWith(":")) return Number(addr.slice(1)) || 8080;
  const idx = addr.lastIndexOf(":");
  return idx >= 0 ? Number(addr.slice(idx + 1)) || 8080 : 8080;
}
