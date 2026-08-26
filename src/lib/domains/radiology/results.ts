import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import type { SessionContext } from "@/lib/auth/session"
import type { WriteReportInput } from "@/lib/domains/radiology/schemas"

/** "Radiology Report" (spec.md §30) — the radiologist's findings/impression against a performed study. */
export async function writeReport(session: SessionContext, imagingOrderId: string, input: WriteReportInput) {
  assertCan(session, "imaging_order.perform")

  const order = await db.imagingOrder.findFirstOrThrow({ where: { id: imagingOrderId, organizationId: session.user.organizationId } })
  if (order.status !== "performed") throw new Error(`Only a performed study can be reported (this one is "${order.status}").`)

  const updated = await db.imagingOrder.update({
    where: { id: imagingOrderId },
    data: {
      status: "reported",
      reportText: input.reportText,
      impression: input.impression ?? null,
      reportedBy: session.user.id,
      reportedAt: new Date(),
    },
  })
  await auditFromSession(session, "update", "imaging_order", imagingOrderId, { new: { status: "reported" } })
  return updated
}

/**
 * "Result Verification" → "Final Result" (spec.md §30) — a distinct
 * permission from reporting (segregation of duties, the same enter/verify
 * pattern as lab_result.enter/verify and prescription.verify/dispense).
 * Since one ImagingOrder is always exactly 1:1 with its ClinicalOrder (unlike
 * lab's fan-out into several LabOrderTest rows), verifying it always
 * completes the parent order — no sibling check needed. Fires
 * ImagingResultFinalized, the same notify-the-ordering-provider pattern
 * already proven by AppointmentCheckedIn/LabResultFinalized.
 */
export async function verifyImagingResult(session: SessionContext, imagingOrderId: string) {
  assertCan(session, "imaging_result.verify")

  const order = await db.imagingOrder.findFirstOrThrow({ where: { id: imagingOrderId, organizationId: session.user.organizationId } })
  if (order.status !== "reported") throw new Error(`Only a reported study can be verified (this one is "${order.status}").`)

  const updated = await db.$transaction(async (tx) => {
    const result = await tx.imagingOrder.update({
      where: { id: imagingOrderId },
      data: { status: "verified", verifiedBy: session.user.id, verifiedAt: new Date() },
    })
    await tx.clinicalOrder.update({ where: { id: order.clinicalOrderId }, data: { status: "completed" } })
    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "ImagingResultFinalized",
      payload: { clinicalOrderId: order.clinicalOrderId },
    })
    return result
  })

  await auditFromSession(session, "update", "imaging_order", imagingOrderId, { new: { status: "verified" } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}

/** Patient 360's Imaging tab — only verified ("Final Result") studies, per spec.md §30's workflow ending in "Patient EMR". A "result view" (SECURITY.md §5) — logged to clinical_access_log, wired up in Phase 14. */
export async function listPatientImagingResults(session: SessionContext, patientId: string) {
  assertCan(session, "patient.view")
  const results = await db.imagingOrder.findMany({
    where: { organizationId: session.user.organizationId, status: "verified", clinicalOrder: { patientId } },
    include: { imagingService: true, clinicalOrder: true },
    orderBy: { verifiedAt: "desc" },
  })
  await writeClinicalAccessLog({ session, patientId, resourceType: "imaging_results", action: "view" })
  return results
}
