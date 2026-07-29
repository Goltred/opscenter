import { getDb } from "./db.js";
import { parseBootstrapOwners } from "./auth/oauth.js";
import { importOAuthBootstrapFile } from "./auth/oauthProviders.js";
import { SEED_ROLES } from "./rbac.js";
import { v4 as uuid } from "uuid";

export async function bootstrap(): Promise<void> {
  const db = getDb();

  for (const role of SEED_ROLES) {
    const existing = db.prepare("SELECT id FROM roles WHERE name = ?").get(role.name) as { id: string } | undefined;
    if (!existing) {
      const id = uuid();
      db.prepare("INSERT INTO roles(id, name, description, builtin) VALUES (?, ?, ?, ?)").run(
        id,
        role.name,
        role.description,
        role.builtin ? 1 : 0,
      );
      const insertPerm = db.prepare("INSERT INTO role_permissions(role_id, permission) VALUES (?, ?)");
      for (const p of role.permissions) insertPerm.run(id, p);
      continue;
    }
    // Keep seed role permissions in sync (additive) so new perms like schedule.confirm land on upgrades.
    const insertPerm = db.prepare(
      "INSERT OR IGNORE INTO role_permissions(role_id, permission) VALUES (?, ?)",
    );
    for (const p of role.permissions) insertPerm.run(existing.id, p);
  }

  importOAuthBootstrapFile();

  const owners = parseBootstrapOwners();
  if (owners.length === 0) {
    console.log(
      "OC_BOOTSTRAP_OWNERS is empty — first Owner will not be auto-created. Set e.g. OC_BOOTSTRAP_OWNERS=discord:YOUR_ID",
    );
  } else {
    console.log(`bootstrap: Owner allowlist ready (${owners.map((o) => `${o.provider}:${o.subject}`).join(", ")})`);
  }

  const { n } = db.prepare("SELECT count(*) AS n FROM users").get() as { n: number };
  if (n === 0) {
    console.log("no users yet — sign in with an allowlisted OAuth identity to become Owner");
  }
}
