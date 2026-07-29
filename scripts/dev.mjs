#!/usr/bin/env node
/**
 * Dev mode: API + Vite UI together (one command, two processes).
 * Open http://localhost:5173 — Vite proxies /api to the API on :8080.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([^=#]+?)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(path.join(root, "deploy", "control-plane.env"));
process.env.OC_HTTP_ADDR ||= ":8080";
process.env.OC_PUBLIC_URL ||= "http://localhost:8080";
process.env.OC_WEB_ORIGIN ||= "http://localhost:5173";
process.env.OC_DEV_MODE ||= "true";
process.env.OC_DATABASE_URL ||= path.join(root, "deploy", "OpsCenter.sqlite");

for (const dir of ["server", "web"]) {
  if (!fs.existsSync(path.join(root, dir, "node_modules"))) {
    const r = spawn("npm", ["install"], { cwd: path.join(root, dir), stdio: "inherit", shell: true });
    await new Promise((resolve, reject) => {
      r.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm install in ${dir} failed`))));
    });
  }
}

console.log("Starting API (:8080) + Vite UI (:5173) — open http://localhost:5173");

const children = [
  spawn("npm", ["run", "dev"], { cwd: path.join(root, "server"), stdio: "inherit", shell: true, env: process.env }),
  spawn("npm", ["run", "dev"], { cwd: path.join(root, "web"), stdio: "inherit", shell: true, env: process.env }),
];

function shutdown() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const c of children) {
  c.on("exit", (code) => {
    if (code && code !== 0) {
      shutdown();
      process.exit(code);
    }
  });
}
