import argon2 from "argon2"

export function hashPassword(plainPassword: string): Promise<string> {
  return argon2.hash(plainPassword, { type: argon2.argon2id })
}

export async function verifyPassword(hash: string, plainPassword: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plainPassword)
  } catch {
    // Malformed/legacy hash — never throw out of an auth check.
    return false
  }
}
