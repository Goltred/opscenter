import { getDb } from "../db.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secrets.js";

export type SteamAccountCreds = {
  id: string;
  label: string;
  username: string;
  password: string;
};

/**
 * Resolve Steam credentials from the panel DB for a one-shot agent dispatch.
 * Does not log the password. Optionally re-encrypts legacy plaintext rows.
 */
export function resolveSteamAccount(steamAccountId?: string | null): SteamAccountCreds {
  const db = getDb();
  const id = String(steamAccountId || "").trim();

  let row: { id: string; label: string; username: string; enc_password: string } | undefined;
  if (id) {
    row = db.prepare("SELECT id, label, username, enc_password FROM steam_accounts WHERE id = ?").get(id) as
      | typeof row
      | undefined;
    if (!row) throw new Error(`Steam account not found: ${id}. Add one under Admin → Steam.`);
  } else {
    row = db
      .prepare("SELECT id, label, username, enc_password FROM steam_accounts ORDER BY label LIMIT 1")
      .get() as typeof row | undefined;
    if (!row) {
      throw new Error("No Steam account configured. Add one under Admin → Steam (credentials are sent to the agent per job).");
    }
  }

  let password = "";
  try {
    password = decryptSecret(row.enc_password || "");
  } catch {
    throw new Error("Failed to decrypt Steam password — check OC_SECRETS_KEY matches the key used when the account was saved.");
  }

  if (!row.username?.trim()) throw new Error(`Steam account “${row.label}” has no username.`);
  if (!password) throw new Error(`Steam account “${row.label}” has no password.`);

  // Upgrade legacy plaintext rows on first use.
  if (row.enc_password && !isEncryptedSecret(row.enc_password)) {
    try {
      db.prepare("UPDATE steam_accounts SET enc_password = ? WHERE id = ?").run(encryptSecret(password), row.id);
    } catch {
      /* non-fatal */
    }
  }

  return { id: row.id, label: row.label, username: row.username, password };
}

/** Payload fields injected into mod.download / steam.app.update (never persist on agent). */
export function steamCredsPayload(creds: SteamAccountCreds): { username: string; password: string; steamAccountId: string } {
  return {
    username: creds.username,
    password: creds.password,
    steamAccountId: creds.id,
  };
}
