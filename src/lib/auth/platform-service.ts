import "server-only"
import { db } from "@/lib/db"
import { verifyPassword } from "@/lib/auth/password"
import {
  createPlatformSession,
  setPlatformSessionCookie,
  clearPlatformSessionCookie,
  revokePlatformSession,
  getCurrentPlatformSession,
} from "@/lib/auth/platform-session"
import { checkIpRateLimit } from "@/lib/auth/rate-limit"

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000

export type PlatformLoginResult = { ok: true } | { ok: false; error: string }

type RequestMeta = { ip?: string | null; userAgent?: string | null }

/**
 * Mirrors auth/service.ts's login() / portal-service.ts's portalLogin()
 * closely, against PlatformOperator instead — same generic error message,
 * same per-account lockout, same IP-based throttle (channel: "platform",
 * reusing the one LoginHistory table every login surface already writes
 * to). Deliberately has no organization-suspension check at all — a
 * PlatformOperator has no organization to be suspended with.
 */
export async function platformLogin(email: string, password: string, meta: RequestMeta): Promise<PlatformLoginResult> {
  const normalizedEmail = email.trim().toLowerCase()

  const rateLimit = await checkIpRateLimit("platform", meta.ip)
  if (rateLimit.throttled) {
    await db.loginHistory.create({
      data: { channel: "platform", emailAttempted: normalizedEmail, success: false, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, reason: "ip_throttled" },
    })
    return { ok: false, error: "Too many attempts from this network. Please try again later." }
  }

  const operator = await db.platformOperator.findFirst({ where: { email: normalizedEmail } })

  // `LoginHistory.userId` has a real FK to `User` (onDelete: SetNull) —
  // unlike `AuditLog.userId`, which is a bare, unconstrained string (see
  // audit.ts's own doc comment), this column cannot hold a
  // `PlatformOperator` id. `emailAttempted` already identifies the attempt
  // for rate-limiting/investigation purposes; `userId` stays null for every
  // platform-channel row, successful or not.
  const recordAttempt = (success: boolean, reason?: string) =>
    db.loginHistory.create({
      data: {
        userId: null,
        channel: "platform",
        emailAttempted: normalizedEmail,
        success,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        reason: reason ?? null,
      },
    })

  if (!operator) {
    await recordAttempt(false, "user_not_found")
    return { ok: false, error: "Invalid email or password." }
  }

  if (operator.lockedUntil && operator.lockedUntil.getTime() > Date.now()) {
    await recordAttempt(false, "locked")
    return { ok: false, error: "This account is locked. Try again later or contact another platform administrator." }
  }

  if (operator.status !== "active") {
    await recordAttempt(false, "inactive")
    return { ok: false, error: "Invalid email or password." }
  }

  const validPassword = await verifyPassword(operator.passwordHash, password)
  if (!validPassword) {
    const failedCount = operator.failedLoginCount + 1
    const shouldLock = failedCount >= MAX_FAILED_ATTEMPTS
    await db.platformOperator.update({
      where: { id: operator.id },
      data: {
        failedLoginCount: failedCount,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : operator.lockedUntil,
      },
    })
    await recordAttempt(false, "bad_password")
    return { ok: false, error: "Invalid email or password." }
  }

  await db.platformOperator.update({
    where: { id: operator.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })
  await recordAttempt(true)

  const rawToken = await createPlatformSession({ operatorId: operator.id, ip: meta.ip, userAgent: meta.userAgent })
  await setPlatformSessionCookie(rawToken)

  return { ok: true }
}

export async function platformLogout(): Promise<void> {
  const session = await getCurrentPlatformSession()
  if (session) {
    await revokePlatformSession(session.sessionId)
  }
  await clearPlatformSessionCookie()
}
