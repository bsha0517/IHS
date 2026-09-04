import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { assertValidTransition } from "@/lib/platform/state-machine"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"
import type { EnterNumericResultInput, EnterTextResultInput } from "@/lib/domains/laboratory/schemas"

/**
 * P1 §20: LabOrderTest's own centralized transition map — the per-test
 * analogue of ClinicalOrder's (clinical/orders.ts), covering P1's literal
 * ladder: ORDERED -> COLLECTED -> PROCESSING -> RESULTED -> VERIFIED.
 * `resulted: ["resulted", ...]` is a deliberate self-loop, not an oversight
 * — it's what lets enterNumericResult/enterTextResult correct an entry
 * before it's verified (a real, legitimate workflow: the tech fixes their
 * own typo before the pathologist signs off) without that correction
 * reading as a "transition" the map would otherwise reject. `verified` is
 * terminal — correcting an already-verified result goes through
 * amendLabResult below (P1 §21), never back through this map.
 */
export const LAB_ORDER_TEST_TRANSITIONS: Readonly<Record<$Enums.LabOrderTestStatus, readonly $Enums.LabOrderTestStatus[]>> = {
  ordered: ["collected", "cancelled"],
  collected: ["processing", "resulted", "cancelled"],
  processing: ["resulted", "cancelled"],
  resulted: ["resulted", "verified", "cancelled"],
  verified: [],
  cancelled: [],
}

/**
 * P1 §22: LOW/HIGH/CRITICAL_LOW/CRITICAL_HIGH, determined only where the
 * relevant threshold is actually configured — never fabricated. Critical
 * checked before ordinary low/high (a value can be simultaneously "outside
 * the normal band" and "outside the panic band"; critical is the more
 * severe, more clinically urgent classification and wins). Normal low/high
 * are now checked independently of each other (previously required BOTH to
 * be non-null before flagging either) — a test configured with only one
 * bound still deserves a flag when that one bound is crossed.
 */
