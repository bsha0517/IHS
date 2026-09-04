import "server-only"
import { db } from "@/lib/db"
import { assertCan, can, ForbiddenError } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { assertValidTransition } from "@/lib/platform/state-machine"
import { CLINICAL_ORDER_TRANSITIONS } from "@/lib/domains/clinical/orders"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { resolvePage, paginationSkipTake, totalPages } from "@/lib/platform/pagination"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"
import type { AssignTestsInput, RejectSpecimenInput } from "@/lib/domains/laboratory/schemas"

/**
 * "Sample Collection" (spec.md §28) — marks the physical draw and cascades
 * every LabOrderTest riding on this specimen from `ordered` to `collected`
 * in one step, since they were all assigned together against the same
 * physical sample.
 */
export async function collectSpecimen(session: SessionContext, specimenId: string) {
  assertCan(session, "lab_result.enter")
  const specimen = await db.specimen.findFirstOrThrow({ where: { id: specimenId, organizationId: session.user.organizationId } })
  // P3.5 §23: this write path checked org membership but never branch —
  // the same class of gap P3.3 closed for encounter writes. See
  // `assignTests` below for the fuller reasoning; applied identically
  // across every Lab/Radiology write this batch touched.
  assertBranchAccess(getAuthorizedBranchScope(session), specimen.branchId)
  if (specimen.status !== "pending") throw new Error(`This specimen is already "${specimen.status}".`)

  const updated = await db.$transaction(async (tx) => {
    const result = await tx.specimen.update({
      where: { id: specimenId },
      data: { status: "collected", collectedBy: session.user.id, collectedAt: new Date() },
    })
    await tx.labOrderTest.updateMany({ where: { specimenId, status: "ordered" }, data: { status: "collected" } })
    return result
  })

  await auditFromSession(session, "update", "specimen", specimenId, { new: { status: "collected" } })
  return updated
}

const ORDER_INCLUDE = {
  patient: true,
  orderingProvider: true,
  labDetail: true,
  specimens: true,
  // P1 §21: current lines only — same "where: { isCurrent: true }" convention
  // ENCOUNTER_WORKSPACE_INCLUDE already uses for ClinicalNote, so an amended
  // result's superseded original never shows as a duplicate working row.
  // Full history (including superseded rows) is a separate, deliberate read
  // — getLabResultHistory (results.ts) — not this operational view.
  labOrderTests: { where: { isCurrent: true }, include: { labTest: true, labPanel: true, specimen: true } },
} as const

/**
 * The Lab Queue (spec.md §28): every doctor-placed lab ClinicalOrder not
 * yet fully completed.
 *
 * P3.5 §6/§8: `orderingProvider` and `branch` added so the queue can show
 * who ordered it and (for a multi-branch session) which branch — both
 * named in §6's own field list, previously missing entirely. This already
 * included every status from "ordered" onward (no separate "unassigned"
 * gap to close — a doctor-created order was never actually invisible
 * here, just not visually distinguished from an assigned one on the
 * queue page itself, fixed below).
 */
const LAB_QUEUE_PAGE_SIZE = 50

/**
 * P4.5 §46-49 originally capped this at a bare `take: 200` after load
 * testing found this page had by far the worst latency of any scenario
 * tested — but a fixed cap on a clinical operational queue silently hides
 * order 201+ with no way to reach them, which is not acceptable (targeted
 * backlog closure, item 2). Replaced with real server-side pagination,
 * matching the same `page`/`pageSize`/total/totalPages convention every
 * other paginated list in this codebase uses (see clinical/orders.ts's own
 * `listOrders` for the closest sibling shape). The root cause of the P4.5
 * latency finding was concurrency/queueing, not this query itself (measured
 * 76-267ms warm even unbounded) — see docs/PERFORMANCE_CAPACITY.md's Query
 * Profiling section — so paginating properly here costs nothing on that
 * front while fixing the real correctness gap a hard cap left open.
 */
