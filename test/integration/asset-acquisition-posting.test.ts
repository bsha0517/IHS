import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { createAsset } from "@/lib/domains/assets/assets"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §17: asset purchases post to a dedicated Fixed Assets account — never
 * ordinary Inventory or Operating Expenses — and acquisition cost is
 * tracked against the Asset record itself. See postAssetAcquired
 * (accounting/posting-service.ts) and createAsset (assets.ts).
 */
const TIMEOUT = 60000

describe("P1 §17: asset acquisition posting", () => {
  let organizationId: string
  let branchId: string
  let userId: string
  let fixedAssetAccountId: string
  let apAccountId: string
  let bankAccountId: string
  const assetIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-asset-acquisition",
      user: { id: userId, organizationId, email: "asset-acquisition-test@test.local", firstName: "Asset", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["asset.manage"]),
      roleNames: ["Super Admin"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    // P2 §14: previously a hardcoded, never-created id — createAsset's
    // synchronous postAssetAcquired posting writes this straight into
    // Journal.postedBy, which now has a real FK to `user` (§14, Category A).
    // Same class of fix as the other test files this batch.
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const [fixedAsset, ap, bank] = await Promise.all([
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1400" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "2000" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1010" } }),
    ])
    fixedAssetAccountId = fixedAsset.id
    apAccountId = ap.id
    bankAccountId = bank.id
  }, TIMEOUT)

  afterAll(async () => {
    const journals = await db.journal.findMany({ where: { organizationId, referenceType: "asset", referenceId: { in: assetIds } } })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.asset.deleteMany({ where: { id: { in: assetIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("an asset bought on credit (no paidVia) posts Dr Fixed Assets / Cr Accounts Payable, never Inventory or Operating Expenses", async () => {
    const asset = await createAsset(session(), {
      branchId, name: "Ultrasound Machine", category: "medical_equipment", cost: 15000,
    })
    assetIds.push(asset.id)
    expect(Number(asset.cost)).toBe(15000)

    const journal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "asset", referenceId: asset.id }, include: { lines: true } })
    const fixedAssetLine = journal.lines.find((l) => l.accountId === fixedAssetAccountId)
    const apLine = journal.lines.find((l) => l.accountId === apAccountId)
    expect(Number(fixedAssetLine?.debit)).toBe(15000)
    expect(Number(apLine?.credit)).toBe(15000)
  }, TIMEOUT)

  it("an asset paid immediately (paidVia set) posts Dr Fixed Assets / Cr the resolved tender account", async () => {
    const asset = await createAsset(session(), {
      branchId, name: "Office Desk", category: "furniture", cost: 500, paidVia: "bank",
    })
    assetIds.push(asset.id)

    const journal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "asset", referenceId: asset.id }, include: { lines: true } })
    const fixedAssetLine = journal.lines.find((l) => l.accountId === fixedAssetAccountId)
    const bankLine = journal.lines.find((l) => l.accountId === bankAccountId)
    expect(Number(fixedAssetLine?.debit)).toBe(500)
    expect(Number(bankLine?.credit)).toBe(500)
  }, TIMEOUT)

  it("an asset entered with no cost (e.g. donated/pre-owned, tracking only) posts nothing", async () => {
    const asset = await createAsset(session(), {
      branchId, name: "Donated Wheelchair", category: "equipment",
    })
    assetIds.push(asset.id)
    expect(asset.cost).toBeNull()

    const journal = await db.journal.findFirst({ where: { organizationId, referenceType: "asset", referenceId: asset.id } })
    expect(journal).toBeNull()
  }, TIMEOUT)

  it("depreciation-readiness fields exist on the Asset record and default to null (no depreciation logic runs yet)", async () => {
    const asset = await db.asset.findUniqueOrThrow({ where: { id: assetIds[0] } })
    expect(asset.depreciationMethod).toBeNull()
    expect(asset.usefulLifeMonths).toBeNull()
    expect(asset.salvageValue).toBeNull()
    expect(asset.depreciationStartDate).toBeNull()
  }, TIMEOUT)
})
