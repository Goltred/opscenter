import fs from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import type { Response } from "express";
import { config } from "./config.js";

/** Directory with published opscenter-agent.exe (+ deps). Override with OC_AGENT_DIST_DIR. */
export function agentDistDir(): string {
  const fromEnv = process.env.OC_AGENT_DIST_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return config.agentDistDir;
}

export function resolveAgentExe(): string | null {
  const dir = agentDistDir();
  const candidates = [
    path.join(dir, "opscenter-agent.exe"),
    path.join(config.repoRoot, "agent-csharp", "bin", "Release", "net8.0", "opscenter-agent.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function agentPackageAvailable(): { ok: boolean; dir: string; exe: string | null; message?: string } {
  const exe = resolveAgentExe();
  const dir = exe ? path.dirname(exe) : agentDistDir();
  if (!exe) {
    return {
      ok: false,
      dir,
      exe: null,
      message:
        `Agent binary not found under ${dir}. On the panel machine run: ` +
        `dotnet publish -c Release -o ../agent-csharp/publish (from agent-csharp), ` +
        `or set OC_AGENT_DIST_DIR to a folder containing opscenter-agent.exe.`,
    };
  }
  return { ok: true, dir, exe };
}

export type AgentJsonFields = {
  controlPlaneUrl: string;
  hostId: string;
  enrollToken: string;
  armaRoot: string;
  modsLibraryPath?: string;
  steamCmdPath?: string;
};

export function buildAgentJson(fields: AgentJsonFields): string {
  const body: Record<string, string> = {
    controlPlaneUrl: fields.controlPlaneUrl,
    hostId: fields.hostId,
    enrollToken: fields.enrollToken,
    armaRoot: fields.armaRoot || "C:\\arma3server",
    steamCmdPath: fields.steamCmdPath || "C:\\steamcmd\\steamcmd.exe",
  };
  if (fields.modsLibraryPath?.trim()) body.modsLibraryPath = fields.modsLibraryPath.trim();
  return JSON.stringify(body, null, 2) + "\n";
}

function buildReadme(hostName: string): string {
  return [
    `OpsCenter host agent package — ${hostName}`,
    ``,
    `1. Extract this zip anywhere on the game host (e.g. C:\\opscenter-agent).`,
    `2. Open agent.json (same folder as opscenter-agent.exe).`,
    `   Check armaRoot and steamCmdPath match this machine. Leave hostId / enrollToken / controlPlaneUrl unless you know you need to change them.`,
    `3. Ensure SteamCMD is installed so steamCmdPath points at steamcmd.exe.`,
    `4. Run opscenter-agent.exe from this folder.`,
    `5. Return to the panel and wait until the host shows "agent connected".`,
    ``,
    `Optional Windows service (Admin PowerShell), from the extract folder:`,
    `  New-Service -Name OpsCenterAgent -BinaryPathName "$pwd\\opscenter-agent.exe" -StartupType Automatic`,
    `  Start-Service OpsCenterAgent`,
    ``,
    `The enroll token in agent.json is one-time. After the first successful connect it is consumed.`,
    ``,
  ].join("\r\n");
}

const SKIP_NAMES = new Set(["agent.json", "agent.example.json"]);
const SKIP_EXT = new Set([".pdb"]);

function appendDistTree(archive: ZipArchive, dir: string, base: string) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (ent.isDirectory()) {
      appendDistTree(archive, full, base);
      continue;
    }
    if (SKIP_EXT.has(path.extname(ent.name).toLowerCase())) continue;
    archive.file(full, { name: rel });
  }
}

/** Stream a zip of the published agent + generated agent.json to the response. */
export async function streamAgentPackageZip(
  res: Response,
  opts: { hostName: string; agentJson: string; downloadName?: string },
): Promise<void> {
  const avail = agentPackageAvailable();
  if (!avail.ok || !avail.exe) {
    throw new Error(avail.message || "agent binary missing");
  }
  const distDir = avail.dir;
  const filename = opts.downloadName || `opscenter-agent-${opts.hostName.replace(/[^\w.-]+/g, "_")}.zip`;

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    archive.on("error", reject);
    archive.on("end", () => resolve());
    res.on("error", reject);
  });
  archive.pipe(res);

  appendDistTree(archive, distDir, distDir);
  archive.append(opts.agentJson, { name: "agent.json" });
  archive.append(buildReadme(opts.hostName), { name: "README.txt" });

  await archive.finalize();
  await done;
}
