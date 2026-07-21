import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { v4 as uuid } from "uuid";
import type { Envelope, Heartbeat, Hello, InstanceHeartbeat, OpType, Result, ArmaOrphanProcess, HcGroupHeartbeat } from "./protocol.js";

const LOG_CAP = 500;

export type SteamCmdStatus = {
  hostId: string;
  running: boolean;
  jobId?: string;
  workshopId?: string;
  pid?: number;
  stage?: string;
  error?: string;
};

export type HostLiveState = {
  hostId: string;
  online: boolean;
  lastSeen: number;
  agentVersion?: string;
  os?: string;
  capabilities: string[];
  steamcmdRunning: boolean;
  steamcmdPid?: number;
  instances: Record<string, InstanceHeartbeat>;
  /** Untracked arma3server processes reported by the agent. */
  orphans?: ArmaOrphanProcess[];
  /** HC worker groups reported by this agent. */
  hcGroups?: Record<string, HcGroupHeartbeat>;
  bootstrap?: Record<string, unknown>;
};

type Pending = {
  resolve: (r: Result) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

type HostConn = {
  ws: WebSocket;
  hostId: string;
  hello?: Hello;
  lastSeen: number;
  heartbeat?: Heartbeat;
  bootstrap?: Record<string, unknown>;
};

class AgentHub extends EventEmitter {
  private hosts = new Map<string, HostConn>();
  private pending = new Map<string, Pending>();
  private steamLogs = new Map<string, string[]>();
  private instanceLogs = new Map<string, string[]>();
  /** Active SSE subscribers per instance id (UI live console). */
  private instanceLogSubs = new Map<string, number>();
  private steamStatus = new Map<string, SteamCmdStatus>();

  isOnline(hostId: string): boolean {
    return this.hosts.has(hostId);
  }

  onlineHostIds(): string[] {
    return [...this.hosts.keys()];
  }

  getHostLive(hostId: string): HostLiveState {
    const conn = this.hosts.get(hostId);
    if (!conn) {
      return {
        hostId,
        online: false,
        lastSeen: 0,
        capabilities: [],
        steamcmdRunning: false,
        instances: {},
        orphans: [],
        hcGroups: {},
      };
    }
    const hb = conn.heartbeat;
    return {
      hostId,
      online: true,
      lastSeen: conn.lastSeen,
      agentVersion: conn.hello?.agentVersion,
      os: conn.hello?.os,
      capabilities: conn.hello?.capabilities || [],
      steamcmdRunning: !!hb?.steamcmdRunning || this.getSteamStatus(hostId).running,
      steamcmdPid: hb?.steamcmdPid ?? this.getSteamStatus(hostId).pid,
      instances: hb?.instances || {},
      orphans: hb?.orphans || [],
      hcGroups: hb?.hcGroups || {},
      bootstrap: conn.bootstrap,
    };
  }

  setBootstrap(hostId: string, data: Record<string, unknown>) {
    const conn = this.hosts.get(hostId);
    if (conn) conn.bootstrap = data;
  }

  getInstanceStatus(hostId: string, instanceId: string): InstanceHeartbeat | undefined {
    return this.getHostLive(hostId).instances[instanceId];
  }

  getHcGroupStatus(hostId: string, groupId: string): HcGroupHeartbeat | undefined {
    return this.getHostLive(hostId).hcGroups?.[groupId];
  }

  attach(hostId: string, ws: WebSocket, hello?: Hello) {
    const prev = this.hosts.get(hostId);
    if (prev && prev.ws !== ws) {
      try {
        prev.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.hosts.set(hostId, { ws, hostId, hello, lastSeen: Date.now() });
    this.emit("online", hostId);
    ws.on("close", () => {
      const cur = this.hosts.get(hostId);
      if (cur?.ws === ws) {
        this.hosts.delete(hostId);
        this.emit("offline", hostId);
      }
    });
  }

  handleEnvelope(hostId: string, env: Envelope) {
    const conn = this.hosts.get(hostId);
    if (conn) conn.lastSeen = Date.now();

    if (env.kind === "hello" && env.hello) {
      if (conn) conn.hello = env.hello;
      this.emit("hello", hostId, env.hello);
      return;
    }
    if (env.kind === "heartbeat") {
      if (conn) conn.heartbeat = env.heartbeat;
      this.emit("heartbeat", hostId, env.heartbeat);
      return;
    }

    if (env.kind === "progress" || env.kind === "result") {
      if (env.id?.startsWith("instance-log:")) {
        const instanceId = env.id.slice("instance-log:".length);
        const line = env.result?.logLine || env.result?.message;
        if (line && instanceId) {
          this.appendInstanceLog(instanceId, line);
          this.emit("instance-log", instanceId, line);
        }
      }

      const logId = env.id?.startsWith("steamcmd:") ? env.id.slice("steamcmd:".length) : hostId;
      const line = env.result?.logLine || env.result?.message;
      if (line && (env.id?.startsWith("steamcmd:") || env.result?.stage === "downloading")) {
        this.appendLog(logId, line);
        this.emit("steamcmd-log", logId, line);
      }

      if (env.result?.stage === "downloading" || env.id?.startsWith("steamcmd:") || env.op === "mod.download" || env.op === "steam.app.update") {
        const st = this.steamStatus.get(hostId) || { hostId, running: true };
        st.stage = env.result?.stage;
        if (env.result?.data?.workshopId) st.workshopId = String(env.result.data.workshopId);
        if (env.result?.data?.pid) st.pid = Number(env.result.data.pid);
        if (env.result?.final) {
          st.running = false;
          if (!env.result.ok) st.error = env.result.error || env.result.message;
        } else {
          st.running = true;
          st.error = undefined;
        }
        this.steamStatus.set(hostId, st);
        this.emit("steamcmd-status", hostId, st);
      }

      if (env.kind === "result" && env.result?.final) {
        const p = this.pending.get(env.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(env.id);
          p.resolve(env.result);
        }
      }
    }
  }

  appendLog(hostId: string, line: string) {
    const buf = this.steamLogs.get(hostId) || [];
    buf.push(line);
    while (buf.length > LOG_CAP) buf.shift();
    this.steamLogs.set(hostId, buf);
  }

  getLogs(hostId: string): string[] {
    return [...(this.steamLogs.get(hostId) || [])];
  }

  clearLogs(hostId: string) {
    this.steamLogs.set(hostId, []);
  }

  appendInstanceLog(instanceId: string, line: string) {
    const buf = this.instanceLogs.get(instanceId) || [];
    buf.push(line);
    while (buf.length > LOG_CAP) buf.shift();
    this.instanceLogs.set(instanceId, buf);
  }

  getInstanceLogs(instanceId: string): string[] {
    return [...(this.instanceLogs.get(instanceId) || [])];
  }

  clearInstanceLogs(instanceId: string) {
    this.instanceLogs.set(instanceId, []);
  }

  /** Returns true when this is the first subscriber (caller should ask agent to follow). */
  subscribeInstanceLogs(instanceId: string): boolean {
    const n = (this.instanceLogSubs.get(instanceId) || 0) + 1;
    this.instanceLogSubs.set(instanceId, n);
    return n === 1;
  }

  /** Returns true when no subscribers remain (caller should ask agent to unfollow). */
  unsubscribeInstanceLogs(instanceId: string): boolean {
    const n = (this.instanceLogSubs.get(instanceId) || 0) - 1;
    if (n <= 0) {
      this.instanceLogSubs.delete(instanceId);
      return true;
    }
    this.instanceLogSubs.set(instanceId, n);
    return false;
  }

  getSteamStatus(hostId: string): SteamCmdStatus {
    return this.steamStatus.get(hostId) || { hostId, running: false };
  }

  setSteamDownloading(hostId: string, jobId: string, workshopId: string) {
    this.steamStatus.set(hostId, { hostId, running: true, jobId, workshopId, stage: "starting" });
  }

  async dispatch(hostId: string, op: OpType, payload: unknown, timeoutMs = 30 * 60 * 1000): Promise<Result> {
    const conn = this.hosts.get(hostId);
    if (!conn) throw new Error("agent offline");
    const id = uuid();
    const env: Envelope = { kind: "command", id, op, payload };
    const result = await new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("agent dispatch timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        conn.ws.send(JSON.stringify(env));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    return result;
  }

  send(hostId: string, env: Envelope): boolean {
    const conn = this.hosts.get(hostId);
    if (!conn) return false;
    try {
      conn.ws.send(JSON.stringify(env));
      return true;
    } catch {
      return false;
    }
  }
}

let hub: AgentHub | null = null;

export function getHub(): AgentHub {
  if (!hub) hub = new AgentHub();
  return hub;
}
