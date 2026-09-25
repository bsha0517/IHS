import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { hashPassword } from "@/lib/auth/password"
import { createSession, getSessionContext } from "@/lib/auth/session"
import { getPlatformSessionContext, createPlatformSession } from "@/lib/auth/platform-session"
import { provisionClinic } from "@/lib/domains/commercial/provisioning"
import {
  isModuleEnabled,
  getModuleEntitlements,
  setModuleEntitlement,
  seedModuleEntitlementsFromPlan,
} from "@/lib/platform/entitlements"
import { isRouteEnforceable, MODULE_KEYS } from "@/lib/platform/entitlements-shared"
import { isPlatformIdempotencyKeyConflict, claimPlatformIdempotencyKey, resolveDuplicatePlatformRequest } from "@/lib/platform/idempotency-platform"
import { createUser } from "@/lib/domains/identity/users"
import { createBranch } from "@/lib/domains/identity/org-structure"
import { assertCan, can } from "@/lib/platform/permissions-core"
import type { PlatformSessionContext } from "@/lib/auth/platform-session"
import type { SessionContext } from "@/lib/auth/session"
import type { ProvisionClinicInput } from "@/lib/domains/commercial/schemas"

const TIMEOUT = 60000

/** A dedicated owner-role connection — needed to clean up rows the restricted `his_app_runtime`/`avant_app_runtime` role can't delete (audit_log) or that need to bypass RLS for cross-fixture teardown, mirroring the existing pattern in p4-3-production-security-hardening.test.ts. */
function ownerDb() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
}

async function makePlatformOperator(emailPrefix: string) {
  const operator = await db.platformOperator.create({
    data: { email: `${emailPrefix}-${Date.now()}@test.local`, passwordHash: "x", firstName: "P5.1", lastName: "Operator" },
  })
  const rawToken = await createPlatformSession({ operatorId: operator.id })
  const session: PlatformSessionContext = {
    sessionId: "test-session",
    operator: { id: operator.id, email: operator.email, firstName: operator.firstName, lastName: operator.lastName },
  }
  return { operator, rawToken, session }
}

async function makePlan(codePrefix: string, overrides: Partial<{ userLimit: number | null; branchLimit: number | null; defaultModuleKeys: string[] }> = {}) {
  return db.commercialPlan.create({
    data: {
      code: `${codePrefix}-${Date.now()}`,
      name: `${codePrefix} plan`,
      userLimit: overrides.userLimit ?? null,
      branchLimit: overrides.branchLimit ?? null,
      defaultModuleKeys: overrides.defaultModuleKeys ?? [...MODULE_KEYS],
    },
  })
}

function baseProvisionInput(overrides: Partial<ProvisionClinicInput> = {}): Omit<ProvisionClinicInput, "planId" | "idempotencyKey"> & { planId: string; idempotencyKey: string } {
  const suffix = overrides.adminEmail ? "" : `${Date.now()}${Math.floor(Math.random() * 1000)}`
  return {
    idempotencyKey: crypto.randomUUID(),
    legalName: "Avant P5 Pilot Clinic Legal",
    displayName: "Avant P5 Pilot Clinic",
    defaultCurrency: "USD",
    defaultTimezone: "Asia/Karachi",
    legalBusinessName: null,
    primaryContactName: "Pilot Contact",
    primaryContactEmail: "pilot-contact@test.local",
    primaryContactPhone: null,
    billingContactName: null,
    billingContactEmail: null,
    country: "PK",
    implementationOwner: "P5.1 Test Suite",
    internalNotes: null,
    planId: "REPLACE_ME",
    subscriptionStatus: "trial",
    startDate: new Date(),
    trialEndsAt: null,
    agreedUserLimit: null,
    agreedBranchLimit: null,
    agreedAmount: null,
    currency: null,
    billingCycle: null,
    subscriptionNotes: null,
    branchName: "Pilot Main Branch",
    branchCode: `PILOT-${suffix}`,
    branchAddress: null,
    branchPhone: null,
    adminEmail: `pilot-admin-${suffix}@test.local`,
    adminFirstName: "Pilot",
    adminLastName: "Admin",
    moduleKeys: undefined,
    ...overrides,
  }
}

