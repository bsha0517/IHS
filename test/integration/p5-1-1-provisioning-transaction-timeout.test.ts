import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { createPlatformSession } from "@/lib/auth/platform-session"
import { provisionClinic } from "@/lib/domains/commercial/provisioning"
import { MODULE_KEYS } from "@/lib/platform/entitlements-shared"
import type { PlatformSessionContext } from "@/lib/auth/platform-session"
import type { ProvisionClinicInput } from "@/lib/domains/commercial/schemas"

const TIMEOUT = 60000

function ownerDb() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
}

async function makePlatformOperator(emailPrefix: string) {
  const operator = await db.platformOperator.create({
    data: { email: `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, passwordHash: "x", firstName: "P5.1.1", lastName: "Operator" },
  })
  await createPlatformSession({ operatorId: operator.id })
  const session: PlatformSessionContext = {
    sessionId: "test-session",
    operator: { id: operator.id, email: operator.email, firstName: operator.firstName, lastName: operator.lastName },
  }
  return { operator, session }
}

async function makePlan(codePrefix: string) {
  return db.commercialPlan.create({
    data: { code: `${codePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: `${codePrefix} plan`, userLimit: null, branchLimit: null, defaultModuleKeys: [...MODULE_KEYS] },
  })
}

function baseProvisionInput(overrides: Partial<ProvisionClinicInput> & { planId: string }): ProvisionClinicInput {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`
  return {
    idempotencyKey: crypto.randomUUID(),
    legalName: "P5.1.1 Test Clinic Legal",
    displayName: "P5.1.1 Test Clinic",
    defaultCurrency: "USD",
    defaultTimezone: "Asia/Karachi",
    legalBusinessName: null,
    primaryContactName: "P5.1.1 Contact",
    primaryContactEmail: "p511-contact@test.local",
    primaryContactPhone: null,
    billingContactName: null,
    billingContactEmail: null,
    country: "PK",
    implementationOwner: "P5.1.1 Test Suite",
    internalNotes: null,
    subscriptionStatus: "trial",
    startDate: new Date(),
    trialEndsAt: null,
    agreedUserLimit: null,
    agreedBranchLimit: null,
    agreedAmount: null,
    currency: null,
    billingCycle: null,
    subscriptionNotes: null,
    branchName: "P5.1.1 Main Branch",
    branchCode: `P511-${suffix}`,
    branchAddress: null,
    branchPhone: null,
    adminEmail: `p511-admin-${suffix}@test.local`,
    adminFirstName: "P5.1.1",
    adminLastName: "Admin",
    moduleKeys: undefined,
    ...overrides,
  }
}

async function cleanupProvisionedOrg(orgId: string) {
  const owner = ownerDb()
  await owner.eInvoiceSubmission.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.goLiveCondition.deleteMany({ where: { commercialProfile: { organizationId: orgId } } }).catch(() => {})
  await owner.organizationSubscription.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.organizationCommercialProfile.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.setting.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  const users = await owner.user.findMany({ where: { organizationId: orgId }, select: { id: true } })
  await owner.passwordResetToken.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } }).catch(() => {})
  await owner.userBranchAccess.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } }).catch(() => {})
  await owner.userRole.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } }).catch(() => {})
  await owner.user.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.rolePermission.deleteMany({ where: { role: { organizationId: orgId } } }).catch(() => {})
  await owner.role.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.branch.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.organization.deleteMany({ where: { id: orgId } }).catch(() => {})
  await owner.$disconnect()
}

/**
 * P5.1.1 hotfix — confirms `provisionClinic()`'s transaction actually
 * receives the widened `{ timeout: 20_000, maxWait: 10_000 }` options
 * (matching posting-service.ts's own `POSTING_TRANSACTION_OPTIONS`
 * precedent), without needing the automated suite to literally wait past
 * Prisma's 5000ms default to reproduce the real production latency that
 * originally surfaced this (P5.6 release smoke test, ~5434ms). `vi.spyOn`
 * wraps the real `db.$transaction` (via `mockImplementation` that calls
 * straight through to the original), so this observes the call arguments
 * without altering provisioning's real behavior — the row-level assertions
 * below prove the transaction body itself is functionally unchanged.
 */
describe("P5.1.1: provisioning transaction timeout", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p511-op")
    operatorId = op.operator.id
    operatorSession = op.session
    const plan = await makePlan("p511-plan")
    planId = plan.id
  }, TIMEOUT)

  afterAll(async () => {
    for (const orgId of createdOrgIds) await cleanupProvisionedOrg(orgId)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("calls db.$transaction with the widened timeout/maxWait options, and provisioning still succeeds with the exact same resulting rows", async () => {
    const originalTransaction = db.$transaction.bind(db)
    const spy = vi.spyOn(db, "$transaction").mockImplementation((...args: Parameters<typeof db.$transaction>) => originalTransaction(...args))

    try {
      const input = baseProvisionInput({ planId })
      const result = await provisionClinic(operatorSession, input)
      createdOrgIds.push(result.organizationId)

      expect(spy).toHaveBeenCalled()
      const [, options] = spy.mock.calls[0]
      expect(options).toMatchObject({ timeout: 20_000, maxWait: 10_000 })

      // Functional proof the transaction body itself is unchanged — same
      // atomic result set as before the hotfix.
      const org = await db.organization.findUniqueOrThrow({ where: { id: result.organizationId } })
      expect(org.displayName).toBe(input.displayName)
      const branch = await db.branch.findUniqueOrThrow({ where: { id: result.branchId } })
      expect(branch.code).toBe(input.branchCode)
      const admin = await db.user.findUniqueOrThrow({ where: { id: result.adminUserId } })
      expect(admin.email).toBe(input.adminEmail.toLowerCase())
      const profile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { id: result.commercialProfileId } })
      expect(profile.customerCode).toBe(result.customerCode)
      const goLiveConditions = await db.goLiveCondition.findMany({ where: { commercialProfileId: result.commercialProfileId } })
      expect(goLiveConditions.length).toBe(4)
    } finally {
      spy.mockRestore()
    }
  }, TIMEOUT)
})
