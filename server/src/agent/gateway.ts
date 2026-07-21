import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { getDb } from "../db.js";
import { getHub } from "./hub.js";
import type { Envelope } from "./protocol.js";
import crypto from "node:crypto";

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Tell the agent about panel instances so it can adopt already-running Arma processes. */
function scheduleReconcile(hostId: string) {
  void (async () => {
    try {
      const db = getDb();
      const host = db.prepare("SELECT arma_root FROM hosts WHERE id = ?").get(hostId) as
        | { arma_root: string }
        | undefined;
      const rows = db
        .prepare("SELECT id, port, profile_dir FROM instances WHERE host_id = ?")
        .all(hostId) as { id: string; port: number; profile_dir: string }[];
      if (!rows.length) return;
      const hub = getHub();
      if (!hub.isOnline(hostId)) return;
      await hub.dispatch(
        hostId,
        "instance.reconcile",
        {
          instances: rows.map((r) => ({
            instanceId: r.id,
            port: Number(r.port) || 2302,
            profileDir: r.profile_dir || "profiles",
            armaRoot: host?.arma_root || "",
          })),
        },
        60_000,
      );
    } catch (e) {
      console.warn("instance.reconcile failed", hostId, e instanceof Error ? e.message : e);
    }
  })();
}

/** Refresh SteamCMD / Arma install presence for the host card after agent connect. */
function scheduleBootstrapRefresh(hostId: string) {
  void (async () => {
    try {
      const hub = getHub();
      if (!hub.isOnline(hostId)) return;
      const info = await hub.dispatch(hostId, "host.info", {}, 30_000);
      if (info.data) hub.setBootstrap(hostId, info.data);
    } catch (e) {
      console.warn("host.info bootstrap refresh failed", hostId, e instanceof Error ? e.message : e);
    }
  })();
}

/**
 * Dev-friendly agent gateway: plaintext WebSocket on a second HTTP server.
 * Identity via X-Host-Id + optional X-Enroll-Token, or hostname header.
 */
export function startAgentGateway(port: number): http.Server {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("a3panel agent gateway\n");
  });
  const wss = new WebSocketServer({ server, path: "/agent/connect" });
  const hub = getHub();

  wss.on("connection", (ws, req) => {
    const hostId = String(req.headers["x-host-id"] || "");
    const enroll = String(req.headers["x-enroll-token"] || "");
    if (!hostId) {
      ws.close(4001, "missing X-Host-Id");
      return;
    }

    const db = getDb();
    const host = db.prepare("SELECT id, enroll_token, cert_fingerprint FROM hosts WHERE id = ?").get(hostId) as
      | { id: string; enroll_token: string; cert_fingerprint: string }
      | undefined;
    if (!host) {
      ws.close(4004, "unknown host");
      return;
    }

    if (host.enroll_token && enroll) {
      if (hashToken(enroll) !== host.enroll_token) {
        ws.close(4003, "bad enroll token");
        return;
      }
      // clear one-time token after successful enroll
      db.prepare("UPDATE hosts SET enroll_token = '', status = 'online', last_seen_at = datetime('now') WHERE id = ?").run(hostId);
    }

    hub.attach(hostId, ws as WebSocket);
    db.prepare("UPDATE hosts SET status = 'online', last_seen_at = datetime('now') WHERE id = ?").run(hostId);

    ws.on("message", (data) => {
      try {
        const env = JSON.parse(String(data)) as Envelope;
        hub.handleEnvelope(hostId, env);
        if (env.kind === "hello" || env.kind === "heartbeat") {
          db.prepare("UPDATE hosts SET status = 'online', last_seen_at = datetime('now') WHERE id = ?").run(hostId);
        }
        if (env.kind === "hello") {
          scheduleReconcile(hostId);
          scheduleBootstrapRefresh(hostId);
        }
        if (env.kind === "heartbeat" && env.heartbeat?.instances) {
          const upd = db.prepare("UPDATE instances SET state = ? WHERE id = ? AND host_id = ?");
          for (const [instanceId, st] of Object.entries(env.heartbeat.instances)) {
            const state = st?.state;
            if (state) upd.run(state, instanceId, hostId);
          }
        }
      } catch (e) {
        console.warn("agent frame error", hostId, e);
      }
    });

    ws.on("close", () => {
      db.prepare("UPDATE hosts SET status = 'offline' WHERE id = ?").run(hostId);
    });
  });

  server.listen(port, () => {
    console.log(`Agent gateway listening on :${port} (ws://localhost:${port}/agent/connect)`);
  });
  return server;
}

export function parseAgentPort(addr: string): number {
  if (addr.startsWith(":")) return Number(addr.slice(1)) || 8443;
  const idx = addr.lastIndexOf(":");
  return idx >= 0 ? Number(addr.slice(idx + 1)) || 8443 : 8443;
}
