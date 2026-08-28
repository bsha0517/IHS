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
import type { AssignImagingServiceInput, ScheduleImagingInput } from "@/lib/domains/radiology/schemas"

const ORDER_INCLUDE = {
  patient: true,
  orderingProvider: true,
  imagingDetail: true,
  imagingOrder: { include: { imagingService: true, room: true } },
} as const

/** The Radiology Queue (spec.md §30): every doctor-placed imaging ClinicalOrder not yet fully completed. */
export async function listRadiologyQueue(session: SessionContext) {
  assertCan(session, "imaging_order.perform")
  const scope = getAuthorizedBranchScope(session)
  return db.clinicalOrder.findMany({
    where: {
      organizationId: session.user.organizationId,
      orderType: "imaging",
      status: { not: "cancelled" },
      branchId: narrowBranchFilter(scope),
    },
    include: { patient: true, imagingDetail: true, imagingOrder: { include: { imagingService: true } } },
    orderBy: { orderedAt: "asc" },
  })
}

export async function getRadiologyOrder(session: SessionContext, id: string) {
  assertCan(session, "imaging_order.perform")
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
  // P1 §20: same centralized guard as laboratory's assignTests — this is
  // what actually moves the order to "in_progress" below.
  assertValidTransition(CLINICAL_ORDER_TRANSITIONS, order.status, "in_progress", "a clinical order")
  const service = await db.imagingService.findFirstOrThrow({
    where: { id: input.imagingServiceId, organizationId: session.user.organizationId },
  })

  const accessionNumber = await nextNumber({ organizationId: session.user.organizationId, sequenceType: "RAD", prefix: "ACC" })

  const created = await db.$transaction(async (tx) => {
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
    await tx.clinicalOrder.update({ where: { id: order.id }, data: { status: "in_progress" } })
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

  const order = await db.imagingOrder.findFirstOrThrow({ where: { id: imagingOrderId, organizationId: session.user.organizationId } })
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

  const order = await db.imagingOrder.findFirstOrThrow({ where: { id: imagingOrderId, organizationId: session.user.organizationId } })
  if (order.status !== "scheduled") throw new Error(`Only a scheduled order can be marked performed (this one is "${order.status}").`)

  const updated = await db.imagingOrder.update({
    where: { id: imagingOrderId },
    data: { status: "performed", performedBy: session.user.id, performedAt: new Date() },
  })
  await auditFromSession(session, "update", "imaging_order", imagingOrderId, { new: { status: "performed" } })
  return updated
}
