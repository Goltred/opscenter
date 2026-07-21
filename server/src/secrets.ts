import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const PREFIX = "v1:";

let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  if (config.secretsKeyFile) return path.resolve(config.secretsKeyFile);
  const db = path.resolve(config.databaseUrl);
  return path.join(path.dirname(db), ".a3p_secrets_key");
}

/** 32-byte AES key from env or a persisted local key file. */
export function getSecretsKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = config.secretsKey?.trim();
  if (fromEnv) {
    // Accept raw string, hex (64 chars), or base64.
    if (/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      cachedKey = Buffer.from(fromEnv, "hex");
    } else {
      try {
        const b64 = Buffer.from(fromEnv, "base64");
        if (b64.length === 32) cachedKey = b64;
      } catch {
        /* fall through */
      }
      if (!cachedKey) cachedKey = crypto.createHash("sha256").update(fromEnv, "utf8").digest();
    }
    return cachedKey;
  }

  const file = keyFilePath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw) {
        cachedKey = Buffer.from(raw, "base64");
        if (cachedKey.length === 32) return cachedKey;
      }
    }
  } catch {
    /* regenerate below */
  }

  cachedKey = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, cachedKey.toString("base64"), { encoding: "utf8", mode: 0o600 });
  console.warn(`A3P_SECRETS_KEY unset — generated and saved to ${file}`);
  return cachedKey;
}

/** Encrypt a secret for DB storage. Format: v1:<iv>:<tag>:<ciphertext> (base64 parts). */
export function encryptSecret(plaintext: string): string {
  const key = getSecretsKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/**
 * Decrypt a stored secret. Legacy plaintext (no v1: prefix) is returned as-is
 * so existing Admin → Steam rows keep working until re-saved.
 */
export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored;
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("invalid encrypted secret format");
  const [ivB64, tagB64, dataB64] = parts;
  const key = getSecretsKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith(PREFIX);
}
