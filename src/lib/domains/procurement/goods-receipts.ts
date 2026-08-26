import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { receiveStock } from "@/lib/domains/inventory/stock"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"
import type { GoodsReceiptInput } from "@/lib/domains/procurement/schemas"

/**
 * Completing a receipt creates the ProductBatch rows and `purchase`
 * StockLedgerEntry rows in the same transaction (spec.md §46: "goods receipt
 * should create inventory movements"), then recalculates the parent
 * PurchaseOrder's status from the total received-vs-ordered per line —
 * `partially_received` vs `received` is always derived, never a separate
 * flag that could drift from the underlying receipt lines. Supports partial
 * receiving by design: a PO can have multiple GoodsReceipts against it.
 */
export async function createGoodsReceipt(session: SessionContext, input: GoodsReceiptInput) {
  assertCan(session, "goods_receipt.create")

  const po = await db.purchaseOrder.findFirstOrThrow({
    where: { id: input.purchaseOrderId, organizationId: session.user.organizationId },
    include: { lines: { include: { goodsReceiptLines: true } } },
  })
  if (po.status === "cancelled") throw new Error("Cannot receive against a cancelled purchase order.")

  const receipt = await db.$transaction(async (tx) => {
    const receiptNumber = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "GR",
      prefix: "GR",
    })
    const gr = await tx.goodsReceipt.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: po.branchId,
        receiptNumber,
        purchaseOrderId: po.id,
        supplierId: po.supplierId,
        notes: input.notes ?? null,
        receivedBy: session.user.id,
      },
    })

    for (const line of input.lines) {
      await tx.goodsReceiptLine.create({
        data: {
          goodsReceiptId: gr.id,
          purchaseOrderLineId: line.purchaseOrderLineId,
          productId: line.productId,
          batchNumber: line.batchNumber,
          manufacturingDate: line.manufacturingDate ?? null,
          expiryDate: line.expiryDate ?? null,
          quantityReceived: line.quantityReceived,
          unitCost: new Decimal(line.unitCost),
        },
      })
      await receiveStock(tx, {
        organizationId: session.user.organizationId,
        branchId: po.branchId,
        productId: line.productId,
        supplierId: po.supplierId,
        batchNumber: line.batchNumber,
        manufacturingDate: line.manufacturingDate,
        expiryDate: line.expiryDate,
        purchaseCost: line.unitCost,
        quantity: line.quantityReceived,
        referenceType: "goods_receipt",
        referenceId: gr.id,
        performedBy: session.user.id,
      })
    }

    // Recompute PO status from every line's total received quantity across all receipts.
    const freshLines = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: po.id },
      include: { goodsReceiptLines: true },
    })
    const allReceived = freshLines.every(
      (l) => l.goodsReceiptLines.reduce((sum, grl) => sum + grl.quantityReceived, 0) >= l.quantity
    )
    const anyReceived = freshLines.some((l) => l.goodsReceiptLines.length > 0)
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: { status: allReceived ? "received" : anyReceived ? "partially_received" : po.status },
    })

    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "GoodsReceiptCompleted",
      payload: { goodsReceiptId: gr.id },
    })

    return gr
  })

  await auditFromSession(session, "create", "goods_receipt", receipt.id, {
    new: { receiptNumber: receipt.receiptNumber, purchaseOrderId: po.id, lineCount: input.lines.length },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return receipt
}

export async function getGoodsReceipt(session: SessionContext, id: string) {
  assertCan(session, "goods_receipt.create")
  return db.goodsReceipt.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { lines: { include: { product: true } }, supplier: true, purchaseOrder: true, branch: true },
  })
}

export async function listGoodsReceipts(session: SessionContext, filters: { purchaseOrderId?: string } = {}) {
  assertCan(session, "goods_receipt.create")
  return db.goodsReceipt.findMany({
    where: { organizationId: session.user.organizationId, purchaseOrderId: filters.purchaseOrderId },
    include: { supplier: true, purchaseOrder: true },
    orderBy: { receivedAt: "desc" },
    take: 100,
  })
}
