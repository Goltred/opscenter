import { v4 as uuid } from "uuid";
import { getDb } from "../db.js";
import { isBootstrapOwner, type NormalizedIdentity } from "./oauth.js";

export type UserIdentityRow = {
  id: string;
  user_id: string;
  provider: string;
  subject: string;
  email: string;
  display_name: string;
};

/** Find or create user from OAuth identity. Bootstrap allowlist → approved + Owner. */
export function upsertOAuthUser(identity: NormalizedIdentity): { userId: string; created: boolean; approved: boolean } {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM user_identities WHERE provider = ? AND subject = ?")
    .get(identity.provider, identity.subject) as UserIdentityRow | undefined;

  const bootstrap = isBootstrapOwner(identity.provider, identity.subject);

  if (existing) {
    db.prepare(
      `UPDATE user_identities SET email = ?, display_name = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(identity.email, identity.displayName, existing.id);
    db.prepare(`UPDATE users SET display_name = ?, email = ?, last_login_at = ? WHERE id = ?`).run(
      identity.displayName,
      identity.email,
      new Date().toISOString(),
      existing.user_id,
    );
    if (bootstrap) {
      ensureApprovedOwner(existing.user_id);
    }
    const u = db.prepare("SELECT approved FROM users WHERE id = ?").get(existing.user_id) as { approved: number };
    return { userId: existing.user_id, created: false, approved: !!u.approved };
  }

  const userId = uuid();
  const approved = bootstrap ? 1 : 0;
  let email = identity.email;
  const emailTaken = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email);
  if (emailTaken) email = `${identity.provider}_${identity.subject}@oauth.local`;

  db.prepare(
    `INSERT INTO users(id, email, display_name, password_hash, approved) VALUES (?, ?, ?, '', ?)`,
  ).run(userId, email, identity.displayName, approved);
  db.prepare(
    `INSERT INTO user_identities(id, user_id, provider, subject, email, display_name) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), userId, identity.provider, identity.subject, identity.email, identity.displayName);
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(new Date().toISOString(), userId);

  if (bootstrap) ensureApprovedOwner(userId);

  return { userId, created: true, approved: !!approved };
}

function ensureApprovedOwner(userId: string) {
  const db = getDb();
  db.prepare("UPDATE users SET approved = 1, disabled = 0 WHERE id = ?").run(userId);
  const owner = db.prepare("SELECT id FROM roles WHERE name = 'Owner'").get() as { id: string } | undefined;
  if (!owner) return;
  const has = db
    .prepare("SELECT id FROM user_roles WHERE user_id = ? AND role_id = ? AND scope_type = 'global'")
    .get(userId, owner.id);
  if (!has) {
    db.prepare(
      `INSERT INTO user_roles(id, user_id, role_id, scope_type, scope_id) VALUES (?, ?, ?, 'global', NULL)`,
    ).run(uuid(), userId, owner.id);
  }
}
