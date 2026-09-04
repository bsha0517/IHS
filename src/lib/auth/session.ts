import "server-only"
import { cookies } from "next/headers"
import { db } from "@/lib/db"
import { generateRawToken, hashToken } from "@/lib/auth/tokens"
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants"

export { SESSION_COOKIE_NAME }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours

export type SessionContext = {
  sessionId: string
  user: {
    id: string
    organizationId: string
    email: string
    firstName: string
    lastName: string
  }
  activeBranchId: string | null
  branchIds: string[]
  permissions: Set<string>
  roleNames: string[]
}

type CreateSessionInput = {
  userId: string
  ip?: string | null
  userAgent?: string | null
  activeBranchId?: string | null
}

/** Creates a DB-backed session row and returns the raw token to set as a cookie. Never returns the hash. */
export async function createSession(input: CreateSessionInput): Promise<string> {
  const rawToken = generateRawToken()
  await db.session.create({
    data: {
      userId: input.userId,
      tokenHash: hashToken(rawToken),
      activeBranchId: input.activeBranchId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  })
  return rawToken
}

export async function setSessionCookie(rawToken: string) {
  const store = await cookies()
  store.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export async function clearSessionCookie() {
  const store = await cookies()
  store.delete(SESSION_COOKIE_NAME)
}

/** Revokes the session (does not delete — revoked_at is set so it remains in login/session history). */
export async function revokeSession(sessionId: string) {
  await db.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  })
}

export async function revokeAllUserSessions(userId: string) {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Loads the full authorization context for a raw session token, or null if invalid/expired/revoked. */
export async function getSessionContext(rawToken: string | undefined): Promise<SessionContext | null> {
  if (!rawToken) return null

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: {
      user: {
        include: {
          organization: true,
          branchAccess: true,
          roles: {
            include: {
              role: {
                include: {
                  permissions: { include: { permission: true } },
                },
              },
            },
          },
        },
      },
    },
  })

  if (!session) return null
  if (session.revokedAt) return null
  if (session.expiresAt.getTime() < Date.now()) return null
  if (session.user.status !== "active") return null
  // P4.3 §5/§16/§21: re-checked on EVERY request, from live DB state, not
  // just at login — an organization suspended mid-session must not leave
  // its staff's already-issued sessions still working. Every request
  // resolves through this function (no session data is cached/embedded in
  // the cookie itself beyond the opaque token), so this takes effect
  // immediately, the same way user deactivation already did before this
  // batch.
  if (session.user.organization.status !== "active") return null

  const permissions = new Set<string>()
  const roleNames: string[] = []
  for (const userRole of session.user.roles) {
    roleNames.push(userRole.role.name)
    for (const rolePermission of userRole.role.permissions) {
      permissions.add(rolePermission.permission.code)
    }
  }

  return {
    sessionId: session.id,
    user: {
      id: session.user.id,
      organizationId: session.user.organizationId,
      email: session.user.email,
      firstName: session.user.firstName,
      lastName: session.user.lastName,
    },
    activeBranchId: session.activeBranchId,
    branchIds: session.user.branchAccess.map((a) => a.branchId),
    permissions,
    roleNames,
  }
}

/** Convenience: reads the session cookie from the current request and resolves it. */
export async function getCurrentSession(): Promise<SessionContext | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE_NAME)?.value
  return getSessionContext(token)
}
