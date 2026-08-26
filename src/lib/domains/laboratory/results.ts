import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"
import type { EnterNumericResultInput, EnterTextResultInput } from "@/lib/domains/laboratory/schemas"

/** Low/high only — no critical-threshold auto-detection, since LabTest carries one reference band, not a separate critical band (see PROJECT_STATUS.md's Phase 8 Known Issues). */
export function computeAbnormalFlag(value: number, low: Decimal | null, high: Decimal | null): $Enums.AbnormalFlag | null {
  if (low === null || high === null) return null
  if (value < Number(low)) return "low"
  if (value > Number(high)) return "high"
  return "normal"
}

/**
 * "Result Entry" (spec.md §28) — snapshots unit/reference range from the
 * LabTest catalog at entry time (the actual clinical-interpretation moment),
 * not at order time, so a later change to the catalog's reference range
 * never silently rewrites an already-entered result's context. abnormalFlag
 * is always computed here from the snapshot, never accepted from the caller.
 */
export async function enterNumericResult(session: SessionContext, labOrderTestId: string, input: EnterNumericResultInput) {
  assertCan(session, "lab_result.enter")

  const line = await db.labOrderTest.findFirstOrThrow({
    where: { id: labOrderTestId, organizationId: session.user.organizationId },
    include: { labTest: true },
  })
  if (line.resultType !== "numeric") throw new Error("This test expects a text result, not a numeric one.")
  if (line.status === "verified") throw new Error("Cannot re-enter a result that has already been verified.")

  const abnormalFlag = computeAbnormalFlag(input.numericValue, line.labTest.referenceRangeLow, line.labTest.referenceRangeHigh)

  const updated = await db.labOrderTest.update({
    where: { id: labOrderTestId },
    data: {
      numericValue: new Decimal(input.numericValue),
      unit: line.labTest.unit,
      referenceRangeLow: line.labTest.referenceRangeLow,
      referenceRangeHigh: line.labTest.referenceRangeHigh,
      abnormalFlag,
      notes: input.notes ?? null,
      status: "resulted",
      enteredBy: session.user.id,
      enteredAt: new Date(),
    },
  })
  await auditFromSession(session, "update", "lab_order_test", labOrderTestId, { new: { numericValue: input.numericValue, abnormalFlag } })
  return updated
}

export async function enterTextResult(session: SessionContext, labOrderTestId: string, input: EnterTextResultInput) {
  assertCan(session, "lab_result.enter")

  const line = await db.labOrderTest.findFirstOrThrow({
    where: { id: labOrderTestId, organizationId: session.user.organizationId },
    include: { labTest: true },
  })
  if (line.resultType !== "text") throw new Error("This test expects a numeric result, not a text one.")
  if (line.status === "verified") throw new Error("Cannot re-enter a result that has already been verified.")

  const updated = await db.labOrderTest.update({
    where: { id: labOrderTestId },
    data: {
      textValue: input.textValue,
      referenceRangeText: line.labTest.referenceRangeText,
      notes: input.notes ?? null,
      status: "resulted",
      enteredBy: session.user.id,
      enteredAt: new Date(),
    },
  })
  await auditFromSession(session, "update", "lab_order_test", labOrderTestId, { new: { textValue: input.textValue } })
  return updated
}

/**
 * "Result Verification" -> "Final Result" (spec.md §28) — a distinct
 * permission from entry (segregation of duties, same pattern as every prior
 * phase's enter/verify pair). Rolls the parent ClinicalOrder to `completed`
 * once every one of its LabOrderTest lines is verified or cancelled, and
 * fires `LabResultFinalized` at that point — reserved in ARCHITECTURE.md's
 * event table since Phase 2, wired for real only now.
 */
export async function verifyResult(session: SessionContext, labOrderTestId: string) {
  assertCan(session, "lab_result.verify")

  const line = await db.labOrderTest.findFirstOrThrow({
    where: { id: labOrderTestId, organizationId: session.user.organizationId },
  })
  if (line.status !== "resulted") throw new Error(`Only a resulted test can be verified (this one is "${line.status}").`)

  const updated = await db.$transaction(async (tx) => {
    const result = await tx.labOrderTest.update({
      where: { id: labOrderTestId },
      data: { status: "verified", verifiedBy: session.user.id, verifiedAt: new Date() },
    })

    const siblings = await tx.labOrderTest.findMany({ where: { clinicalOrderId: line.clinicalOrderId } })
    const allDone = siblings.every((s) => s.id === result.id || s.status === "verified" || s.status === "cancelled")
    if (allDone) {
      await tx.clinicalOrder.update({ where: { id: line.clinicalOrderId }, data: { status: "completed" } })
      await writeOutboxEvent(tx, {
        organizationId: session.user.organizationId,
        eventType: "LabResultFinalized",
        payload: { clinicalOrderId: line.clinicalOrderId },
      })
    }

    return result
  })

  await auditFromSession(session, "update", "lab_order_test", labOrderTestId, { new: { status: "verified" } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}

/** Patient 360's Lab Results tab — only verified ("Final Result") lines, per spec.md §28's workflow ending in "Patient EMR". A "result view" (SECURITY.md §5) — logged to clinical_access_log, wired up in Phase 14. */
export async function listPatientLabResults(session: SessionContext, patientId: string) {
  assertCan(session, "patient.view")
  const results = await db.labOrderTest.findMany({
    where: { organizationId: session.user.organizationId, status: "verified", clinicalOrder: { patientId } },
    include: { labTest: true, labPanel: true, clinicalOrder: true },
    orderBy: { verifiedAt: "desc" },
  })
  await writeClinicalAccessLog({ session, patientId, resourceType: "lab_results", action: "view" })
  return results
}
