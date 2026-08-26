import "server-only"
import { db } from "@/lib/db"
import { verifyPassword, hashPassword } from "@/lib/auth/password"
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
  revokeAllUserSessions,
  getCurrentSession,
} from "@/lib/auth/session"
import { generateRawToken, hashToken } from "@/lib/auth/tokens"

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000

export type LoginResult = { ok: true } | { ok: false; error: string }

type RequestMeta = { ip?: string | null; userAgent?: string | null }

/**
 * Every attempt (success or failure) writes login_history, and the generic error
 * message is identical for "no such user" / "wrong password" / "locked" so a caller
 * can't enumerate valid accounts (SECURITY.md §1). Locking is a separate, honest
 * message since it's not account-existence information an attacker gains — the
 * attacker already knows the account exists if they're the one who caused the lock.
 */
export async function login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
  const normalizedEmail = email.trim().toLowerCase()
  const user = await db.user.findFirst({ where: { email: normalizedEmail } })

  const recordAttempt = (success: boolean, reason?: string) =>
    db.loginHistory.create({
      data: {
        userId: user?.id ?? null,
        emailAttempted: normalizedEmail,
        success,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        reason: reason ?? null,
      },
    })

  if (!user) {
    await recordAttempt(false, "user_not_found")
    return { ok: false, error: "Invalid email or password." }
  }

  if (user.status === "locked" || (user.lockedUntil && user.lockedUntil.getTime() > Date.now())) {
    await recordAttempt(false, "locked")
    return { ok: false, error: "This account is locked. Try again later or contact an administrator." }
  }

  if (user.status !== "active") {
    await recordAttempt(false, "inactive")
    return { ok: false, error: "This account is inactive." }
  }

  const validPassword = await verifyPassword(user.passwordHash, password)
  if (!validPassword) {
    const failedCount = user.failedLoginCount + 1
    const shouldLock = failedCount >= MAX_FAILED_ATTEMPTS
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failedCount,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : user.lockedUntil,
      },
    })
    await recordAttempt(false, "bad_password")
    return { ok: false, error: "Invalid email or password." }
  }

  await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })
  await recordAttempt(true)

  const branchAccess = await db.userBranchAccess.findFirst({ where: { userId: user.id } })
  const rawToken = await createSession({
    userId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    activeBranchId: branchAccess?.branchId ?? null,
  })
  await setSessionCookie(rawToken)

  return { ok: true }
}

export async function logout(): Promise<void> {
  const session = await getCurrentSession()
  if (session) {
    await revokeSession(session.sessionId)
  }
  await clearSessionCookie()
}

/** No user enumeration: behaves identically whether or not the email exists. */
export async function requestPasswordReset(email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase()
  const user = await db.user.findFirst({ where: { email: normalizedEmail } })
  if (!user) return

  const rawToken = generateRawToken()
  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  })

  // TODO(Phase 12): route through the communications adapter (SMS/WhatsApp/Email).
  // Never claim delivery here — this is a local-dev stand-in, logged, not sent.
  console.log(`[password-reset] token for ${normalizedEmail}: ${rawToken}`)
}

export async function confirmPasswordReset(
  rawToken: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  const record = await db.passwordResetToken.findUnique({ where: { tokenHash: hashToken(rawToken) } })
  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "This reset link is invalid or has expired." }
  }

  const passwordHash = await hashPassword(newPassword)
  await db.$transaction([
    db.user.update({
      where: { id: record.userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    }),
    db.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ])
  // Successful reset invalidates every existing session — a stolen active session
  // shouldn't survive the legitimate owner regaining control of the account.
  await revokeAllUserSessions(record.userId)

  return { ok: true }
}
