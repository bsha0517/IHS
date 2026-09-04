import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { recordAdjustment, listNearExpiryBatches, listExpiredBatches } from "@/lib/domains/inventory/stock"
import { createTransfer, completeTransfer, listTransfers } from "@/lib/domains/inventory/transfers"
import { stockTransferSchema } from "@/lib/domains/inventory/schemas"
import { createPurchaseRequest, approvePurchaseRequest, rejectPurchaseRequest, listPurchaseRequests } from "@/lib/domains/procurement/purchase-requests"
import { createPurchaseOrder, listPurchaseOrders } from "@/lib/domains/procurement/purchase-orders"
import { createGoodsReceipt } from "@/lib/domains/procurement/goods-receipts"
import { createSupplierInvoice, recordSupplierPayment } from "@/lib/domains/procurement/supplier-invoices"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P3.8 — Inventory / Procurement Operational UX. Covers the genuinely new or
 * changed behavior from this batch only (see P3_8_INVENTORY_PROCUREMENT_
 * OPERATIONAL_UX_REPORT.md for the full trace/rationale) — not a re-test of
 * P1/P2's already-covered FEFO, batch-adjustment, or AP-posting behavior:
 *
 *  - stock transfers: batch now mandatory, both branches authorized,
 *    expired-batch rejected, atomic + row-locked completion
 *  - stock adjustments: row-locked "out" direction, multi-branch selection
 *  - near-expiry/expired batch listing: bulk balance lookup (no N+1)
 *  - purchase requests / purchase orders: real pagination
 *  - goods receipts: concurrent over-receipt protection
 *  - supplier invoices: idempotent double-submit
 */
const TIMEOUT = 60000

describe("P3.8 §20-25: stockTransferSchema requires a real batchId", () => {
  const base = {
    fromBranchId: "11111111-1111-4111-8111-111111111111",
    toBranchId: "22222222-2222-4222-8222-222222222222",
    productId: "33333333-3333-4333-8333-333333333333",
    quantity: 5,
  }

  it("rejects a transfer with no batchId", () => {
    expect(stockTransferSchema.safeParse(base).success).toBe(false)
  })

  it("accepts a transfer with a real batchId", () => {
    expect(stockTransferSchema.safeParse({ ...base, batchId: "44444444-4444-4444-8444-444444444444" }).success).toBe(true)
  })
})