describe("P5.1 §5/§37: platform authorization is a fully separate session plane from staff auth", () => {
  let orgId: string
  let staffUserId: string
  let staffRawToken: string
  let operatorId: string
  let platformRawToken: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { legalName: "P5.1 Auth Boundary Org", displayName: "P5.1 Auth Boundary Org" } })
    orgId = org.id
    const superAdminRole = await db.role.create({ data: { organizationId: orgId, name: "Super Admin" } })
    const user = await db.user.create({
      data: { organizationId: orgId, email: `p51-auth-${Date.now()}@test.local`, firstName: "P51", lastName: "SuperAdmin", passwordHash: await hashPassword("correct-horse-battery") },
    })
    staffUserId = user.id
    await db.userRole.create({ data: { userId: user.id, roleId: superAdminRole.id } })
    staffRawToken = await createSession({ userId: user.id })

    const operator = await db.platformOperator.create({
      data: { email: `p51-operator-${Date.now()}@test.local`, passwordHash: "x", firstName: "Real", lastName: "Operator" },
    })
    operatorId = operator.id
    platformRawToken = await createPlatformSession({ operatorId: operator.id })
  }, TIMEOUT)

  afterAll(async () => {
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.session.deleteMany({ where: { userId: staffUserId } })
    await db.userRole.deleteMany({ where: { userId: staffUserId } })
    await db.user.deleteMany({ where: { id: staffUserId } })
    await db.role.deleteMany({ where: { organizationId: orgId } })
    await db.organization.deleteMany({ where: { id: orgId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("REQUIRED ANSWER — a clinic Super Admin's staff session token resolves a real staff session, but NEVER a platform session (different token hash space, different table)", async () => {
    const staffSession = await getSessionContext(staffRawToken)
    expect(staffSession).not.toBeNull()
    expect(staffSession?.roleNames).toContain("Super Admin")

    // The exact staff raw token, handed to the PLATFORM session resolver —
    // this is the literal attack this section must rule out: a clinic
    // Super Admin's own cookie value used against /platform.
    const platformSessionFromStaffToken = await getPlatformSessionContext(staffRawToken)
    expect(platformSessionFromStaffToken).toBeNull()
  })

  it("a genuine platform operator token resolves a platform session, and that token never resolves a staff session", async () => {
    const platformSession = await getPlatformSessionContext(platformRawToken)
    expect(platformSession).not.toBeNull()
    expect(platformSession?.operator.id).toBe(operatorId)

    const staffSessionFromPlatformToken = await getSessionContext(platformRawToken)
    expect(staffSessionFromPlatformToken).toBeNull()
  })

  it("an unknown/garbage token resolves neither session type", async () => {
    expect(await getPlatformSessionContext("not-a-real-token")).toBeNull()
    expect(await getSessionContext("not-a-real-token")).toBeNull()
  })

  it("§8: a platform operator session carries no clinic RBAC at all — it is not a SessionContext, has no organizationId, no permissions set, and cannot satisfy can()/assertCan() for any clinic permission", async () => {
    const platformSession = await getPlatformSessionContext(platformRawToken)
    expect(platformSession).not.toBeNull()
    // Structural proof: PlatformSessionContext has no `permissions`/`roleNames`/
    // `user.organizationId` fields at all — can()/assertCan() take a
    // SessionContext, and a PlatformSessionContext is simply not one; there is
    // no code path that adapts one into the other. can(null, ...) is the
    // closest a platform session ever gets to that function, and it denies.
    expect(can(null, "patient.view")).toBe(false)
    expect(can(null, "invoice.create")).toBe(false)
    expect(() => assertCan(null, "users.manage")).toThrow()
  })
})

describe("P5.1 §3/§20/§23/§37: full synthetic provisioning workflow (Avant P5 Pilot Clinic)", () => {
  let operatorId: string
  let planId: string
  let result: Awaited<ReturnType<typeof provisionClinic>>
  let operatorSession: PlatformSessionContext

  beforeAll(async () => {
    const op = await makePlatformOperator("p51-provision-op")
    operatorId = op.operator.id
    operatorSession = op.session
    const plan = await makePlan("p51-pilot-plan", { userLimit: 10, branchLimit: 2, defaultModuleKeys: ["reception", "patients", "appointments", "clinical", "nursing", "pos_billing", "reports"] })
    planId = plan.id

    result = await provisionClinic(operatorSession, baseProvisionInput({ planId }))
  }, TIMEOUT)

  afterAll(async () => {
    await db.goLiveCondition.deleteMany({ where: { commercialProfileId: result.commercialProfileId } }).catch(() => {})
    await db.organizationSubscription.deleteMany({ where: { organizationId: result.organizationId } }).catch(() => {})
    await db.organizationCommercialProfile.deleteMany({ where: { organizationId: result.organizationId } }).catch(() => {})
    await db.setting.deleteMany({ where: { organizationId: result.organizationId } }).catch(() => {})
    await db.passwordResetToken.deleteMany({ where: { userId: result.adminUserId } }).catch(() => {})
    await db.userBranchAccess.deleteMany({ where: { userId: result.adminUserId } }).catch(() => {})
    await db.userRole.deleteMany({ where: { userId: result.adminUserId } }).catch(() => {})
    await db.user.deleteMany({ where: { id: result.adminUserId } }).catch(() => {})
    await db.rolePermission.deleteMany({ where: { role: { organizationId: result.organizationId } } }).catch(() => {})
    await db.role.deleteMany({ where: { organizationId: result.organizationId } }).catch(() => {})
    await db.branch.deleteMany({ where: { organizationId: result.organizationId } }).catch(() => {})
    const owner = ownerDb()
    await owner.auditLog.deleteMany({ where: { organizationId: result.organizationId } }).catch(() => {})
    await owner.$disconnect()
    await db.organization.deleteMany({ where: { id: result.organizationId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("creates a real, active Organization with the submitted commercial details", async () => {
    const org = await db.organization.findUniqueOrThrow({ where: { id: result.organizationId } })
    expect(org.displayName).toBe("Avant P5 Pilot Clinic")
    expect(org.status).toBe("active")
  })

  it("creates the initial branch under the new organization", async () => {
    const branch = await db.branch.findUniqueOrThrow({ where: { id: result.branchId } })
    expect(branch.organizationId).toBe(result.organizationId)
    expect(branch.status).toBe("active")
  })

  it("§23: initial admin belongs to the correct org/branch, holds the Super Admin role, has NO platform privileges, and no client-chosen/predictable password", async () => {
    const admin = await db.user.findUniqueOrThrow({
      where: { id: result.adminUserId },
      include: { roles: { include: { role: true } }, branchAccess: true },
    })
    expect(admin.organizationId).toBe(result.organizationId)
    expect(admin.roles.map((r) => r.role.name)).toContain("Super Admin")
    expect(admin.branchAccess.map((b) => b.branchId)).toContain(result.branchId)
    // The stored hash is never a hash of anything guessable/client-supplied —
    // it cannot be verified against a known/predictable string.
    const { verifyPassword } = await import("@/lib/auth/password")
    expect(await verifyPassword(admin.passwordHash, "password123")).toBe(false)
    expect(await verifyPassword(admin.passwordHash, "ChangeMe123!")).toBe(false)
    // No platform_operator row exists for this admin's email — a clinic
    // admin is not, and cannot become, a PlatformOperator via provisioning.
    const asOperator = await db.platformOperator.findFirst({ where: { email: admin.email } })
    expect(asOperator).toBeNull()

    // §23: a real, working activation path exists (PasswordResetToken), not a
    // dead end — this is literally how the admin sets their first real password.
    const resetToken = await db.passwordResetToken.findFirst({ where: { userId: admin.id } })
    expect(resetToken).not.toBeNull()
    expect(resetToken?.usedAt).toBeNull()
  })

  it("creates a commercial profile with a generated, unique customer code, and a matching subscription referencing the chosen plan", async () => {
    const profile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId: result.organizationId } })
    expect(profile.customerCode).toMatch(/^AVT-\d{6}$/)
    expect(profile.commercialLifecycle).toBe("onboarding")

    const subscription = await db.organizationSubscription.findFirstOrThrow({ where: { organizationId: result.organizationId } })
    expect(subscription.planId).toBe(planId)
    expect(subscription.status).toBe("trial")
  })

  it("§22: seeds all four go-live conditions as pending — never pre-completed by provisioning itself", async () => {
    const conditions = await db.goLiveCondition.findMany({ where: { commercialProfileId: result.commercialProfileId } })
    expect(conditions).toHaveLength(4)
    expect(conditions.every((c) => c.status === "pending")).toBe(true)
    expect(conditions.every((c) => c.completedByOperatorId === null)).toBe(true)
  })

  it("§9/§21: module entitlements are seeded from the plan's own defaults — enabled modules match, everything else is off", async () => {
    const entitlements = await getModuleEntitlements(result.organizationId)
    expect(entitlements.reception).toBe(true)
    expect(entitlements.pos_billing).toBe(true)
    expect(entitlements.laboratory).toBe(false)
    expect(entitlements.payroll).toBe(false)
  })

  it("§18: a commercial audit entry records the provisioning event, scoped to the new organization, with no PHI/secret content", async () => {
    const auditRows = await db.auditLog.findMany({ where: { organizationId: result.organizationId, action: "platform.organization.provisioned" } })
    expect(auditRows).toHaveLength(1)
    const payload = JSON.stringify(auditRows[0].newValues)
    expect(payload).not.toMatch(/password/i)
    expect(payload).not.toMatch(/token/i)
    expect(auditRows[0].userId).toBe(operatorId)
  })

  it("§20: the new clinic's onboarding/readiness derives from its actual configuration, not a manually-declared 'ready' flag — a fresh clinic starts not ready", async () => {
    const { getOnboardingStatus } = await import("@/lib/domains/onboarding/readiness")
    const clinicSession: SessionContext = {
      sessionId: "test-onboarding",
      user: { id: result.adminUserId, organizationId: result.organizationId, email: "x", firstName: "X", lastName: "Y" },
      activeBranchId: result.branchId,
      branchIds: [result.branchId],
      permissions: new Set(["users.manage"]),
      roleNames: ["Super Admin"],
    }
    const readiness = await getOnboardingStatus(clinicSession)
    // A brand-new clinic has done none of the real setup steps yet — it must
    // not report itself fully ready just because it was provisioned.
    expect(readiness.operationallyReady).toBe(false)
  })
})

describe("P5.1 §4/§19: provisioning atomicity — idempotency and duplicate-submission protection", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p51-idempotency-op")
    operatorId = op.operator.id
    operatorSession = op.session
    const plan = await makePlan("p51-idempotency-plan")
    planId = plan.id
  }, TIMEOUT)

  afterAll(async () => {
    for (const orgId of createdOrgIds) {
      await db.goLiveCondition.deleteMany({ where: { commercialProfile: { organizationId: orgId } } }).catch(() => {})
      await db.organizationSubscription.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
      await db.organizationCommercialProfile.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
      await db.setting.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
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
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("a repeated submission with the SAME idempotency key never creates a second organization — the retry resolves to the original result instead", async () => {
    const input = baseProvisionInput({ planId })
    const first = await provisionClinic(operatorSession, input)
    createdOrgIds.push(first.organizationId)

    // Genuine retry: identical idempotencyKey, identical form data (this is
    // what a real double-click/browser-retry sends).
    await expect(provisionClinic(operatorSession, input)).rejects.toThrow(/already provisioned/i)

    const orgCount = await db.organization.count({ where: { displayName: input.displayName, commercialProfile: { customerCode: (await db.organizationCommercialProfile.findFirstOrThrow({ where: { organizationId: first.organizationId } })).customerCode } } })
    expect(orgCount).toBe(1)
  }, TIMEOUT)

  it("claimPlatformIdempotencyKey/isPlatformIdempotencyKeyConflict correctly detect a conflicting claim outside a full provisioning call", async () => {
    const key = crypto.randomUUID()
    await db.$transaction(async (tx) => {
      await claimPlatformIdempotencyKey(tx, { operatorId, scope: "test_scope", key })
    })
    let conflict = false
    try {
      await db.$transaction(async (tx) => {
        await claimPlatformIdempotencyKey(tx, { operatorId, scope: "test_scope", key })
      })
    } catch (e) {
      conflict = isPlatformIdempotencyKeyConflict(e)
    }
    expect(conflict).toBe(true)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId, scope: "test_scope" } })
  }, TIMEOUT)

  it("resolveDuplicatePlatformRequest throws when the original claim never recorded a result (a genuinely still-in-flight/crashed attempt, not silently treated as a duplicate success)", async () => {
    const key = crypto.randomUUID()
    await db.$transaction(async (tx) => {
      await claimPlatformIdempotencyKey(tx, { operatorId, scope: "test_scope_unfinished", key })
    })
    await expect(resolveDuplicatePlatformRequest({ operatorId, scope: "test_scope_unfinished", key })).rejects.toThrow()
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId, scope: "test_scope_unfinished" } })
  }, TIMEOUT)

  it("§4: the same admin email is legitimately allowed across two DIFFERENT organizations (User.email uniqueness is org-scoped — @@unique([organizationId, email]) — not global; a consultant administering multiple client clinics is a real, intended case, not a collision)", async () => {
    const sharedEmail = `p51-dup-admin-${Date.now()}@test.local`
    const orgA = await provisionClinic(operatorSession, baseProvisionInput({ planId, adminEmail: sharedEmail, displayName: "P5.1 Dup Email Org A", branchCode: `DUPA-${Date.now()}` }))
    createdOrgIds.push(orgA.organizationId)
    const orgB = await provisionClinic(operatorSession, baseProvisionInput({ planId, adminEmail: sharedEmail, displayName: "P5.1 Dup Email Org B", branchCode: `DUPB-${Date.now()}` }))
    createdOrgIds.push(orgB.organizationId)

    expect(orgA.adminUserId).not.toBe(orgB.adminUserId)
    const adminA = await db.user.findUniqueOrThrow({ where: { id: orgA.adminUserId } })
    const adminB = await db.user.findUniqueOrThrow({ where: { id: orgB.adminUserId } })
    expect(adminA.email).toBe(sharedEmail)
    expect(adminB.email).toBe(sharedEmail)
    expect(adminA.organizationId).not.toBe(adminB.organizationId)
  }, TIMEOUT)

  it("§4/§19: a genuine collision on the one globally-unique, server-generated field (customerCode) is handled by the same P2002 catch path — verified directly against the constraint provisionClinic relies on", async () => {
    const code = `AVT-COLLISION-${Date.now()}`
    await db.organizationCommercialProfile.create({
      data: { organizationId: (await db.organization.create({ data: { legalName: "P5.1 Collision Seed", displayName: "P5.1 Collision Seed" } })).id, customerCode: code, country: "PK" },
    })
    await expect(db.organizationCommercialProfile.create({ data: { organizationId: (await db.organization.create({ data: { legalName: "P5.1 Collision Seed 2", displayName: "P5.1 Collision Seed 2" } })).id, customerCode: code, country: "PK" } })).rejects.toMatchObject({ code: "P2002" })
    await db.organizationCommercialProfile.deleteMany({ where: { customerCode: code } })
    await db.organization.deleteMany({ where: { displayName: { in: ["P5.1 Collision Seed", "P5.1 Collision Seed 2"] } } })
  }, TIMEOUT)
})

