import "server-only"
import { randomInt } from "crypto"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { hashPassword } from "@/lib/auth/password"
import type { SessionContext } from "@/lib/auth/session"

const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I — avoids transcription errors when relayed by phone/in person

function generateTempPassword(length = 10): string {
  let out = ""
  for (let i = 0; i < length; i++) out += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)]
  return out
}

/**
 * "Patient Portal Architecture" (spec.md §57) — staff-provisioned, not
 * patient self-registration (see PatientPortalAccount's own doc comment for
 * why). No email adapter dependency: the generated temp password is
 * returned once, for staff to relay directly (in person / by phone) —
 * emailing a raw password through the honestly-unconfigured Null email
 * adapter would be worse than not sending it at all, since the adapter
 * never claims delivery succeeded (spec.md §92).
 */
export async function enablePortalAccess(session: SessionContext, patientId: string, email: string) {
  assertCan(session, "patient.edit")

  const patient = await db.patient.findFirstOrThrow({ where: { id: patientId, organizationId: session.user.organizationId } })
  const existing = await db.patientPortalAccount.findUnique({ where: { patientId } })
  if (existing) throw new Error("This patient already has a portal account.")

  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)

  const account = await db.patientPortalAccount.create({
    data: {
      organizationId: session.user.organizationId,
      patientId: patient.id,
      email: email.trim().toLowerCase(),
      passwordHash,
    },
  })

  await auditFromSession(session, "create", "patient_portal_account", account.id, { new: { patientId, email: account.email } })
  return { account, tempPassword }
}

export async function resetPortalPassword(session: SessionContext, patientId: string) {
  assertCan(session, "patient.edit")

  const account = await db.patientPortalAccount.findUniqueOrThrow({ where: { patientId } })
  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)

  await db.patientPortalAccount.update({
    where: { id: account.id },
    data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
  })
  await auditFromSession(session, "update", "patient_portal_account", account.id, { new: { passwordReset: true } })
  return { tempPassword }
}

export async function deactivatePortalAccess(session: SessionContext, patientId: string) {
  assertCan(session, "patient.edit")
  const account = await db.patientPortalAccount.findUniqueOrThrow({ where: { patientId } })
  await db.patientPortalAccount.update({ where: { id: account.id }, data: { status: "inactive" } })
  await db.patientPortalSession.updateMany({ where: { portalAccountId: account.id, revokedAt: null }, data: { revokedAt: new Date() } })
  await auditFromSession(session, "update", "patient_portal_account", account.id, { new: { status: "inactive" } })
}

export async function getPortalAccountForPatient(session: SessionContext, patientId: string) {
  assertCan(session, "patient.edit")
  return db.patientPortalAccount.findUnique({ where: { patientId } })
}
