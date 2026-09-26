import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

// Same next/headers mocking pattern as p5-6/p5-1-1: `requirePlatformOperator()`
// -> `getCurrentPlatformSession()` calls Next's `cookies()`, which throws
// "called outside a request scope" in a plain vitest process. `actingAs()`
// points the mocked cookie jar at a real, DB-backed PlatformSession token
// before each gated call.
const { activePlatformToken } = vi.hoisted(() => ({ activePlatformToken: { current: undefined as string | undefined } }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "his_platform_session" && activePlatformToken.current ? { value: activePlatformToken.current } : undefined),
  }),
}))

import { createPlatformSession } from "@/lib/auth/platform-session"
import { provisionClinic } from "@/lib/domains/commercial/provisioning"
import { createPlan, updatePlan, listPlans } from "@/lib/domains/commercial/plans"
import { getPlanChangeImpact, updateSubscription, updateModuleEntitlement, SubscriptionLimitError } from "@/lib/domains/commercial/organizations"
import { getModuleEntitlements } from "@/lib/platform/entitlements"
import { COUNTRY_PACKS, getCountryPack, ALL_COUNTRY_PACK_CODES } from "@/lib/domains/commercial/country-packs-shared"
import { MODULE_KEYS } from "@/lib/platform/entitlements-shared"
import { PlatformForbiddenError } from "@/lib/platform/operator-guard"
import type { PlatformSessionContext } from "@/lib/auth/platform-session"
import type { ProvisionClinicInput } from "@/lib/domains/commercial/schemas"

const TIMEOUT = 60000

function actingAs(rawToken: string) {
  activePlatformToken.current = rawToken
}

function ownerDb() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
}

