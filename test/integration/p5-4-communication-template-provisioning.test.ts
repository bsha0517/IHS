import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { createSession, getSessionContext } from "@/lib/auth/session"
import { createPlatformSession } from "@/lib/auth/platform-session"
import { provisionClinic } from "@/lib/domains/commercial/provisioning"
import { ensureCommunicationTemplates, updateTemplate } from "@/lib/domains/communications/templates"
import { sendTemplateMessage } from "@/lib/domains/communications/service"
import { MODULE_KEYS } from "@/lib/platform/entitlements-shared"
import type { PlatformSessionContext } from "@/lib/auth/platform-session"
import type { SessionContext } from "@/lib/auth/session"
import type { ProvisionClinicInput } from "@/lib/domains/commercial/schemas"

const TIMEOUT = 60000

/**
 * P5.4 §3 — the real P5.3 UAT defect this closes: a freshly-provisioned
 * clinic had no default CommTemplate rows, so its very first appointment
 * notification dead-lettered forever. These tests exercise
 * `ensureCommunicationTemplates` (src/lib/domains/communications/templates.ts)
 * directly, through the real `provisionClinic` flow, against a real database
 * — not mocked — per the exact scenarios P5.4's own command requires:
 * provision → templates exist; reseed → no duplicates; edit → reseed →
 * customization preserved; concurrent seed → no duplicates; notification
 * resolves.
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
    legalName: `P5.4 Test Clinic Legal ${suffix}`,
    displayName: `P5.4 Test Clinic ${suffix}`,
    defaultCurrency: "USD",
    defaultTimezone: "UTC",
    branchName: "Main Branch",
    branchCode: `P54-${suffix}`.slice(0, 20),
    branchAddress: null,
    branchPhone: null,
    adminFirstName: "Test",
    adminLastName: "Admin",
    adminEmail: `p54-admin-${suffix}@test.local`,
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
  await db.commTemplate.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await db.patient.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
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

describe("P5.4 — communication template provisioning", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planWithBillingId: string
  let planNoBillingId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p54-comm-op")
    operatorId = op.operator.id
    operatorSession = op.session
    planWithBillingId = (await makePlan("p54-comm-plan-billing", [...MODULE_KEYS])).id
    planNoBillingId = (await makePlan("p54-comm-plan-nobilling", MODULE_KEYS.filter((k) => k !== "pos_billing" && k !== "finance"))).id
  }, TIMEOUT)

  afterAll(async () => {
    for (const orgId of createdOrgIds) await cleanupOrg(orgId)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: { in: [planWithBillingId, planNoBillingId] } } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("provisioning a clinic seeds every applicable baseline template exactly once, and respects module gating for payment_reminder", async () => {
    const withBilling = await provisionClinic(operatorSession, baseProvisionInput(planWithBillingId))
    createdOrgIds.push(withBilling.organizationId)
    const withBillingTemplates = await db.commTemplate.findMany({ where: { organizationId: withBilling.organizationId } })
    expect(withBillingTemplates.map((t) => t.key).sort()).toEqual(
      ["appointment_cancellation", "appointment_confirmation", "appointment_reminder", "birthday", "payment_reminder"].sort()
    )

    const noBilling = await provisionClinic(operatorSession, baseProvisionInput(planNoBillingId))
    createdOrgIds.push(noBilling.organizationId)
    const noBillingTemplates = await db.commTemplate.findMany({ where: { organizationId: noBilling.organizationId } })
    expect(noBillingTemplates.map((t) => t.key).sort()).toEqual(["appointment_cancellation", "appointment_confirmation", "appointment_reminder", "birthday"].sort())
  }, TIMEOUT)

  it("re-running the seed on an already-provisioned clinic creates no duplicates", async () => {
    const provisioned = await provisionClinic(operatorSession, baseProvisionInput(planWithBillingId))
    createdOrgIds.push(provisioned.organizationId)
    const before = await db.commTemplate.findMany({ where: { organizationId: provisioned.organizationId } })

    await ensureCommunicationTemplates(provisioned.organizationId)
    await ensureCommunicationTemplates(provisioned.organizationId)
    await ensureCommunicationTemplates(provisioned.organizationId)

    const after = await db.commTemplate.findMany({ where: { organizationId: provisioned.organizationId } })
    expect(after.length).toBe(before.length)
    expect(after.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort())
  }, TIMEOUT)

  it("an edited (or deactivated) template is never overwritten or resurrected by re-seeding", async () => {
    const provisioned = await provisionClinic(operatorSession, baseProvisionInput(planWithBillingId))
    createdOrgIds.push(provisioned.organizationId)

    const rawToken = await createSession({ userId: provisioned.adminUserId })
    const session = (await getSessionContext(rawToken)) as SessionContext
    const confirmation = await db.commTemplate.findFirstOrThrow({ where: { organizationId: provisioned.organizationId, key: "appointment_confirmation" } })

    const customBody = "CUSTOM: {{patientName}}, see you {{appointmentDate}} at {{appointmentTime}}!"
    await updateTemplate(session, confirmation.id, { key: confirmation.key, channel: confirmation.channel, name: "My Custom Confirmation", subject: null, body: customBody })

    await ensureCommunicationTemplates(provisioned.organizationId)
    await ensureCommunicationTemplates(provisioned.organizationId)

    const stillCustom = await db.commTemplate.findFirstOrThrow({ where: { id: confirmation.id } })
    expect(stillCustom.body).toBe(customBody)
    expect(stillCustom.name).toBe("My Custom Confirmation")

    const dup = await db.commTemplate.count({ where: { organizationId: provisioned.organizationId, key: "appointment_confirmation" } })
    expect(dup).toBe(1)
  }, TIMEOUT)

  it("concurrent seed calls against a brand-new organization never duplicate a template or throw", async () => {
    const provisioned = await provisionClinic(operatorSession, baseProvisionInput(planWithBillingId))
    createdOrgIds.push(provisioned.organizationId)
    // provisionClinic already seeded once — delete to simulate a genuinely
    // fresh, never-seeded organization racing two concurrent first-seeds.
    await db.commTemplate.deleteMany({ where: { organizationId: provisioned.organizationId } })

    await expect(Promise.all([ensureCommunicationTemplates(provisioned.organizationId), ensureCommunicationTemplates(provisioned.organizationId)])).resolves.not.toThrow()

    const rows = await db.commTemplate.findMany({ where: { organizationId: provisioned.organizationId } })
    expect(rows.length).toBe(5)
    const keys = rows.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  }, TIMEOUT)

  it("a real appointment notification resolves against the seeded template and renders its variables", async () => {
    const provisioned = await provisionClinic(operatorSession, baseProvisionInput(planWithBillingId))
    createdOrgIds.push(provisioned.organizationId)

    const patient = await db.patient.create({
      data: {
        organizationId: provisioned.organizationId,
        registrationBranchId: provisioned.branchId,
        mrn: `P54-MRN-${Date.now()}`,
        firstName: "Test",
        lastName: "Patient",
        dob: new Date("1990-01-01"),
        gender: "male",
        mobile: "0300-0000000",
      },
    })

    const rawToken = await createSession({ userId: provisioned.adminUserId })
    const session = (await getSessionContext(rawToken)) as SessionContext

    const message = await sendTemplateMessage(session, {
      patientId: patient.id,
      templateKey: "appointment_confirmation",
      variables: { patientName: "Test Patient", providerName: "Dr. Test", appointmentDate: "1 Jan 2027", appointmentTime: "10:00", branchName: "Main Branch" },
    })

    expect(message.body).toContain("Test Patient")
    expect(message.body).toContain("Dr. Test")
    expect(message.body).not.toContain("{{")
  }, TIMEOUT)
})
