import type { Request, Response, NextFunction } from "express";
import { getDb } from "../db.js";
import type { Grant } from "../rbac.js";
import { hashSessionId } from "./password.js";

export const SESSION_COOKIE = "a3p_session";

export type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  mfa_secret: string;
  mfa_enabled: number;
  disabled: number;
  approved: number;
};

export type SessionRow = {
  id: string;
  user_id: string;
  csrf_token: string;
  expires_at: string;
  mfa_pending: number;
};

export type AuthedRequest = Request & {
  user?: UserRow;
  session?: SessionRow;
  grants?: Grant[];
};

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    mfaEnabled: !!u.mfa_enabled,
    disabled: !!u.disabled,
    approved: !!u.approved,
  };
}

export function loadGrants(userId: string): Grant[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rp.permission, ur.scope_type AS scopeType, COALESCE(ur.scope_id, '') AS scopeId
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = ?`,
    )
    .all(userId) as { permission: string; scopeType: string; scopeId: string }[];
  return rows.map((r) => ({
    permission: r.permission,
    scopeType: r.scopeType,
    ...(r.scopeId ? { scopeId: r.scopeId } : {}),
  }));
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return res.status(401).json({ error: "unauthorized" });

  const db = getDb();
  const sess = db.prepare("SELECT * FROM sessions WHERE id = ?").get(hashSessionId(raw)) as SessionRow | undefined;
  if (!sess) return res.status(401).json({ error: "unauthorized" });
  const expires = Date.parse(sess.expires_at.includes("T") ? sess.expires_at : sess.expires_at.replace(" ", "T") + "Z");
  if (Number.isFinite(expires) && expires < Date.now()) {
    return res.status(401).json({ error: "session expired" });
  }
  if (sess.mfa_pending) return res.status(401).json({ error: "mfa required" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(sess.user_id) as UserRow | undefined;
  if (!user || user.disabled) return res.status(401).json({ error: "unauthorized" });
  // Default approved=0 if column missing on weird DBs
  if (user.approved === undefined || user.approved === null) (user as UserRow).approved = 0;

  req.user = user;
  req.session = sess;
  req.grants = user.approved ? loadGrants(user.id) : [];
  next();
}

/** Block API use until an Owner approves the account. */
export function requireApproved(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user?.approved) return res.status(403).json({ error: "pending_approval" });
  next();
}

export function requirePerm(permission: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const grants = req.grants || [];
    const has = grants.some((g) => g.permission === permission);
    if (!has) return res.status(403).json({ error: "forbidden" });
    next();
  };
}

export function csrfProtect(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const token = req.header("X-CSRF-Token") || "";
  if (!req.session || !token || token !== req.session.csrf_token) {
    return res.status(403).json({ error: "csrf" });
  }
  next();
}

export function clientIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
}
