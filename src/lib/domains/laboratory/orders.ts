import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { assertValidTransition } from "@/lib/platform/state-machine"
import { CLINICAL_ORDER_TRANSITIONS } from "@/lib/domains/clinical/orders"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
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

/** The Lab Queue (spec.md §28): every doctor-placed lab ClinicalOrder not yet fully completed. */
export async function listLabQueue(session: SessionContext, filters: { status?: string } = {}) {
  assertCan(session, "lab_result.enter")
  const scope = getAuthorizedBranchScope(session)
  return db.clinicalOrder.findMany({
    where: {
      organizationId: session.user.organizationId,
      orderType: "lab",
      branchId: narrowBranchFilter(scope),
      status: filters.status ? (filters.status as never) : { not: "cancelled" },
    },
    include: { patient: true, labDetail: true, labOrderTests: true },
    orderBy: { orderedAt: "asc" },
  })
}

export async function getLabOrder(session: SessionContext, id: string) {
  assertCan(session, "lab_result.enter")
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

    await tx.clinicalOrder.update({ where: { id: order.id }, data: { status: "in_progress" } })

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
  const updated = await db.specimen.update({
    where: { id: specimenId },
    data: { status: "rejected", rejectionReason: input.rejectionReason },
  })
  await auditFromSession(session, "update", "specimen", specimenId, { old: { status: existing.status }, new: { status: "rejected" } })
  return updated
}

export async function receiveSpecimen(session: SessionContext, specimenId: string) {
  assertCan(session, "lab_result.enter")
  const updated = await db.specimen.update({ where: { id: specimenId }, data: { status: "received" } })
  await auditFromSession(session, "update", "specimen", specimenId, { new: { status: "received" } })
  return updated
}
