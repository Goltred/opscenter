// Thin API client. All requests are same-origin (Vite proxies /api in dev) and
// send the session cookie. Mutating requests include the CSRF token header.

let csrfToken = "";
export function setCsrf(t: string) {
  csrfToken = t;
}

export class ApiError extends Error {
  status: number;
  data?: Record<string, unknown>;
  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, credentials: "include", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (method !== "GET" && method !== "HEAD") {
    headers["X-CSRF-Token"] = csrfToken;
  }
  const res = await fetch("/api" + path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || res.statusText, data && typeof data === "object" ? data : undefined);
  }
  return data as T;
}

/** Binary/download response (e.g. agent package zip). Mutating methods send CSRF. */
async function downloadRequest(method: string, path: string, body?: unknown): Promise<{ blob: Blob; filename: string | null }> {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, credentials: "include", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (method !== "GET" && method !== "HEAD") {
    headers["X-CSRF-Token"] = csrfToken;
  }
  const res = await fetch("/api" + path, init);
  if (!res.ok) {
    const text = await res.text();
    let msg = res.statusText;
    try {
      const data = text ? JSON.parse(text) : undefined;
      if (data?.error) msg = data.error;
    } catch {
      if (text) msg = text.slice(0, 200);
    }
    throw new ApiError(res.status, msg);
  }
  const cd = res.headers.get("Content-Disposition") || "";
  const m = /filename="([^"]+)"/i.exec(cd) || /filename=([^;]+)/i.exec(cd);
  const filename = m ? m[1].trim() : null;
  return { blob: await res.blob(), filename };
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, body?: unknown) => request<T>("POST", p, body),
  put: <T>(p: string, body?: unknown) => request<T>("PUT", p, body),
  patch: <T>(p: string, body?: unknown) => request<T>("PATCH", p, body),
  del: <T>(p: string, body?: unknown) => request<T>("DELETE", p, body),
  downloadPost: (p: string, body?: unknown) => downloadRequest("POST", p, body ?? {}),
};

// Multipart upload (FormData) with CSRF. Missions only (.pbo).
export async function uploadMissionFile(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/uploads?section=mission", {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken },
    body: fd,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText);
  return data;
}

/** @deprecated Use uploadMissionFile */
export async function uploadFile(section: string, file: File) {
  if (section !== "mission") {
    throw new ApiError(400, "Only mission .pbo uploads are supported");
  }
  return uploadMissionFile(file);
}

/** Upload a .bikey into the panel signature-key library. */
export async function uploadSignatureKey(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/signature-keys", {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken },
    body: fd,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText);
  return data as SignatureKey;
}

export interface SignatureKey {
  id: string;
  filename: string;
  contentHash: string;
  sizeBytes: number;
  createdAt: string;
}

// ---- shared types ----
export interface User {
  id: string;
  email: string;
  displayName: string;
  disabled: boolean;
  approved?: boolean;
  identities?: { provider: string; subject: string; email?: string; displayName?: string }[];
}
export interface Grant {
  permission: string;
  scopeType: string;
  scopeId?: string;
}
export interface Host {
  id: string;
  name: string;
  armaRoot: string;
  /** Empty = Steam workshop under armaRoot; else absolute or relative host path of {id}\ folders */
  modsLibraryPath?: string;
  /** IP/hostname other machines use to reach Arma on this host (cross-host HCs). */
  advertiseHost?: string;
  allowReboot: boolean;
  status: string;
  online: boolean;
  lastSeenAt?: string;
  agentVersion?: string;
  os?: string;
  capabilities?: string[];
  steamcmdRunning?: boolean;
  steamcmdPid?: number;
  /** Untracked arma3server processes the agent found (not matched to an instance). */
  orphans?: { pid?: number; port?: number; profileHint?: string; commandLine?: string }[];
  bootstrap?: {
    steamCmdPresent?: boolean;
    armaServerPresent?: boolean;
    armaRoot?: string;
    steamCmdPath?: string;
    message?: string;
    [key: string]: unknown;
  };
}
export interface HeadlessStatus {
  name: string;
  state: string;
  pid?: number;
  port?: number;
  error?: string;
}
export interface HcGroup {
  id: string;
  hostId: string;
  hostName?: string;
  name: string;
  desiredCount: number;
  targetInstanceId?: string;
  targetName?: string;
  targetHostId?: string;
  targetHostName?: string;
  targetPort?: number;
  profileDir?: string;
  connectHost?: string;
  workerAdvertiseHost?: string;
  workerOnline?: boolean;
  status?: {
    state: string;
    active: number;
    failed: number;
    desired: number;
    headless?: HeadlessStatus[];
  };
}
export interface InstanceStatus {
  state: string;
  pid?: number;
  players: number;
  maxPlayers: number;
  uptimeSec?: number;
  /** True when Steam A2S_INFO answered (same view as launcher browser). */
  queryOk?: boolean;
  queryError?: string;
  hostname?: string;
  map?: string;
  password?: boolean;
  queryPort?: number;
  queriedAt?: string;
  /** Process was already running when the agent connected / restarted. */
  adopted?: boolean;
  headless?: HeadlessStatus[];
}
export interface Instance {
  id: string;
  hostId: string;
  name: string;
  port: number;
  profileDir: string;
  currentProfileId?: string;
  currentProfileName?: string;
  /** Global shared settings merged into every profile apply; profile serverCfgOverrides win on conflict. */
  sharedServerCfg?: Record<string, unknown>;
  sharedCfgVersion?: number;
  /** Desired local same-host headless clients (0–8). */
  headlessCount?: number;
  /** Extra IPs for server.cfg headlessClients / localClient (remote HCs). */
  remoteHcIps?: string[];
  /** HC worker groups on other (or same) hosts targeting this instance. */
  remoteHcGroups?: { id: string; name: string; hostId: string; desiredCount: number }[];
  state: string;
  status: InstanceStatus;
  online: boolean;
  /** Scheduled op waiting for Finish → fallback profile. */
  activeOperation?: {
    scheduleId: string;
    name: string;
    state: string;
    profileId: string;
    profileName?: string;
    fallbackProfileId?: string;
    fallbackProfileName?: string;
  };
}
export interface SharedCfgPreset {
  id: string;
  name: string;
  version: number;
  serverCfg: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}
