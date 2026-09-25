import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { createPlatformSession } from "@/lib/auth/platform-session"
import { provisionClinic } from "@/lib/domains/commercial/provisioning"
import { getFinancialReadinessGaps } from "@/lib/domains/accounting/posting-service"
import { getGoLiveBlockers, approveGoLive, GoLiveNotReadyError } from "@/lib/domains/commercial/organizations"
import { MODULE_KEYS } from "@/lib/platform/entitlements-shared"
import type { PlatformSessionContext } from "@/lib/auth/platform-session"
import type { ProvisionClinicInput } from "@/lib/domains/commercial/schemas"

const TIMEOUT = 60000

/**
 * P5.4 §4/§10 — missing required financial configuration must be visible
 * BEFORE go-live, detected server-side and enforced through the same
 * authoritative `getGoLiveBlockers`/`approveGoLive` mechanism the UI renders
 * from — never a UI-only check. `getFinancialReadinessGaps`
 * (src/lib/domains/accounting/posting-service.ts) is exercised here against
 * a real provisioned organization, not mocked.
 */

function ownerDb() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
}

async function makePlatformOperator(emailPrefix: string) {
  const operator = await db.platformOperator.create({
    data: { email: `${emailPrefix}-${Date.now()}@test.local`, passwordHash: "x", firstName: "P5.4", lastName: "Operator" },
  })
  await createPlatformSession({ operatorId: operator.id })
  const session: PlatformSessionContext = {
    sessionId: "test-session",
    operator: { id: operator.id, email: operator.email, firstName: operator.firstName, lastName: operator.lastName },
  }
  return { operator, session }
}

async function makePlan(codePrefix: string, moduleKeys: string[]) {
  return db.commercialPlan.create({
    data: { code: `${codePrefix}-${Date.now()}`, name: `${codePrefix} plan`, userLimit: null, branchLimit: null, defaultModuleKeys: moduleKeys },
  })
}

