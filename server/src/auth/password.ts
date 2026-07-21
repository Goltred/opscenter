import crypto from "node:crypto";
import argon2 from "argon2";

const opts: argon2.Options & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 2,
  hashLength: 32,
};

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error("password must be at least 10 characters");
  return argon2.hash(password, opts);
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    return await argon2.verify(encoded, password);
  } catch {
    return false;
  }
}

export function newToken(nbytes = 32): string {
  return crypto.randomBytes(nbytes).toString("base64url");
}

export function hashSessionId(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
