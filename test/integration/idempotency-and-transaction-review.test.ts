import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { generateInvoice } from "@/lib/domains/billing/invoices"
import { recordPayment } from "@/lib/domains/billing/payments"
import { createGoodsReceipt } from "@/lib/domains/procurement/goods-receipts"
import { createSupplierInvoice, recordSupplierPayment } from "@/lib/domains/procurement/supplier-invoices"
import { consumeStock } from "@/lib/domains/inventory/stock"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 Batch 8, §32 (transaction protection) / §33 (idempotency review) —
 * real DB integration tests against the gaps found and fixed this batch:
 * A5 (double-invoicing), B8 (goods receipt duplicate submission), a new
 * Payment double-click gap (distinct from §29's already-fixed overpayment
 * race), a new package-session double-click gap (covered in
 * package-session-concurrency.test.ts's own file instead — this file
 * covers the other five), A3 (supplier payment concurrency), and A8
 * (FEFO consumption concurrency, `consumeStock`). Session is a hand-built
 * Super Admin context — the same precedent every other concurrency test in
 * this pass uses, since these files test transactional correctness, not
 * authorization.
 */
const TIMEOUT = 60000

describe("P1 §32/§33: transaction boundaries and idempotency", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let supplierId: string
  let userId: string
  const chargeIds: string[] = []
  const invoiceIds: string[] = []
  const cashierSessionIds: string[] = []
  const purchaseOrderIds: string[] = []
  const goodsReceiptIds: string[] = []
  const supplierInvoiceIds: string[] = []
  const productIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-idempotency-transaction-review",
      user: { id: userId, organizationId, email: "idempotency-review-test@test.local", firstName: "Review", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set([
        "invoice.create", "payment.create", "goods_receipt.create", "supplier_invoice.manage", "purchase_order.manage",
      ]),
      roleNames: ["Super Admin"],
    }
  }

  async function createCharge(amount: number) {
    const charge = await db.charge.create({
      data: {
        organizationId, branchId, patientId,
        sourceType: "other", description: "Idempotency review test charge",
        quantity: 1, unitPrice: amount, amount, status: "pending",
      },
    })
    chargeIds.push(charge.id)
    return charge
  }

  async function openCashierSession() {
    const cashierSession = await db.cashierSession.create({
      data: { organizationId, branchId, cashierUserId: userId, openingCash: 0, status: "open" },
    })
    cashierSessionIds.push(cashierSession.id)
    return cashierSession
  }

  async function createProduct(purchaseCost: number) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const product = await db.product.create({
      data: {
        organizationId, name: `Idempotency Review Product ${suffix}`, sku: `TESTIDEMP-${suffix}`,
        category: "consumable", unit: "unit", reorderLevel: 0, purchaseCost, sellingPrice: purchaseCost * 2,
      },
    })
    productIds.push(product.id)
    return product
  }

  async function createPO(productId: string, quantity: number, unitCost: number) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const po = await db.purchaseOrder.create({
      data: { organizationId, branchId, supplierId, poNumber: `TESTIDEMPPO-${suffix}`, status: "issued", lines: { create: [{ productId, quantity, unitCost }] } },
      include: { lines: true },
    })
    purchaseOrderIds.push(po.id)
    return po
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTIDEMP-${Date.now()}`, firstName: "IdempotencyReview", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `IR${Date.now()}`,
      },
    })
    patientId = patient.id

    const supplier = await db.supplier.create({
      data: { organizationId, companyName: `Idempotency Review Supplier ${Date.now()}`, code: `TESTIDEMPSUP-${Date.now()}` },
    })
    supplierId = supplier.id
  }, TIMEOUT)

  afterAll(async () => {
    // P3.13: a "payment" journal's referenceId is the Payment's own id, not
    // the invoice's (posting-service.ts's postPaymentReceived, fixed this
    // batch) — resolve the real payment ids first so this cleanup still finds them.
    const paymentIds = (await db.payment.findMany({ where: { allocations: { some: { invoiceId: { in: invoiceIds } } } }, select: { id: true } })).map((p) => p.id)
    const journals = await db.journal.findMany({
      where: {
        organizationId,
        OR: [
          { referenceType: "invoice", referenceId: { in: invoiceIds } },
          { referenceType: "payment", referenceId: { in: paymentIds } },
          { referenceType: "goods_receipt", referenceId: { in: goodsReceiptIds } },
          { referenceType: "supplier_invoice", referenceId: { in: supplierInvoiceIds } },
        ],
      },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })

    await db.idempotencyKey.deleteMany({ where: { organizationId, scope: { in: ["goods_receipt.create", "payment.record"] } } })

    const paymentAllocations = await db.paymentAllocation.findMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.paymentAllocation.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.payment.deleteMany({ where: { id: { in: paymentAllocations.map((a) => a.paymentId) } } })
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await db.charge.deleteMany({ where: { id: { in: chargeIds } } })
    await db.cashierSession.deleteMany({ where: { id: { in: cashierSessionIds } } })

    const supplierPayments = await db.supplierPayment.findMany({ where: { supplierInvoiceId: { in: supplierInvoiceIds } } })
    await db.supplierPayment.deleteMany({ where: { id: { in: supplierPayments.map((p) => p.id) } } })
    await db.supplierInvoice.deleteMany({ where: { id: { in: supplierInvoiceIds } } })
    const goodsReceiptLines = await db.goodsReceiptLine.findMany({ where: { goodsReceiptId: { in: goodsReceiptIds } } })
    await db.goodsReceiptLine.deleteMany({ where: { id: { in: goodsReceiptLines.map((l) => l.id) } } })
    await db.goodsReceipt.deleteMany({ where: { id: { in: goodsReceiptIds } } })
    const poLines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: { in: purchaseOrderIds } } })
    await db.purchaseOrderLine.deleteMany({ where: { id: { in: poLines.map((l) => l.id) } } })
    await db.purchaseOrder.deleteMany({ where: { id: { in: purchaseOrderIds } } })
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: productIds } } })
    await db.productBatch.deleteMany({ where: { productId: { in: productIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.supplier.delete({ where: { id: supplierId } })
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  describe("§32/§33 (finding A5): invoice issuance — transaction protection and idempotency", () => {
    it("two concurrent generateInvoice calls selecting the same charge — only one succeeds, the charge is never billed twice", async () => {
      const charge = await createCharge(300)

      const results = await Promise.allSettled([
        generateInvoice(session(), { patientId, branchId, chargeIds: [charge.id], discountAmount: 0 }),
        generateInvoice(session(), { patientId, branchId, chargeIds: [charge.id], discountAmount: 0 }),
      ])
      const fulfilled = results.filter((r) => r.status === "fulfilled")
      for (const r of fulfilled) invoiceIds.push((r as PromiseFulfilledResult<{ id: string }>).value.id)

      expect(fulfilled.length).toBe(1)
      expect(results.filter((r) => r.status === "rejected").length).toBe(1)

      const invoiceLines = await db.invoiceLine.findMany({ where: { chargeId: charge.id } })
      expect(invoiceLines.length).toBe(1) // never billed on two different invoices

      const after = await db.charge.findUniqueOrThrow({ where: { id: charge.id } })
      expect(after.status).toBe("invoiced")
    }, TIMEOUT)
  })

  describe("§33: Payment — idempotency key prevents a double-click from collecting the same tender twice", () => {
    it("two identical recordPayment calls with the SAME idempotency key — only one Payment row is ever created", async () => {
      const charge = await createCharge(500)
      const invoice = await generateInvoice(session(), { patientId, branchId, chargeIds: [charge.id], discountAmount: 0 })
      invoiceIds.push(invoice.id)
      const cashierSession = await openCashierSession()
      const key = `test-payment-key-${Date.now()}`

      const [first, second] = await Promise.all([
        recordPayment(session(), { invoiceId: invoice.id, cashierSessionId: cashierSession.id, tenders: [{ method: "cash", amount: 200 }], idempotencyKey: key }),
        recordPayment(session(), { invoiceId: invoice.id, cashierSessionId: cashierSession.id, tenders: [{ method: "cash", amount: 200 }], idempotencyKey: key }),
      ])

      expect(first.map((p) => p.id).sort()).toEqual(second.map((p) => p.id).sort()) // the second call replayed the first's own result

      const payments = await db.payment.findMany({ where: { allocations: { some: { invoiceId: invoice.id } } } })
      expect(payments.length).toBe(1) // not two — one real 200 tender, not 400 collected

      const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(after.paidAmount)).toBe(200)
    }, TIMEOUT)

    it("two recordPayment calls with DIFFERENT idempotency keys — both are treated as genuinely separate payments", async () => {
      const charge = await createCharge(500)
      const invoice = await generateInvoice(session(), { patientId, branchId, chargeIds: [charge.id], discountAmount: 0 })
      invoiceIds.push(invoice.id)
      const cashierSession = await openCashierSession()

      await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId: cashierSession.id, tenders: [{ method: "cash", amount: 200 }], idempotencyKey: `test-payment-key-a-${Date.now()}` })
      await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId: cashierSession.id, tenders: [{ method: "cash", amount: 100 }], idempotencyKey: `test-payment-key-b-${Date.now()}` })

      const payments = await db.payment.findMany({ where: { allocations: { some: { invoiceId: invoice.id } } } })
      expect(payments.length).toBe(2)
      const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(after.paidAmount)).toBe(300)
    }, TIMEOUT)
  })

  describe("§33 (finding B8): Goods Receipt — idempotency key prevents a double-submitted request from creating a second physical receipt", () => {
    it("two identical createGoodsReceipt calls with the SAME idempotency key — only one GoodsReceipt row is ever created", async () => {
      const product = await createProduct(10)
      const po = await createPO(product.id, 50, 10)
      const key = `test-gr-key-${Date.now()}`
      const input = {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `TESTIDEMPBATCH-${Date.now()}`, quantityReceived: 50, unitCost: 10 }],
        allowOverReceipt: false,
        idempotencyKey: key,
      }

      const [first, second] = await Promise.all([createGoodsReceipt(session(), input), createGoodsReceipt(session(), input)])
      goodsReceiptIds.push(first.id)
      if (second.id !== first.id) goodsReceiptIds.push(second.id)

      expect(second.id).toBe(first.id) // the second call replayed the first's own receipt

      const receipts = await db.goodsReceipt.findMany({ where: { purchaseOrderId: po.id } })
      expect(receipts.length).toBe(1)

      // Stock was only ever received once — not doubled.
      const balance = await db.stockLedgerEntry.aggregate({ where: { productId: product.id }, _sum: { quantity: true } })
      expect(Number(balance._sum.quantity)).toBe(50)
    }, TIMEOUT)

    it("createGoodsReceipt without an idempotency key still works normally (the guard doesn't over-require one)", async () => {
      const product = await createProduct(15)
      const po = await createPO(product.id, 20, 15)
      const receipt = await createGoodsReceipt(session(), {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `TESTIDEMPBATCH2-${Date.now()}`, quantityReceived: 20, unitCost: 15 }],
        allowOverReceipt: false,
      })
      goodsReceiptIds.push(receipt.id)
      expect(receipt.id).toBeDefined()
    }, TIMEOUT)
  })

  describe("§32 (finding A3): Supplier Payment — concurrency-safe against overpayment, same pattern as applyPaymentAtomically", () => {
    it("supplier invoice outstanding 500, two simultaneous 400 payments — only one combination is allowed to succeed", async () => {
      const invoice = await createSupplierInvoice(session(), { supplierId, branchId, invoiceNumber: `TESTIDEMPSI-${Date.now()}`, amount: 500, taxAmount: 0 })
      supplierInvoiceIds.push(invoice.id)

      const results = await Promise.allSettled([
        recordSupplierPayment(session(), { supplierInvoiceId: invoice.id, method: "bank", amount: 400 }),
        recordSupplierPayment(session(), { supplierInvoiceId: invoice.id, method: "bank", amount: 400 }),
      ])
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1)
      expect(results.filter((r) => r.status === "rejected").length).toBe(1)

      const after = await db.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(after.paidAmount)).toBe(400) // exactly one 400 payment applied, not 800
      expect(after.status).toBe("partially_paid")
    }, TIMEOUT)
  })

  describe("§32 (finding A8): Inventory consumption — consumeStock is locked against concurrent overselling", () => {
    it("a batch with 10 units, two concurrent consumers each requesting 8 — only one succeeds, balance never goes negative", async () => {
      const product = await createProduct(5)
      const batch = await db.productBatch.create({
        data: { organizationId, productId: product.id, batchNumber: `TESTIDEMPSTOCK-${Date.now()}`, purchaseCost: 5, receivedQuantity: 10 },
      })
      await db.stockLedgerEntry.create({
        data: { organizationId, branchId, productId: product.id, batchId: batch.id, transactionType: "purchase", quantity: 10, referenceType: "test" },
      })

      const attempt = (refId: string) =>
        db.$transaction((tx) =>
          consumeStock(tx, {
            organizationId, branchId, productId: product.id, quantity: 8,
            referenceType: "test_consumption", referenceId: refId, performedBy: userId,
          })
        )

      const results = await Promise.allSettled([attempt("test-consume-a"), attempt("test-consume-b")])
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1)
      expect(results.filter((r) => r.status === "rejected").length).toBe(1)
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message).toMatch(/Insufficient stock/)

      const balance = await db.stockLedgerEntry.aggregate({ where: { productId: product.id, branchId }, _sum: { quantity: true } })
      expect(Number(balance._sum.quantity)).toBe(2) // 10 - 8, never negative
    }, TIMEOUT)

    it("a single consumption within available stock still succeeds normally (the lock doesn't over-reject)", async () => {
      const product = await createProduct(5)
      const batch = await db.productBatch.create({
        data: { organizationId, productId: product.id, batchNumber: `TESTIDEMPSTOCK2-${Date.now()}`, purchaseCost: 5, receivedQuantity: 10 },
      })
      await db.stockLedgerEntry.create({
        data: { organizationId, branchId, productId: product.id, batchId: batch.id, transactionType: "purchase", quantity: 10, referenceType: "test" },
      })
      const { totalCost } = await db.$transaction((tx) =>
        consumeStock(tx, { organizationId, branchId, productId: product.id, quantity: 4, referenceType: "test_consumption", referenceId: "test-consume-solo", performedBy: userId })
      )
      expect(Number(totalCost)).toBe(20) // 4 * 5
    }, TIMEOUT)
  })
})
