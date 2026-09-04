import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { recordAdjustment, listAvailableBatches } from "@/lib/domains/inventory/stock"
import { stockAdjustmentSchema } from "@/lib/domains/inventory/schemas"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P2 Batch 4 (§5) — batch-aware manual inventory adjustments. See
 * P2_REMEDIATION_REPORT.md and recordAdjustment's own doc comment
 * (stock.ts) for the full redesign. Covers exactly the six scenarios
 * P2.md §5 names: batch increase, batch decrease, insufficient batch
 * balance, expired batch adjustment, multi-batch product, audit/reference
 * integrity — plus the schema-level refinements that make a batch-less
 * adjustment impossible before it ever reaches the service layer.
 */
const TIMEOUT = 60000

describe("P2 §5: stockAdjustmentSchema rejects batch-less adjustments", () => {
  const base = {
    branchId: "11111111-1111-4111-8111-111111111111",
    productId: "22222222-2222-4222-8222-222222222222",
    quantity: 5,
    reason: "test",
  }

  it("rejects an 'out' adjustment with no batchId", () => {
    const result = stockAdjustmentSchema.safeParse({ ...base, direction: "out" })
    expect(result.success).toBe(false)
  })

  it("rejects an 'in' adjustment with neither batchId nor newBatchNumber", () => {
    const result = stockAdjustmentSchema.safeParse({ ...base, direction: "in" })
    expect(result.success).toBe(false)
  })

  it("accepts an 'in' adjustment with a newBatchNumber and no batchId", () => {
    const result = stockAdjustmentSchema.safeParse({ ...base, direction: "in", newBatchNumber: "LOT-1" })
    expect(result.success).toBe(true)
  })

  it("accepts an 'out' adjustment with a batchId", () => {
    const result = stockAdjustmentSchema.safeParse({ ...base, direction: "out", batchId: "33333333-3333-4333-8333-333333333333" })
    expect(result.success).toBe(true)
  })
})

