import "server-only"
import { cookies } from "next/headers"
import { db } from "@/lib/db"
import { generateRawToken, hashToken } from "@/lib/auth/tokens"
import { PLATFORM_SESSION_COOKIE_NAME } from "@/lib/auth/platform-constants"

export { PLATFORM_SESSION_COOKIE_NAME }
const PLATFORM_SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours, same as staff/portal sessions

export type PlatformSessionContext = {
  sessionId: string
  operator: {
    id: string
    email: string
    firstName: string
    lastName: string
  }
}

type CreatePlatformSessionInput = {
  operatorId: string
  ip?: string | null
  userAgent?: string | null
}

/** Mirrors createSession()/createPortalSession() exactly, against PlatformSession instead. */
export async function createPlatformSession(input: CreatePlatformSessionInput): Promise<string> {
  const rawToken = generateRawToken()
  await db.platformSession.create({
    data: {
      operatorId: input.operatorId,
      tokenHash: hashToken(rawToken),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      expiresAt: new Date(Date.now() + PLATFORM_SESSION_TTL_MS),
    },
  })
  return rawToken
}

export async function setPlatformSessionCookie(rawToken: string) {
  const store = await cookies()
  store.set(PLATFORM_SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: PLATFORM_SESSION_TTL_MS / 1000,
  })
}

export async function clearPlatformSessionCookie() {
  const store = await cookies()
  store.delete(PLATFORM_SESSION_COOKIE_NAME)
}

export async function revokePlatformSession(sessionId: string) {
  await db.platformSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
}

/**
 * P5.1 §84: the whole security proof lives here — this looks up
 * `PlatformSession`/`PlatformOperator`, never `Session`/`User`. There is no
 * code path anywhere that lets a resolved staff `SessionContext` produce a
 * `PlatformSessionContext` or vice versa; a clinic Super Admin's cookie is
 * simply the wrong cookie name for this function to even look at.
 */
export async function getPlatformSessionContext(rawToken: string | undefined): Promise<PlatformSessionContext | null> {
  if (!rawToken) return null

  const session = await db.platformSession.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { operator: true },
  })

  if (!session) return null
  if (session.revokedAt) return null
  if (session.expiresAt.getTime() < Date.now()) return null
  if (session.operator.status !== "active") return null

  return {
    sessionId: session.id,
    operator: {
      id: session.operator.id,
      email: session.operator.email,
      firstName: session.operator.firstName,
      lastName: session.operator.lastName,
    },
  }
}

export async function getCurrentPlatformSession(): Promise<PlatformSessionContext | null> {
  const store = await cookies()
  const token = store.get(PLATFORM_SESSION_COOKIE_NAME)?.value
  return getPlatformSessionContext(token)
}
