import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { createAdHocCharge, voidCharge } from "@/lib/domains/billing/charges"
import { recordAdjustment } from "@/lib/domains/inventory/stock"
import { getInventoryReport } from "@/lib/domains/analytics/reports/inventory"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §9-§13: POS product sales, FEFO safety, COGS posting, valuation
 * reconciliation, and stock-adjustment accounting — real DB integration
 * tests against `src/lib/domains/billing/charges.ts`'s new productId-driven
 * consumption path and `accounting/posting-service.ts`'s new
 * postProductSaleCogs/postProductSaleVoided/postInventoryAdjustment.
 */
const TIMEOUT = 60000

describe("P1 §9-§13: POS product sales, FEFO, COGS, and inventory adjustment accounting", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let userId: string
  let cogsAccountId: string
  let inventoryAccountId: string
  let writeOffAccountId: string
  let gainAccountId: string
  const productIds: string[] = []
  const chargeIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-pos-inventory-cogs",
      user: { id: userId, organizationId, email: "pos-cogs-test@test.local", firstName: "Pos", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["charge.create", "charge.void", "invoice.view", "inventory.view", "inventory.adjust"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createProduct(purchaseCost: number) {
    const product = await db.product.create({
      data: {
        organizationId,
        name: `POS COGS Test Product ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sku: `TESTPOSCOGS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        category: "consumable",
        unit: "unit",
        reorderLevel: 0,
        purchaseCost,
        sellingPrice: purchaseCost * 2,
      },
    })
    productIds.push(product.id)
    return product
  }

  async function createBatch(productId: string, opts: { purchaseCost: number; quantity: number; expiryDate?: Date | null }) {
    const batch = await db.productBatch.create({
      data: {
        organizationId,
        productId,
        batchNumber: `B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    // P2 §14: previously a hardcoded, never-created id — createAdHocCharge
    // writes this straight into Charge.createdBy, which now has a real FK
    // to `user` (§14, Category A). Same class of fix as
    // pharmacy-dispensing-integrity.test.ts / procurement-ap-integrity.test.ts.
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const [cogs, inventory, writeOff, gain] = await Promise.all([
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "5100" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1200" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "5200" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "4100" } }),
    ])
    cogsAccountId = cogs.id
    inventoryAccountId = inventory.id
    writeOffAccountId = writeOff.id
    gainAccountId = gain.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTPOSCOGS-${Date.now()}`, firstName: "PosCogs", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `PC${Date.now()}`,
      },
    })
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    const journals = await db.journal.findMany({
      where: { organizationId, OR: [{ referenceType: { in: ["charge_cogs", "charge_cogs_void"] }, referenceId: { in: chargeIds } }, { referenceType: "stock_ledger_entry" }] },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.notification.deleteMany({ where: { organizationId, referenceType: "outbox_event" } }).catch(() => {})
    await db.invoiceLine.deleteMany({ where: { chargeId: { in: chargeIds } } })
    await db.charge.deleteMany({ where: { id: { in: chargeIds } } })
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: productIds } } })
    await db.productBatch.deleteMany({ where: { productId: { in: productIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("selling an inventory-managed product creates a stock ledger movement referencing the charge, branch, product, and batch — never a direct decrement", async () => {
    const product = await createProduct(10)
    const batch = await createBatch(product.id, { purchaseCost: 10, quantity: 20 })

    const charge = await createAdHocCharge(session(), {
      patientId, branchId, sourceType: "product", productId: product.id,
      description: "Sold product", quantity: 5, unitPrice: 20,
    })
    chargeIds.push(charge.id)

    const entries = await db.stockLedgerEntry.findMany({ where: { referenceType: "charge", referenceId: charge.id } })
    expect(entries.length).toBe(1)
    expect(entries[0].productId).toBe(product.id)
    expect(entries[0].branchId).toBe(branchId)
    expect(entries[0].batchId).toBe(batch.id)
    expect(Number(entries[0].quantity)).toBe(-5)
    expect(entries[0].transactionType).toBe("sale")

    const balance = await db.stockLedgerEntry.aggregate({ where: { productId: product.id }, _sum: { quantity: true } })
    expect(Number(balance._sum.quantity)).toBe(15) // 20 received - 5 sold
  }, TIMEOUT)

  it("selling a product posts Dr COGS / Cr Inventory Asset, valued at the specific batch's actual cost", async () => {
    const product = await createProduct(7)
    await createBatch(product.id, { purchaseCost: 7, quantity: 10 })

    const charge = await createAdHocCharge(session(), {
      patientId, branchId, sourceType: "product", productId: product.id,
      description: "Sold product", quantity: 3, unitPrice: 20,
    })
    chargeIds.push(charge.id)

    const journal = await db.journal.findFirstOrThrow({
      where: { organizationId, referenceType: "charge_cogs", referenceId: charge.id },
      include: { lines: true },
    })
    const cogsLine = journal.lines.find((l) => l.accountId === cogsAccountId)
    const inventoryLine = journal.lines.find((l) => l.accountId === inventoryAccountId)
    expect(Number(cogsLine?.debit)).toBe(21) // 3 units x 7 actual batch cost
    expect(Number(inventoryLine?.credit)).toBe(21)
  }, TIMEOUT)

  it("a charge with no productId (a service or 'other' line) creates no stock movement at all", async () => {
    const charge = await createAdHocCharge(session(), {
      patientId, branchId, sourceType: "other",
      description: "Non-tracked line item", quantity: 1, unitPrice: 50,
    })
    chargeIds.push(charge.id)

    const entries = await db.stockLedgerEntry.findMany({ where: { referenceType: "charge", referenceId: charge.id } })
    expect(entries.length).toBe(0)
    const journal = await db.journal.findFirst({ where: { organizationId, referenceType: "charge_cogs", referenceId: charge.id } })
    expect(journal).toBeNull()
  }, TIMEOUT)

  it("POS FEFO allocation excludes an expired batch and uses actual per-batch cost across a split allocation", async () => {
    const product = await createProduct(5)
    const expired = await createBatch(product.id, { purchaseCost: 3, quantity: 100, expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    const validB = await createBatch(product.id, { purchaseCost: 5, quantity: 4, expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000) })
    const validC = await createBatch(product.id, { purchaseCost: 6, quantity: 10, expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })

    // 6 units requested: FEFO must take all 4 from validB then 2 from validC, never touching the cheaper expired batch.
    const charge = await createAdHocCharge(session(), {
      patientId, branchId, sourceType: "product", productId: product.id,
      description: "Sold product across two batches", quantity: 6, unitPrice: 50,
    })
    chargeIds.push(charge.id)

    const entries = await db.stockLedgerEntry.findMany({ where: { referenceType: "charge", referenceId: charge.id } })
    const byBatch = new Map(entries.map((e) => [e.batchId, Number(e.quantity)]))
    expect(byBatch.get(expired.id)).toBeUndefined()
    expect(byBatch.get(validB.id)).toBe(-4)
    expect(byBatch.get(validC.id)).toBe(-2)

    const journal = await db.journal.findFirstOrThrow({
      where: { organizationId, referenceType: "charge_cogs", referenceId: charge.id },
      include: { lines: true },
    })
    const cogsLine = journal.lines.find((l) => l.accountId === cogsAccountId)
    expect(Number(cogsLine?.debit)).toBe(4 * 5 + 2 * 6) // 32 — actual batch costs, never the expired batch's 3
  }, TIMEOUT)

  it("insufficient stock aborts the charge entirely — no charge, no invoice line, no stock movement is left behind", async () => {
    const product = await createProduct(4)
    await createBatch(product.id, { purchaseCost: 4, quantity: 2 })

    await expect(
      createAdHocCharge(session(), {
        patientId, branchId, sourceType: "product", productId: product.id,
        description: "Oversell attempt", quantity: 50, unitPrice: 20,
      })
    ).rejects.toThrow(/Insufficient stock/)

    const charges = await db.charge.findMany({ where: { organizationId, patientId, description: "Oversell attempt" } })
    expect(charges.length).toBe(0)
    const entries = await db.stockLedgerEntry.findMany({ where: { productId: product.id, transactionType: "sale" } })
    expect(entries.length).toBe(0)
  }, TIMEOUT)

  it("voiding a product-sale charge reverses the stock consumption and posts a matching COGS reversal", async () => {
    const product = await createProduct(8)
    await createBatch(product.id, { purchaseCost: 8, quantity: 10 })

    const charge = await createAdHocCharge(session(), {
      patientId, branchId, sourceType: "product", productId: product.id,
      description: "To be voided", quantity: 4, unitPrice: 20,
    })
    chargeIds.push(charge.id)

    const balanceAfterSale = await db.stockLedgerEntry.aggregate({ where: { productId: product.id }, _sum: { quantity: true } })
    expect(Number(balanceAfterSale._sum.quantity)).toBe(6) // 10 - 4

    await voidCharge(session(), charge.id, "test void")

    const balanceAfterVoid = await db.stockLedgerEntry.aggregate({ where: { productId: product.id }, _sum: { quantity: true } })
    expect(Number(balanceAfterVoid._sum.quantity)).toBe(10) // fully restored

    const originalJournal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "charge_cogs", referenceId: charge.id }, include: { lines: true } })
    const voidJournal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "charge_cogs_void", referenceId: charge.id }, include: { lines: true } })
    const originalCogsDebit = originalJournal.lines.find((l) => l.accountId === cogsAccountId)
    const voidCogsCredit = voidJournal.lines.find((l) => l.accountId === cogsAccountId)
    expect(Number(voidCogsCredit?.credit)).toBe(Number(originalCogsDebit?.debit)) // exact mirror, 32 = 4 x 8

    const updatedCharge = await db.charge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(updatedCharge.status).toBe("void")
  }, TIMEOUT)

  it("a damage adjustment posts Dr Inventory Write-off Expense / Cr Inventory Asset, valued at the batch's actual cost", async () => {
    const product = await createProduct(6)
    const batch = await createBatch(product.id, { purchaseCost: 6, quantity: 20 })

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: batch.id,
      direction: "out", quantity: 3, transactionType: "damage", reason: "dropped and broken",
    })

    const journal = await db.journal.findFirstOrThrow({
      where: { organizationId, referenceType: "stock_ledger_entry", referenceId: entry.id },
      include: { lines: true },
    })
    const writeOffLine = journal.lines.find((l) => l.accountId === writeOffAccountId)
    const inventoryLine = journal.lines.find((l) => l.accountId === inventoryAccountId)
    expect(Number(writeOffLine?.debit)).toBe(18) // 3 x 6
    expect(Number(inventoryLine?.credit)).toBe(18)
  }, TIMEOUT)

  it("an expiry adjustment posts the same write-off treatment as damage", async () => {
    const product = await createProduct(9)
    const batch = await createBatch(product.id, { purchaseCost: 9, quantity: 10 })

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: batch.id,
      direction: "out", quantity: 2, transactionType: "expiry", reason: "expired on shelf",
    })

    const journal = await db.journal.findFirstOrThrow({
      where: { organizationId, referenceType: "stock_ledger_entry", referenceId: entry.id },
      include: { lines: true },
    })
    expect(Number(journal.lines.find((l) => l.accountId === writeOffAccountId)?.debit)).toBe(18)
  }, TIMEOUT)

  // P2 §5: a batch-less "in" adjustment is no longer possible at all
  // (recordAdjustment now requires either an existing batchId or new-batch
  // fields — see its own doc comment in stock.ts) — this test now exercises
  // the "create a new batch inline, no cost given" path, which is what
  // preserves the same fallback-to-the-product's-purchaseCost valuation the
  // pre-P2 batch-less case used to test.
  it("a positive count-correction adjustment with a newly-created batch (no cost given) posts Dr Inventory Asset / Cr Inventory Adjustment Gain, falling back to the product's purchaseCost", async () => {
    const product = await createProduct(11)

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id,
      direction: "in", quantity: 5, transactionType: "adjustment", reason: "physical count found more",
      newBatchNumber: `B-COUNT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    })
    expect(entry.batchId).not.toBeNull()
    const newBatch = await db.productBatch.findUniqueOrThrow({ where: { id: entry.batchId! } })
    expect(Number(newBatch.purchaseCost)).toBe(11) // defaulted from product.purchaseCost — no newBatchPurchaseCost given

    const journal = await db.journal.findFirstOrThrow({
      where: { organizationId, referenceType: "stock_ledger_entry", referenceId: entry.id },
      include: { lines: true },
    })
    const gainLine = journal.lines.find((l) => l.accountId === gainAccountId)
    const inventoryLine = journal.lines.find((l) => l.accountId === inventoryAccountId)
    expect(Number(gainLine?.credit)).toBe(55) // 5 x product.purchaseCost (11), inherited by the new batch
    expect(Number(inventoryLine?.debit)).toBe(55)
  }, TIMEOUT)

  it("a 'return' adjustment posts no accounting entry at all — deliberately out of scope (see INVENTORY.md)", async () => {
    const product = await createProduct(15)
    const batch = await createBatch(product.id, { purchaseCost: 15, quantity: 10 })

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: batch.id,
      direction: "in", quantity: 1, transactionType: "return", reason: "unopened item returned",
    })

    const journal = await db.journal.findFirst({ where: { organizationId, referenceType: "stock_ledger_entry", referenceId: entry.id } })
    expect(journal).toBeNull()
  }, TIMEOUT)

  it("the inventory valuation report and COGS posting use the same batch-level cost basis", async () => {
    const product = await createProduct(20)
    await createBatch(product.id, { purchaseCost: 20, quantity: 10 })
    await createBatch(product.id, { purchaseCost: 25, quantity: 5, expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) })
    // Total on hand: 10 @ 20 + 5 @ 25 = 325

    const report = await getInventoryReport(session(), { from: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), to: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), branchId })
    const row = report.valuation.find((v) => v.productId === product.id)
    expect(row?.value).toBe(325)

    // Now sell 3 units — FEFO takes from whichever batch sorts first (no
    // expiry on the first, so it's treated as "last" per the nulls-last
    // FEFO order — the second batch, with a real expiry date, is consumed
    // first). Confirm the report's remaining value drops by exactly what
    // COGS posted for this sale.
    const charge = await createAdHocCharge(session(), {
      patientId, branchId, sourceType: "product", productId: product.id,
      description: "Reconciliation sale", quantity: 3, unitPrice: 50,
    })
    chargeIds.push(charge.id)

    const cogsJournal = await db.journal.findFirstOrThrow({
      where: { organizationId, referenceType: "charge_cogs", referenceId: charge.id },
      include: { lines: true },
    })
    const cogsAmount = Number(cogsJournal.lines.find((l) => l.accountId === cogsAccountId)?.debit)

    const reportAfter = await getInventoryReport(session(), { from: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), to: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), branchId })
    const rowAfter = reportAfter.valuation.find((v) => v.productId === product.id)
    expect(row!.value - rowAfter!.value).toBe(cogsAmount) // the report's own value drop exactly equals what COGS recognized
  }, TIMEOUT)
})
