/** Registered by api routes so Discord (and others) can start/stop/restart without circular imports. */

export type InstanceControlOp = "instance.start" | "instance.stop" | "instance.restart";

export type InstanceControlOpts = {
  instanceId: string;
  op: InstanceControlOp;
  /** Panel user id when a signed-in / linked user started the action. */
  actorId?: string | null;
  /** Human-readable actor for audit (email, Discord tag). */
  actorLabel?: string | null;
  /** Source tag for audit IP column (e.g. discord). */
  source?: string | null;
};

export type InstanceControlResult = {
  ok: boolean;
  status: number;
  error?: string;
  state?: string;
  warning?: string;
  launchSummary?: unknown;
  args?: string[];
  result?: unknown;
};

type Impl = (opts: InstanceControlOpts) => Promise<InstanceControlResult>;

let impl: Impl | null = null;

export function registerInstanceControlImpl(fn: Impl) {
  impl = fn;
}

export async function runInstanceControl(opts: InstanceControlOpts): Promise<InstanceControlResult> {
  if (!impl) throw new Error("Instance control is not registered yet");
  return impl(opts);
}
