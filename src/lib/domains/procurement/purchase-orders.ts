import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { PurchaseOrderInput } from "@/lib/domains/procurement/schemas"

const PO_INCLUDE = {
  lines: { include: { product: true, goodsReceiptLines: true } },
  supplier: true,
  branch: true,
  purchaseRequest: true,
} as const

export async function createPurchaseOrder(session: SessionContext, input: PurchaseOrderInput) {
  assertCan(session, "purchase_order.create", { branchId: input.branchId })

  if (input.purchaseRequestId) {
    const pr = await db.purchaseRequest.findFirstOrThrow({
      where: { id: input.purchaseRequestId, organizationId: session.user.organizationId },
    })
    if (pr.status !== "approved") throw new Error("Only an approved purchase request can be converted to a purchase order.")
  }

  const created = await db.$transaction(async (tx) => {
    const poNumber = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "PO",
      prefix: "PO",
    })
    const po = await tx.purchaseOrder.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        poNumber,
        supplierId: input.supplierId,
        purchaseRequestId: input.purchaseRequestId ?? null,
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        notes: input.notes ?? null,
        createdBy: session.user.id,
        status: "issued",
        issuedAt: new Date(),
      },
    })
    await tx.purchaseOrderLine.createMany({
      data: input.lines.map((line) => ({
        purchaseOrderId: po.id,
        productId: line.productId,
        quantity: line.quantity,
        unitCost: new Decimal(line.unitCost),
      })),
    })
    if (input.purchaseRequestId) {
      await tx.purchaseRequest.update({ where: { id: input.purchaseRequestId }, data: { status: "converted" } })
    }
    return po
  })

  await auditFromSession(session, "create", "purchase_order", created.id, {
    new: { poNumber: created.poNumber, supplierId: input.supplierId, lineCount: input.lines.length },
  })
  return created
}

export async function getPurchaseOrder(session: SessionContext, id: string) {
  assertCan(session, "purchase_order.create")
  const po = await db.purchaseOrder.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: PO_INCLUDE,
  })
  assertBranchAccess(getAuthorizedBranchScope(session), po.branchId)
  return {
    ...po,
    lines: po.lines.map((line) => ({
      ...line,
      receivedQuantity: line.goodsReceiptLines.reduce((sum, grl) => sum + grl.quantityReceived, 0),
    })),
  }
}

export async function listPurchaseOrders(session: SessionContext, filters: { status?: string } = {}) {
  assertCan(session, "purchase_order.create")
  const scope = getAuthorizedBranchScope(session)
  return db.purchaseOrder.findMany({
    where: { organizationId: session.user.organizationId, status: filters.status as never, branchId: narrowBranchFilter(scope) },
    include: { supplier: true, branch: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
}

export async function cancelPurchaseOrder(session: SessionContext, id: string, reason: string) {
  assertCan(session, "purchase_order.create")
  const po = await db.purchaseOrder.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  assertBranchAccess(getAuthorizedBranchScope(session), po.branchId)
  if (po.status === "received") throw new Error("Cannot cancel a fully received purchase order.")

  const updated = await db.purchaseOrder.update({ where: { id }, data: { status: "cancelled", notes: reason } })
  await auditFromSession(session, "cancel", "purchase_order", id, { new: { status: "cancelled", reason } })
  return updated
}