export async function listLabQueue(session: SessionContext, filters: { status?: $Enums.ClinicalOrderStatus; page?: number } = {}) {
  assertCan(session, "lab_result.enter")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where = {
    organizationId: session.user.organizationId,
    orderType: "lab" as const,
    branchId: narrowBranchFilter(scope),
    status: filters.status ?? { not: "cancelled" as const },
  }
  const [orders, total] = await Promise.all([
    db.clinicalOrder.findMany({
      where,
      include: { patient: true, labDetail: true, labOrderTests: true, orderingProvider: true, branch: { select: { name: true } } },
      // Deterministic tiebreak — `orderedAt` alone can tie for orders placed
      // in the same batch/second, which would otherwise make page 2's top
      // row unstable across requests.
      orderBy: [{ orderedAt: "asc" }, { id: "asc" }],
      ...paginationSkipTake(page, LAB_QUEUE_PAGE_SIZE),
    }),
    db.clinicalOrder.count({ where }),
  ])
  return { orders, total, page, pageSize: LAB_QUEUE_PAGE_SIZE, totalPages: totalPages(total, LAB_QUEUE_PAGE_SIZE) }
}

/**
 * P3.5 §18/§19: previously gated on `lab_result.enter` alone (the lab-ops
 * permission), so the only real destination for "what did this test come
 * back as" — this exact page — was a dead end for the ordering Doctor, who
 * doesn't hold that permission. Broadened to also allow `patient.view` (the
 * same permission Patient 360's own Lab Results tab already trusts for
 * verified-result visibility) so the read-only side of this page has a real
 * destination to link to from the encounter. Every operational action on
 * the page (assign/collect/receive/reject/enter/verify) still requires its
 * own specific permission independently — this only widens who can *view*
 * the page, not who can act on it.
 */
export async function getLabOrder(session: SessionContext, id: string) {
  if (!can(session, "lab_result.enter") && !can(session, "patient.view")) throw new ForbiddenError("lab_result.enter")
  const order = await db.clinicalOrder.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId, orderType: "lab" },
    include: ORDER_INCLUDE,
  })
  assertBranchAccess(getAuthorizedBranchScope(session), order.branchId)
  return order
}

/**
 * Translates the doctor's free-text order intent (Phase 3's ClinicalOrder +
 * LabOrderDetail) into structured, catalog-priced, billable lines — the
 * point where lab staff decide exactly which test/panel codes actually run
 * (spec.md §28's "Lab Test Master"). Creates one Specimen for the whole
 * assignment (a single collection commonly services multiple tests), one
 * LabOrderTest per selected test (a panel expands into one row per member,
 * spec.md §28's structured-results requirement — a panel isn't one combined
 * result), and one Charge per line via the same `generateSystemCharge` used
 * for consultation/package charges — this IS the billable moment for a lab
 * test, the same reasoning already applied to EncounterCompleted in Phase 4.
 */
