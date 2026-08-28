import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { listAvailableBatches, consumeStock } from "@/lib/domains/inventory/stock"
import type { SessionContext } from "@/lib/auth/session"

// Real-DB $transaction round trips against this environment's Supabase
// pooler occasionally exceed vitest's default 5s test timeout.
const TIMEOUT = 30000

/**
 * P0-03 remediation tests (P0.md §14) — exact scenarios: Batch A (expired
 * yesterday), Batch B (expires tomorrow), Batch C (expires next month).
 * Allocation must produce B then C, never A. Also verifies that when only
 * expired stock remains, allocation fails with a real error rather than
 * silently substituting it.
 */
describe("P0-03: expired stock is excluded from FEFO allocation", () => {
  let organizationId: string
  let branchId: string
  let productId: string
  let batchAId: string
  let batchBId: string
  let batchCId: string
  const ledgerEntryIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-fefo",
      user: { id: "00000000-0000-0000-0000-0000000000f1", organizationId, email: "fefo@test.local", firstName: "Fefo", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["inventory.view", "inventory.adjust"]),
      roleNames: ["Pharmacist"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id

    const product = await db.product.create({
      data: {
        organizationId, name: `FEFO Test Product ${Date.now()}`, sku: `TESTFEFO-${Date.now()}`,
        category: "consumable", unit: "unit", reorderLevel: 0, purchaseCost: 1, sellingPrice: 2,
      },
    })
    productId = product.id

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    const batchA = await db.productBatch.create({
      data: { organizationId, productId, batchNumber: `A-${Date.now()}`, expiryDate: yesterday, purchaseCost: 1, receivedQuantity: 10 },
    })
    batchAId = batchA.id
    const batchB = await db.productBatch.create({
      data: { organizationId, productId, batchNumber: `B-${Date.now()}`, expiryDate: tomorrow, purchaseCost: 1, receivedQuantity: 10 },
    })
    batchBId = batchB.id
    const batchC = await db.productBatch.create({
      data: { organizationId, productId, batchNumber: `C-${Date.now()}`, expiryDate: nextMonth, purchaseCost: 1, receivedQuantity: 10 },
    })
    batchCId = batchC.id

    for (const batchId of [batchAId, batchBId, batchCId]) {
      const entry = await db.stockLedgerEntry.create({
        data: { organizationId, branchId, productId, batchId, transactionType: "purchase", quantity: 10, referenceType: "test" },
      })
      ledgerEntryIds.push(entry.id)
    }
  }, TIMEOUT)

  afterAll(async () => {
    // Query by productId broadly (not just the tracked ledgerEntryIds) —
    // defensive against a mid-test timeout leaving orphaned consumption
    // entries this test's own inline cleanup never reached.
    await db.stockLedgerEntry.deleteMany({ where: { productId } })
    await db.productBatch.deleteMany({ where: { id: { in: [batchAId, batchBId, batchCId] } } })
    await db.product.deleteMany({ where: { id: productId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("expired Batch A never appears in the available (allocatable) batch list", async () => {
    const available = await listAvailableBatches(session(), productId, branchId)
    const batchIds = available.map((b) => b.batch.id)
    expect(batchIds).not.toContain(batchAId)
    expect(batchIds).toContain(batchBId)
    expect(batchIds).toContain(batchCId)
  }, TIMEOUT)

  it("available batches are ordered B (expires tomorrow) before C (expires next month), A excluded entirely", async () => {
    const available = await listAvailableBatches(session(), productId, branchId)
    expect(available.map((b) => b.batch.id)).toEqual([batchBId, batchCId])
  }, TIMEOUT)

  it("consuming stock allocates from B and C in order, never touches expired A", async () => {
    // 15 units requested: should take all 10 from B, then 5 from C — never A.
    await db.$transaction(async (tx) => {
      await consumeStock(tx, {
        organizationId, branchId, productId, quantity: 15,
        referenceType: "test", referenceId: "fefo-test", performedBy: null,
      })
    })

    const [balanceA, balanceB, balanceC] = await Promise.all(
      [batchAId, batchBId, batchCId].map((batchId) =>
        db.stockLedgerEntry.aggregate({ where: { batchId }, _sum: { quantity: true } })
      )
    )
    expect(Number(balanceA._sum.quantity)).toBe(10) // untouched — still the original receipt, no consumption
    expect(Number(balanceB._sum.quantity)).toBe(0) // 10 received - 10 consumed
    expect(Number(balanceC._sum.quantity)).toBe(5) // 10 received - 5 consumed

    // Clean up the consumption entries this test created so later assertions
    // in this file see the original fixture state again.
    const consumptionEntries = await db.stockLedgerEntry.findMany({ where: { referenceId: "fefo-test" } })
    await db.stockLedgerEntry.deleteMany({ where: { id: { in: consumptionEntries.map((e) => e.id) } } })
  }, TIMEOUT)

  it("requesting more than the unexpired total fails with a meaningful error rather than consuming expired Batch A", async () => {
    // Only B (10) + C (10) = 20 unexpired units exist; A (10, expired) must
    // never be used to make up the difference.
    await expect(
      db.$transaction(async (tx) => {
        await consumeStock(tx, {
          organizationId, branchId, productId, quantity: 25,
          referenceType: "test", referenceId: "fefo-test-overdraw", performedBy: null,
        })
      })
    ).rejects.toThrow(/Insufficient stock/)

    // Confirm nothing was actually consumed from any batch — the whole
    // transaction rolled back, including A.
    const balanceA = await db.stockLedgerEntry.aggregate({ where: { batchId: batchAId }, _sum: { quantity: true } })
    expect(Number(balanceA._sum.quantity)).toBe(10)
  }, TIMEOUT)
})