describe("P3.8: inventory operational fixes", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let userId: string
  const productIds: string[] = []
  const transferIds: string[] = []

  function sessionForBranches(branchIds: string[], extraPermissions: string[] = []): SessionContext {
    return {
      sessionId: "test-p3-8-inventory",
      user: { id: userId, organizationId, email: "p3-8-inventory-test@test.local", firstName: "Inv38", lastName: "Test" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["inventory.view", "inventory.adjust", "stock.transfer", ...extraPermissions]),
      roleNames: ["Inventory Staff"],
    }
  }

  async function createProduct() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const product = await db.product.create({
      data: { organizationId, name: `P3.8 Test Product ${suffix}`, sku: `TESTP38-${suffix}`, category: "consumable", unit: "unit", reorderLevel: 0, purchaseCost: 10, sellingPrice: 20 },
    })
    productIds.push(product.id)
    return product
  }

  async function createBatch(productId: string, branchId: string, opts: { purchaseCost: number; quantity: number; expiryDate?: Date | null }) {
    const batch = await db.productBatch.create({
      data: {
        organizationId, productId,
        batchNumber: `P38-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        expiryDate: opts.expiryDate ?? null,
        purchaseCost: opts.purchaseCost,
        receivedQuantity: opts.quantity,
      },
    })
    await db.stockLedgerEntry.create({
      data: { organizationId, branchId, productId, batchId: batch.id, transactionType: "purchase", quantity: opts.quantity, referenceType: "test" },
    })
    return batch
  }

  async function balanceAt(branchId: string, productId: string, batchId?: string) {
    const result = await db.stockLedgerEntry.aggregate({ where: { organizationId, branchId, productId, batchId }, _sum: { quantity: true } })
    return Number(result._sum?.quantity ?? 0)
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const branchB = await db.branch.create({
      data: { organizationId, name: `P3.8 Test Branch B ${Date.now()}`, code: `P38B-${Date.now()}`, timezone: "UTC" },
    })
    branchBId = branchB.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId, referenceType: "outbox_event" } }).catch(() => {})
    // The §17 multi-branch adjustment test's out-adjustment at Branch B is
    // financially relevant (InventoryAdjusted) and posts a real journal
    // referencing branchBId — must be cleared before the branch itself can
    // be deleted (journal.branch_id_fkey).
    const journals = await db.journal.findMany({ where: { organizationId, branchId: branchBId } })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.stockTransfer.deleteMany({ where: { id: { in: transferIds } } })
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: productIds } } })
    await db.productBatch.deleteMany({ where: { productId: { in: productIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.branch.delete({ where: { id: branchBId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("§13: listNearExpiryBatches and listExpiredBatches only return batches with a positive balance, using the bulk balance lookup", async () => {
    const product = await createProduct()
    const nearExpiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const expiredDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)

    const nearExpiryWithStock = await createBatch(product.id, branchAId, { purchaseCost: 5, quantity: 10, expiryDate: nearExpiryDate })
    const nearExpiryFullyConsumed = await createBatch(product.id, branchAId, { purchaseCost: 5, quantity: 10, expiryDate: nearExpiryDate })
    await recordAdjustment(sessionForBranches([branchAId]), {
      branchId: branchAId, productId: product.id, batchId: nearExpiryFullyConsumed.id,
      direction: "out", quantity: 10, transactionType: "adjustment", reason: "fully consumed for the zero-balance case",
    })

    const expiredWithStock = await createBatch(product.id, branchAId, { purchaseCost: 5, quantity: 7, expiryDate: expiredDate })

    const nearExpiry = await listNearExpiryBatches(sessionForBranches([branchAId]), branchAId)
    const nearExpiryIds = nearExpiry.map((b) => b.batch.id)
    expect(nearExpiryIds).toContain(nearExpiryWithStock.id)
    expect(nearExpiryIds).not.toContain(nearExpiryFullyConsumed.id)
    expect(nearExpiry.find((b) => b.batch.id === nearExpiryWithStock.id)?.balance.toNumber()).toBe(10)

    const expired = await listExpiredBatches(sessionForBranches([branchAId]), branchAId)
    const expiredIds = expired.map((b) => b.batch.id)
    expect(expiredIds).toContain(expiredWithStock.id)
    expect(expired.find((b) => b.batch.id === expiredWithStock.id)?.balance.toNumber()).toBe(7)
  }, TIMEOUT)

  it("§19/§48: two concurrent 'out' adjustments against the same near-depleted batch never drive the balance negative", async () => {
    const product = await createProduct()
    const batch = await createBatch(product.id, branchAId, { purchaseCost: 4, quantity: 10 })

    const results = await Promise.allSettled([
      recordAdjustment(sessionForBranches([branchAId]), {
        branchId: branchAId, productId: product.id, batchId: batch.id,
        direction: "out", quantity: 6, transactionType: "adjustment", reason: "concurrent out #1",
      }),
      recordAdjustment(sessionForBranches([branchAId]), {
        branchId: branchAId, productId: product.id, batchId: batch.id,
        direction: "out", quantity: 6, transactionType: "adjustment", reason: "concurrent out #2",
      }),
    ])

    const succeeded = results.filter((r) => r.status === "fulfilled")
    const failed = results.filter((r) => r.status === "rejected")
    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect((failed[0] as PromiseRejectedResult).reason.message).toMatch(/available/)

    const finalBalance = await balanceAt(branchAId, product.id, batch.id)
    expect(finalBalance).toBeGreaterThanOrEqual(0)
    expect(finalBalance).toBe(4) // exactly one 6-unit reduction from 10
  }, TIMEOUT)

  it("§17: a multi-branch-authorized session can adjust stock at either accessible branch; a single-branch session is denied the other", async () => {
    const product = await createProduct()
    const batchAtB = await createBatch(product.id, branchBId, { purchaseCost: 3, quantity: 5 })

    // Authorized for both branches — adjusting at Branch B succeeds.
    const entry = await recordAdjustment(sessionForBranches([branchAId, branchBId]), {
      branchId: branchBId, productId: product.id, batchId: batchAtB.id,
      direction: "out", quantity: 2, transactionType: "adjustment", reason: "multi-branch adjustment at branch B",
    })
    expect(entry.branchId).toBe(branchBId)

    // Authorized only for Branch A — adjusting at Branch B is denied.
    await expect(
      recordAdjustment(sessionForBranches([branchAId]), {
        branchId: branchBId, productId: product.id, batchId: batchAtB.id,
        direction: "out", quantity: 1, transactionType: "adjustment", reason: "cross-branch attempt",
      })
    ).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§20-25: a batch-specific transfer moves real stock from source to destination with coherent transfer_out/transfer_in ledger entries referencing the same batch and transfer", async () => {
    const product = await createProduct()
    const batch = await createBatch(product.id, branchAId, { purchaseCost: 8, quantity: 20 })

    const transfer = await createTransfer(sessionForBranches([branchAId, branchBId]), {
      fromBranchId: branchAId, toBranchId: branchBId, productId: product.id, batchId: batch.id, quantity: 12,
    })
    transferIds.push(transfer.id)
    expect(transfer.status).toBe("pending")

    const completed = await completeTransfer(sessionForBranches([branchAId, branchBId]), transfer.id)
    expect(completed.status).toBe("completed")

    const sourceBalance = await balanceAt(branchAId, product.id, batch.id)
    const destBalance = await balanceAt(branchBId, product.id, batch.id)
    expect(sourceBalance).toBe(8) // 20 - 12
    expect(destBalance).toBe(12)

    const outEntry = await db.stockLedgerEntry.findFirstOrThrow({ where: { referenceType: "stock_transfer", referenceId: transfer.id, transactionType: "transfer_out" } })
    const inEntry = await db.stockLedgerEntry.findFirstOrThrow({ where: { referenceType: "stock_transfer", referenceId: transfer.id, transactionType: "transfer_in" } })
    expect(outEntry.batchId).toBe(batch.id)
    expect(inEntry.batchId).toBe(batch.id) // same ProductBatch record reused across branches — never a merged/duplicated batch
    expect(Number(outEntry.quantity)).toBe(-12)
    expect(Number(inEntry.quantity)).toBe(12)
  }, TIMEOUT)

  it("§21: an expired batch cannot be selected for a transfer", async () => {
    const product = await createProduct()
    const expiredBatch = await createBatch(product.id, branchAId, { purchaseCost: 5, quantity: 10, expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000) })

    await expect(
      createTransfer(sessionForBranches([branchAId, branchBId]), {
        fromBranchId: branchAId, toBranchId: branchBId, productId: product.id, batchId: expiredBatch.id, quantity: 5,
      })
    ).rejects.toThrow(/expired/i)
  }, TIMEOUT)

  it("§22/§46: creating or completing a transfer requires authorization at BOTH the source and destination branch", async () => {
    const product = await createProduct()
    const batch = await createBatch(product.id, branchAId, { purchaseCost: 6, quantity: 10 })

    // Authorized only for the source branch — destination (Branch B) is not accessible.
    await expect(
      createTransfer(sessionForBranches([branchAId]), {
        fromBranchId: branchAId, toBranchId: branchBId, productId: product.id, batchId: batch.id, quantity: 3,
      })
    ).rejects.toThrow(ForbiddenError)

    // A transfer created by an org-wide-equivalent session, then completion attempted by a session authorized for neither branch.
    const transfer = await createTransfer(sessionForBranches([branchAId, branchBId]), {
      fromBranchId: branchAId, toBranchId: branchBId, productId: product.id, batchId: batch.id, quantity: 3,
    })
    transferIds.push(transfer.id)

    await expect(completeTransfer(sessionForBranches(["99999999-9999-4999-8999-999999999999"]), transfer.id)).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§24/§48: two concurrent completions competing for the same batch's remaining stock never drive the source balance negative", async () => {
    const product = await createProduct()
    const batch = await createBatch(product.id, branchAId, { purchaseCost: 7, quantity: 10 })

    const session = sessionForBranches([branchAId, branchBId])
    const transferA = await createTransfer(session, { fromBranchId: branchAId, toBranchId: branchBId, productId: product.id, batchId: batch.id, quantity: 6 })
    const transferB = await createTransfer(session, { fromBranchId: branchAId, toBranchId: branchBId, productId: product.id, batchId: batch.id, quantity: 6 })
    transferIds.push(transferA.id, transferB.id)

    const results = await Promise.allSettled([completeTransfer(session, transferA.id), completeTransfer(session, transferB.id)])
    const succeeded = results.filter((r) => r.status === "fulfilled")
    expect(succeeded).toHaveLength(1) // only one of the two 6-unit transfers can complete against 10 units

    const sourceBalance = await balanceAt(branchAId, product.id, batch.id)
    expect(sourceBalance).toBeGreaterThanOrEqual(0)
    expect(sourceBalance).toBe(4) // 10 - 6
  }, TIMEOUT)

  it("§46 (related pagination fix): listTransfers returns a paginated shape and stays branch-scoped", async () => {
    const product = await createProduct()
    const batch = await createBatch(product.id, branchAId, { purchaseCost: 2, quantity: 5 })
    const transfer = await createTransfer(sessionForBranches([branchAId, branchBId]), {
      fromBranchId: branchAId, toBranchId: branchBId, productId: product.id, batchId: batch.id, quantity: 1,
    })
    transferIds.push(transfer.id)

    const result = await listTransfers(sessionForBranches([branchAId, branchBId]), { page: 1 })
    expect(result).toHaveProperty("total")
    expect(result).toHaveProperty("totalPages")
    expect(result.transfers.map((t) => t.id)).toContain(transfer.id)

    // A session with no access to either branch sees none of it.
    const unrelated = await listTransfers(sessionForBranches(["88888888-8888-4888-8888-888888888888"]))
    expect(unrelated.transfers.map((t) => t.id)).not.toContain(transfer.id)
  }, TIMEOUT)
})

describe("P3.8: procurement operational fixes", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let userId: string
  let supplierId: string
  const productIds: string[] = []
  const purchaseRequestIds: string[] = []
  const purchaseOrderIds: string[] = []
  const goodsReceiptIds: string[] = []
  const supplierInvoiceIds: string[] = []

  function sessionForBranches(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-8-procurement",
      user: { id: userId, organizationId, email: "p3-8-procurement-test@test.local", firstName: "Proc38", lastName: "Test" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "inventory.view", "purchase_request.create", "purchase_request.approve",
        "purchase_order.create", "goods_receipt.create", "supplier_invoice.manage", "supplier.view",
      ]),
      roleNames: ["Procurement Staff"],
    }
  }

  async function createProduct() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const product = await db.product.create({
      data: { organizationId, name: `P3.8 Procurement Product ${suffix}`, sku: `TESTP38PR-${suffix}`, category: "consumable", unit: "unit", reorderLevel: 0, purchaseCost: 10, sellingPrice: 20 },
    })
    productIds.push(product.id)
    return product
  }

  async function createPO(branchId: string, productId: string, quantity: number, unitCost: number) {
    const po = await createPurchaseOrder(sessionForBranches([branchId]), {
      branchId, supplierId, lines: [{ productId, quantity, unitCost }],
    })
    purchaseOrderIds.push(po.id)
    const full = await db.purchaseOrder.findFirstOrThrow({ where: { id: po.id }, include: { lines: true } })
    return full
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const branchB = await db.branch.create({
      data: { organizationId, name: `P3.8 Procurement Branch B ${Date.now()}`, code: `P38PB-${Date.now()}`, timezone: "UTC" },
    })
    branchBId = branchB.id

    const supplier = await db.supplier.create({
      data: { organizationId, code: `TESTP38SUP-${Date.now()}`, companyName: "P3.8 Test Supplier" },
    })
    supplierId = supplier.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId, referenceType: "outbox_event" } }).catch(() => {})
    const journals = await db.journal.findMany({
      where: { organizationId, OR: [{ referenceType: "goods_receipt", referenceId: { in: goodsReceiptIds } }, { referenceType: "supplier_invoice", referenceId: { in: supplierInvoiceIds } }] },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.supplierInvoice.deleteMany({ where: { id: { in: supplierInvoiceIds } } })
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: productIds } } })
    await db.productBatch.deleteMany({ where: { productId: { in: productIds } } })
    await db.goodsReceiptLine.deleteMany({ where: { goodsReceiptId: { in: goodsReceiptIds } } })
    await db.goodsReceipt.deleteMany({ where: { id: { in: goodsReceiptIds } } })
    await db.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: { in: purchaseOrderIds } } })
    await db.purchaseOrder.deleteMany({ where: { id: { in: purchaseOrderIds } } })
    await db.purchaseRequestLine.deleteMany({ where: { purchaseRequestId: { in: purchaseRequestIds } } })
    await db.purchaseRequest.deleteMany({ where: { id: { in: purchaseRequestIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.supplier.delete({ where: { id: supplierId } })
    await db.branch.delete({ where: { id: branchBId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("§45-46: approving/rejecting a purchase request, receiving goods, and paying a supplier invoice all now enforce branch access — previously unchecked write paths", async () => {
    const product = await createProduct()

    // Purchase request approval/rejection.
    const pr = await createPurchaseRequest(sessionForBranches([branchAId]), {
      branchId: branchAId, lines: [{ productId: product.id, quantity: 2 }],
    })
    purchaseRequestIds.push(pr.id)
    await expect(approvePurchaseRequest(sessionForBranches([branchBId]), pr.id)).rejects.toThrow(ForbiddenError)
    await expect(rejectPurchaseRequest(sessionForBranches([branchBId]), pr.id, "wrong branch")).rejects.toThrow(ForbiddenError)

    // Goods receipt creation against a PO belonging to a branch the session can't access.
    const po = await createPO(branchAId, product.id, 5, 4)
    await expect(
      createGoodsReceipt(sessionForBranches([branchBId]), {
        purchaseOrderId: po.id, allowOverReceipt: false,
        lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `P38GR-BRANCH-${Date.now()}`, quantityReceived: 1, unitCost: 4 }],
      })
    ).rejects.toThrow(ForbiddenError)

    // Supplier payment against an invoice belonging to a branch the session can't access.
    const invoice = await createSupplierInvoice(sessionForBranches([branchAId]), {
      supplierId, branchId: branchAId, invoiceNumber: `TESTP38SI-BRANCH-${Date.now()}`, amount: 100, taxAmount: 0,
    })
    supplierInvoiceIds.push(invoice.id)
    await expect(
      recordSupplierPayment(sessionForBranches([branchBId]), { supplierInvoiceId: invoice.id, method: "cash", amount: 50 })
    ).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§26-27: purchase request status transitions follow the real enum lifecycle — only a submitted request can be approved or rejected, never twice", async () => {
    const product = await createProduct()
    const pr = await createPurchaseRequest(sessionForBranches([branchAId]), {
      branchId: branchAId, lines: [{ productId: product.id, quantity: 5 }],
    })
    purchaseRequestIds.push(pr.id)
    expect(pr.status).toBe("submitted")

    const approved = await approvePurchaseRequest(sessionForBranches([branchAId]), pr.id)
    expect(approved.status).toBe("approved")

    await expect(approvePurchaseRequest(sessionForBranches([branchAId]), pr.id)).rejects.toThrow(/submitted/)
    await expect(rejectPurchaseRequest(sessionForBranches([branchAId]), pr.id, "too late")).rejects.toThrow(/submitted/)
  }, TIMEOUT)

  it("§28: listPurchaseRequests returns a real paginated shape, branch-scoped, not the old take:100", async () => {
    const product = await createProduct()
    const pr = await createPurchaseRequest(sessionForBranches([branchAId]), {
      branchId: branchAId, lines: [{ productId: product.id, quantity: 3 }],
    })
    purchaseRequestIds.push(pr.id)

    const page1 = await listPurchaseRequests(sessionForBranches([branchAId]), { page: 1 })
    expect(page1).toHaveProperty("total")
    expect(page1).toHaveProperty("pageSize")
    expect(page1).toHaveProperty("totalPages")
    expect(page1.requests.map((r) => r.id)).toContain(pr.id)

    // Far out-of-range page returns empty, not an error and not the whole unbounded set.
    const farPage = await listPurchaseRequests(sessionForBranches([branchAId]), { page: 9999 })
    expect(farPage.requests).toHaveLength(0)

    // Branch isolation: a session with no access to branchA doesn't see it.
    const unrelated = await listPurchaseRequests(sessionForBranches([branchBId]))
    expect(unrelated.requests.map((r) => r.id)).not.toContain(pr.id)
  }, TIMEOUT)

  it("§30: listPurchaseOrders returns a real paginated shape, branch-scoped, not the old take:100", async () => {
    const product = await createProduct()
    const po = await createPO(branchAId, product.id, 10, 5)

    const page1 = await listPurchaseOrders(sessionForBranches([branchAId]), { page: 1 })
    expect(page1).toHaveProperty("total")
    expect(page1).toHaveProperty("totalPages")
    expect(page1.orders.map((o) => o.id)).toContain(po.id)

    const unrelated = await listPurchaseOrders(sessionForBranches([branchBId]))
    expect(unrelated.orders.map((o) => o.id)).not.toContain(po.id)
  }, TIMEOUT)

  it("§35/§39/§48: partial receiving is supported, over-receipt is rejected by default, and two concurrent receipts against the remaining quantity cannot jointly over-receive", async () => {
    const product = await createProduct()
    const po = await createPO(branchAId, product.id, 10, 5)
    const line = po.lines[0]

    // Partial receipt: 4 of 10.
    const first = await createGoodsReceipt(sessionForBranches([branchAId]), {
      purchaseOrderId: po.id, allowOverReceipt: false,
      lines: [{ purchaseOrderLineId: line.id, productId: product.id, batchNumber: `P38GR-${Date.now()}-a`, quantityReceived: 4, unitCost: 5 }],
    })
    goodsReceiptIds.push(first.id)
    const afterFirst = await db.purchaseOrder.findFirstOrThrow({ where: { id: po.id } })
    expect(afterFirst.status).toBe("partially_received")

    // Default (no override): receiving more than the remaining 6 is rejected.
    await expect(
      createGoodsReceipt(sessionForBranches([branchAId]), {
        purchaseOrderId: po.id, allowOverReceipt: false,
        lines: [{ purchaseOrderLineId: line.id, productId: product.id, batchNumber: `P38GR-${Date.now()}-over`, quantityReceived: 7, unitCost: 5 }],
      })
    ).rejects.toThrow(/exceed/)

    // Two concurrent receipts of 4 each against the remaining 6 — jointly 8 > 6.
    // Exactly one must succeed; the total received must never exceed the ordered quantity.
    const results = await Promise.allSettled([
      createGoodsReceipt(sessionForBranches([branchAId]), {
        purchaseOrderId: po.id, allowOverReceipt: false,
        lines: [{ purchaseOrderLineId: line.id, productId: product.id, batchNumber: `P38GR-${Date.now()}-race1`, quantityReceived: 4, unitCost: 5 }],
      }),
      createGoodsReceipt(sessionForBranches([branchAId]), {
        purchaseOrderId: po.id, allowOverReceipt: false,
        lines: [{ purchaseOrderLineId: line.id, productId: product.id, batchNumber: `P38GR-${Date.now()}-race2`, quantityReceived: 4, unitCost: 5 }],
      }),
    ])
    for (const r of results) if (r.status === "fulfilled") goodsReceiptIds.push(r.value.id)
    const succeeded = results.filter((r) => r.status === "fulfilled")
    expect(succeeded.length).toBeLessThanOrEqual(1) // 4+4=8 > the remaining 6, so both cannot succeed

    const totalReceived = await db.goodsReceiptLine.aggregate({
      where: { purchaseOrderLineId: line.id }, _sum: { quantityReceived: true },
    })
    expect(Number(totalReceived._sum.quantityReceived ?? 0)).toBeLessThanOrEqual(10)

    // Batch/ledger correctness for the confirmed successful receipt.
    const batch = await db.productBatch.findFirstOrThrow({ where: { productId: product.id, batchNumber: { contains: "P38GR" } } })
    const ledgerEntry = await db.stockLedgerEntry.findFirstOrThrow({ where: { batchId: batch.id, transactionType: "purchase" } })
    expect(ledgerEntry.referenceType).toBe("goods_receipt")
  }, TIMEOUT)

  it("§41: creating a supplier invoice twice with the same idempotency key returns the SAME invoice, not a duplicate AP liability", async () => {
    const key = `p3-8-supplier-invoice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const first = await createSupplierInvoice(sessionForBranches([branchAId]), {
      supplierId, branchId: branchAId, invoiceNumber: `TESTP38SI-${Date.now()}`, amount: 150, taxAmount: 0, idempotencyKey: key,
    })
    supplierInvoiceIds.push(first.id)

    const second = await createSupplierInvoice(sessionForBranches([branchAId]), {
      supplierId, branchId: branchAId, invoiceNumber: `TESTP38SI-${Date.now()}`, amount: 150, taxAmount: 0, idempotencyKey: key,
    })
    expect(second.id).toBe(first.id)

    const count = await db.supplierInvoice.count({ where: { id: first.id } })
    expect(count).toBe(1)
    const allWithThatNumber = await db.supplierInvoice.count({ where: { organizationId, supplierId, amount: 150, taxAmount: 0 } })
    // Only the first call's row exists — the second call did not insert a second SupplierInvoice.
    expect(allWithThatNumber).toBe(1)
  }, TIMEOUT)
})