function baseProvisionInput(planId: string): ProvisionClinicInput {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`
  return {
    idempotencyKey: crypto.randomUUID(),
    legalName: `P5.4 Fin Test Clinic Legal ${suffix}`,
    displayName: `P5.4 Fin Test Clinic ${suffix}`,
    defaultCurrency: "USD",
    defaultTimezone: "UTC",
    branchName: "Main Branch",
    branchCode: `P54F-${suffix}`.slice(0, 20),
    branchAddress: null,
    branchPhone: null,
    adminFirstName: "Test",
    adminLastName: "Admin",
    adminEmail: `p54-fin-admin-${suffix}@test.local`,
    planId,
    country: "US",
    legalBusinessName: null,
    primaryContactName: null,
    primaryContactEmail: null,
    primaryContactPhone: null,
    billingContactName: null,
    billingContactEmail: null,
    implementationOwner: null,
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
    moduleKeys: undefined,
  }
}

async function cleanupOrg(orgId: string) {
  await db.accountMapping.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await db.chartOfAccount.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await db.commTemplate.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await db.goLiveCondition.deleteMany({ where: { commercialProfile: { organizationId: orgId } } }).catch(() => {})
  await db.organizationSubscription.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await db.organizationCommercialProfile.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await db.setting.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await db.onboardingChecklistItem.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  const users = await db.user.findMany({ where: { organizationId: orgId }, select: { id: true } })
  await db.passwordResetToken.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } }).catch(() => {})
  await db.userBranchAccess.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } }).catch(() => {})
  await db.userRole.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } }).catch(() => {})
  await db.user.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await db.rolePermission.deleteMany({ where: { role: { organizationId: orgId } } }).catch(() => {})
  await db.role.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await db.branch.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  const owner = ownerDb()
  await owner.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.$disconnect()
  await db.organization.deleteMany({ where: { id: orgId } }).catch(() => {})
}

/** Fills EVERY intent `getFinancialReadinessGaps` could possibly require, so a test can start from "fully configured" and remove one mapping to isolate a single gap. */
async function fillAllMappings(organizationId: string) {
  const account = await db.chartOfAccount.create({ data: { organizationId, code: `TEST-${Date.now()}`, name: "Test Catch-all Account", type: "asset" } })
  const allIntents = [
    "cash", "card", "bank", "online", "insurance", "credit", "other",
    "accounts_receivable", "revenue", "tax_payable", "unearned_revenue",
    "inventory_asset", "accounts_payable", "salary_expense", "payroll_payable",
    "cogs", "inventory_write_off", "inventory_adjustment_gain",
    "goods_received_not_invoiced", "recoverable_tax", "fixed_asset",
  ] as const
  await db.accountMapping.createMany({ data: allIntents.map((intent) => ({ organizationId, branchId: null, intent, accountId: account.id })) })
  return account.id
}

describe("P5.4 — financial configuration readiness", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planPosBillingId: string
  let planNoFinanceId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p54-fin-op")
    operatorId = op.operator.id
    operatorSession = op.session
    planPosBillingId = (await makePlan("p54-fin-plan-pos", [...MODULE_KEYS])).id
    planNoFinanceId = (await makePlan("p54-fin-plan-nofin", MODULE_KEYS.filter((k) => !["pos_billing", "inventory", "procurement", "payroll", "assets", "finance"].includes(k)))).id
  }, TIMEOUT)

  afterAll(async () => {
    for (const orgId of createdOrgIds) await cleanupOrg(orgId)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: { in: [planPosBillingId, planNoFinanceId] } } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("an enabled module with a missing required mapping produces a gap and a go-live blocker", async () => {
    const provisioned = await provisionClinic(operatorSession, baseProvisionInput(planPosBillingId))
    createdOrgIds.push(provisioned.organizationId)

    const gaps = await getFinancialReadinessGaps(provisioned.organizationId)
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.some((g) => g.intent === "accounts_receivable")).toBe(true)
    expect(gaps.find((g) => g.intent === "accounts_receivable")!.requiredByModules).toContain("pos_billing")

    const blockers = await getGoLiveBlockers(provisioned.organizationId)
    expect(blockers.some((b) => /account mapping/i.test(b))).toBe(true)
  }, TIMEOUT)

  it("once every required mapping is present, no financial gap remains", async () => {
    const provisioned = await provisionClinic(operatorSession, baseProvisionInput(planPosBillingId))
    createdOrgIds.push(provisioned.organizationId)

    await fillAllMappings(provisioned.organizationId)

    const gaps = await getFinancialReadinessGaps(provisioned.organizationId)
    expect(gaps).toEqual([])

    const blockers = await getGoLiveBlockers(provisioned.organizationId)
    expect(blockers.some((b) => /account mapping/i.test(b))).toBe(false)
  }, TIMEOUT)

  it("a disabled module's mapping requirement is never flagged as a gap", async () => {
    const provisioned = await provisionClinic(operatorSession, baseProvisionInput(planNoFinanceId))
    createdOrgIds.push(provisioned.organizationId)

    const gaps = await getFinancialReadinessGaps(provisioned.organizationId)
    // pos_billing/inventory/procurement/payroll/assets are all disabled on
    // this plan — none of their intents (e.g. accounts_receivable,
    // payroll_payable, fixed_asset) should appear as a required gap.
    expect(gaps.length).toBe(0)

    const blockers = await getGoLiveBlockers(provisioned.organizationId)
    expect(blockers.some((b) => /account mapping/i.test(b))).toBe(false)
  }, TIMEOUT)

  it("a direct server-side go-live approval attempt is rejected while a required mapping is missing, and succeeds once it's configured", async () => {
    const provisioned = await provisionClinic(operatorSession, baseProvisionInput(planPosBillingId))
    createdOrgIds.push(provisioned.organizationId)

    // Satisfy every OTHER go-live prerequisite so the financial gap is
    // isolated as the one remaining blocker.
    await db.goLiveCondition.updateMany({ where: { commercialProfile: { organizationId: provisioned.organizationId } }, data: { status: "complete" } })
    await db.onboardingChecklistItem.updateMany({ where: { organizationId: provisioned.organizationId, required: true }, data: { status: "completed" } })

    await expect(approveGoLive(provisioned.organizationId, operatorId, null)).rejects.toThrow(GoLiveNotReadyError)

    await fillAllMappings(provisioned.organizationId)

    const approved = await approveGoLive(provisioned.organizationId, operatorId, null)
    expect(approved.commercialLifecycle).toBe("live")
  }, TIMEOUT)
})
