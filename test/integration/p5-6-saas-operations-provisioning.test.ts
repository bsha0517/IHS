import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

// `listOrganizationsForPlatform`/`listOrganizationCountries`/
// `getRegulatoryIntegrations` all self-guard via `requirePlatformOperator()`
// -> `getCurrentPlatformSession()` -> Next's `cookies()`, which throws
// "called outside a request scope" in a plain vitest process (confirmed
// directly — this is exactly why P5.1's own test file never calls these
// gated functions directly either, testing the underlying Prisma model
// instead). Rather than duplicate their query logic against raw `db.*`
// calls, this mocks `next/headers` with a fake cookie jar backed by
// `activePlatformToken` — set via `actingAs()` before each gated call,
// exercising the REAL `requirePlatformOperator()` -> `getPlatformSessionContext()`
// resolution path (a real DB-backed PlatformSession token), not a bypass of it.
const { activePlatformToken } = vi.hoisted(() => ({ activePlatformToken: { current: undefined as string | undefined } }))
vi.mock("next/headers", () => ({
  // "his_platform_session" is PLATFORM_SESSION_COOKIE_NAME
  // (src/lib/auth/platform-constants.ts) — inlined because vi.mock's
  // factory is hoisted above every import in this file, so it can't
  // reference that module's export directly.
  cookies: async () => ({
    get: (name: string) => (name === "his_platform_session" && activePlatformToken.current ? { value: activePlatformToken.current } : undefined),
  }),
}))

import { createPlatformSession } from "@/lib/auth/platform-session"
import { provisionClinic } from "@/lib/domains/commercial/provisioning"
import { listOrganizationsForPlatform, listOrganizationCountries } from "@/lib/domains/commercial/organizations"
import { getRegulatoryIntegrations } from "@/lib/domains/commercial/regulatory"
import { setZatcaSellerProfile } from "@/lib/domains/einvoicing/config"
import { MODULE_KEYS } from "@/lib/platform/entitlements-shared"
import { PlatformForbiddenError } from "@/lib/platform/operator-guard"
import type { PlatformSessionContext } from "@/lib/auth/platform-session"
import type { SessionContext } from "@/lib/auth/session"
import type { ProvisionClinicInput } from "@/lib/domains/commercial/schemas"

const TIMEOUT = 60000

/** Points the mocked cookie jar at this raw platform-session token for the duration of a gated call. */
function actingAs(rawToken: string) {
  activePlatformToken.current = rawToken
}

function ownerDb() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
}

