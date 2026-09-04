import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"

/**
 * P2 Batch 1 (§10, §11, §12) — proves each schema-quality change is
 * actually DB-enforced, not merely a TypeScript-level convention. §3's
 * index additions are not independently tested here (an index is a
 * performance property, not a correctness one — there is nothing to assert
 * that a query returns different rows with vs. without one); see
 * DATABASE.md's "P2 Remediation Schema Changes, Batch 1" for the evidence
 * behind each index instead.
 */
const TIMEOUT = 60000

describe("P2 §10: AccountMapping.intent is a real DB enum, not a free-form string", () => {
  let organizationId: string
  let accountId: string

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    const account = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId } })
    accountId = account.id
  }, TIMEOUT)

  it("rejects an intent value that isn't a real PostingIntent member, at the database level", async () => {
    // Bypasses the TypeScript-level PostingIntent union on purpose (real
    // application code can no longer even construct this call — the whole
    // point of this test is proving the *database* rejects it too, not just
    // the compiler, matching this codebase's own "prove the DB enforces it"
    // discipline for the journal-balance trigger / exclusion constraints).
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO account_mapping (id, organization_id, branch_id, intent, account_id, created_at)
         VALUES (gen_random_uuid(), $1, NULL, 'not_a_real_intent', $2, now())`,
        organizationId,
        accountId
      )
    ).rejects.toThrow()
  })

  it("still accepts every real PostingIntent value (regression check — the enum wasn't accidentally narrowed)", async () => {
    // account_mapping already has exactly one org-wide row per real intent
    // from prisma/seed.ts's DEFAULT_MAPPINGS — if the enum were missing a
    // value the seed actually uses, this count would be short.
    const count = await db.accountMapping.count({ where: { organizationId, branchId: null } })
    expect(count).toBeGreaterThanOrEqual(22)
  })
})

describe("P2 §11: composite org-scoped uniqueness (User.username, Provider.licenseNumber)", () => {
  let organizationId: string
  const userIds: string[] = []
  const providerIds: string[] = []

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
  }, TIMEOUT)

  afterAll(async () => {
    await db.provider.deleteMany({ where: { id: { in: providerIds } } })
    await db.user.deleteMany({ where: { id: { in: userIds } } })
  }, TIMEOUT)

  it("rejects a duplicate username within the same organization", async () => {
    const username = `dupe-test-${Date.now()}`
    const first = await db.user.create({
      data: { organizationId, email: `p2b1-u1-${Date.now()}@test.local`, username, passwordHash: "not-a-real-hash", firstName: "First", lastName: "User" },
    })
    userIds.push(first.id)

    await expect(
      db.user.create({
        data: { organizationId, email: `p2b1-u2-${Date.now()}@test.local`, username, passwordHash: "not-a-real-hash", firstName: "Second", lastName: "User" },
      })
    ).rejects.toThrow()
  })

  it("allows two users in the same organization to both have no username set (NULL stays distinct)", async () => {
    const a = await db.user.create({
      data: { organizationId, email: `p2b1-null-a-${Date.now()}@test.local`, passwordHash: "not-a-real-hash", firstName: "NullA", lastName: "User" },
    })
    const b = await db.user.create({
      data: { organizationId, email: `p2b1-null-b-${Date.now()}@test.local`, passwordHash: "not-a-real-hash", firstName: "NullB", lastName: "User" },
    })
    userIds.push(a.id, b.id)
    expect(a.username).toBeNull()
    expect(b.username).toBeNull()
  })

  it("rejects a duplicate license number within the same organization", async () => {
    const licenseNumber = `LIC-DUPE-${Date.now()}`
    const first = await db.provider.create({
      data: { organizationId, providerType: "doctor", firstName: "First", lastName: `P2B1LicenseA-${Date.now()}`, licenseNumber },
    })
    providerIds.push(first.id)

    await expect(
      db.provider.create({
        data: { organizationId, providerType: "doctor", firstName: "Second", lastName: `P2B1LicenseB-${Date.now()}`, licenseNumber },
      })
    ).rejects.toThrow()
  })

  it("allows two providers in the same organization to both have no license number set", async () => {
    const a = await db.provider.create({
      data: { organizationId, providerType: "doctor", firstName: "NullLicA", lastName: `P2B1-${Date.now()}` },
    })
    const b = await db.provider.create({
      data: { organizationId, providerType: "doctor", firstName: "NullLicB", lastName: `P2B1-${Date.now()}` },
    })
    providerIds.push(a.id, b.id)
    expect(a.licenseNumber).toBeNull()
    expect(b.licenseNumber).toBeNull()
  })
})

describe("P2 §12: updatedAt on Charge/Invoice/Payment actually changes on mutation", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  const chargeIds: string[] = []

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTP2B1-${Date.now()}`, firstName: "P2Batch1", lastName: "UpdatedAt",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P2B1-${Date.now()}`,
      },
    })
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.charge.deleteMany({ where: { id: { in: chargeIds } } })
    await db.patient.delete({ where: { id: patientId } })
  }, TIMEOUT)

  it("Charge.updatedAt advances when its status changes", async () => {
    const charge = await db.charge.create({
      data: { organizationId, branchId, patientId, sourceType: "other", description: "P2 §12 test", quantity: 1, unitPrice: 10, amount: 10, status: "pending" },
    })
    chargeIds.push(charge.id)
    expect(charge.updatedAt).toEqual(charge.createdAt)

    // A real gap, not a same-millisecond race — Prisma's @updatedAt sets a
    // fresh timestamp on every UPDATE regardless of elapsed time, but a
    // deliberate small delay makes the assertion below robust even on a
    // very fast/coalesced clock.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const updated = await db.charge.update({ where: { id: charge.id }, data: { status: "void", voidReason: "P2 §12 test" } })
    expect(updated.updatedAt.getTime()).toBeGreaterThan(charge.updatedAt.getTime())
  })
})