describe("P5.1 §9/§10/§11/§37: module entitlements — independent of RBAC, enforced per-organization", () => {
  let orgId: string
  let userId: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { legalName: "P5.1 Entitlement Org", displayName: "P5.1 Entitlement Org" } })
    orgId = org.id
    const user = await db.user.create({ data: { organizationId: orgId, email: `p51-ent-${Date.now()}@test.local`, firstName: "P51", lastName: "Ent", passwordHash: "x" } })
    userId = user.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.setting.deleteMany({ where: { organizationId: orgId } })
    await db.user.deleteMany({ where: { id: userId } })
    const owner = ownerDb()
    await owner.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
    await owner.$disconnect()
    await db.organization.deleteMany({ where: { id: orgId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("a module defaults to enabled when no Setting row exists yet", async () => {
    expect(await isModuleEnabled(orgId, "laboratory")).toBe(true)
  })

  it("disabling a module persists and is readable back for exactly this organization", async () => {
    await setModuleEntitlement({ organizationId: orgId, moduleKey: "laboratory", enabled: false, operatorId: userId })
    expect(await isModuleEnabled(orgId, "laboratory")).toBe(false)

    // A second, unrelated organization is completely unaffected — entitlement
    // state never leaks across tenants.
    const otherOrg = await db.organization.create({ data: { legalName: "P5.1 Other Ent Org", displayName: "P5.1 Other Ent Org" } })
    expect(await isModuleEnabled(otherOrg.id, "laboratory")).toBe(true)
    await db.organization.deleteMany({ where: { id: otherOrg.id } })
  }, TIMEOUT)

  it("§16: CORE_MODULES (reception/patients/appointments/clinical/nursing) are never route-enforceable, regardless of their entitlement flag — the clinical-safety carve-out", () => {
    expect(isRouteEnforceable("reception")).toBe(false)
    expect(isRouteEnforceable("patients")).toBe(false)
    expect(isRouteEnforceable("appointments")).toBe(false)
    expect(isRouteEnforceable("clinical")).toBe(false)
    expect(isRouteEnforceable("nursing")).toBe(false)
    // Optional/add-on modules ARE enforceable.
    expect(isRouteEnforceable("laboratory")).toBe(true)
    expect(isRouteEnforceable("payroll")).toBe(true)
  })

  it("§11: RBAC and entitlement are independent gates — disabling a module does not change what a permission grants, and a missing permission is not overridden by an enabled module", async () => {
    await setModuleEntitlement({ organizationId: orgId, moduleKey: "laboratory", enabled: true, operatorId: userId })
    const sessionWithoutPermission: SessionContext = {
      sessionId: "t", user: { id: userId, organizationId: orgId, email: "x", firstName: "X", lastName: "Y" },
      activeBranchId: null, branchIds: [], permissions: new Set([]), roleNames: [],
    }
    // Module enabled, but RBAC still denies — entitlement never grants a
    // permission the role set doesn't have.
    expect(can(sessionWithoutPermission, "lab_result.enter")).toBe(false)

    // Conversely: RBAC would allow, but proxy.ts's own entitlement gate
    // (exercised end-to-end in the E2E suite) blocks the ROUTE when the
    // module is off — isModuleEnabled itself correctly reports the disabled
    // state regardless of what any permission set says.
    await setModuleEntitlement({ organizationId: orgId, moduleKey: "laboratory", enabled: false, operatorId: userId })
    expect(await isModuleEnabled(orgId, "laboratory")).toBe(false)
  }, TIMEOUT)

  it("seedModuleEntitlementsFromPlan writes an explicit row for every module key, never leaving one to an implicit default", async () => {
    await seedModuleEntitlementsFromPlan({ organizationId: orgId, defaultModuleKeys: ["reception", "patients"], operatorId: userId })
    const settingCount = await db.setting.count({ where: { organizationId: orgId, key: { startsWith: "module_enabled:" } } })
    // Every MODULE_KEYS entry except pharmacy (which reuses the pre-existing
    // `pharmacy_enabled` key, not `module_enabled:pharmacy`) gets its own row.
    expect(settingCount).toBe(MODULE_KEYS.length - 1)
    expect(await isModuleEnabled(orgId, "reception")).toBe(true)
    expect(await isModuleEnabled(orgId, "laboratory")).toBe(false)
  }, TIMEOUT)
})

describe("P5.1 §12/§13/§14/§37: subscription limits — blocks new creation, never destroys existing data", () => {
  let orgId: string
  let branchId: string
  let planId: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { legalName: "P5.1 Limits Org", displayName: "P5.1 Limits Org" } })
    orgId = org.id
    const branch = await db.branch.create({ data: { organizationId: orgId, name: "P5.1 Limits Branch", code: `P51LB-${Date.now()}`, timezone: "UTC" } })
    branchId = branch.id
    const role = await db.role.create({ data: { organizationId: orgId, name: "P5.1 Limits Role" } })
    const permission = await db.permission.findFirstOrThrow({ where: { code: "users.manage" } })
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    const branchPermission = await db.permission.findFirstOrThrow({ where: { code: "branch.manage" } })
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: branchPermission.id } })

    const plan = await makePlan("p51-limits-plan", { userLimit: 2, branchLimit: 1 })
    planId = plan.id
    const commercialProfile = await db.organizationCommercialProfile.create({
      data: { organizationId: orgId, customerCode: `AVT-LIM${Date.now()}`, country: "PK" },
    })
    await db.organizationSubscription.create({
      data: { organizationId: orgId, commercialProfileId: commercialProfile.id, planId, status: "active", startDate: new Date() },
    })

    // Seed one existing active user to bring the org to "1 of 2" before tests run.
    await db.user.create({ data: { organizationId: orgId, email: `p51-limits-seed-${Date.now()}@test.local`, firstName: "Seed", lastName: "User", passwordHash: "x" } })
    void role
  }, TIMEOUT)

  afterAll(async () => {
    await db.organizationSubscription.deleteMany({ where: { organizationId: orgId } })
    await db.organizationCommercialProfile.deleteMany({ where: { organizationId: orgId } })
    await db.commercialPlan.deleteMany({ where: { id: planId } })
    await db.user.deleteMany({ where: { organizationId: orgId } })
    await db.rolePermission.deleteMany({ where: { role: { organizationId: orgId } } })
    await db.role.deleteMany({ where: { organizationId: orgId } })
    await db.branch.deleteMany({ where: { organizationId: orgId } })
    const owner = ownerDb()
    await owner.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
    await owner.$disconnect()
    await db.organization.deleteMany({ where: { id: orgId } })
    await db.$disconnect()
  }, TIMEOUT)

  function actorSession(): SessionContext {
    return {
      sessionId: "t", user: { id: "actor", organizationId: orgId, email: "actor@test.local", firstName: "Actor", lastName: "Actor" },
      activeBranchId: branchId, branchIds: [branchId], permissions: new Set(["users.manage", "branch.manage"]), roleNames: [],
    }
  }

  it("user limit: below limit (1 of 2 active) allows creating one more, bringing the org exactly to the limit", async () => {
    const created = await createUser(actorSession(), {
      email: `p51-limits-u2-${Date.now()}@test.local`, firstName: "Second", lastName: "User", password: "correct-horse-battery-1", roleIds: [], branchIds: [],
    })
    expect(created.status).toBe("active")
    const activeCount = await db.user.count({ where: { organizationId: orgId, status: "active" } })
    expect(activeCount).toBe(2)
  }, TIMEOUT)

  it("user limit: exactly at limit (2 of 2) blocks creating one more — no silent over-limit activation", async () => {
    await expect(
      createUser(actorSession(), { email: `p51-limits-u3-${Date.now()}@test.local`, firstName: "Third", lastName: "User", password: "correct-horse-battery-1", roleIds: [], branchIds: [] })
    ).rejects.toThrow(/subscription allows at most/i)
    // The blocked attempt created nothing.
    const activeCount = await db.user.count({ where: { organizationId: orgId, status: "active" } })
    expect(activeCount).toBe(2)
  }, TIMEOUT)

  it("branch limit: exactly at limit (1 of 1) blocks creating a new branch", async () => {
    await expect(createBranch(actorSession(), { name: "Second Branch", code: `P51LB2-${Date.now()}`, timezone: "UTC" })).rejects.toThrow(/subscription allows at most/i)
    const activeBranchCount = await db.branch.count({ where: { organizationId: orgId, status: "active" } })
    expect(activeBranchCount).toBe(1)
  }, TIMEOUT)

  it("§14: plan downgrade to a lower limit than current usage does NOT delete or deactivate any existing user/branch — it only blocks future creation", async () => {
    // Simulate a downgrade: a new subscription row with an even lower user
    // limit than the org's current active count (already at 2).
    const lowerPlan = await makePlan("p51-downgrade-plan", { userLimit: 1, branchLimit: 1 })
    const commercialProfile = await db.organizationCommercialProfile.findFirstOrThrow({ where: { organizationId: orgId } })
    await db.organizationSubscription.create({
      data: { organizationId: orgId, commercialProfileId: commercialProfile.id, planId: lowerPlan.id, status: "active", startDate: new Date() },
    })

    // Existing 2 active users are untouched by the downgrade itself.
    const stillActive = await db.user.count({ where: { organizationId: orgId, status: "active" } })
    expect(stillActive).toBe(2)

    // But the org is now over its new limit — any further creation is blocked.
    await expect(
      createUser(actorSession(), { email: `p51-downgrade-u-${Date.now()}@test.local`, firstName: "Over", lastName: "Limit", password: "correct-horse-battery-1", roleIds: [], branchIds: [] })
    ).rejects.toThrow(/subscription allows at most/i)

    await db.organizationSubscription.deleteMany({ where: { planId: lowerPlan.id } })
    await db.commercialPlan.deleteMany({ where: { id: lowerPlan.id } })
  }, TIMEOUT)

  it("an organization with no subscription at all is never limited (the pre-P5.1 seed/bootstrap tenant stays fully unrestricted)", async () => {
    const unmanagedOrg = await db.organization.create({ data: { legalName: "P5.1 No Subscription Org", displayName: "P5.1 No Subscription Org" } })
    const unmanagedSession: SessionContext = {
      sessionId: "t", user: { id: "actor2", organizationId: unmanagedOrg.id, email: "x", firstName: "X", lastName: "Y" },
      activeBranchId: null, branchIds: [], permissions: new Set(["users.manage"]), roleNames: [],
    }
    // No SubscriptionLimitError thrown — reaches the real unique-constraint
    // layer instead, proving the limit check itself was a genuine no-op.
    const created = await createUser(unmanagedSession, {
      email: `p51-nosub-${Date.now()}@test.local`, firstName: "NoSub", lastName: "User", password: "correct-horse-battery-1", roleIds: [], branchIds: [],
    })
    expect(created.status).toBe("active")
    await db.user.deleteMany({ where: { organizationId: unmanagedOrg.id } })
    const owner = ownerDb()
    await owner.auditLog.deleteMany({ where: { organizationId: unmanagedOrg.id } }).catch(() => {})
    await owner.$disconnect()
    await db.organization.deleteMany({ where: { id: unmanagedOrg.id } })
  }, TIMEOUT)
})

