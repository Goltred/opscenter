/** Registered by HC group routes so Discord can scale/start/stop groups without circular imports. */

export type HcGroupControlOpts = {
  groupId: string;
  /** Absolute desired count (0–8). */
  count?: number;
  delta?: number;
  forceStart?: boolean;
  forceRestart?: boolean;
  /** Stop processes without changing desired_count (panel stop semantics). */
  stopOnly?: boolean;
  actorId?: string | null;
  actorLabel?: string | null;
  source?: string | null;
};

export type HcGroupControlResult = {
  ok: boolean;
  status: number;
  error?: string;
  group?: unknown;
  result?: unknown;
};

type Impl = (opts: HcGroupControlOpts) => Promise<HcGroupControlResult>;

let impl: Impl | null = null;

export function registerHcGroupControlImpl(fn: Impl) {
  impl = fn;
}

export async function runHcGroupControl(opts: HcGroupControlOpts): Promise<HcGroupControlResult> {
  if (!impl) throw new Error("HC group control is not registered yet");
  return impl(opts);
}