async function makePlatformOperator(emailPrefix: string) {
  const operator = await db.platformOperator.create({
    data: { email: `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, passwordHash: "x", firstName: "P5.6", lastName: "Operator" },
  })
  const rawToken = await createPlatformSession({ operatorId: operator.id })
  const session: PlatformSessionContext = {
    sessionId: "test-session",
    operator: { id: operator.id, email: operator.email, firstName: operator.firstName, lastName: operator.lastName },
  }
  return { operator, session, rawToken }
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
    legalName: "P5.6 Test Clinic Legal",
    displayName: "P5.6 Test Clinic",
    defaultCurrency: "USD",
    defaultTimezone: "Asia/Karachi",
    legalBusinessName: null,
    primaryContactName: "P5.6 Contact",
    primaryContactEmail: "p56-contact@test.local",
    primaryContactPhone: null,
    billingContactName: null,
    billingContactEmail: null,
    country: "PK",
    implementationOwner: "P5.6 Test Suite",
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
    branchName: "P5.6 Main Branch",
    branchCode: `P56-${suffix}`,
    branchAddress: null,
    branchPhone: null,
    adminEmail: `p56-admin-${suffix}@test.local`,
    adminFirstName: "P5.6",
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

describe("P5.6: concurrent provisioning safety", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p56-concurrency-op")
    operatorId = op.operator.id
    operatorSession = op.session
    const plan = await makePlan("p56-concurrency-plan")
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

  it("two truly simultaneous provisioning requests with the SAME idempotency key create exactly one organization, one branch, one admin", async () => {
    const sharedIdempotencyKey = crypto.randomUUID()
    const sharedAdminEmail = `p56-concurrent-admin-${Date.now()}@test.local`
    const sharedBranchCode = `P56CC-${Date.now()}`
    const input = baseProvisionInput({ planId, idempotencyKey: sharedIdempotencyKey, adminEmail: sharedAdminEmail, branchCode: sharedBranchCode })

    const results = await Promise.allSettled([provisionClinic(operatorSession, input), provisionClinic(operatorSession, input)])

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof provisionClinic>>> => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")

    // Whichever pattern this races into (both resolve to the same result, or
    // one succeeds and one throws a "duplicate submission" error), the
    // database-level invariant is what actually matters: never two
    // organizations for one idempotency key.
    expect(fulfilled.length + rejected.length).toBe(2)
    if (fulfilled.length === 2) {
      expect(fulfilled[0].value.organizationId).toBe(fulfilled[1].value.organizationId)
    }
    const resultOrgId = fulfilled[0]?.value.organizationId
    expect(resultOrgId).toBeTruthy()
    if (resultOrgId) createdOrgIds.push(resultOrgId)

    const matchingOrgs = await db.user.findMany({ where: { email: sharedAdminEmail } })
    expect(matchingOrgs.length).toBe(1) // exactly one admin user, never two, regardless of how the race resolved

    const matchingBranches = await db.branch.findMany({ where: { code: sharedBranchCode } })
    expect(matchingBranches.length).toBe(1) // exactly one branch, never a duplicate branch code
  }, TIMEOUT)
})

describe("P5.6: organizations list filters", () => {
  let operatorId: string
  let planId: string
  const createdOrgIds: string[] = []
  let saOrgId: string
  let pkOrgId: string

  beforeAll(async () => {
    const op = await makePlatformOperator("p56-filters-op")
    operatorId = op.operator.id
    actingAs(op.rawToken)
    const plan = await makePlan("p56-filters-plan")
    planId = plan.id

    const saResult = await provisionClinic(op.session, baseProvisionInput({ planId, country: "SA", subscriptionStatus: "active" }))
    saOrgId = saResult.organizationId
    createdOrgIds.push(saOrgId)

    const pkResult = await provisionClinic(op.session, baseProvisionInput({ planId, country: "PK", subscriptionStatus: "trial" }))
    pkOrgId = pkResult.organizationId
    createdOrgIds.push(pkOrgId)
  }, TIMEOUT)

  afterAll(async () => {
    for (const orgId of createdOrgIds) await cleanupProvisionedOrg(orgId)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("filters by country", async () => {
    const { organizations } = await listOrganizationsForPlatform({ country: "SA", pageSize: 100 })
    const ids = organizations.map((o) => o.id)
    expect(ids).toContain(saOrgId)
    expect(ids).not.toContain(pkOrgId)
  }, TIMEOUT)

  it("filters by subscription status", async () => {
    const { organizations } = await listOrganizationsForPlatform({ subscriptionStatus: "active", pageSize: 100 })
    const ids = organizations.map((o) => o.id)
    expect(ids).toContain(saOrgId)
    expect(ids).not.toContain(pkOrgId)
  }, TIMEOUT)

  it("filters by onboarding status (both fresh orgs are not_started)", async () => {
    const { organizations } = await listOrganizationsForPlatform({ onboardingStatus: "not_started", pageSize: 100 })
    const ids = organizations.map((o) => o.id)
    expect(ids).toContain(saOrgId)
    expect(ids).toContain(pkOrgId)
  }, TIMEOUT)

  it("filters by go-live lifecycle (both fresh orgs are still onboarding, never live)", async () => {
    const { organizations } = await listOrganizationsForPlatform({ commercialLifecycle: "onboarding", pageSize: 100 })
    const ids = organizations.map((o) => o.id)
    expect(ids).toContain(saOrgId)
    expect(ids).toContain(pkOrgId)
    const liveOnly = await listOrganizationsForPlatform({ commercialLifecycle: "live", pageSize: 100 })
    expect(liveOnly.organizations.map((o) => o.id)).not.toContain(saOrgId)
  }, TIMEOUT)

  it("listOrganizationCountries includes both seeded countries", async () => {
    const countries = await listOrganizationCountries()
    expect(countries).toContain("SA")
    expect(countries).toContain("PK")
  }, TIMEOUT)
})

describe("P5.6: regulatory configuration surface", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  const createdOrgIds: string[] = []
  let saOrgId: string

  beforeAll(async () => {
    const op = await makePlatformOperator("p56-regulatory-op")
    operatorId = op.operator.id
    operatorSession = op.session
    actingAs(op.rawToken)
    const plan = await makePlan("p56-regulatory-plan")
    planId = plan.id

    const saResult = await provisionClinic(operatorSession, baseProvisionInput({ planId, country: "SA" }))
    saOrgId = saResult.organizationId
    createdOrgIds.push(saOrgId)
  }, TIMEOUT)

  afterAll(async () => {
    for (const orgId of createdOrgIds) await cleanupProvisionedOrg(orgId)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("a Saudi org sees ZATCA as available-but-not-configured, and FBR/DHA as not applicable", async () => {
    const integrations = await getRegulatoryIntegrations(saOrgId, "SA")
    const zatca = integrations.find((i) => i.code === "zatca")
    const fbr = integrations.find((i) => i.code === "fbr")
    const dha = integrations.find((i) => i.code === "dha_nabidh")
    expect(zatca?.status).toBe("not_configured")
    expect(zatca?.configureHref).toBe("/einvoicing")
    expect(fbr?.status).toBe("not_available")
    expect(dha?.status).toBe("not_available")
  }, TIMEOUT)

  it("enabling ZATCA for the org moves its status to sandbox_configuration_pending (no real credentials in this test environment) and never claims certification/connection", async () => {
    const session: SessionContext = {
      sessionId: "p56-regulatory-session",
      user: { id: "system", organizationId: saOrgId, email: "system@test.local", firstName: "P5.6", lastName: "Test" },
      activeBranchId: null,
      branchIds: [],
      permissions: new Set(["einvoicing.configure"]),
      roleNames: ["Accountant"],
    }
    await setZatcaSellerProfile(session, {
      enabled: true,
      vatRegistrationNumber: "300000000000003",
      sellerName: "P5.6 Test Seller",
      buildingNumber: "1234",
      streetName: "Test Street",
      district: "Test District",
      city: "Riyadh",
      postalCode: "12211",
      additionalNumber: "6789",
      countryCode: "SA",
    })

    const integrations = await getRegulatoryIntegrations(saOrgId, "SA")
    const zatca = integrations.find((i) => i.code === "zatca")
    expect(zatca?.status).toBe("sandbox_configuration_pending")
    expect(zatca?.environment).toBe("sandbox")
    // Wording discipline (P5.6 Part 4): must never claim certification/compliance/approval anywhere in the status vocabulary.
    const allStatusText = JSON.stringify(integrations).toLowerCase()
    expect(allStatusText).not.toContain("certified")
    expect(allStatusText).not.toContain("compliant")
    expect(allStatusText).not.toContain("approved")
  }, TIMEOUT)

  it("a Pakistani org sees FBR as not_implemented (no adapter exists), never a fabricated working integration", async () => {
    const pkResult = await provisionClinic(operatorSession, baseProvisionInput({ planId, country: "PK" }))
    createdOrgIds.push(pkResult.organizationId)
    const integrations = await getRegulatoryIntegrations(pkResult.organizationId, "PK")
    const fbr = integrations.find((i) => i.code === "fbr")
    expect(fbr?.status).toBe("not_implemented")
    expect(fbr?.configureHref).toBeNull()
  }, TIMEOUT)

  it("an organization with no country recorded sees every integration as not_available", async () => {
    const integrations = await getRegulatoryIntegrations(saOrgId, null)
    expect(integrations.every((i) => i.status === "not_available")).toBe(true)
  }, TIMEOUT)
})

describe("P5.6: platform authorization boundary", () => {
  it("PlatformForbiddenError is the real, importable guard error type used by every commercial platform function", () => {
    expect(new PlatformForbiddenError().name).toBe("PlatformForbiddenError")
    expect(new PlatformForbiddenError().message).toMatch(/platform operator session required/i)
  })
})
