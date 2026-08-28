import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { getAuthorizedBranchScope, patientVisibilityWhere } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { PrescriptionInput } from "@/lib/domains/clinical/schemas"

export async function createPrescription(session: SessionContext, encounterId: string, input: PrescriptionInput) {
  assertCan(session, "prescription.create")

  const encounter = await db.encounter.findFirstOrThrow({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })

  const prescription = await db.$transaction(async (tx) => {
    const prescriptionNumber = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "RX",
      prefix: "RX",
    })

    return tx.prescription.create({
      data: {
        organizationId: session.user.organizationId,
        patientId: encounter.patientId,
        encounterId,
        providerId: encounter.providerId,
        prescriptionNumber,
        createdBy: session.user.id,
        items: { createMany: { data: input.items } },
      },
      include: { items: true },
    })
  })

  await auditFromSession(session, "create", "prescription", prescription.id, {
    new: { prescriptionNumber: prescription.prescriptionNumber, itemCount: input.items.length },
  })

  return prescription
}

export async function cancelPrescription(session: SessionContext, prescriptionId: string) {
  assertCan(session, "prescription.create")
  const before = await db.prescription.findFirstOrThrow({
    where: { id: prescriptionId, organizationId: session.user.organizationId },
  })
  const updated = await db.prescription.update({ where: { id: prescriptionId }, data: { status: "cancelled" } })
  await auditFromSession(session, "cancel", "prescription", prescriptionId, { old: before, new: updated })
  return updated
}

export async function listPatientPrescriptions(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  const visibility = patientVisibilityWhere(getAuthorizedBranchScope(session))
  return db.prescription.findMany({
    where: { organizationId: session.user.organizationId, patientId, ...(visibility ? { patient: visibility } : {}) },
    include: { items: true, provider: true },
    orderBy: { issuedAt: "desc" },
  })
}

export async function getPrescription(session: SessionContext, prescriptionId: string) {
  assertCan(session, "encounter.view")
  const visibility = patientVisibilityWhere(getAuthorizedBranchScope(session))
  return db.prescription.findFirstOrThrow({
    where: { id: prescriptionId, organizationId: session.user.organizationId, ...(visibility ? { patient: visibility } : {}) },
    include: { items: true, provider: true, patient: true, encounter: true },
  })
}
