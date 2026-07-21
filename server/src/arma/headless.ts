import { jsonParse } from "../db.js";

export const MAX_LOCAL_HEADLESS = 8;

/** Clamp desired local HC count to 0..MAX. */
export function clampHeadlessCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_LOCAL_HEADLESS, Math.max(0, Math.floor(n)));
}

/** Parse remote HC IP allowlist from JSON array or comma/space-separated string. */
export function parseRemoteHcIps(raw: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) list = parsed;
      else list = s.split(/[\s,;]+/);
    } catch {
      list = s.split(/[\s,;]+/);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const ip = String(item || "").trim();
    if (!ip || seen.has(ip)) continue;
    // Basic IPv4 / hostname sanity (reject path-like junk).
    if (/[\\/]/.test(ip) || ip.length > 64) continue;
    seen.add(ip);
    out.push(ip);
  }
  return out;
}

export function remoteHcIpsFromInstance(inst: Record<string, unknown>): string[] {
  return parseRemoteHcIps(inst.remote_hc_ips);
}

/** IPs for headlessClients[] / localClient[] given local count + remote list. */
export function headlessAllowlistIps(localCount: number, remoteIps: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (ip: string) => {
    const s = ip.trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (localCount > 0) add("127.0.0.1");
  for (const ip of remoteIps) add(ip);
  return out;
}

/**
 * Merge HC allowlists into a server.cfg map unless the operator already set them explicitly.
 * Returns a new object (does not mutate input).
 */
export function injectHeadlessIntoServerCfg(
  cfg: Record<string, unknown>,
  localCount: number,
  remoteIps: string[],
): Record<string, unknown> {
  const ips = headlessAllowlistIps(localCount, remoteIps);
  const out: Record<string, unknown> = { ...cfg };
  if (!ips.length) return out;

  const hasHc =
    (Array.isArray(out.headlessClients) && out.headlessClients.length > 0) ||
    (Array.isArray(out["headlessClients[]"]) && (out["headlessClients[]"] as unknown[]).length > 0);
  const hasLocal =
    (Array.isArray(out.localClient) && out.localClient.length > 0) ||
    (Array.isArray(out["localClient[]"]) && (out["localClient[]"] as unknown[]).length > 0);

  if (!hasHc) out.headlessClients = ips;
  if (!hasLocal) out.localClient = ips;
  return out;
}

export type HeadlessLaunchSpec = {
  name: string;
  index: number;
  args: string[];
  profileDir: string;
  port: number;
};

/**
 * Build launch specs for local headless clients (panel → agent).
 * HC bind port = serverPort + 10 + index to avoid colliding with the dedicated server.
 */
export function buildHeadlessLaunchSpecs(opts: {
  count: number;
  serverPort: number;
  /** Instance profile dir (relative or absolute). */
  instanceProfileDir: string;
  password?: string;
  modParts: string[];
  /** Host/IP HCs connect to (default 127.0.0.1 for same-host). */
  connectHost?: string;
  /** Name prefix before index (default "hc" → hc0, hc1, …). */
  namePrefix?: string;
  /** First HC bind port; defaults to serverPort + 10. */
  bindPortBase?: number;
}): HeadlessLaunchSpec[] {
  const count = clampHeadlessCount(opts.count);
  const serverPort = opts.serverPort > 0 ? opts.serverPort : 2302;
  const connectHost = String(opts.connectHost || "127.0.0.1").trim() || "127.0.0.1";
  const namePrefix = String(opts.namePrefix || "hc").replace(/[^\w-]/g, "") || "hc";
  const bindBase = opts.bindPortBase != null && opts.bindPortBase > 0 ? opts.bindPortBase : serverPort + 10;
  const baseProfile = String(opts.instanceProfileDir || "profiles").replace(/[/\\]+$/, "");
  const specs: HeadlessLaunchSpec[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${namePrefix}${i}`;
    const hcPort = bindBase + i;
    const profileDir = `${baseProfile}/hc/${name}`.replace(/\\/g, "/");
    const args: string[] = [
      "-client",
      `-connect=${connectHost}:${serverPort}`,
      `-port=${hcPort}`,
      `-name=${name}`,
      "-nosound",
    ];
    const pw = String(opts.password || "").trim();
    if (pw) args.push(`-password=${pw}`);
    const mods = opts.modParts.map((m) => String(m || "").trim()).filter(Boolean);
    if (mods.length) args.push(`-mod=${mods.join(";")}`);
    specs.push({ name, index: i, args, profileDir, port: hcPort });
  }
  return specs;
}

export function recommendedHeadlessFromProfile(profile: Record<string, unknown> | null | undefined): number | null {
  if (!profile) return null;
  const raw = profile.recommended_headless_count ?? profile.recommendedHeadlessCount;
  if (raw == null || raw === "") return null;
  return clampHeadlessCount(raw);
}

export function instanceHeadlessCount(inst: Record<string, unknown>): number {
  return clampHeadlessCount(inst.headless_count);
}

export function serializeRemoteHcIps(ips: string[]): string {
  return JSON.stringify(parseRemoteHcIps(ips));
}

/** Read password from merged server.cfg map for HC -password=. */
export function serverCfgPassword(cfg: Record<string, unknown>): string {
  return String(cfg.password ?? "").trim();
}

export function parseRemoteHcIpsColumn(inst: Record<string, unknown>): string[] {
  return parseRemoteHcIps(jsonParse(String(inst.remote_hc_ips || "[]"), [] as string[]));
}
