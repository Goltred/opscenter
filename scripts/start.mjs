#!/usr/bin/env node
/**
 * Single-command start: load deploy/control-plane.env, build the React UI,
 * then run the API (which also serves web/dist on the same port).
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

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || root,
      stdio: "inherit",
      shell: true,
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

function ensureDeps(dir) {
  if (fs.existsSync(path.join(root, dir, "node_modules"))) return Promise.resolve();
  console.log(`Installing ${dir} dependencies...`);
  return run("npm", ["install"], { cwd: path.join(root, dir) });
}

loadEnvFile(path.join(root, "deploy", "control-plane.env"));

// Defaults for a single-port local run
process.env.OC_HTTP_ADDR ||= ":8080";
process.env.OC_PUBLIC_URL ||= "http://localhost:8080";
process.env.OC_WEB_ORIGIN ||= "http://localhost:8080";
process.env.OC_WEB_DIR ||= path.join(root, "web", "dist");
process.env.OC_DEV_MODE ||= "true";
process.env.OC_DATABASE_URL ||= path.join(root, "deploy", "OpsCenter.sqlite");

await ensureDeps("server");
await ensureDeps("web");

console.log("Building web UI...");
await run("npm", ["run", "build"], { cwd: path.join(root, "web") });

console.log("Starting API + UI on http://localhost:8080 ...");
await run("npm", ["start"], { cwd: path.join(root, "server") });