async function makePlatformOperator(emailPrefix: string) {
  const operator = await db.platformOperator.create({
    data: { email: `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, passwordHash: "x", firstName: "P5.7", lastName: "Operator" },
  })
  const rawToken = await createPlatformSession({ operatorId: operator.id })
  const session: PlatformSessionContext = {
    sessionId: "test-session",
    operator: { id: operator.id, email: operator.email, firstName: operator.firstName, lastName: operator.lastName },
  }
  return { operator, session, rawToken }
}

async function makePlan(codePrefix: string, overrides: Partial<{ userLimit: number | null; branchLimit: number | null; defaultModuleKeys: string[]; active: boolean }> = {}) {
  return db.commercialPlan.create({
    data: {
      code: `${codePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${codePrefix} plan`,
      userLimit: overrides.userLimit ?? null,
      branchLimit: overrides.branchLimit ?? null,
      defaultModuleKeys: overrides.defaultModuleKeys ?? [...MODULE_KEYS],
      active: overrides.active ?? true,
    },
  })
}

function baseProvisionInput(overrides: Partial<ProvisionClinicInput> & { planId: string }): ProvisionClinicInput {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`
  return {
    idempotencyKey: crypto.randomUUID(),
    legalName: "P5.7 Test Clinic Legal",
    displayName: "P5.7 Test Clinic",
    defaultCurrency: "USD",
    defaultTimezone: "Asia/Karachi",
    legalBusinessName: null,
    primaryContactName: "P5.7 Contact",
    primaryContactEmail: "p57-contact@test.local",
    primaryContactPhone: null,
    billingContactName: null,
    billingContactEmail: null,
    country: "PK",
    implementationOwner: "P5.7 Test Suite",
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
    branchName: "P5.7 Main Branch",
    branchCode: `P57-${suffix}`,
    branchAddress: null,
    branchPhone: null,
    adminEmail: `p57-admin-${suffix}@test.local`,
    adminFirstName: "P5.7",
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

describe("P5.7: plan management — create/edit/deactivate, historical subscriptions preserved", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  const planIds: string[] = []
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p57-plans-op")
    operatorId = op.operator.id
    operatorSession = op.session
    actingAs(op.rawToken)
  }, TIMEOUT)

  afterAll(async () => {
    for (const orgId of createdOrgIds) await cleanupProvisionedOrg(orgId)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    for (const id of planIds) await db.commercialPlan.deleteMany({ where: { id } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("creates a plan with no price field, and rejects a duplicate code", async () => {
    const code = `p57-dup-${Date.now()}`
    const plan = await createPlan({ code, name: "Avant Starter", active: true, userLimit: 5, branchLimit: 1, defaultModuleKeys: ["reception", "patients"], description: null, notes: null })
    planIds.push(plan.id)
    expect(plan).not.toHaveProperty("price")
    await expect(
      createPlan({ code, name: "Duplicate", active: true, userLimit: null, branchLimit: null, defaultModuleKeys: [], description: null, notes: null })
    ).rejects.toThrow(/already exists/i)
  }, TIMEOUT)

  it("deactivating a plan keeps it in listPlans (never hard-deleted) but provisionClinic rejects it for new provisioning", async () => {
    const plan = await makePlan("p57-deactivate")
    planIds.push(plan.id)
    await updatePlan(plan.id, { code: plan.code, name: plan.name, active: false, userLimit: null, branchLimit: null, defaultModuleKeys: [...MODULE_KEYS], description: null, notes: null })

    const stillListed = await listPlans()
    expect(stillListed.map((p) => p.id)).toContain(plan.id)

    await expect(provisionClinic(operatorSession, baseProvisionInput({ planId: plan.id }))).rejects.toThrow(/no longer active/i)
  }, TIMEOUT)

  it("a subscription created while a plan was active remains valid after the plan is later deactivated", async () => {
    const plan = await makePlan("p57-historical")
    planIds.push(plan.id)
    const result = await provisionClinic(operatorSession, baseProvisionInput({ planId: plan.id }))
    createdOrgIds.push(result.organizationId)

    await updatePlan(plan.id, { code: plan.code, name: plan.name, active: false, userLimit: null, branchLimit: null, defaultModuleKeys: [...MODULE_KEYS], description: null, notes: null })

    const subscription = await db.organizationSubscription.findFirstOrThrow({ where: { organizationId: result.organizationId } })
    expect(subscription.planId).toBe(plan.id) // historical row untouched by the later deactivation
  }, TIMEOUT)
})

describe("P5.7: entitlement overrides — plan default vs override, fully audited", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let operatorRawToken: string
  let planId: string
  let orgId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p57-entitlements-op")
    operatorId = op.operator.id
    operatorSession = op.session
    operatorRawToken = op.rawToken
    actingAs(op.rawToken)
    const plan = await makePlan("p57-entitlements-plan", { defaultModuleKeys: ["reception", "patients", "appointments", "clinical", "nursing", "pharmacy"] })
    planId = plan.id
    const result = await provisionClinic(operatorSession, baseProvisionInput({ planId }))
    orgId = result.organizationId
    createdOrgIds.push(orgId)
  }, TIMEOUT)

  afterAll(async () => {
    for (const id of createdOrgIds) await cleanupProvisionedOrg(id)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("pharmacy is enabled by plan default after provisioning", async () => {
    const entitlements = await getModuleEntitlements(orgId)
    expect(entitlements.pharmacy).toBe(true)
    expect(entitlements.inventory).toBe(false) // not in this plan's default bundle
  }, TIMEOUT)

  it("enabling a module NOT in the plan default (an override) is audited with actor, module, previous, and new values", async () => {
    await updateModuleEntitlement(orgId, "inventory", true)
    const entitlements = await getModuleEntitlements(orgId)
    expect(entitlements.inventory).toBe(true)

    const audit = await db.auditLog.findFirstOrThrow({
      where: { organizationId: orgId, entityType: "module_entitlement", entityId: "inventory" },
      orderBy: { createdAt: "desc" },
    })
    expect(audit.userId).toBe(operatorId)
    expect(audit.oldValues).toMatchObject({ enabled: false })
    expect(audit.newValues).toMatchObject({ enabled: true })
  }, TIMEOUT)

  it("disabling a module that IS in the plan default is also audited", async () => {
    await updateModuleEntitlement(orgId, "pharmacy", false)
    const entitlements = await getModuleEntitlements(orgId)
    expect(entitlements.pharmacy).toBe(false)

    const audit = await db.auditLog.findFirstOrThrow({
      where: { organizationId: orgId, entityType: "module_entitlement", entityId: "pharmacy" },
      orderBy: { createdAt: "desc" },
    })
    expect(audit.oldValues).toMatchObject({ enabled: true })
    expect(audit.newValues).toMatchObject({ enabled: false })
  }, TIMEOUT)

  it("a clinic (non-platform-operator) caller cannot reach updateModuleEntitlement at all — no session, no cookie", async () => {
    activePlatformToken.current = undefined
    await expect(updateModuleEntitlement(orgId, "reception", false)).rejects.toThrow(PlatformForbiddenError)
    actingAs(operatorRawToken) // restore this describe block's own valid session (no new operator created — nothing extra to clean up)
  }, TIMEOUT)
})

describe("P5.7: plan change comparison and downgrade safety", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let generousPlanId: string
  let tightPlanId: string
  let orgId: string
  const createdOrgIds: string[] = []
  const planIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p57-downgrade-op")
    operatorId = op.operator.id
    operatorSession = op.session
    actingAs(op.rawToken)

    const generousPlan = await makePlan("p57-generous", { userLimit: 10, branchLimit: 5, defaultModuleKeys: ["reception", "patients", "pharmacy"] })
    generousPlanId = generousPlan.id
    planIds.push(generousPlanId)

    const tightPlan = await makePlan("p57-tight", { userLimit: 1, branchLimit: 1, defaultModuleKeys: ["reception", "patients"] })
    tightPlanId = tightPlan.id
    planIds.push(tightPlanId)

    const result = await provisionClinic(operatorSession, baseProvisionInput({ planId: generousPlanId }))
    orgId = result.organizationId
    createdOrgIds.push(orgId)
    // Provisioning creates exactly 1 admin user already — bring active users to 2, over the tight plan's limit of 1.
    await db.user.create({
      data: {
        organizationId: orgId,
        email: `p57-second-user-${Date.now()}@test.local`,
        passwordHash: "x",
        firstName: "Second",
        lastName: "User",
        status: "active",
      },
    })
  }, TIMEOUT)

  afterAll(async () => {
    for (const id of createdOrgIds) await cleanupProvisionedOrg(id)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    for (const id of planIds) await db.commercialPlan.deleteMany({ where: { id } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("getPlanChangeImpact reports modules to be added/removed against CURRENT entitlements, without changing anything", async () => {
    const impact = await getPlanChangeImpact(orgId, tightPlanId)
    expect(impact.modulesToBeRemoved).toEqual(expect.arrayContaining(["pharmacy"]))
    expect(impact.modulesToBeAdded).toEqual([])
    // Read-only — entitlements must be untouched by merely previewing.
    const entitlements = await getModuleEntitlements(orgId)
    expect(entitlements.pharmacy).toBe(true)
  }, TIMEOUT)

  it("blocks a downgrade whose new user limit is below current active user count, and never deactivates anyone", async () => {
    const impact = await getPlanChangeImpact(orgId, tightPlanId)
    expect(impact.blocked).toBe(true)
    expect(impact.blockReasons.join(" ")).toMatch(/current active users.*exceed/i)

    await expect(
      updateSubscription(orgId, {
        planId: tightPlanId,
        status: "active",
        startDate: new Date(),
        endDate: null,
        trialEndsAt: null,
        agreedUserLimit: null,
        agreedBranchLimit: null,
        agreedAmount: null,
        currency: null,
        billingCycle: null,
        notes: null,
      })
    ).rejects.toThrow(SubscriptionLimitError)

    const activeUsers = await db.user.count({ where: { organizationId: orgId, status: "active" } })
    expect(activeUsers).toBe(2) // untouched — blocked, not silently reconciled
  }, TIMEOUT)

  it("an upgrade to a plan with a higher limit succeeds and creates a new subscription row (history preserved)", async () => {
    const before = await db.organizationSubscription.count({ where: { organizationId: orgId } })
    await updateSubscription(orgId, {
      planId: generousPlanId,
      status: "active",
      startDate: new Date(),
      endDate: null,
      trialEndsAt: null,
      agreedUserLimit: null,
      agreedBranchLimit: null,
      agreedAmount: null,
      currency: null,
      billingCycle: null,
      notes: null,
    })
    const after = await db.organizationSubscription.count({ where: { organizationId: orgId } })
    expect(after).toBe(before + 1)
  }, TIMEOUT)

  it("an explicit per-organization override limit is honored by the impact check (not just the plan's own limit)", async () => {
    // Even though tightPlan's own limit is 1, an override of 5 should un-block the same change.
    const impact = await getPlanChangeImpact(orgId, tightPlanId, { agreedUserLimit: 5 })
    expect(impact.blocked).toBe(false)
    expect(impact.effectiveNewUserLimit).toBe(5)
  }, TIMEOUT)
})

describe("P5.7: country packs — PK/SA/AE static mapping, no compliance claims", () => {
  it("defines exactly PK, SA, AE with currency/timezone/regulatory-surface data", () => {
    expect(ALL_COUNTRY_PACK_CODES.sort()).toEqual(["AE", "PK", "SA"])
    expect(COUNTRY_PACKS.PK.currency).toBe("PKR")
    expect(COUNTRY_PACKS.SA.currency).toBe("SAR")
    expect(COUNTRY_PACKS.AE.currency).toBe("AED")
    expect(COUNTRY_PACKS.PK.regulatorySurfaces).toContain("fbr")
    expect(COUNTRY_PACKS.SA.regulatorySurfaces).toContain("zatca")
    expect(COUNTRY_PACKS.AE.regulatorySurfaces).toContain("dha_nabidh")
  })

  it("getCountryPack is case-insensitive and returns null for an unmapped/missing country", () => {
    expect(getCountryPack("sa")?.code).toBe("SA")
    expect(getCountryPack("XX")).toBeNull()
    expect(getCountryPack(null)).toBeNull()
    expect(getCountryPack(undefined)).toBeNull()
  })

  it("never claims certification/compliance/approval anywhere in the country pack data", () => {
    const text = JSON.stringify(COUNTRY_PACKS).toLowerCase()
    expect(text).not.toContain("certified")
    expect(text).not.toContain("compliant")
    expect(text).not.toContain("approved")
  })
})

describe("P5.7: provisioning integration — country pack + plan defaults + P5.1.1 timeout intact", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p57-provint-op")
    operatorId = op.operator.id
    operatorSession = op.session
    actingAs(op.rawToken)
    const plan = await makePlan("p57-provint-plan", { defaultModuleKeys: ["reception", "patients", "pharmacy"] })
    planId = plan.id
  }, TIMEOUT)

  afterAll(async () => {
    for (const id of createdOrgIds) await cleanupProvisionedOrg(id)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("provisioning a SA org still uses the widened {timeout: 20_000, maxWait: 10_000} transaction options and ends up with plan-default entitlements seeded", async () => {
    const originalTransaction = db.$transaction.bind(db)
    const spy = vi.spyOn(db, "$transaction").mockImplementation((...args: Parameters<typeof db.$transaction>) => originalTransaction(...args))

    try {
      const result = await provisionClinic(operatorSession, baseProvisionInput({ planId, country: "SA" }))
      createdOrgIds.push(result.organizationId)

      expect(spy).toHaveBeenCalled()
      const [, options] = spy.mock.calls[0]
      expect(options).toMatchObject({ timeout: 20_000, maxWait: 10_000 })

      const entitlements = await getModuleEntitlements(result.organizationId)
      expect(entitlements.pharmacy).toBe(true)
      expect(entitlements.inventory).toBe(false)

      const pack = getCountryPack("SA")
      expect(pack?.currency).toBe("SAR") // the Country Pack this org's country maps to, independent of provisioning's own input
    } finally {
      spy.mockRestore()
    }
  }, TIMEOUT)
})
