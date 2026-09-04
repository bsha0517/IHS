import "server-only"
import { db } from "@/lib/db"
import { verifyPassword } from "@/lib/auth/password"
import { createPortalSession, setPortalSessionCookie, clearPortalSessionCookie, revokePortalSession, getCurrentPortalSession } from "@/lib/auth/portal-session"
import { checkIpRateLimit } from "@/lib/auth/rate-limit"

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000

export type PortalLoginResult = { ok: true } | { ok: false; error: string }

type RequestMeta = { ip?: string | null; userAgent?: string | null }

/**
 * Mirrors auth/service.ts's login() closely, against PatientPortalAccount
 * instead of User — same generic error message, same per-account lockout
 * mechanism. P4.3 §9: now also writes every attempt to `LoginHistory`
 * (channel: "portal") and applies the same IP-based throttle as staff
 * login — closing the "no separate login-history table" gap this file's
 * own comment used to note (PROJECT_STATUS.md's Phase 12 Known Issues) by
 * reusing the one table rather than building a second.
 */
export async function portalLogin(email: string, password: string, meta: RequestMeta): Promise<PortalLoginResult> {
  const normalizedEmail = email.trim().toLowerCase()

  const rateLimit = await checkIpRateLimit("portal", meta.ip)
  if (rateLimit.throttled) {
    await db.loginHistory.create({
      data: { channel: "portal", emailAttempted: normalizedEmail, success: false, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, reason: "ip_throttled" },
    })
    return { ok: false, error: "Too many attempts from this network. Please try again later." }
  }

  const account = await db.patientPortalAccount.findFirst({ where: { email: normalizedEmail }, include: { organization: true } })

  const recordAttempt = (success: boolean, reason?: string) =>
    db.loginHistory.create({
      data: {
        channel: "portal",
        emailAttempted: normalizedEmail,
        success,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        reason: reason ?? null,
      },
    })

  if (!account) {
    await recordAttempt(false, "user_not_found")
    return { ok: false, error: "Invalid email or password." }
  }

  if (account.status === "locked" || (account.lockedUntil && account.lockedUntil.getTime() > Date.now())) {
    await recordAttempt(false, "locked")
    return { ok: false, error: "This account is locked. Try again later or contact the clinic." }
  }

  if (account.status !== "active") {
    // Targeted backlog closure, item 11 — see auth/service.ts's identical
    // comment on the same fix for the staff login flow.
    await recordAttempt(false, "inactive")
    return { ok: false, error: "Invalid email or password." }
  }

  if (account.organization.status !== "active") {
    await recordAttempt(false, "organization_suspended")
    return { ok: false, error: "This organization's account is suspended. Contact the clinic." }
  }

  const validPassword = await verifyPassword(account.passwordHash, password)
  if (!validPassword) {
    const failedCount = account.failedLoginCount + 1
    const shouldLock = failedCount >= MAX_FAILED_ATTEMPTS
    await db.patientPortalAccount.update({
      where: { id: account.id },
      data: {
        failedLoginCount: failedCount,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : account.lockedUntil,
      },
    })
    await recordAttempt(false, "bad_password")
    return { ok: false, error: "Invalid email or password." }
  }

  await db.patientPortalAccount.update({
    where: { id: account.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })
  await recordAttempt(true)

  const rawToken = await createPortalSession({ portalAccountId: account.id, ip: meta.ip, userAgent: meta.userAgent })
  await setPortalSessionCookie(rawToken)

  return { ok: true }
}

export async function portalLogout(): Promise<void> {
  const session = await getCurrentPortalSession()
  if (session) {
    await revokePortalSession(session.sessionId)
  }
  await clearPortalSessionCookie()
}