export function computeAbnormalFlag(
  value: number,
  low: Decimal | null,
  high: Decimal | null,
  criticalLow: Decimal | null = null,
  criticalHigh: Decimal | null = null
): $Enums.AbnormalFlag | null {
  if (low === null && high === null && criticalLow === null && criticalHigh === null) return null
  if (criticalLow !== null && value < Number(criticalLow)) return "critical_low"
  if (criticalHigh !== null && value > Number(criticalHigh)) return "critical_high"
  if (low !== null && value < Number(low)) return "low"
  if (high !== null && value > Number(high)) return "high"
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
    include: { labTest: true, clinicalOrder: { select: { branchId: true } } },
  })
  // P3.5 §23: same branch-write gap fixed across every Lab/Radiology write
  // this batch touched — LabOrderTest has no branchId of its own, so this
  // goes through its parent ClinicalOrder (already selected above, no
  // extra round trip).
  assertBranchAccess(getAuthorizedBranchScope(session), line.clinicalOrder.branchId)
  if (line.resultType !== "numeric") throw new Error("This test expects a text result, not a numeric one.")
  // P1 §20: routes through the same centralized map as everything else —
  // this used to only block re-entry after "verified", which meant a result
  // could be entered directly against an "ordered" line that was never
  // actually collected. Still allows "resulted" -> "resulted" (a correction
  // before verification — see the map's own doc comment).
  assertValidTransition(LAB_ORDER_TEST_TRANSITIONS, line.status, "resulted", "a lab result")

  const abnormalFlag = computeAbnormalFlag(
    input.numericValue,
    line.labTest.referenceRangeLow,
    line.labTest.referenceRangeHigh,
    line.labTest.criticalLow,
    line.labTest.criticalHigh
  )

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
    include: { labTest: true, clinicalOrder: { select: { branchId: true } } },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), line.clinicalOrder.branchId)
  if (line.resultType !== "text") throw new Error("This test expects a numeric result, not a text one.")
  assertValidTransition(LAB_ORDER_TEST_TRANSITIONS, line.status, "resulted", "a lab result")

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
 *
 * P1 §22: a critical (critical_low/critical_high) result additionally fires
 * `CriticalLabResultVerified` — independent of whether this is the last
 * line on its order (a single critical value deserves immediate attention,
 * not only once every sibling test also happens to finish). Fired through
 * the outbox, same as every other notification side effect in this
 * codebase, specifically so a notification failure can never roll back or
 * block the verification write itself, which has already committed by the
 * time dispatch runs (P1 §22's own "notification failure must never
 * invalidate the clinical result" — see event-handlers.ts's handler for who
 * gets notified and why that's restricted, not broadcast).
 */
export async function verifyResult(session: SessionContext, labOrderTestId: string) {
  assertCan(session, "lab_result.verify")

  const line = await db.labOrderTest.findFirstOrThrow({
    where: { id: labOrderTestId, organizationId: session.user.organizationId },
    include: { clinicalOrder: { select: { branchId: true } } },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), line.clinicalOrder.branchId)
  if (!line.isCurrent) throw new Error("Only the current version of a lab result can be verified.")
  assertValidTransition(LAB_ORDER_TEST_TRANSITIONS, line.status, "verified", "a lab result")

  const updated = await db.$transaction(async (tx) => {
    // P3.5 §27: the status check above reads *before* this transaction —
    // two technicians racing to verify the same line (one still has the
    // form open while the other submits first) would otherwise both pass
    // that check and both succeed, the second silently overwriting the
    // first's verifiedBy/verifiedAt with no error to either party. The
    // `where: { status: "resulted" }` here makes the actual write
    // conditional on the row still being in the state this call observed —
    // `updateMany` (not `update`, which requires a plain unique `where`)
    // so a stale second caller gets `count: 0` and a real, friendly error
    // instead of silently succeeding.
    const { count } = await tx.labOrderTest.updateMany({
      where: { id: labOrderTestId, status: "resulted" },
      data: { status: "verified", verifiedBy: session.user.id, verifiedAt: new Date() },
    })
    if (count === 0) throw new Error("This result was already verified by someone else — refresh to see the current state.")
    const result = await tx.labOrderTest.findFirstOrThrow({ where: { id: labOrderTestId } })

    if (result.abnormalFlag === "critical_low" || result.abnormalFlag === "critical_high") {
      await writeOutboxEvent(tx, {
        organizationId: session.user.organizationId,
        eventType: "CriticalLabResultVerified",
        payload: { labOrderTestId: result.id, clinicalOrderId: line.clinicalOrderId, abnormalFlag: result.abnormalFlag },
      })
    }

    const siblings = await tx.labOrderTest.findMany({ where: { clinicalOrderId: line.clinicalOrderId, isCurrent: true } })
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

/**
 * P1 §21: corrects an already-verified ("Final Result") lab result without
 * ever editing it in place — the same isCurrent+amendsId pattern
 * notes.ts's createAmendment already established for ClinicalNote, reused
 * here rather than reinvented. The amendment is born `verified` (it's
 * correcting something already final, not restarting the entry/verify
 * cycle) but under the AMENDING user's own name/timestamp, on a fresh row
 * — the original stays exactly as it was, permanently, just no longer
 * `isCurrent`. `chargeId` is deliberately never copied onto the amendment
 * (it's a data correction, not a new billable event, and `chargeId` is
 * unique — copying it would collide with the original row that still holds
 * it).
 */
export async function amendLabResult(
  session: SessionContext,
  labOrderTestId: string,
  input: EnterNumericResultInput | EnterTextResultInput
) {
  assertCan(session, "lab_result.enter")

  const original = await db.labOrderTest.findFirstOrThrow({
    where: { id: labOrderTestId, organizationId: session.user.organizationId },
    include: { labTest: true, clinicalOrder: { select: { branchId: true } } },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), original.clinicalOrder.branchId)
  if (!original.isCurrent) throw new Error("Only the current version of a lab result can be amended.")
  if (original.status !== "verified") throw new Error("Only a verified result needs an amendment — edit the entry directly instead.")

  const isNumeric = "numericValue" in input
  const abnormalFlag = isNumeric
    ? computeAbnormalFlag(input.numericValue, original.labTest.referenceRangeLow, original.labTest.referenceRangeHigh, original.labTest.criticalLow, original.labTest.criticalHigh)
    : null

  const amendment = await db.$transaction(async (tx) => {
    await tx.labOrderTest.update({ where: { id: original.id }, data: { isCurrent: false } })
    return tx.labOrderTest.create({
      data: {
        organizationId: original.organizationId,
        clinicalOrderId: original.clinicalOrderId,
        labTestId: original.labTestId,
        labPanelId: original.labPanelId,
        specimenId: original.specimenId,
        chargeId: null,
        resultType: original.resultType,
        numericValue: isNumeric ? new Decimal(input.numericValue) : null,
        textValue: isNumeric ? null : input.textValue,
        unit: original.unit,
        referenceRangeLow: original.referenceRangeLow,
        referenceRangeHigh: original.referenceRangeHigh,
        referenceRangeText: original.referenceRangeText,
        abnormalFlag,
        notes: input.notes ?? null,
        status: "verified",
        enteredBy: session.user.id,
        enteredAt: new Date(),
        verifiedBy: session.user.id,
        verifiedAt: new Date(),
        amendsId: original.id,
      },
    })
  })

  await auditFromSession(session, "amend", "lab_order_test", amendment.id, {
    old: { amends: original.id },
    new: isNumeric ? { numericValue: input.numericValue, abnormalFlag } : { textValue: input.textValue },
  })
  return amendment
}

/** Full version chain for a lab result, oldest first — the amendment counterpart to notes.ts's getNoteHistory. */
export async function getLabResultHistory(session: SessionContext, currentLabOrderTestId: string) {
  assertCan(session, "lab_result.enter")
  const chain = []
  let cursor = await db.labOrderTest.findFirst({
    where: { id: currentLabOrderTestId, organizationId: session.user.organizationId },
    include: { clinicalOrder: true },
  })
  if (cursor) assertBranchAccess(getAuthorizedBranchScope(session), cursor.clinicalOrder.branchId)
  while (cursor) {
    chain.unshift(cursor)
    if (!cursor.amendsId) break
    cursor = await db.labOrderTest.findFirst({
      where: { id: cursor.amendsId, organizationId: session.user.organizationId },
      include: { clinicalOrder: true },
    })
  }
  return chain
}

/**
 * Patient 360's Lab Results tab — only verified ("Final Result") lines, per
 * spec.md §28's workflow ending in "Patient EMR". A "result view"
 * (SECURITY.md §5) — logged to clinical_access_log, wired up in Phase 14.
 *
 * P1 §21: also filters `isCurrent: true` — without it, an amended result
 * would show twice (the superseded original alongside its correction),
 * both still carrying `status: "verified"` since the original is never
 * un-verified, only superseded.
 */
export async function listPatientLabResults(session: SessionContext, patientId: string) {
  assertCan(session, "patient.view")
  const scope = getAuthorizedBranchScope(session)
  const results = await db.labOrderTest.findMany({
    where: {
      organizationId: session.user.organizationId,
      status: "verified",
      isCurrent: true,
      clinicalOrder: { patientId, branchId: narrowBranchFilter(scope) },
    },
    // P3.2 §20: this only powers Patient 360's summary table (test name,
    // value, range, flag, order link) — it previously pulled every scalar
    // column via `include` (entered/verified-by ids, free-text `notes`,
    // the whole LabPanel relation) just to show a one-line row. Narrowed to
    // exactly what the tab renders; nothing else reads this function.
    select: {
      id: true,
      verifiedAt: true,
      numericValue: true,
      unit: true,
      textValue: true,
      referenceRangeLow: true,
      referenceRangeHigh: true,
      referenceRangeText: true,
      abnormalFlag: true,
      labTest: { select: { name: true } },
      clinicalOrder: { select: { id: true, orderNumber: true } },
    },
    orderBy: { verifiedAt: "desc" },
  })
  await writeClinicalAccessLog({ session, patientId, resourceType: "lab_results", action: "view" })
  return results
}
