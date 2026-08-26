import { randomBytes, createHash } from "crypto"

/** A raw, unpredictable, URL-safe token — the value that goes in a cookie or is emailed to a user. */
export function generateRawToken(): string {
  return randomBytes(32).toString("base64url")
}

/** Only the hash is ever persisted, so a DB leak alone never yields a usable session/reset token. */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex")
}
