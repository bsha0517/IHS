import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import type { SessionContext } from "@/lib/auth/session"
import type { ClinicalOrderInput } from "@/lib/domains/clinical/schemas"

/** spec.md §7 names `lab_order.create` distinctly; every other CPOE type shares `order.create`. */
function permissionFor(orderType: ClinicalOrderInput["orderType"]): string {
  return orderType === "lab" ? "lab_order.create" : "order.create"
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

export async function updateOrderStatus(
  session: SessionContext,
  orderId: string,
  status: "acknowledged" | "in_progress" | "completed" | "cancelled"
) {
  const order = await db.clinicalOrder.findFirstOrThrow({
    where: { id: orderId, organizationId: session.user.organizationId },
  })
  assertCan(session, permissionFor(order.orderType))

  const updated = await db.clinicalOrder.update({ where: { id: orderId }, data: { status } })
  await auditFromSession(session, "update", "clinical_order", orderId, { old: order, new: updated })
  return updated
}

export async function listPatientOrders(session: SessionContext, patientId: string) {
  assertCan(session, "encounter.view")
  return db.clinicalOrder.findMany({
    where: { organizationId: session.user.organizationId, patientId },
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
