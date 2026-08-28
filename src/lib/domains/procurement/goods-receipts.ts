import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { receiveStock } from "@/lib/domains/inventory/stock"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { claimIdempotencyKey, recordIdempotentResult, resolveDuplicateRequest, isIdempotencyKeyConflict } from "@/lib/platform/idempotency"
import type { SessionContext } from "@/lib/auth/session"
import type { GoodsReceiptInput } from "@/lib/domains/procurement/schemas"

const IDEMPOTENCY_SCOPE = "goods_receipt.create"

/**
 * Completing a receipt creates the ProductBatch rows and `purchase`
 * StockLedgerEntry rows in the same transaction (spec.md §46: "goods receipt
 * should create inventory movements"), then recalculates the parent
 * PurchaseOrder's status from the total received-vs-ordered per line —
 * `partially_received` vs `received` is always derived, never a separate
 * flag that could drift from the underlying receipt lines. Supports partial
 * receiving by design: a PO can have multiple GoodsReceipts against it.
 *
 * P1 §16: rejects any line whose cumulative received quantity (every prior
 * GoodsReceiptLine against that PurchaseOrderLine, plus this one) would
 * exceed the PurchaseOrderLine's ordered quantity, unless the caller passed
 * `allowOverReceipt` — see goodsReceiptSchema's doc comment for why that's
 * a receipt-level override rather than a blanket unconditional block.
 *
 * P1 §33 (finding B8): `idempotencyKey`, when the caller supplies one (the
 * UI generates one per dialog-open — see the goods-receipt-dialog client
 * component), makes a double-submitted request (double-click, network
 * retry) return the SAME receipt instead of creating a second full
 * physical-receipt record — previously every call unconditionally created a
 * new GoodsReceipt + stock entries + a real posted journal, with no
 * duplicate-detection of any kind. See platform/idempotency.ts.
 */
export async function createGoodsReceipt(session: SessionContext, input: GoodsReceiptInput & { idempotencyKey?: string }) {
  assertCan(session, "goods_receipt.create")

  const po = await db.purchaseOrder.findFirstOrThrow({
    where: { id: input.purchaseOrderId, organizationId: session.user.organizationId },
    include: { lines: { include: { goodsReceiptLines: true } } },
  })
  if (po.status === "cancelled") throw new Error("Cannot receive against a cancelled purchase order.")

  if (!input.allowOverReceipt) {
    for (const line of input.lines) {
      const poLine = po.lines.find((l) => l.id === line.purchaseOrderLineId)
      if (!poLine) throw new Error("One of these lines doesn't belong to this purchase order.")
      const alreadyReceived = poLine.goodsReceiptLines.reduce((sum, grl) => sum + grl.quantityReceived, 0)
      if (alreadyReceived + line.quantityReceived > poLine.quantity) {
        throw new Error(
          `Receiving ${line.quantityReceived} would exceed the ordered quantity for this line (ordered ${poLine.quantity}, already received ${alreadyReceived}). Check "Allow over-receipt" to authorize it explicitly.`
        )
      }
    }
  }

  let receipt
  try {
    receipt = await db.$transaction(async (tx) => {
      if (input.idempotencyKey) {
        await claimIdempotencyKey(tx, { organizationId: session.user.organizationId, scope: IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
      }

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

      if (input.idempotencyKey) {
        await recordIdempotentResult(tx, { organizationId: session.user.organizationId, scope: IDEMPOTENCY_SCOPE, key: input.idempotencyKey, resultId: gr.id })
      }

      return gr
    }, { timeout: 20_000, maxWait: 10_000 }) // widened for the same reason posting-service.ts's POSTING_TRANSACTION_OPTIONS is — one receiveStock() call per line (each its own batch create + stock-ledger create) plus the PO status recompute query add up under this environment's real Supabase pooler latency, and a real P1 Batch 6 full-suite run caught this exact transaction genuinely exceeding Prisma's 5000ms default
  } catch (error) {
    if (input.idempotencyKey && isIdempotencyKeyConflict(error)) {
      const resultId = await resolveDuplicateRequest({ organizationId: session.user.organizationId, scope: IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
      return getGoodsReceipt(session, resultId) // idempotent replay — the original request's own result, not a new receipt
    }
    throw error
  }

  await auditFromSession(session, "create", "goods_receipt", receipt.id, {
    new: { receiptNumber: receipt.receiptNumber, purchaseOrderId: po.id, lineCount: input.lines.length, allowOverReceipt: input.allowOverReceipt },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return receipt
}

export async function getGoodsReceipt(session: SessionContext, id: string) {
  assertCan(session, "goods_receipt.create")
  const receipt = await db.goodsReceipt.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { lines: { include: { product: true } }, supplier: true, purchaseOrder: true, branch: true },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), receipt.branchId)
  return receipt
}

export async function listGoodsReceipts(session: SessionContext, filters: { purchaseOrderId?: string } = {}) {
  assertCan(session, "goods_receipt.create")
  const scope = getAuthorizedBranchScope(session)
  return db.goodsReceipt.findMany({
    where: { organizationId: session.user.organizationId, purchaseOrderId: filters.purchaseOrderId, branchId: narrowBranchFilter(scope) },
    include: { supplier: true, purchaseOrder: true },
    orderBy: { receivedAt: "desc" },
    take: 100,
  })
}