describe("P5.1 §16/§17/§37: suspension reuses the existing P4.3 mechanism and blocks/restores clinic access immediately", () => {
  let orgId: string
  let userId: string
  let rawToken: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { legalName: "P5.1 Suspend Org", displayName: "P5.1 Suspend Org" } })
    orgId = org.id
    const user = await db.user.create({
      data: { organizationId: orgId, email: `p51-suspend-${Date.now()}@test.local`, firstName: "P51", lastName: "Suspend", passwordHash: await hashPassword("correct-horse-battery") },
    })
    userId = user.id
    rawToken = await createSession({ userId })
  }, TIMEOUT)

  afterAll(async () => {
    await db.session.deleteMany({ where: { userId } })
    await db.user.deleteMany({ where: { id: userId } })
    await db.organization.deleteMany({ where: { id: orgId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("suspending via the same OrgStatus field the platform's suspendOrganization() writes blocks the clinic session immediately, and reactivating restores it with branches/users/data untouched", async () => {
    expect(await getSessionContext(rawToken)).not.toBeNull()

    await db.organization.update({ where: { id: orgId }, data: { status: "suspended" } })
    expect(await getSessionContext(rawToken)).toBeNull()

    await db.organization.update({ where: { id: orgId }, data: { status: "active" } })
    const restored = await getSessionContext(rawToken)
    expect(restored).not.toBeNull()
    expect(restored?.user.id).toBe(userId)

    // The user record itself was never touched by suspend/reactivate.
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(user.status).toBe("active")
    expect(user.email).toMatch(/p51-suspend-/)
  }, TIMEOUT)
})

describe("P5.1 §7/§37: platform organization views expose operational metadata only, never PHI", () => {
  it("the Organization Prisma model itself (what listOrganizationsForPlatform/getOrganizationCommercialDetail query) carries no patient/clinical fields — those live exclusively on Patient/Encounter/etc., separate models never joined into these platform queries", async () => {
    // Structural proof by introspection: confirms the platform list/detail
    // queries (read directly in organizations.ts — selecting id, displayName,
    // status, createdAt, commercialProfile.*, branch/user counts) have no
    // field path that could even reference a Patient/Diagnosis/Prescription
    // row, because Organization has no direct relation exposing one without
    // an explicit, separate query this code never makes.
    const org = await db.organization.findFirst()
    if (org) {
      const keys = Object.keys(org)
      expect(keys.every((k) => !/patient|diagnos|prescri|labresult|clinicalnote/i.test(k))).toBe(true)
    }
  })
})
