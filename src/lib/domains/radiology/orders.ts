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
import type { AssignImagingServiceInput, ScheduleImagingInput } from "@/lib/domains/radiology/schemas"

const ORDER_INCLUDE = {
  patient: true,
  orderingProvider: true,
  imagingDetail: true,
  imagingOrder: {
    include: {
      imagingService: true,
      room: true,
      // Targeted backlog closure, item 7: the amendment history, oldest
      // first — the page derives "current" as the latest of these (if any)
      // else the ImagingOrder's own original fields, and renders the rest
      // as accessible history. Small, bounded (amendments are rare), no
      // separate round trip.
      amendments: { orderBy: { amendedAt: "asc" }, include: { amendedByUser: { select: { firstName: true, lastName: true } } } },
    },
  },
} as const

/**
 * The Radiology Queue (spec.md §30): every doctor-placed imaging
 * ClinicalOrder not yet fully completed.
 *
 * P3.5 §7/§8: `orderingProvider`, `branch`, and the assigned service's
 * `category` (modality) added — all named in §7's own field list. Filters
 * already covered every status from "ordered" onward — same reasoning as
 * laboratory's own `listLabQueue`.
 */
const RADIOLOGY_QUEUE_PAGE_SIZE = 50

/**
 * P4.5 §46-49 originally capped this at a bare `take: 200` after load
 * testing found this page had among the worst latency of any scenario
 * tested — but a fixed cap on a clinical operational queue silently hides
 * order 201+ with no way to reach them, which is not acceptable (targeted
 * backlog closure, item 2). Replaced with real server-side pagination, same
 * convention as laboratory's own `listLabQueue` (and clinical/orders.ts's
 * `listOrders`). The root cause of the P4.5 latency finding was
 * concurrency/queueing, not this query itself (measured 76-267ms warm even
 * unbounded on the lab equivalent) — see docs/PERFORMANCE_CAPACITY.md's
 * Query Profiling section — so paginating properly here costs nothing on
 * that front while fixing the real correctness gap a hard cap left open.
 */
export async function listRadiologyQueue(session: SessionContext, filters: { status?: $Enums.ClinicalOrderStatus; page?: number } = {}) {
  assertCan(session, "imaging_order.perform")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where = {
    organizationId: session.user.organizationId,
    orderType: "imaging" as const,
    status: filters.status ?? { not: "cancelled" as const },
    branchId: narrowBranchFilter(scope),
  }
  const [orders, total] = await Promise.all([
    db.clinicalOrder.findMany({
      where,
      include: {
        patient: true,
        imagingDetail: true,
        imagingOrder: { include: { imagingService: true } },
        orderingProvider: true,
        branch: { select: { name: true } },
      },
      // Deterministic tiebreak — see listLabQueue's identical comment.
      orderBy: [{ orderedAt: "asc" }, { id: "asc" }],
      ...paginationSkipTake(page, RADIOLOGY_QUEUE_PAGE_SIZE),
    }),
    db.clinicalOrder.count({ where }),
  ])
  return { orders, total, page, pageSize: RADIOLOGY_QUEUE_PAGE_SIZE, totalPages: totalPages(total, RADIOLOGY_QUEUE_PAGE_SIZE) }
}

/**
 * P3.5 §18/§19: same widening as laboratory's `getLabOrder` — see that
 * function's comment for the full reasoning. Every operational action on
 * the page still requires its own specific permission independently.
 */
export async function getRadiologyOrder(session: SessionContext, id: string) {
  if (!can(session, "imaging_order.perform") && !can(session, "patient.view")) throw new ForbiddenError("imaging_order.perform")
  const order = await db.clinicalOrder.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId, orderType: "imaging" },
    include: ORDER_INCLUDE,
  })
  assertBranchAccess(getAuthorizedBranchScope(session), order.branchId)
  return order
}

/**
 * Translates the doctor's free-text order intent (Phase 3's ClinicalOrder +
 * ImagingOrderDetail) into a structured, catalog-priced, billable
 * ImagingOrder (spec.md §30's "Imaging Service Master") — the same
 * doctor-intent-vs-structured-execution moment Phase 8/9 already established
 * for lab/pharmacy. Unlike lab, exactly one ImagingService is assigned per
 * order (clinicalOrderId is ImagingOrder's own @id), and billing happens
 * here, at assignment time — the same reasoning as `assignTests`.
 */
