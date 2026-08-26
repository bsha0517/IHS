import "server-only"
import { cookies } from "next/headers"
import { db } from "@/lib/db"
import { generateRawToken, hashToken } from "@/lib/auth/tokens"
import { PORTAL_SESSION_COOKIE_NAME } from "@/lib/auth/portal-constants"

export { PORTAL_SESSION_COOKIE_NAME }
const PORTAL_SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours, same as staff sessions

export type PortalSessionContext = {
  sessionId: string
  patient: {
    id: string
    organizationId: string
    firstName: string
    lastName: string
    mrn: string
  }
  portalAccountId: string
  email: string
}

type CreatePortalSessionInput = {
  portalAccountId: string
  ip?: string | null
  userAgent?: string | null
}

/** Mirrors createSession() (session.ts) exactly, against PatientPortalSession instead of Session. */
export async function createPortalSession(input: CreatePortalSessionInput): Promise<string> {
  const rawToken = generateRawToken()
  await db.patientPortalSession.create({
    data: {
      portalAccountId: input.portalAccountId,
      tokenHash: hashToken(rawToken),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      expiresAt: new Date(Date.now() + PORTAL_SESSION_TTL_MS),
    },
  })
  return rawToken
}

export async function setPortalSessionCookie(rawToken: string) {
  const store = await cookies()
  store.set(PORTAL_SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: PORTAL_SESSION_TTL_MS / 1000,
  })
}

export async function clearPortalSessionCookie() {
  const store = await cookies()
  store.delete(PORTAL_SESSION_COOKIE_NAME)
}

export async function revokePortalSession(sessionId: string) {
  await db.patientPortalSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
}

export async function getPortalSessionContext(rawToken: string | undefined): Promise<PortalSessionContext | null> {
  if (!rawToken) return null

  const session = await db.patientPortalSession.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { portalAccount: { include: { patient: true } } },
  })

  if (!session) return null
  if (session.revokedAt) return null
  if (session.expiresAt.getTime() < Date.now()) return null
  if (session.portalAccount.status !== "active") return null

  return {
    sessionId: session.id,
    patient: {
      id: session.portalAccount.patient.id,
      organizationId: session.portalAccount.organizationId,
      firstName: session.portalAccount.patient.firstName,
      lastName: session.portalAccount.patient.lastName,
      mrn: session.portalAccount.patient.mrn,
    },
    portalAccountId: session.portalAccount.id,
    email: session.portalAccount.email,
  }
}

export async function getCurrentPortalSession(): Promise<PortalSessionContext | null> {
  const store = await cookies()
  const token = store.get(PORTAL_SESSION_COOKIE_NAME)?.value
  return getPortalSessionContext(token)
}