export interface Mod {
  id: string;
  workshopId: string;
  name: string;
  kind: string;
  bikeys: string[];
  previewUrl?: string;
  workshopUrl?: string;
}
export interface ModlistEntry {
  workshopId: string;
  name?: string;
  kind: "client" | "server" | string;
  previewUrl?: string;
  workshopUrl?: string;
}
export interface Modlist {
  id: string;
  name: string;
  sourceFilename: string;
  entries: ModlistEntry[];
  createdAt?: string;
  updatedAt?: string;
}
export interface Mission {
  id: string;
  name: string;
  pboFilename: string;
}
export interface DifficultyPreset {
  id: string;
  name: string;
  version: number;
  difficulty: {
    options: Record<string, number>;
    aiLevelPreset: number;
    skillAI: number;
    precisionAI: number;
  };
  createdAt?: string;
  updatedAt?: string;
}
export interface MissionProfile {
  id: string;
  name: string;
  version: number;
  mods: string[];
  serverMods: string[];
  /** library = panel PBO; mod = template shipped inside a Workshop mod. */
  missionSource?: "library" | "mod";
  missionId?: string;
  missionName?: string;
  /** Arma template when missionSource is mod (e.g. Antistasi_Ultimate.Altis). */
  missionTemplate?: string;
  modlistId?: string;
  modlistName?: string;
  difficultyPresetId?: string;
  difficultyPresetName?: string;
  serverCfgOverrides: Record<string, unknown>;
  basicCfgOverrides: Record<string, unknown>;
  extraArgs: string[];
  customDifficulty?: {
    options: Record<string, number>;
    aiLevelPreset: number;
    skillAI: number;
    precisionAI: number;
  };
  dlcs?: string[];
  resolvedModsAt?: string;
  /** Soft operator hint — does not force instance headless_count. */
  recommendedHeadlessCount?: number | null;
}
export interface RevisionMeta {
  id: string;
  version: number;
  actorId?: string;
  actorEmail: string;
  note: string;
  createdAt: string;
}
export interface RevisionChange {
  path: string;
  before: unknown;
  after: unknown;
}
export interface Job {
  id: string;
  kind: string;
  state: string;
  stage: string;
  error?: string;
  progress: { stage: string; message: string; at: string }[];
  createdAt?: string;
  updatedAt?: string;
  hostId?: string;
  hostName?: string;
  instanceId?: string;
  instanceName?: string;
  profileId?: string;
  profileName?: string;
  requestedBy?: string;
  actorLabel?: string;
  triggerKind?: string;
  scheduleId?: string;
  scheduleName?: string;
}
export interface Schedule {
  id: string;
  profileId: string;
  profileName?: string;
  fallbackProfileId?: string;
  fallbackProfileName?: string;
  instanceId?: string;
  instanceName?: string;
  name: string;
  runAt: string;
  recurrence: string;
  reminderOffsets: number[];
  discordChannel: string;
  requesterDiscordId?: string;
  state: string;
  approvedBy?: string;
  confirmedAt?: string;
  confirmedBy?: string;
  confirmSource?: string;
  lastJobId?: string;
  lastError?: string;
  lastFiredAt?: string;
}
export interface Upload {
  id: string;
  section: string;
  originalName: string;
  contentHash: string;
  sizeBytes: number;
  detectedType: string;
  validationState: string;
  rejectReason?: string;
}
export interface Role {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: string[];
}
export interface UserRole {
  id: string;
  userId: string;
  roleId: string;
  roleName: string;
  scopeType: string;
  scopeId?: string;
}
export interface AuditEntry {
  id: number;
  actorEmail: string;
  action: string;
  targetId: string;
  scope: string;
  result: string;
  ip: string;
  createdAt: string;
}