export async function assignTests(session: SessionContext, clinicalOrderId: string, input: AssignTestsInput) {
  assertCan(session, "lab_result.enter")

  const order = await db.clinicalOrder.findFirstOrThrow({
    where: { id: clinicalOrderId, organizationId: session.user.organizationId, orderType: "lab" },
  })
  // P3.5 §23: same branch-write gap fixed across every Lab/Radiology write
  // this batch touched — confirmed via direct code reading, not assumed:
  // this write path (and every other one in this file and radiology's own
  // orders.ts/results.ts) checked organization membership but never branch,
  // the same class of gap P3.3 already closed for encounter writes.
  assertBranchAccess(getAuthorizedBranchScope(session), order.branchId)
  // P1 §20: this is what actually moves the order to "in_progress" below —
  // validate it through the same centralized map updateOrderStatus uses,
  // so assigning tests against an already-completed or cancelled order
  // can't silently drag it back to in_progress.
  assertValidTransition(CLINICAL_ORDER_TRANSITIONS, order.status, "in_progress", "a clinical order")

  const testIds = input.lines.filter((l) => l.kind === "test").map((l) => l.id)
  const panelIds = input.lines.filter((l) => l.kind === "panel").map((l) => l.id)
  const [tests, panels] = await Promise.all([
    db.labTest.findMany({ where: { id: { in: testIds }, organizationId: session.user.organizationId } }),
    db.labPanel.findMany({
      where: { id: { in: panelIds }, organizationId: session.user.organizationId },
      include: { tests: { include: { labTest: true } } },
    }),
  ])

  const specimenNumber = await nextNumber({ organizationId: session.user.organizationId, sequenceType: "LAB", prefix: "SPC" })

  const result = await db.$transaction(async (tx) => {
    // P3.5 §27: the transition check above reads *before* this transaction —
    // two lab techs opening the same freshly-ordered order at once (or a
    // double-submit) would otherwise both pass it and both create their own
    // Specimen + LabOrderTest + Charge rows below, duplicating billable
    // charges for the same order. Claiming the order with a conditional
    // `updateMany` first (instead of the unconditional `update` this used to
    // end with) means only the caller who actually observes "ordered" gets
    // to proceed; a stale second caller gets `count: 0` and a friendly error
    // before creating anything.
    const { count } = await tx.clinicalOrder.updateMany({
      where: { id: order.id, status: order.status },
      data: { status: "in_progress" },
    })
    if (count === 0) throw new Error("This order has already been assigned by someone else — refresh to see its current state.")

    const specimen = await tx.specimen.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: order.branchId,
        clinicalOrderId: order.id,
        specimenNumber,
        specimenType: input.specimenType,
      },
    })

    const createdTests = []

    for (const test of tests) {
      const charge = await generateSystemCharge(tx, {
        organizationId: session.user.organizationId,
        branchId: order.branchId,
        patientId: order.patientId,
        encounterId: order.encounterId,
        providerId: order.orderingProviderId,
        sourceType: "lab",
        sourceReferenceId: order.id,
        description: test.name,
        quantity: 1,
        unitPrice: Number(test.price),
      })
      const line = await tx.labOrderTest.create({
        data: {
          organizationId: session.user.organizationId,
          clinicalOrderId: order.id,
          labTestId: test.id,
          specimenId: specimen.id,
          chargeId: charge.id,
          resultType: test.resultType,
        },
      })
      createdTests.push(line)
    }

    for (const panel of panels) {
      const charge = await generateSystemCharge(tx, {
        organizationId: session.user.organizationId,
        branchId: order.branchId,
        patientId: order.patientId,
        encounterId: order.encounterId,
        providerId: order.orderingProviderId,
        sourceType: "lab",
        sourceReferenceId: order.id,
        description: panel.name,
        quantity: 1,
        unitPrice: Number(panel.price),
      })
      // The panel's charge covers every member test — only the first member
      // line carries chargeId (charge_id is UNIQUE on lab_order_test), the
      // rest reference the same panel/specimen for grouped display without a
      // second, duplicate billing line.
      for (const [index, member] of panel.tests.entries()) {
        const line = await tx.labOrderTest.create({
          data: {
            organizationId: session.user.organizationId,
            clinicalOrderId: order.id,
            labTestId: member.labTestId,
            labPanelId: panel.id,
            specimenId: specimen.id,
            chargeId: index === 0 ? charge.id : null,
            resultType: member.labTest.resultType,
          },
        })
        createdTests.push(line)
      }
    }

    return { specimen, tests: createdTests }
  })

  await auditFromSession(session, "create", "specimen", result.specimen.id, {
    new: { clinicalOrderId: order.id, testCount: result.tests.length },
  })
  return result
}

export async function rejectSpecimen(session: SessionContext, specimenId: string, input: RejectSpecimenInput) {
  assertCan(session, "lab_result.enter")
  const existing = await db.specimen.findFirstOrThrow({ where: { id: specimenId, organizationId: session.user.organizationId } })
  assertBranchAccess(getAuthorizedBranchScope(session), existing.branchId)
  const updated = await db.specimen.update({
    where: { id: specimenId },
    data: { status: "rejected", rejectionReason: input.rejectionReason },
  })
  await auditFromSession(session, "update", "specimen", specimenId, { old: { status: existing.status }, new: { status: "rejected" } })
  return updated
}

export async function receiveSpecimen(session: SessionContext, specimenId: string) {
  assertCan(session, "lab_result.enter")
  // P3.5 §23: this previously updated by id alone — no organizationId
  // filter and no branch check at all (worse than the other write paths in
  // this file, which at least checked organizationId) — a session with
  // `lab_result.enter` could have marked *any* specimen in *any*
  // organization "received" by id. Scoped and branch-checked the same as
  // every other Lab/Radiology write this batch touched, and given a real
  // status guard (this had none before either).
  const existing = await db.specimen.findFirstOrThrow({ where: { id: specimenId, organizationId: session.user.organizationId } })
  assertBranchAccess(getAuthorizedBranchScope(session), existing.branchId)
  if (existing.status !== "collected") throw new Error(`Cannot receive a specimen with status "${existing.status}".`)
  const updated = await db.specimen.update({ where: { id: specimenId }, data: { status: "received" } })
  await auditFromSession(session, "update", "specimen", specimenId, { old: { status: existing.status }, new: { status: "received" } })
  return updated
}