export async function assignImagingService(session: SessionContext, clinicalOrderId: string, input: AssignImagingServiceInput) {
  assertCan(session, "imaging_order.perform")

  const order = await db.clinicalOrder.findFirstOrThrow({
    where: { id: clinicalOrderId, organizationId: session.user.organizationId, orderType: "imaging" },
  })
  // P3.5 §23: same branch-write gap fixed across every Lab/Radiology write
  // this batch touched — see laboratory/orders.ts's own `assignTests`
  // comment for the full reasoning.
  assertBranchAccess(getAuthorizedBranchScope(session), order.branchId)
  // P1 §20: same centralized guard as laboratory's assignTests — this is
  // what actually moves the order to "in_progress" below.
  assertValidTransition(CLINICAL_ORDER_TRANSITIONS, order.status, "in_progress", "a clinical order")
  const service = await db.imagingService.findFirstOrThrow({
    where: { id: input.imagingServiceId, organizationId: session.user.organizationId },
  })

  const accessionNumber = await nextNumber({ organizationId: session.user.organizationId, sequenceType: "RAD", prefix: "ACC" })

  const created = await db.$transaction(async (tx) => {
    // P3.5 §27/§34: same race guarded against as laboratory's own
    // `assignTests` — see that function's comment for the full reasoning.
    // Unlike lab, ImagingOrder's `clinicalOrderId` is itself the primary
    // key (a hard 1:1 with ClinicalOrder), so a genuine duplicate
    // ImagingOrder row is already impossible — the loser's `create` below
    // would hit a unique-constraint violation and the whole transaction
    // would roll back either way. But without this guard that violation
    // surfaces to the loser as a raw Prisma/Postgres error (the exact thing
    // §34 asks to avoid), and would still burn an accession number and
    // attempt a charge first. Claiming the transition here first gives a
    // friendly "already assigned" error instead.
    const { count } = await tx.clinicalOrder.updateMany({
      where: { id: order.id, status: order.status },
      data: { status: "in_progress" },
    })
    if (count === 0) throw new Error("This order has already been assigned by someone else — refresh to see its current state.")

    const charge = await generateSystemCharge(tx, {
      organizationId: session.user.organizationId,
      branchId: order.branchId,
      patientId: order.patientId,
      encounterId: order.encounterId,
      providerId: order.orderingProviderId,
      sourceType: "imaging",
      sourceReferenceId: order.id,
      description: service.name,
      quantity: 1,
      unitPrice: Number(service.price),
    })
    const imagingOrder = await tx.imagingOrder.create({
      data: {
        organizationId: session.user.organizationId,
        clinicalOrderId: order.id,
        imagingServiceId: service.id,
        accessionNumber,
        chargeId: charge.id,
      },
    })
    return imagingOrder
  })

  await auditFromSession(session, "create", "imaging_order", created.id, {
    new: { clinicalOrderId: order.id, imagingServiceId: service.id, accessionNumber },
  })
  return created
}

/** "Scheduling" (spec.md §30) — assigns a date/time and optional room. Informational, not a hard double-booking constraint (see PROJECT_STATUS.md's Phase 10 Known Issues). */
export async function scheduleImaging(session: SessionContext, imagingOrderId: string, input: ScheduleImagingInput) {
  assertCan(session, "imaging_order.perform")

  const order = await db.imagingOrder.findFirstOrThrow({
    where: { id: imagingOrderId, organizationId: session.user.organizationId },
    // ImagingOrder has no branchId of its own — goes through its parent
    // ClinicalOrder, the same pattern lab's LabOrderTest write paths use.
    include: { clinicalOrder: { select: { branchId: true } } },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), order.clinicalOrder.branchId)
  if (order.status !== "ordered" && order.status !== "scheduled") {
    throw new Error(`Cannot (re)schedule an order that is already "${order.status}".`)
  }

  const updated = await db.imagingOrder.update({
    where: { id: imagingOrderId },
    data: { status: "scheduled", scheduledAt: input.scheduledAt, roomId: input.roomId ?? null },
  })
  await auditFromSession(session, "update", "imaging_order", imagingOrderId, { new: { status: "scheduled", scheduledAt: input.scheduledAt } })
  return updated
}

/** "Imaging Performed" (spec.md §30) — the technologist marking the study as physically done. */
export async function markPerformed(session: SessionContext, imagingOrderId: string) {
  assertCan(session, "imaging_order.perform")

  const order = await db.imagingOrder.findFirstOrThrow({
    where: { id: imagingOrderId, organizationId: session.user.organizationId },
    include: { clinicalOrder: { select: { branchId: true } } },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), order.clinicalOrder.branchId)
  if (order.status !== "scheduled") throw new Error(`Only a scheduled order can be marked performed (this one is "${order.status}").`)

  const updated = await db.imagingOrder.update({
    where: { id: imagingOrderId },
    data: { status: "performed", performedBy: session.user.id, performedAt: new Date() },
  })
  await auditFromSession(session, "update", "imaging_order", imagingOrderId, { new: { status: "performed" } })
  return updated
}
