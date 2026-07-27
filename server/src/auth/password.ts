import crypto from "node:crypto";

export function newToken(nbytes = 32): string {
  return crypto.randomBytes(nbytes).toString("base64url");
}

export function hashSessionId(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}
