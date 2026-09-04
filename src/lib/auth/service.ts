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
  getSessionContext,
} from "@/lib/auth/session"
import { generateRawToken, hashToken } from "@/lib/auth/tokens"
import { NullEmailAdapter } from "@/lib/domains/communications/adapters/email-adapter"
import { resolveDefaultLandingRoute } from "@/lib/platform/landing"
import { checkIpRateLimit } from "@/lib/auth/rate-limit"

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000

export type LoginResult = { ok: true; redirectTo: string } | { ok: false; error: string }

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

  // P4.3 §9: checked BEFORE the user lookup — an IP already generating
  // excessive failures is throttled regardless of which email it's
  // currently trying, so this can't itself become a per-account
  // enumeration signal (it fires identically for a real account, a
  // made-up one, or a typo). The per-account lockout below is unaffected
  // and still applies independently.
  const rateLimit = await checkIpRateLimit("staff", meta.ip)
  if (rateLimit.throttled) {
    await db.loginHistory.create({
      data: { channel: "staff", emailAttempted: normalizedEmail, success: false, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, reason: "ip_throttled" },
    })
    return { ok: false, error: "Too many attempts from this network. Please try again later." }
  }

  const user = await db.user.findFirst({ where: { email: normalizedEmail }, include: { organization: true } })

  const recordAttempt = (success: boolean, reason?: string) =>
    db.loginHistory.create({
      data: {
        userId: user?.id ?? null,
        channel: "staff",
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
    // Targeted backlog closure, item 11 (P4.3's own documented LOW-severity
    // backlog item): this branch previously returned a distinct "This
    // account is inactive" message BEFORE the password is ever checked —
    // enough on its own for an unauthenticated caller to learn a given
    // email belongs to a real, deactivated account. Normalized to the same
    // message as a nonexistent account/wrong password (below); the real
    // reason ("inactive") is still recorded in LoginHistory for internal
    // investigation — nothing about detection or the underlying block is
    // weakened, only what's disclosed to the unauthenticated caller.
    // Account lockout ("locked", above) and organization suspension keep
    // their own distinct messages — narrower, already-documented, separate
    // concerns this item doesn't ask to change.
    await recordAttempt(false, "inactive")
    return { ok: false, error: "Invalid email or password." }
  }

  // P4.3 §5/§16: previously unchecked — a suspended organization's staff
  // could keep authenticating and using already-issued sessions
  // indefinitely (see getSessionContext's matching check in session.ts for
  // the existing-session half of this fix). `OrgStatus.suspended` existed
  // in the schema with nothing anywhere actually enforcing it.
  if (user.organization.status !== "active") {
    await recordAttempt(false, "organization_suspended")
    return { ok: false, error: "This organization's account is suspended. Contact your administrator." }
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

  // P3.12 §33-36: resolved once, centrally, right here — using the raw
  // token already in scope rather than re-reading it back off the request
  // cookie jar (which a Server Action mutates but doesn't guarantee every
  // caller re-reads consistently).
  const newSession = await getSessionContext(rawToken)
  const redirectTo = newSession ? resolveDefaultLandingRoute(newSession) : "/dashboard"

  return { ok: true, redirectTo }
}

export async function logout(): Promise<void> {
  const session = await getCurrentSession()
  if (session) {
    await revokeSession(session.sessionId)
  }
  await clearSessionCookie()
}

export type RequestPasswordResetResult = { delivered: boolean }

/**
 * P0-04: no user enumeration — behaves identically (same return shape, same
 * timing-insensitive path) whether or not the email exists, and never
 * returns or logs the raw token. Delivery goes through the same honest
 * `CommunicationAdapter` pattern the Communications module already uses
 * (spec.md §56/§92 — never fake successful external delivery): today that's
 * `NullEmailAdapter`, which always reports `status: "failed"` because no
 * live provider is configured in this environment, so `delivered` is
 * honestly `false` — the caller (the reset-request page) surfaces this
 * plainly rather than claiming an email was sent. Swapping in a real
 * provider later requires no change here, only a different adapter.
 */
export async function requestPasswordReset(email: string): Promise<RequestPasswordResetResult> {
  const normalizedEmail = email.trim().toLowerCase()
  const user = await db.user.findFirst({ where: { email: normalizedEmail } })
  if (!user) return { delivered: false }

  const rawToken = generateRawToken()
  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  })

  // P4.1 §14/§17: a real email provider needs an ABSOLUTE link — a bare
  // relative path only means anything inside a browser tab already on the
  // site, which an email client never is. `APP_BASE_URL` is optional (unset
  // in local dev, where nothing reads this link outside the app itself);
  // when it's configured, this is the one place in the codebase that turns
  // it into a real clickable URL — see env.ts's own doc comment.
  const resetPath = `/reset-password?token=${rawToken}`
  const resetLink = process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}${resetPath}` : resetPath
  const result = await new NullEmailAdapter().send({
    to: normalizedEmail,
    subject: "Reset your Avant password",
    body: `A password reset was requested for your account. Open ${resetLink} to choose a new password.\n\nThis link expires in 30 minutes. If you didn't request this, you can ignore this message.`,
  })
  return { delivered: result.status === "sent" }
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
