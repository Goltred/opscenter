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
  httpAddr: env("OC_HTTP_ADDR", ":8080"),
  publicUrl: env("OC_PUBLIC_URL", "http://localhost:8080"),
  devMode: envBool("OC_DEV_MODE", true),
  webOrigin: env("OC_WEB_ORIGIN", "http://localhost:5173"),
  webDir: env("OC_WEB_DIR", path.join(repoRoot, "web", "dist")),
  databaseUrl: env("OC_DATABASE_URL", path.join(repoRoot, "deploy", "OpsCenter.sqlite")),
  sessionTtlHours: envInt("OC_SESSION_TTL_HOURS", 12),
  /** Comma-separated provider:subject — e.g. discord:123,steam:7656… */
  bootstrapOwners: env("OC_BOOTSTRAP_OWNERS", ""),
  agentAddr: env("OC_AGENT_ADDR", ":8443"),
  secretsKey: env("OC_SECRETS_KEY", ""),
  secretsKeyFile: env("OC_SECRETS_KEY_FILE", ""),
  /** Folder with published opscenter-agent.exe (default: <repo>/agent-csharp/publish). */
  agentDistDir: env("OC_AGENT_DIST_DIR", path.join(repoRoot, "agent-csharp", "publish")),
  repoRoot,
};

export function listenPort(): number {
  const addr = config.httpAddr;
  if (addr.startsWith(":")) return Number(addr.slice(1)) || 8080;
  const idx = addr.lastIndexOf(":");
  return idx >= 0 ? Number(addr.slice(idx + 1)) || 8080 : 8080;
}