describe("P2 §5: batch-aware manual inventory adjustments", () => {
  let organizationId: string
  let branchId: string
  let userId: string
  const productIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-p2-batch4-inventory-adjustment",
      user: { id: userId, organizationId, email: "p2-batch4-inventory-test@test.local", firstName: "Inv", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["inventory.view", "inventory.adjust"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createProduct(purchaseCost: number) {
    const product = await db.product.create({
      data: {
        organizationId,
        name: `P2B4 Adjustment Test Product ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sku: `TESTP2B4-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        category: "consumable",
        unit: "unit",
        reorderLevel: 0,
        purchaseCost,
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
        batchNumber: `P2B4-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

  async function batchBalance(batchId: string) {
    const result = await db.stockLedgerEntry.aggregate({ where: { organizationId, branchId, batchId }, _sum: { quantity: true } })
    return Number(result._sum?.quantity ?? 0)
  }

  async function productBalance(productId: string) {
    const result = await db.stockLedgerEntry.aggregate({ where: { organizationId, branchId, productId }, _sum: { quantity: true } })
    return Number(result._sum?.quantity ?? 0)
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: productIds } } })
    await db.productBatch.deleteMany({ where: { productId: { in: productIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("batch increase: adding to an existing batch raises that batch's balance and the product's aggregate balance identically", async () => {
    const product = await createProduct(10)
    const batch = await createBatch(product.id, { purchaseCost: 10, quantity: 20 })

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: batch.id,
      direction: "in", quantity: 5, transactionType: "adjustment", reason: "physical count found more of this exact lot",
    })

    expect(entry.batchId).toBe(batch.id)
    expect(Number(entry.quantity)).toBe(5)
    expect(await batchBalance(batch.id)).toBe(25) // 20 + 5
    expect(await productBalance(product.id)).toBe(25) // ledger stays reconcilable with batch-level stock
  }, TIMEOUT)

  it("batch increase via a newly-created batch: creates the batch inline and posts the ledger entry against it", async () => {
    const product = await createProduct(12)

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id,
      direction: "in", quantity: 8, transactionType: "adjustment", reason: "newly discovered, unlogged stock",
      newBatchNumber: `P2B4-NEW-${Date.now()}`,
      newBatchPurchaseCost: 12,
    })

    expect(entry.batchId).not.toBeNull()
    const batch = await db.productBatch.findUniqueOrThrow({ where: { id: entry.batchId! } })
    expect(Number(batch.purchaseCost)).toBe(12)
    expect(batch.receivedQuantity).toBe(8)
    expect(await batchBalance(batch.id)).toBe(8)
    expect(await productBalance(product.id)).toBe(8)
  }, TIMEOUT)

  it("batch decrease: removing from an existing batch lowers only that batch's balance", async () => {
    const product = await createProduct(15)
    const batch = await createBatch(product.id, { purchaseCost: 15, quantity: 30 })

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: batch.id,
      direction: "out", quantity: 10, transactionType: "damage", reason: "dropped during restocking",
    })

    expect(entry.batchId).toBe(batch.id)
    expect(Number(entry.quantity)).toBe(-10)
    expect(await batchBalance(batch.id)).toBe(20) // 30 - 10
    expect(await productBalance(product.id)).toBe(20)
  }, TIMEOUT)

  it("insufficient batch balance: a reduction larger than the selected batch's own balance is rejected, and posts nothing", async () => {
    const product = await createProduct(20)
    const batch = await createBatch(product.id, { purchaseCost: 20, quantity: 5 })

    await expect(
      recordAdjustment(session(), {
        branchId, productId: product.id, batchId: batch.id,
        direction: "out", quantity: 6, transactionType: "adjustment", reason: "count correction attempt",
      })
    ).rejects.toThrow(/only 5 units available/i)

    // Nothing was written — the balance is unchanged and no stray ledger row exists.
    expect(await batchBalance(batch.id)).toBe(5)
    const entries = await db.stockLedgerEntry.findMany({ where: { organizationId, batchId: batch.id } })
    expect(entries).toHaveLength(1) // only the original createBatch purchase entry
  }, TIMEOUT)

  it("expired batch adjustment: an expired batch — excluded from the FEFO-allocatable pool — can still be explicitly targeted for a write-off reduction", async () => {
    const product = await createProduct(8)
    const expiredBatch = await createBatch(product.id, {
      purchaseCost: 8, quantity: 12, expiryDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
    })

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: expiredBatch.id,
      direction: "out", quantity: 12, transactionType: "expiry", reason: "expired stock written off",
    })

    expect(entry.batchId).toBe(expiredBatch.id)
    expect(await batchBalance(expiredBatch.id)).toBe(0)
  }, TIMEOUT)

  it("expired batches are excluded from the FEFO-allocatable pool even though the manual adjustment path can still target them directly — proving 'keep FEFO consumption logic unchanged'", async () => {
    const product = await createProduct(8)
    const expiredBatch = await createBatch(product.id, {
      purchaseCost: 8, quantity: 5, expiryDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    })
    const freshBatch = await createBatch(product.id, { purchaseCost: 8, quantity: 5 })

    const allocatable = await listAvailableBatches(session(), product.id, branchId)
    const allocatableIds = allocatable.map((b) => b.batch.id)
    expect(allocatableIds).not.toContain(expiredBatch.id)
    expect(allocatableIds).toContain(freshBatch.id)

    // Yet a manual adjustment can still explicitly target the expired batch
    // — the whole point of this batch's redesign (writing off expired
    // stock is a named required scenario, not something FEFO exclusion
    // should also block for a direct, staff-initiated correction).
    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: expiredBatch.id,
      direction: "out", quantity: 5, transactionType: "expiry", reason: "confirmed still targetable despite FEFO exclusion",
    })
    expect(entry.batchId).toBe(expiredBatch.id)
  }, TIMEOUT)

  it("multi-batch product: adjustments against one batch never move another batch's balance, and the product aggregate always equals the sum of its batches", async () => {
    const product = await createProduct(5)
    const batchA = await createBatch(product.id, { purchaseCost: 5, quantity: 10 })
    const batchB = await createBatch(product.id, { purchaseCost: 5.5, quantity: 15 })
    const batchC = await createBatch(product.id, { purchaseCost: 6, quantity: 20 })

    await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: batchB.id,
      direction: "out", quantity: 4, transactionType: "adjustment", reason: "count correction against batch B only",
    })
    await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: batchA.id,
      direction: "in", quantity: 3, transactionType: "adjustment", reason: "count correction against batch A only",
    })

    expect(await batchBalance(batchA.id)).toBe(13) // 10 + 3
    expect(await batchBalance(batchB.id)).toBe(11) // 15 - 4
    expect(await batchBalance(batchC.id)).toBe(20) // untouched

    const sumOfBatches = (await batchBalance(batchA.id)) + (await batchBalance(batchB.id)) + (await batchBalance(batchC.id))
    expect(await productBalance(product.id)).toBe(sumOfBatches) // ledger and batch-level stock never diverge
  }, TIMEOUT)

  it("audit/reference integrity: the ledger entry, audit log, and optional external reference are all correctly recorded and traceable", async () => {
    const product = await createProduct(9)
    const batch = await createBatch(product.id, { purchaseCost: 9, quantity: 10 })

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: batch.id,
      direction: "out", quantity: 2, transactionType: "adjustment", reason: "physical count found less",
      reference: "COUNT-SHEET-2026-014",
    })

    // The ledger entry itself identifies every dimension P2.md §5 names:
    // product, branch, batch, quantity, reason, adjustment type, user, timestamp, reference.
    const reloaded = await db.stockLedgerEntry.findUniqueOrThrow({ where: { id: entry.id } })
    expect(reloaded.productId).toBe(product.id)
    expect(reloaded.branchId).toBe(branchId)
    expect(reloaded.batchId).toBe(batch.id)
    expect(Number(reloaded.quantity)).toBe(-2)
    expect(reloaded.reason).toBe("physical count found less")
    expect(reloaded.transactionType).toBe("adjustment")
    expect(reloaded.performedBy).toBe(userId)
    expect(reloaded.createdAt).toBeInstanceOf(Date)
    expect(reloaded.referenceType).toBe("manual_adjustment")
    expect(reloaded.referenceId).toBe("COUNT-SHEET-2026-014")

    // A real, queryable audit_log entry exists for this exact ledger row —
    // the "always traceable" half of the same requirement.
    const auditEntry = await db.auditLog.findFirst({
      where: { organizationId, entityType: "stock_ledger_entry", entityId: entry.id },
      orderBy: { createdAt: "desc" },
    })
    expect(auditEntry).not.toBeNull()
    expect(auditEntry!.userId).toBe(userId)
    expect(auditEntry!.action).toBe("create")
    const newValues = auditEntry!.newValues as Record<string, unknown>
    expect(newValues.batchId).toBe(batch.id)
    expect(newValues.reference).toBe("COUNT-SHEET-2026-014")
  }, TIMEOUT)

  it("omitting reference leaves referenceType/referenceId null — reference stays optional, not a required field", async () => {
    const product = await createProduct(7)
    const batch = await createBatch(product.id, { purchaseCost: 7, quantity: 10 })

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id, batchId: batch.id,
      direction: "out", quantity: 1, transactionType: "adjustment", reason: "no external document for this one",
    })

    const reloaded = await db.stockLedgerEntry.findUniqueOrThrow({ where: { id: entry.id } })
    expect(reloaded.referenceType).toBeNull()
    expect(reloaded.referenceId).toBeNull()
  }, TIMEOUT)

  it("a batchId belonging to a different product is rejected, not silently accepted", async () => {
    const productA = await createProduct(10)
    const productB = await createProduct(10)
    const batchOfA = await createBatch(productA.id, { purchaseCost: 10, quantity: 10 })

    await expect(
      recordAdjustment(session(), {
        branchId, productId: productB.id, batchId: batchOfA.id,
        direction: "out", quantity: 1, transactionType: "adjustment", reason: "cross-product batch attempt",
      })
    ).rejects.toThrow(/batch was not found/i)
  }, TIMEOUT)

  it("adding to an existing batch by re-entering its exact batch number (not the dropdown) reuses that batch instead of erroring on the unique constraint", async () => {
    const product = await createProduct(6)
    const batch = await createBatch(product.id, { purchaseCost: 6, quantity: 5 })

    const entry = await recordAdjustment(session(), {
      branchId, productId: product.id,
      direction: "in", quantity: 2, transactionType: "adjustment", reason: "adding to the same lot by number",
      newBatchNumber: batch.batchNumber,
    })

    expect(entry.batchId).toBe(batch.id) // reused, not a second batch row
    expect(await batchBalance(batch.id)).toBe(7) // 5 + 2
    const batchCount = await db.productBatch.count({ where: { productId: product.id } })
    expect(batchCount).toBe(1)
  }, TIMEOUT)
})
