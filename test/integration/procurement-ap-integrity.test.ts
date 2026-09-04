import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { createGoodsReceipt } from "@/lib/domains/procurement/goods-receipts"
import { createSupplierInvoice, recordSupplierPayment } from "@/lib/domains/procurement/supplier-invoices"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §15/§16: the PO -> Goods Receipt -> Supplier Invoice -> AP -> Payment
 * chain's accounting (the GR/IR clearing-account redesign — see
 * GoodsReceipt's doc comment, schema.prisma, and postGoodsReceiptCompleted /
 * postSupplierInvoiceCreated in accounting/posting-service.ts) and the
 * over-receiving guard (goods-receipts.ts's createGoodsReceipt).
 */
const TIMEOUT = 60000

describe("P1 §15/§16: procurement AP chain and over-receiving guard", () => {
  let organizationId: string
  let branchId: string
  let userId: string
  let supplierId: string
  let inventoryAccountId: string
  let apAccountId: string
  let grirAccountId: string
  let taxAccountId: string
  const productIds: string[] = []
  const purchaseOrderIds: string[] = []
  const supplierInvoiceIds: string[] = []
  const goodsReceiptIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-procurement-ap",
      user: { id: userId, organizationId, email: "procurement-ap-test@test.local", firstName: "Procure", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["goods_receipt.create", "supplier_invoice.manage", "purchase_order.manage"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createProduct() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const product = await db.product.create({
      data: { organizationId, name: `Procurement Test Product ${suffix}`, sku: `TESTPROC-${suffix}`, category: "consumable", unit: "unit", reorderLevel: 0, purchaseCost: 10, sellingPrice: 20 },
    })
    productIds.push(product.id)
    return product
  }

  async function createPO(productId: string, quantity: number, unitCost: number) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const po = await db.purchaseOrder.create({
      data: {
        organizationId, branchId, supplierId,
        poNumber: `TESTPO-${suffix}`,
        status: "issued",
        lines: { create: [{ productId, quantity, unitCost }] },
      },
      include: { lines: true },
    })
    purchaseOrderIds.push(po.id)
    return po
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    // P2 §14: previously a hardcoded, never-created id
    // ("00000000-0000-0000-0000-0000000000f5") — worked only because
    // nothing enforced it referenced a real row. createGoodsReceipt/
    // recordSupplierPayment write this straight into GoodsReceipt.receivedBy/
    // SupplierPayment.paidBy, which now have a real FK to `user` (§14,
    // Category A) — found and fixed as a direct consequence of that
    // migration, the same class of fix as pharmacy-dispensing-integrity.test.ts.
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const supplier = await db.supplier.create({
      data: { organizationId, code: `TESTSUP-${Date.now()}`, companyName: "Test AP Supplier" },
    })
    supplierId = supplier.id

    const [inventory, ap, grir, tax] = await Promise.all([
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1200" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "2000" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "2050" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1300" } }),
    ])
    inventoryAccountId = inventory.id
    apAccountId = ap.id
    grirAccountId = grir.id
    taxAccountId = tax.id
  }, TIMEOUT)

  afterAll(async () => {
    const journals = await db.journal.findMany({
      where: { organizationId, OR: [{ referenceType: "goods_receipt", referenceId: { in: goodsReceiptIds } }, { referenceType: "supplier_invoice", referenceId: { in: supplierInvoiceIds } }, { referenceType: "supplier_payment" }] },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.notification.deleteMany({ where: { organizationId, referenceType: "outbox_event" } }).catch(() => {})
    await db.supplierPayment.deleteMany({ where: { supplierInvoiceId: { in: supplierInvoiceIds } } })
    await db.supplierInvoice.deleteMany({ where: { id: { in: supplierInvoiceIds } } })
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: productIds } } })
    await db.productBatch.deleteMany({ where: { productId: { in: productIds } } })
    await db.goodsReceiptLine.deleteMany({ where: { goodsReceiptId: { in: goodsReceiptIds } } })
    await db.goodsReceipt.deleteMany({ where: { id: { in: goodsReceiptIds } } })
    await db.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: { in: purchaseOrderIds } } })
    await db.purchaseOrder.deleteMany({ where: { id: { in: purchaseOrderIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.supplier.delete({ where: { id: supplierId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("goods receipt posts Dr Inventory / Cr Goods Received Not Invoiced — never Accounts Payable directly", async () => {
    const product = await createProduct()
    const po = await createPO(product.id, 100, 10)

    const receipt = await createGoodsReceipt(session(), {
      purchaseOrderId: po.id,
      allowOverReceipt: false,
      lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `GRB-${Date.now()}`, quantityReceived: 100, unitCost: 10 }],
    })
    goodsReceiptIds.push(receipt.id)

    const journal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "goods_receipt", referenceId: receipt.id }, include: { lines: true } })
    const invLine = journal.lines.find((l) => l.accountId === inventoryAccountId)
    const grirLine = journal.lines.find((l) => l.accountId === grirAccountId)
    const apLine = journal.lines.find((l) => l.accountId === apAccountId)
    expect(Number(invLine?.debit)).toBe(1000)
    expect(Number(grirLine?.credit)).toBe(1000)
    expect(apLine).toBeUndefined() // AP is never touched at receipt time
  }, TIMEOUT)

  it("a PO-linked supplier invoice clears Goods Received Not Invoiced and credits real Accounts Payable, with recoverable tax debited separately", async () => {
    const product = await createProduct()
    const po = await createPO(product.id, 50, 8)
    const receipt = await createGoodsReceipt(session(), {
      purchaseOrderId: po.id,
      allowOverReceipt: false,
      lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `GRB2-${Date.now()}`, quantityReceived: 50, unitCost: 8 }],
    })
    goodsReceiptIds.push(receipt.id)

    const invoice = await createSupplierInvoice(session(), {
      supplierId, branchId, purchaseOrderId: po.id, invoiceNumber: `TESTINV-${Date.now()}`, amount: 400, taxAmount: 20,
    })
    supplierInvoiceIds.push(invoice.id)

    const journal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "supplier_invoice", referenceId: invoice.id }, include: { lines: true } })
    const grirLine = journal.lines.find((l) => l.accountId === grirAccountId)
    const taxLine = journal.lines.find((l) => l.accountId === taxAccountId)
    const apLine = journal.lines.find((l) => l.accountId === apAccountId)
    expect(Number(grirLine?.debit)).toBe(400)
    expect(Number(taxLine?.debit)).toBe(20)
    expect(Number(apLine?.credit)).toBe(420) // amount + taxAmount
  }, TIMEOUT)

  it("a standalone supplier invoice (no purchase order) debits Inventory directly, and can exist entirely independently of patient billing", async () => {
    const invoice = await createSupplierInvoice(session(), {
      supplierId, branchId, invoiceNumber: `TESTINV-STANDALONE-${Date.now()}`, amount: 250, taxAmount: 0,
    })
    supplierInvoiceIds.push(invoice.id)
    expect(invoice.purchaseOrderId).toBeNull()

    const journal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "supplier_invoice", referenceId: invoice.id }, include: { lines: true } })
    const invLine = journal.lines.find((l) => l.accountId === inventoryAccountId)
    const apLine = journal.lines.find((l) => l.accountId === apAccountId)
    expect(Number(invLine?.debit)).toBe(250) // debits Inventory directly — nothing was ever provisionally recognized to clear
    expect(Number(apLine?.credit)).toBe(250)

    // Nothing about this invoice references a patient, charge, or invoice on the revenue side.
    expect((invoice as Record<string, unknown>).patientId).toBeUndefined()
  }, TIMEOUT)

  it("supplier payment posts Dr AP / Cr tender account against the total (amount + taxAmount), and rejects overpayment past the outstanding balance", async () => {
    const invoice = await createSupplierInvoice(session(), {
      supplierId, branchId, invoiceNumber: `TESTINV-PAY-${Date.now()}`, amount: 300, taxAmount: 30,
    })
    supplierInvoiceIds.push(invoice.id)

    const payment = await recordSupplierPayment(session(), { supplierInvoiceId: invoice.id, method: "bank", amount: 330 })
    const updated = await db.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(updated.status).toBe("paid")

    const journal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "supplier_payment", referenceId: payment.id }, include: { lines: true } })
    const apLine = journal.lines.find((l) => l.accountId === apAccountId)
    expect(Number(apLine?.debit)).toBe(330)

    // Fully paid — any further payment must be rejected, not silently overpay.
    await expect(recordSupplierPayment(session(), { supplierInvoiceId: invoice.id, method: "bank", amount: 1 })).rejects.toThrow(/exceeds the outstanding balance/)
  }, TIMEOUT)

  it("partial goods receiving: stock updates per confirmed receipt only, and multiple supplier invoices can bill against one purchase order", async () => {
    const product = await createProduct()
    const po = await createPO(product.id, 100, 5)

    const receipt1 = await createGoodsReceipt(session(), {
      purchaseOrderId: po.id,
      allowOverReceipt: false,
      lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `PART1-${Date.now()}`, quantityReceived: 40, unitCost: 5 }],
    })
    goodsReceiptIds.push(receipt1.id)

    let poAfter1 = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(poAfter1.status).toBe("partially_received")
    let balance = await db.stockLedgerEntry.aggregate({ where: { productId: product.id }, _sum: { quantity: true } })
    expect(Number(balance._sum.quantity)).toBe(40) // only the confirmed receipt, not the full 100 ordered

    const receipt2 = await createGoodsReceipt(session(), {
      purchaseOrderId: po.id,
      allowOverReceipt: false,
      lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `PART2-${Date.now()}`, quantityReceived: 60, unitCost: 5 }],
    })
    goodsReceiptIds.push(receipt2.id)

    poAfter1 = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(poAfter1.status).toBe("received")
    balance = await db.stockLedgerEntry.aggregate({ where: { productId: product.id }, _sum: { quantity: true } })
    expect(Number(balance._sum.quantity)).toBe(100)

    // Two supplier invoices against the same PO — partial invoicing across receipts.
    const inv1 = await createSupplierInvoice(session(), { supplierId, branchId, purchaseOrderId: po.id, invoiceNumber: `TESTINV-PART1-${Date.now()}`, amount: 200, taxAmount: 0 })
    const inv2 = await createSupplierInvoice(session(), { supplierId, branchId, purchaseOrderId: po.id, invoiceNumber: `TESTINV-PART2-${Date.now()}`, amount: 300, taxAmount: 0 })
    supplierInvoiceIds.push(inv1.id, inv2.id)
    expect(inv1.purchaseOrderId).toBe(po.id)
    expect(inv2.purchaseOrderId).toBe(po.id) // no uniqueness conflict — both reference the same PO
  }, TIMEOUT)

  it("over-receiving beyond the PO quantity is rejected by default, and only proceeds with explicit authorization", async () => {
    const product = await createProduct()
    const po = await createPO(product.id, 20, 10)

    await expect(
      createGoodsReceipt(session(), {
        purchaseOrderId: po.id,
        allowOverReceipt: false,
        lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `OVER-${Date.now()}`, quantityReceived: 25, unitCost: 10 }],
      })
    ).rejects.toThrow(/would exceed the ordered quantity/)

    // No partial side effect from the rejected attempt.
    const poAfter = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(poAfter.status).toBe("issued")
    const entries = await db.stockLedgerEntry.findMany({ where: { productId: product.id } })
    expect(entries.length).toBe(0)

    // With explicit authorization, the same over-receipt succeeds.
    const receipt = await createGoodsReceipt(session(), {
      purchaseOrderId: po.id,
      allowOverReceipt: true,
      lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `OVER2-${Date.now()}`, quantityReceived: 25, unitCost: 10 }],
    })
    goodsReceiptIds.push(receipt.id)
    const balance = await db.stockLedgerEntry.aggregate({ where: { productId: product.id }, _sum: { quantity: true } })
    expect(Number(balance._sum.quantity)).toBe(25)
  }, TIMEOUT)
})
