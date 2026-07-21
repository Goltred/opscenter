export type OpType =
  | "ping"
  | "host.info"
  | "host.bootstrap"
  | "host.dlc.check"
  | "instance.status"
  | "instance.start"
  | "instance.stop"
  | "instance.restart"
  | "instance.reconcile"
  | "instance.headless.scale"
  | "instance.headless.stop"
  | "instance.headless.restart"
  | "hcgroup.scale"
  | "hcgroup.stop"
  | "hcgroup.restart"
  | "config.apply"
  | "mod.download"
  | "mod.download.cancel"
  | "mod.check"
  | "steam.app.update"
  | "keys.sync"
  | "file.deploy"
  | "file.list"
  | "file.read"
  | "rcon.command"
  | "host.reboot";

export type MessageKind = "command" | "result" | "progress" | "heartbeat" | "hello";

export type Result = {
  ok: boolean;
  final: boolean;
  stage?: string;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
  logLine?: string;
};

export type Hello = {
  agentVersion: string;
  hostId: string;
  os?: string;
  capabilities?: string[];
};

export type HeadlessHeartbeat = {
  name: string;
  state: string;
  pid?: number;
  port?: number;
  error?: string;
};

export type InstanceHeartbeat = {
  state: string;
  pid?: number;
  port?: number;
  players?: number;
  maxPlayers?: number;
  uptimeSec?: number;
  /** Steam A2S_INFO succeeded (launcher-visible). */
  queryOk?: boolean;
  queryError?: string;
  hostname?: string;
  map?: string;
  password?: boolean;
  queryPort?: number;
  queriedAt?: string;
  /** Reattached to a process that was already running when the agent started. */
  adopted?: boolean;
  /** Local headless client processes for this instance. */
  headless?: HeadlessHeartbeat[];
};

export type ArmaOrphanProcess = {
  pid?: number;
  port?: number;
  profileHint?: string;
  commandLine?: string;
};

export type HcGroupHeartbeat = {
  headless?: HeadlessHeartbeat[];
};

export type Heartbeat = {
  instances?: Record<string, InstanceHeartbeat>;
  /** Worker HC groups keyed by group id (processes owned by this agent). */
  hcGroups?: Record<string, HcGroupHeartbeat>;
  /** arma3server processes not claimed by any instance. */
  orphans?: ArmaOrphanProcess[];
  steamcmdRunning?: boolean;
  steamcmdPid?: number;
};

export type Envelope = {
  kind: MessageKind;
  id: string;
  op?: OpType;
  payload?: unknown;
  result?: Result;
  heartbeat?: Heartbeat;
  hello?: Hello;
};

export type DownloadModPayload = {
  workshopId?: string;
  workshopIds?: string[];
  /** @deprecated Prefer username/password from panel; kept for agent.json fallback. */
  steamAccountId?: string;
  username?: string;
  password?: string;
  validate?: boolean;
};

export type UpdateAppPayload = {
  appId?: string;
  steamAccountId?: string;
  username?: string;
  password?: string;
  validate?: boolean;
  beta?: string;
};

export type HostBootstrapPayload = {
  ensureSteamCmd?: boolean;
  ensureDirs?: boolean;
};

export type InstanceControlPayload = {
  instanceId: string;
  port?: number;
  profileDir?: string;
  armaRoot?: string;
  executable?: string;
  args?: string[];
  workingDirectory?: string;
  followLogs?: boolean;
};

export type ApplyConfigPayload = {
  instanceId: string;
  profileDir?: string;
  files?: { relativePath: string; content: string }[];
};

export type FileDeployPayload = {
  relativePath: string;
  contentBase64?: string;
  content?: string;
  root?: string;
  skipIfExists?: boolean;
};
