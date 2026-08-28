import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { assertValidTransition } from "@/lib/platform/state-machine"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"
import type { ClinicalOrderInput } from "@/lib/domains/clinical/schemas"

/** spec.md §7 names `lab_order.create` distinctly; every other CPOE type shares `order.create`. */
function permissionFor(orderType: ClinicalOrderInput["orderType"]): string {
  return orderType === "lab" ? "lab_order.create" : "order.create"
}

/**
 * P1 §20: the outer ClinicalOrder lifecycle's centralized transition map —
 * ORDERED -> ... -> COMPLETED, never an arbitrary skip like ORDERED ->
 * COMPLETED directly (P1's own named example). `draft` and `acknowledged`
 * are real enum values with no current UI path that sets them (every order
 * today is born "ordered", and no explicit "acknowledge" action exists yet)
 * — still included as valid waypoints so a future caller isn't blocked by
 * this map, not because anything currently produces them. `completed` and
 * `cancelled` are terminal: a completed order is corrected via its own
 * result's amendment path (P1 §21), never re-opened; a cancelled order stays
 * cancelled (re-ordering is a new ClinicalOrder, not a resurrection of this
 * one).
 */
export const CLINICAL_ORDER_TRANSITIONS: Readonly<Record<$Enums.ClinicalOrderStatus, readonly $Enums.ClinicalOrderStatus[]>> = {
  draft: ["ordered", "cancelled"],
  ordered: ["acknowledged", "in_progress", "cancelled"],
  acknowledged: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
}

export async function createOrder(session: SessionContext, encounterId: string, input: ClinicalOrderInput) {
  assertCan(session, permissionFor(input.orderType))

  const encounter = await db.encounter.findFirstOrThrow({
    where: { id: encounterId, organizationId: session.user.organizationId },
  })

  if (input.orderType === "lab" && !input.testName) {
    throw new Error("A test name is required for a laboratory order.")
  }
  if (input.orderType === "imaging" && !input.imagingType) {
    throw new Error("An imaging type is required for an imaging order.")
  }
  if (input.orderType === "procedure" && !input.procedureName) {
    throw new Error("A procedure name is required for a procedure order.")
  }
  if (input.orderType === "referral" && !input.referralScope) {
    throw new Error("A referral scope (internal/external) is required for a referral order.")
  }

  const order = await db.$transaction(async (tx) => {
    const orderNumber = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "ORD",
      prefix: "ORD",
    })

    const created = await tx.clinicalOrder.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: encounter.branchId,
        patientId: encounter.patientId,
        encounterId,
        orderNumber,
        orderType: input.orderType,
        priority: input.priority,
        instructions: input.instructions ?? null,
        status: "ordered",
        orderingProviderId: encounter.providerId,
        createdBy: session.user.id,
      },
    })

    switch (input.orderType) {
      case "lab":
        await tx.labOrderDetail.create({
          data: {
            clinicalOrderId: created.id,
            testName: input.testName!,
            specimenType: input.specimenType ?? null,
            clinicalNotes: input.reason ?? null,
          },
        })
        break
      case "imaging":
        await tx.imagingOrderDetail.create({
          data: {
            clinicalOrderId: created.id,
            imagingType: input.imagingType!,
            bodyPart: input.bodyPart ?? null,
            clinicalNotes: input.reason ?? null,
          },
        })
        break
      case "procedure":
        await tx.procedureOrderDetail.create({
          data: { clinicalOrderId: created.id, procedureName: input.procedureName!, notes: input.reason ?? null },
        })
        break
      case "referral":
        await tx.referralOrderDetail.create({
          data: {
            clinicalOrderId: created.id,
            referralScope: input.referralScope!,
            referredToProviderId: input.referredToProviderId ?? null,
            referredToExternal: input.referredToExternal ?? null,
            reason: input.reason ?? null,
          },
        })
        break
      case "other":
        break
    }

    return created
  })

  await auditFromSession(session, "create", "clinical_order", order.id, {
    new: { orderNumber: order.orderNumber, orderType: order.orderType },
  })

  return order
}

/**
 * P1 §20: validated through the same CLINICAL_ORDER_TRANSITIONS map every
 * other status-changing path (assignTests, assignImagingService, cancelOrder)
 * goes through — this used to accept any of its four target statuses with no
 * check against the order's current status at all, meaning a caller could
 * move a `completed` or `cancelled` order back to `acknowledged`/`in_progress`,
 * or jump `ordered` straight to `completed` bypassing acknowledgement/
 * progress entirely (P1's own named "ORDERED -> FINALIZED" example). Does
 * NOT handle `cancelled` — that always needs a reason, so it goes through
 * the dedicated `cancelOrder` below instead of this generic setter.
 */
export async function updateOrderStatus(
  session: SessionContext,
  orderId: string,
  status: "acknowledged" | "in_progress" | "completed"
) {
  const order = await db.clinicalOrder.findFirstOrThrow({
    where: { id: orderId, organizationId: session.user.organizationId },
  })
  assertCan(session, permissionFor(order.orderType))
  assertValidTransition(CLINICAL_ORDER_TRANSITIONS, order.status, status, "a clinical order")

  // P1 §33 (procedure completion): a plain `update({ where: { id } })` had no
  // precondition on the row's current status — a double-clicked "mark
  // completed" would both read the same stale status, both pass the
  // transition check above, and both write, though harmlessly here (no
  // charge/stock side effect fires off this transition, unlike
  // dispenseRecord/consumeSession). `updateMany` with the status still
  // matching what was just validated makes the second write a clean no-op
  // failure instead of a silent double-apply, the same "claim before acting"
  // shape used everywhere else in this pass.
  const claimed = await db.clinicalOrder.updateMany({ where: { id: orderId, status: order.status }, data: { status } })
  if (claimed.count === 0) {
    throw new Error(`This order's status changed before this update could apply — refresh and try again.`)
  }
  const updated = await db.clinicalOrder.findUniqueOrThrow({ where: { id: orderId } })
  await auditFromSession(session, "update", "clinical_order", orderId, { old: order, new: updated })
  return updated
}

/** P1 §24: Clinical Order cancellation — always captures a reason (user/timestamp come from the audit log). */
export async function cancelOrder(session: SessionContext, orderId: string, reason: string) {
  const order = await db.clinicalOrder.findFirstOrThrow({
    where: { id: orderId, organizationId: session.user.organizationId },
  })
  assertCan(session, permissionFor(order.orderType))
  assertValidTransition(CLINICAL_ORDER_TRANSITIONS, order.status, "cancelled", "a clinical order")

  const updated = await db.clinicalOrder.update({ where: { id: orderId }, data: { status: "cancelled", cancelReason: reason } })
  await auditFromSession(session, "cancel", "clinical_order", orderId, { old: { status: order.status }, new: { status: "cancelled", reason } })
  return updated
}

export async function listPatientOrders(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  const scope = getAuthorizedBranchScope(session)
  return db.clinicalOrder.findMany({
    where: { organizationId: session.user.organizationId, patientId, branchId: narrowBranchFilter(scope) },
    include: {
      labDetail: true,
      imagingDetail: true,
      procedureDetail: true,
      referralDetail: { include: { referredToProvider: true } },
      orderingProvider: true,
    },
    orderBy: { orderedAt: "desc" },
  })
}
