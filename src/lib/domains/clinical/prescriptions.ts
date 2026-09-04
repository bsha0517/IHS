import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { nextNumber } from "@/lib/platform/sequences"
import { assertValidTransition } from "@/lib/platform/state-machine"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"
import type { PrescriptionInput } from "@/lib/domains/clinical/schemas"

/**
 * P3.6 §22/§27: `active` is the only non-terminal state — a prescription is
 * born `active` and ends either `completed` (Pharmacy fully dispensed every
 * item, see `dispensing.ts`'s own completion-sync comment) or `cancelled`
 * (the Doctor's own action below). Both ends are terminal: a completed
 * prescription is never re-opened by a later return (a return corrects
 * stock/quantity, not "undispenses" — see `returnDispensingRecord`'s own
 * comment), and a cancelled one is never silently reactivated. Reused by
 * both `cancelPrescription` below and `dispensing.ts`'s completion sync, the
 * same "one shared transition map per status-owning model" precedent as
 * `CLINICAL_ORDER_TRANSITIONS`/`LAB_ORDER_TEST_TRANSITIONS`.
 */
export const PRESCRIPTION_TRANSITIONS: Readonly<Record<$Enums.PrescriptionStatus, readonly $Enums.PrescriptionStatus[]>> = {
  active: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
}

export async function createPrescription(session: SessionContext, encounterId: string, input: PrescriptionInput) {
  assertCan(session, "prescription.create")

  // P3.3 §33: see clinical/vitals.ts's comment — `findFirstOrThrow` leaked
  // a raw Prisma message for a stale/invalid encounterId.
  const encounter = await db.encounter.findFirst({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })
  if (!encounter) throw new Error("This encounter no longer exists or is not accessible.")
  // P3.3 §34: this is exactly the shape of leak P2 already fixed elsewhere
  // for prescriptions (cross-branch visibility on the *read* side) — this
  // write path had never had the equivalent branch check at all. See
  // vitals.ts's comment for the full reasoning.
  assertBranchAccess(getAuthorizedBranchScope(session), encounter.branchId)

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
  // Targeted backlog closure, item 6 — see clinical/diagnoses.ts's identical comment.
  const before = await db.prescription.findFirst({
    where: { id: prescriptionId, organizationId: session.user.organizationId },
    include: { encounter: { select: { branchId: true } } },
  })
  if (!before) throw new Error("This prescription no longer exists or is not accessible.")
  assertBranchAccess(getAuthorizedBranchScope(session), before.encounter.branchId)
  // P3.6 §22/§27: previously an unconditional `update` — a prescription
  // already `completed` (fully dispensed) or already `cancelled` could be
  // "cancelled" again with no error, silently relabeling settled history.
  // Routed through the same centralized transition map every other
  // status-owning model in this codebase uses, so this can never happen.
  assertValidTransition(PRESCRIPTION_TRANSITIONS, before.status, "cancelled", "a prescription")
  const updated = await db.prescription.update({ where: { id: prescriptionId }, data: { status: "cancelled" } })
  await auditFromSession(session, "cancel", "prescription", prescriptionId, { old: before, new: updated })
  return updated
}

/**
 * P2 §13: was scoped only by `patient: visibility` (registered branch OR
 * has an appointment at an authorized branch) — the correct check for
 * whether the *patient record* is visible at all, but not sufficient here:
 * Prescription is per-encounter clinical content, not a patient-level
 * summary, and a patient legitimately visible via Branch B (any appointment
 * there) does not make every prescription from every OTHER branch that
 * patient was ever treated at visible too. `listPatientDiagnoses`
 * (diagnoses.ts) already scopes correctly by the record's own
 * `encounter.branchId` alone (not ANDed with patient-level visibility,
 * deliberately — a patient with an encounter at an authorized branch but no
 * registration/appointment there otherwise must still see that encounter's
 * own content) — this was a real inconsistency with that established
 * pattern, found during this batch's own review, not previously
 * catalogued. Fixed to match it exactly.
 */
/** P2 §7: a patient's prescription history — real chart content, previously unlogged. */
export async function listPatientPrescriptions(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  const prescriptions = await db.prescription.findMany({
    where: {
      organizationId: session.user.organizationId,
      patientId,
      ...(scope.isOrgWide ? {} : { encounter: { branchId: narrowBranchFilter(scope) } }),
    },
    // P3.6 §29: `dispensingRecords` added — a documented Phase 9 gap
    // (PROJECT_STATUS.md's own "No per-item dispensing status surfaced on
    // Patient 360's existing Prescriptions tab") this batch closes. Only
    // `status`/`quantityDispensed` selected, not the fuller shape
    // `getPrescriptionForDispensing` needs — Patient 360 only needs enough
    // to derive a fulfillment summary, never the operational workstation
    // itself (§29's own "do not load unnecessary inventory internals").
    include: { items: { include: { dispensingRecords: { select: { status: true, quantityDispensed: true } } } }, provider: true },
    orderBy: { issuedAt: "desc" },
  })
  await writeClinicalAccessLog({ session, patientId, resourceType: "prescriptions", action: "view" })
  return prescriptions
}

export async function getPrescription(session: SessionContext, prescriptionId: string) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  const prescription = await db.prescription.findFirstOrThrow({
    where: {
      id: prescriptionId,
      organizationId: session.user.organizationId,
      ...(scope.isOrgWide ? {} : { encounter: { branchId: narrowBranchFilter(scope) } }),
    },
    include: { items: true, provider: true, patient: true, encounter: true },
  })
  await writeClinicalAccessLog({ session, patientId: prescription.patientId, resourceType: "prescription", resourceId: prescriptionId, action: "view" })
  return prescription
}
