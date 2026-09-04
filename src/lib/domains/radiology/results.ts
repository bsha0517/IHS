import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { WriteReportInput, AmendReportInput } from "@/lib/domains/radiology/schemas"

/** "Radiology Report" (spec.md §30) — the radiologist's findings/impression against a performed study. */
export async function writeReport(session: SessionContext, imagingOrderId: string, input: WriteReportInput) {
  assertCan(session, "imaging_order.perform")

  const order = await db.imagingOrder.findFirstOrThrow({
    where: { id: imagingOrderId, organizationId: session.user.organizationId },
    include: { clinicalOrder: { select: { branchId: true } } },
  })
  // P3.5 §23: same branch-write gap fixed across every Lab/Radiology write
  // this batch touched — see laboratory/orders.ts's `assignTests` comment
  // for the full reasoning.
  assertBranchAccess(getAuthorizedBranchScope(session), order.clinicalOrder.branchId)
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

  const order = await db.imagingOrder.findFirstOrThrow({
    where: { id: imagingOrderId, organizationId: session.user.organizationId },
    include: { clinicalOrder: { select: { branchId: true } } },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), order.clinicalOrder.branchId)
  if (order.status !== "reported") throw new Error(`Only a reported study can be verified (this one is "${order.status}").`)

  const updated = await db.$transaction(async (tx) => {
    // P3.5 §27: same stale-transition guard as laboratory's own
    // `verifyResult` — see that function's comment for the full reasoning.
    const { count } = await tx.imagingOrder.updateMany({
      where: { id: imagingOrderId, status: "reported" },
      data: { status: "verified", verifiedBy: session.user.id, verifiedAt: new Date() },
    })
    if (count === 0) throw new Error("This report was already verified by someone else — refresh to see the current state.")
    const result = await tx.imagingOrder.findFirstOrThrow({ where: { id: imagingOrderId } })
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

/**
 * Targeted backlog closure, item 7: corrects a finalized ("verified")
 * radiology report without ever overwriting it. `ImagingOrder`'s own
 * reportText/impression/reportedBy/reportedAt fields are left completely
 * untouched forever, exactly like Lab's own verified LabOrderTest row —
 * the correction lives entirely in a new `ImagingReportAmendment` row
 * instead (see that model's own doc comment in schema.prisma for why a
 * dedicated table, not a second ImagingOrder row, is used here). Gated on
 * the same permission `writeReport` itself uses (not a new one) — matches
 * "permissions follow existing radiology report verification/amendment
 * logic."
 */
export async function amendImagingReport(session: SessionContext, imagingOrderId: string, input: AmendReportInput) {
  assertCan(session, "imaging_order.perform")

  const order = await db.imagingOrder.findFirst({
    where: { id: imagingOrderId, organizationId: session.user.organizationId },
    include: { clinicalOrder: { select: { branchId: true } } },
  })
  if (!order) throw new Error("This imaging order no longer exists or is not accessible.")
  assertBranchAccess(getAuthorizedBranchScope(session), order.clinicalOrder.branchId)
  if (order.status !== "verified") throw new Error(`Only a verified report can be amended (this one is "${order.status}").`)

  const amendment = await db.imagingReportAmendment.create({
    data: {
      organizationId: order.organizationId,
      imagingOrderId: order.id,
      reportText: input.reportText,
      impression: input.impression ?? null,
      reason: input.reason,
      amendedBy: session.user.id,
    },
  })

  await auditFromSession(session, "amend", "imaging_order", imagingOrderId, {
    old: { reportText: order.reportText, impression: order.impression },
    new: { reportText: input.reportText, impression: input.impression, reason: input.reason },
  })
  return amendment
}

// No separate getImagingReportHistory function — unlike Lab's own
// getLabResultHistory (which exists but, confirmed by a full route search,
// has no UI caller anywhere), the radiology order detail page already gets
// its full amendment chain through getRadiologyOrder's own enriched
// ORDER_INCLUDE (radiology/orders.ts) — a second, functionally-identical
// domain call would be genuinely dead code, not a reusable API surface.

/** Patient 360's Imaging tab — only verified ("Final Result") studies, per spec.md §30's workflow ending in "Patient EMR". A "result view" (SECURITY.md §5) — logged to clinical_access_log, wired up in Phase 14. */
export async function listPatientImagingResults(session: SessionContext, patientId: string) {
  assertCan(session, "patient.view")
  const scope = getAuthorizedBranchScope(session)
  const results = await db.imagingOrder.findMany({
    where: {
      organizationId: session.user.organizationId,
      status: "verified",
      clinicalOrder: { patientId, branchId: narrowBranchFilter(scope) },
    },
    // P3.2 §20: this only powers Patient 360's summary table (impression +
    // order link) — it previously pulled the full radiology narrative
    // (`reportText`, which can be long free-text sensitive content),
    // `externalImageUrl`, `notes`, and every perform/report/verify actor id
    // via `include` just to show one impression line. Narrowed to exactly
    // what the tab renders; the real report lives on the radiology order
    // page (`/radiology/orders/[id]`), which this table links out to.
    select: {
      id: true,
      verifiedAt: true,
      impression: true,
      imagingService: { select: { name: true } },
      clinicalOrder: { select: { id: true, orderNumber: true } },
      // Targeted backlog closure, item 7: only the single latest amendment's
      // impression is needed to show the CURRENT one here — the full
      // correction history stays on the radiology order page itself, not
      // duplicated into this summary tab.
      amendments: { orderBy: { amendedAt: "desc" }, take: 1, select: { impression: true } },
    },
    orderBy: { verifiedAt: "desc" },
  })
  await writeClinicalAccessLog({ session, patientId, resourceType: "imaging_results", action: "view" })
  // The latest amendment's impression, when one exists, is the current one
  // — the original ImagingOrder.impression is never overwritten.
  return results.map((r) => ({ ...r, impression: r.amendments[0]?.impression ?? r.impression }))
}
