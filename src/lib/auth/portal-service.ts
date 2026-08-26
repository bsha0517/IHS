import "server-only"
import { db } from "@/lib/db"
import { verifyPassword } from "@/lib/auth/password"
import { createPortalSession, setPortalSessionCookie, clearPortalSessionCookie, revokePortalSession, getCurrentPortalSession } from "@/lib/auth/portal-session"

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000

export type PortalLoginResult = { ok: true } | { ok: false; error: string }

type RequestMeta = { ip?: string | null; userAgent?: string | null }

/** Mirrors auth/service.ts's login() exactly, against PatientPortalAccount instead of User — same generic error message, same lockout mechanism, no separate login-history table (see PROJECT_STATUS.md's Phase 12 Known Issues). */
export async function portalLogin(email: string, password: string, meta: RequestMeta): Promise<PortalLoginResult> {
  const normalizedEmail = email.trim().toLowerCase()
  const account = await db.patientPortalAccount.findFirst({ where: { email: normalizedEmail } })

  if (!account) {
    return { ok: false, error: "Invalid email or password." }
  }

  if (account.status === "locked" || (account.lockedUntil && account.lockedUntil.getTime() > Date.now())) {
    return { ok: false, error: "This account is locked. Try again later or contact the clinic." }
  }

  if (account.status !== "active") {
    return { ok: false, error: "This account is inactive." }
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
    return { ok: false, error: "Invalid email or password." }
  }

  await db.patientPortalAccount.update({
    where: { id: account.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

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
