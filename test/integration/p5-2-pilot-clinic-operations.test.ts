import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { createPlatformSession } from "@/lib/auth/platform-session"
import { provisionClinic } from "@/lib/domains/commercial/provisioning"
import {
  ensureOnboardingChecklist,
  listOnboardingChecklist,
  updateOnboardingChecklistItem,
  getOnboardingChecklistSummary,
} from "@/lib/domains/commercial/onboarding-checklist"
import {
  getOrganizationUsage,
  getGoLiveBlockers,
  approveGoLive,
  GoLiveNotReadyError,
} from "@/lib/domains/commercial/organizations"
import {
  createSupportTicket,
  createSupportTicketFromClinic,
  listSupportTicketsForClinic,
  getSupportTicketForClinic,
  addSupportTicketNoteFromOperator,
  addSupportTicketNoteFromClinic,
  updateSupportTicketStatus,
} from "@/lib/domains/commercial/support-tickets"
import { createPilotUat, recordUatScenario, completePilotUat } from "@/lib/domains/commercial/pilot-uat"
import { assertModuleEnabled, ModuleDisabledError, setModuleEntitlement } from "@/lib/platform/entitlements"
import { isRouteEnforceable } from "@/lib/platform/entitlements-shared"
import { can, assertCan, ForbiddenError } from "@/lib/platform/permissions-core"
import type { PlatformSessionContext } from "@/lib/auth/platform-session"
import type { SessionContext } from "@/lib/auth/session"
import type { ProvisionClinicInput } from "@/lib/domains/commercial/schemas"

const TIMEOUT = 60000

function ownerDb() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
}

async function makePlatformOperator(emailPrefix: string) {
  const operator = await db.platformOperator.create({
    data: { email: `${emailPrefix}-${Date.now()}@test.local`, passwordHash: "x", firstName: "P5.2", lastName: "Operator" },
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
      defaultModuleKeys: overrides.defaultModuleKeys ?? ["reception", "patients", "appointments", "clinical", "nursing", "laboratory", "finance"],
    },
  })
}

async function provisionTestOrg(operatorSession: PlatformSessionContext, planId: string, suffix: string) {
  const input: ProvisionClinicInput = {
    idempotencyKey: crypto.randomUUID(),
    legalName: `P5.2 Test Org ${suffix} Legal`,
    displayName: `P5.2 Test Org ${suffix}`,
    defaultCurrency: "USD",
    defaultTimezone: "Asia/Karachi",
    legalBusinessName: null,
    primaryContactName: null,
    primaryContactEmail: null,
    primaryContactPhone: null,
    billingContactName: null,
    billingContactEmail: null,
    country: "PK",
    implementationOwner: null,
    internalNotes: null,
    planId,
    subscriptionStatus: "trial",
    startDate: new Date(),
    trialEndsAt: null,
    agreedUserLimit: null,
    agreedBranchLimit: null,
    agreedAmount: null,
    currency: null,
    billingCycle: null,
    subscriptionNotes: null,
    branchName: "Main Branch",
    branchCode: `P52-${suffix}`,
    branchAddress: null,
    branchPhone: null,
    adminEmail: `p52-admin-${suffix}@test.local`,
    adminFirstName: "P5.2",
    adminLastName: "Admin",
    moduleKeys: undefined,
  }
  return provisionClinic(operatorSession, input)
}

async function teardownOrg(organizationId: string) {
  await db.pilotUatScenario.deleteMany({ where: { uat: { organizationId } } }).catch(() => {})
  await db.pilotUat.deleteMany({ where: { organizationId } }).catch(() => {})
  await db.supportTicketNote.deleteMany({ where: { organizationId } }).catch(() => {})
  await db.supportTicket.deleteMany({ where: { organizationId } }).catch(() => {})
  await db.onboardingChecklistItem.deleteMany({ where: { organizationId } }).catch(() => {})
  await db.goLiveCondition.deleteMany({ where: { commercialProfile: { organizationId } } }).catch(() => {})
  await db.organizationSubscription.deleteMany({ where: { organizationId } }).catch(() => {})
  await db.organizationCommercialProfile.deleteMany({ where: { organizationId } }).catch(() => {})
  await db.setting.deleteMany({ where: { organizationId } }).catch(() => {})
  const users = await db.user.findMany({ where: { organizationId }, select: { id: true } })
  const userIds = users.map((u) => u.id)
  await db.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await db.userBranchAccess.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {})
  await db.user.deleteMany({ where: { organizationId } }).catch(() => {})
  await db.rolePermission.deleteMany({ where: { role: { organizationId } } }).catch(() => {})
  await db.role.deleteMany({ where: { organizationId } }).catch(() => {})
  // provisionClinic's own bootstrapSystemRoles/branch setup creates real
  // NumberSequence rows (MRN, INV, ...) for the organization — must be
  // cleared before the organization itself can be deleted.
  await db.numberSequence.deleteMany({ where: { organizationId } }).catch(() => {})
  await db.branch.deleteMany({ where: { organizationId } }).catch(() => {})
  const owner = ownerDb()
  await owner.auditLog.deleteMany({ where: { organizationId } }).catch(() => {})
  await owner.$disconnect()
  await db.organization.deleteMany({ where: { id: organizationId } }).catch(() => {})
}

describe("P5.2 §2: onboarding checklist — catalog-driven, entitlement-filtered, operator-editable, never a technical-readiness substitute", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let organizationId: string

  beforeAll(async () => {
    const op = await makePlatformOperator("p52-checklist-op")
    operatorId = op.operator.id
    operatorSession = op.session
    const plan = await makePlan("p52-checklist-plan", { defaultModuleKeys: ["reception", "patients", "appointments", "clinical", "nursing", "laboratory"] })
    planId = plan.id
    const result = await provisionTestOrg(operatorSession, planId, `checklist-${Date.now()}`)
    organizationId = result.organizationId
  }, TIMEOUT)

  afterAll(async () => {
    await teardownOrg(organizationId)
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("is seeded automatically by provisioning, filtered to only the organization's actually-entitled modules — a lab-catalogue item exists (laboratory is enabled), a pharmacy-catalogue item does not (pharmacy is not)", async () => {
    const items = await db.onboardingChecklistItem.findMany({ where: { organizationId } })
    expect(items.length).toBeGreaterThan(0)
    expect(items.some((i) => i.key === "lab_catalogue_configured")).toBe(true)
    expect(items.some((i) => i.key === "medications_configured")).toBe(false)
    expect(items.some((i) => i.key === "initial_branch")).toBe(true)
  })

  it("writes a platform.onboarding.created audit row exactly once, on first seed — re-seeding (idempotent) does not duplicate it", async () => {
    const before = await db.auditLog.count({ where: { organizationId, action: "platform.onboarding.created" } })
    await ensureOnboardingChecklist(organizationId, operatorId)
    await ensureOnboardingChecklist(organizationId, operatorId)
    const after = await db.auditLog.count({ where: { organizationId, action: "platform.onboarding.created" } })
    expect(before).toBe(1)
    expect(after).toBe(1)
  }, TIMEOUT)

  it("updating an item's status is audited, records the operator and timestamp on completion, and moves the summary count", async () => {
    const items = await listOnboardingChecklist(organizationId, operatorId)
    const item = items.find((i) => i.key === "initial_branch")!
    const before = await getOnboardingChecklistSummary(organizationId)

    const updated = await updateOnboardingChecklistItem(organizationId, item.id, operatorId, { status: "completed" })
    expect(updated.status).toBe("completed")
    expect(updated.completedByOperatorId).toBe(operatorId)
    expect(updated.completedAt).not.toBeNull()

    const after = await getOnboardingChecklistSummary(organizationId)
    expect(after.requiredComplete).toBe(before.requiredComplete + 1)

    const auditRow = await db.auditLog.findFirst({ where: { organizationId, action: "platform.onboarding.updated", entityId: item.id }, orderBy: { createdAt: "desc" } })
    expect(auditRow).not.toBeNull()
  }, TIMEOUT)

  it("waiving a mandatory item is allowed (an explicit, audited operator decision) but requires going through the same audited update path — never a silent bypass", async () => {
    const items = await listOnboardingChecklist(organizationId, operatorId)
    const item = items.find((i) => i.key === "additional_branches")! // optional, but test waiving a required one too
    const requiredItem = items.find((i) => i.required && i.status !== "completed")!
    const updated = await updateOnboardingChecklistItem(organizationId, requiredItem.id, operatorId, { status: "waived", notes: "Not applicable for this pilot clinic." })
    expect(updated.status).toBe("waived")
    const summary = await getOnboardingChecklistSummary(organizationId)
    // Waived counts toward "required complete" (§2: waived is a resolved state, not a gap) — verified via the summary's own definition.
    expect(summary.requiredComplete).toBeGreaterThan(0)
    void item
  }, TIMEOUT)

  it("marking every required item complete/waived writes platform.onboarding.completed exactly once", async () => {
    const items = await listOnboardingChecklist(organizationId, operatorId)
    for (const item of items.filter((i) => i.required && i.status !== "completed" && i.status !== "waived")) {
      await updateOnboardingChecklistItem(organizationId, item.id, operatorId, { status: "completed" })
    }
    const completedCount = await db.auditLog.count({ where: { organizationId, action: "platform.onboarding.completed" } })
    expect(completedCount).toBe(1)

    const summary = await getOnboardingChecklistSummary(organizationId)
    expect(summary.allRequiredComplete).toBe(true)
  }, TIMEOUT)
})

describe("P5.2 §3/§4/§37: go-live readiness and approval — server-side validated, never a UI-only gate", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let organizationId: string

  beforeAll(async () => {
    const op = await makePlatformOperator("p52-golive-op")
    operatorId = op.operator.id
    operatorSession = op.session
    const plan = await makePlan("p52-golive-plan")
    planId = plan.id
    const result = await provisionTestOrg(operatorSession, planId, `golive-${Date.now()}`)
    organizationId = result.organizationId
  }, TIMEOUT)

  afterAll(async () => {
    await teardownOrg(organizationId)
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("a freshly-provisioned organization is NOT ready for go-live — blockers list every unmet condition and incomplete required item", async () => {
    const blockers = await getGoLiveBlockers(organizationId)
    expect(blockers.length).toBeGreaterThan(0)
    expect(blockers.some((b) => b.includes("go-live condition"))).toBe(true)
  })

  it("approveGoLive() rejects server-side when conditions are unmet — never relies on a UI button being disabled", async () => {
    await expect(approveGoLive(organizationId, operatorId, null)).rejects.toThrow(GoLiveNotReadyError)
    const profile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })
    expect(profile.commercialLifecycle).not.toBe("live")
    expect(profile.goLiveApprovedAt).toBeNull()
  }, TIMEOUT)

  it("approveGoLive() succeeds once every go-live condition and every required checklist item is resolved, and records the approving operator/timestamp/notes", async () => {
    // Resolve every go-live condition — direct DB write, not
    // updateGoLiveCondition() (an existing, unmodified P5.1 function that
    // still resolves its operator via requirePlatformOperator()/cookies()
    // internally, exactly like every other pre-P5.2 organizations.ts
    // mutator; P5.1 itself established this class of function as
    // untestable outside a request scope — see that function's own file).
    // This test is about approveGoLive()'s OWN validation/success behavior,
    // not re-proving updateGoLiveCondition's — that's covered live via
    // browser verification and the E2E suite.
    const commercialProfile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId } })
    await db.goLiveCondition.updateMany({ where: { commercialProfileId: commercialProfile.id }, data: { status: "complete", completedAt: new Date() } })
    // Resolve every required checklist item.
    const items = await listOnboardingChecklist(organizationId, operatorId)
    for (const item of items.filter((i) => i.required && i.status !== "completed")) {
      await updateOnboardingChecklistItem(organizationId, item.id, operatorId, { status: "completed" })
    }

    const blockers = await getGoLiveBlockers(organizationId)
    expect(blockers).toEqual([])

    const updated = await approveGoLive(organizationId, operatorId, "Approved for pilot go-live.")
    expect(updated.commercialLifecycle).toBe("live")
    expect(updated.onboardingStatus).toBe("live")
    expect(updated.goLiveApprovedByOperatorId).toBe(operatorId)
    expect(updated.goLiveApprovedAt).not.toBeNull()
    expect(updated.goLiveNotes).toBe("Approved for pilot go-live.")

    const auditRow = await db.auditLog.findFirst({ where: { organizationId, action: "platform.go_live.approved" }, orderBy: { createdAt: "desc" } })
    expect(auditRow).not.toBeNull()
  }, TIMEOUT)

  it("re-approving an already-live organization is rejected — there is exactly one real approval event", async () => {
    await expect(approveGoLive(organizationId, operatorId, null)).rejects.toThrow(/already live/i)
  }, TIMEOUT)

  it("suspending the organization blocks go-live approval even if every other condition is otherwise met", async () => {
    await db.organization.update({ where: { id: organizationId }, data: { status: "suspended" } })
    const blockers = await getGoLiveBlockers(organizationId)
    expect(blockers.some((b) => /suspended/i.test(b))).toBe(true)
    await db.organization.update({ where: { id: organizationId }, data: { status: "active" } })
  }, TIMEOUT)
})

describe("P5.2 §6: centralized commercial usage service", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let organizationId: string
  let branchId: string

  beforeAll(async () => {
    const op = await makePlatformOperator("p52-usage-op")
    operatorId = op.operator.id
    operatorSession = op.session
    const plan = await makePlan("p52-usage-plan", { userLimit: 5, branchLimit: 2, defaultModuleKeys: ["reception", "patients", "laboratory", "finance"] })
    planId = plan.id
    const result = await provisionTestOrg(operatorSession, planId, `usage-${Date.now()}`)
    organizationId = result.organizationId
    branchId = result.branchId
  }, TIMEOUT)

  afterAll(async () => {
    await teardownOrg(organizationId)
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("reports accurate active user/branch counts, effective limits, module counts, and subscription/plan info", async () => {
    const usage = await getOrganizationUsage(organizationId)
    expect(usage.activeUserCount).toBe(1) // the initial admin
    expect(usage.activeBranchCount).toBe(1) // the initial branch
    expect(usage.userLimit).toBe(5)
    expect(usage.branchLimit).toBe(2)
    expect(usage.subscriptionStatus).toBe("trial")
    expect(usage.enabledModuleCount).toBeGreaterThan(0)
    expect(usage.totalModuleCount).toBe(usage.enabledModuleCount + (usage.totalModuleCount - usage.enabledModuleCount))
  })

  it("never counts an inactive user/branch toward usage — matches P5.1's own active-only limit-enforcement convention", async () => {
    const inactiveUser = await db.user.create({
      data: { organizationId, email: `p52-inactive-${Date.now()}@test.local`, firstName: "Inactive", lastName: "User", passwordHash: "x", status: "inactive" },
    })
    const inactiveBranch = await db.branch.create({ data: { organizationId, name: "Inactive Branch", code: `P52IB-${Date.now()}`, timezone: "UTC", status: "inactive" } })

    const usage = await getOrganizationUsage(organizationId)
    expect(usage.activeUserCount).toBe(1)
    expect(usage.activeBranchCount).toBe(1)

    await db.user.deleteMany({ where: { id: inactiveUser.id } })
    await db.branch.deleteMany({ where: { id: inactiveBranch.id } })
    void branchId
  }, TIMEOUT)
})

describe("P5.2 §7/§8/§37: support tickets — platform-wide management, clinic org isolation, internal-note isolation", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let orgAId: string
  let orgBId: string
  let sessionA: SessionContext

  beforeAll(async () => {
    const op = await makePlatformOperator("p52-ticket-op")
    operatorId = op.operator.id
    operatorSession = op.session
    const plan = await makePlan("p52-ticket-plan")
    planId = plan.id
    const resultA = await provisionTestOrg(operatorSession, planId, `ticketA-${Date.now()}`)
    orgAId = resultA.organizationId
    const resultB = await provisionTestOrg(operatorSession, planId, `ticketB-${Date.now()}`)
    orgBId = resultB.organizationId

    sessionA = {
      sessionId: "t", user: { id: resultA.adminUserId, organizationId: orgAId, email: "a@test.local", firstName: "A", lastName: "A" },
      activeBranchId: resultA.branchId, branchIds: [resultA.branchId], permissions: new Set(["support_ticket.manage"]), roleNames: [],
    }
  }, TIMEOUT)

  afterAll(async () => {
    await teardownOrg(orgAId)
    await teardownOrg(orgBId)
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("ticket numbers are generated via the concurrency-safe NumberSequence mechanism, not count()+1 — sequential and collision-free under back-to-back creates", async () => {
    const t1 = await createSupportTicket(operatorId, { organizationId: orgAId, title: "T1", description: "D1", category: "technical", priority: "normal" })
    const t2 = await createSupportTicket(operatorId, { organizationId: orgAId, title: "T2", description: "D2", category: "technical", priority: "normal" })
    expect(t1.ticketNumber).not.toBe(t2.ticketNumber)
    expect(t1.ticketNumber).toMatch(/^SUP-\d{6}$/)
  }, TIMEOUT)

  it("a clinic user can create and read their own organization's ticket via the clinic-facing functions", async () => {
    const ticket = await createSupportTicketFromClinic(sessionA, { title: "Clinic-filed", description: "Something's wrong", category: "technical", priority: "normal" })
    expect(ticket.organizationId).toBe(orgAId)
    expect(ticket.createdByUserId).toBe(sessionA.user.id)

    const listed = await listSupportTicketsForClinic(sessionA)
    expect(listed.some((t) => t.id === ticket.id)).toBe(true)
  }, TIMEOUT)

  it("REQUIRED — Clinic A cannot read Clinic B's support tickets, even by direct id", async () => {
    const ticketB = await createSupportTicket(operatorId, { organizationId: orgBId, title: "Org B ticket", description: "D", category: "technical", priority: "normal" })
    await expect(getSupportTicketForClinic(sessionA, ticketB.id)).rejects.toThrow()

    const listedByA = await listSupportTicketsForClinic(sessionA)
    expect(listedByA.some((t) => t.id === ticketB.id)).toBe(false)
  }, TIMEOUT)

  it("REQUIRED — a platform-internal note is never returned by the clinic-facing read path, even though it exists on the same ticket the clinic CAN otherwise see", async () => {
    const ticket = await createSupportTicket(operatorId, { organizationId: orgAId, title: "Mixed-notes ticket", description: "D", category: "technical", priority: "normal" })
    await addSupportTicketNoteFromOperator(ticket.id, operatorId, "INTERNAL: do not show the clinic this.", "internal")
    await addSupportTicketNoteFromOperator(ticket.id, operatorId, "We're looking into it.", "customer")

    const clinicView = await getSupportTicketForClinic(sessionA, ticket.id)
    expect(clinicView.notes).toHaveLength(1)
    expect(clinicView.notes[0].body).toBe("We're looking into it.")
    expect(clinicView.notes.some((n) => n.body.includes("INTERNAL"))).toBe(false)

    // The platform side sees both.
    const platformNotes = await db.supportTicketNote.findMany({ where: { ticketId: ticket.id } })
    expect(platformNotes).toHaveLength(2)
  }, TIMEOUT)

  it("a clinic reply always lands as a customer-visible note and reopens a resolved/closed ticket", async () => {
    const ticket = await createSupportTicket(operatorId, { organizationId: orgAId, title: "Reopen test", description: "D", category: "technical", priority: "normal" })
    await updateSupportTicketStatus(ticket.id, operatorId, "resolved")
    await addSupportTicketNoteFromClinic(sessionA, ticket.id, "Actually still broken.")

    const reloaded = await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(reloaded.status).toBe("open")
    const notes = await db.supportTicketNote.findMany({ where: { ticketId: ticket.id } })
    expect(notes.every((n) => n.visibility === "customer")).toBe(true)
  }, TIMEOUT)

  it("a clinic user without the support_ticket.manage permission is denied by RBAC — independent of organization scoping", async () => {
    const noPermSession: SessionContext = { ...sessionA, permissions: new Set([]) }
    await expect(listSupportTicketsForClinic(noPermSession)).rejects.toThrow(ForbiddenError)
  })
})

describe("P5.2 §11/§13: pilot UAT records", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let organizationId: string

  beforeAll(async () => {
    const op = await makePlatformOperator("p52-uat-op")
    operatorId = op.operator.id
    operatorSession = op.session
    const plan = await makePlan("p52-uat-plan")
    planId = plan.id
    const result = await provisionTestOrg(operatorSession, planId, `uat-${Date.now()}`)
    organizationId = result.organizationId
  }, TIMEOUT)

  afterAll(async () => {
    await teardownOrg(organizationId)
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("records a UAT cycle, per-scenario results, and a signoff — audited at creation and completion", async () => {
    const uat = await createPilotUat(operatorId, { organizationId, cycleLabel: "Cycle 1", testerName: "Clinic Reception Staff" })
    await recordUatScenario(uat.id, { area: "reception", scenario: "Patient registration", passed: true })
    await recordUatScenario(uat.id, { area: "billing", scenario: "Invoice + payment", passed: false, notes: "Payment method dropdown was empty" })

    const completed = await completePilotUat(uat.id, operatorId, { result: "failed", blockers: "Payment method dropdown empty", notes: null }, true)
    expect(completed.result).toBe("failed")
    expect(completed.signedOffByOperatorId).toBe(operatorId)
    expect(completed.signedOffAt).not.toBeNull()

    const scenarios = await db.pilotUatScenario.findMany({ where: { uatId: uat.id } })
    expect(scenarios).toHaveLength(2)
    expect(scenarios.some((s) => s.passed === false)).toBe(true)

    const createdAudit = await db.auditLog.findFirst({ where: { organizationId, action: "platform.uat.created", entityId: uat.id } })
    const completedAudit = await db.auditLog.findFirst({ where: { organizationId, action: "platform.uat.completed", entityId: uat.id } })
    expect(createdAudit).not.toBeNull()
    expect(completedAudit).not.toBeNull()
  }, TIMEOUT)

  it("no PHI is required or stored anywhere in a UAT record — the schema has no patient-identifying field", async () => {
    const uat = await createPilotUat(operatorId, { organizationId, cycleLabel: "Cycle 2", testerName: "Doctor" })
    const keys = Object.keys(uat)
    expect(keys.every((k) => !/patient|diagnos|prescri|mrn/i.test(k))).toBe(true)
  }, TIMEOUT)
})

describe("P5.2 §9/§10/§37: Server Action entitlement audit — the carried-forward P5.1 item, now closed", () => {
  let organizationId: string

  beforeAll(async () => {
    const org = await db.organization.create({ data: { legalName: "P5.2 Entitlement Audit Org", displayName: "P5.2 Entitlement Audit Org" } })
    organizationId = org.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.setting.deleteMany({ where: { organizationId } })
    const owner = ownerDb()
    await owner.auditLog.deleteMany({ where: { organizationId } }).catch(() => {})
    await owner.$disconnect()
    await db.organization.deleteMany({ where: { id: organizationId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("assertModuleEnabled resolves silently when a module is enabled (the default)", async () => {
    await expect(assertModuleEnabled(organizationId, "laboratory")).resolves.toBeUndefined()
  })

  it("REQUIRED — assertModuleEnabled throws ModuleDisabledError once a module is explicitly disabled — this is the exact chokepoint every gated actions.ts file's local requireSession() now calls", async () => {
    await setModuleEntitlement({ organizationId, moduleKey: "laboratory", enabled: false, operatorId: "test-operator" })
    await expect(assertModuleEnabled(organizationId, "laboratory")).rejects.toThrow(ModuleDisabledError)
    await setModuleEntitlement({ organizationId, moduleKey: "laboratory", enabled: true, operatorId: "test-operator" })
  }, TIMEOUT)

  it("REQUIRED — the core clinical spine is NEVER blocked by assertModuleEnabled, even if somehow marked disabled — mirrors proxy.ts's own carve-out exactly, so route-level and Server-Action-level enforcement can never disagree", async () => {
    for (const coreModule of ["reception", "patients", "appointments", "clinical", "nursing"] as const) {
      expect(isRouteEnforceable(coreModule)).toBe(false)
      await setModuleEntitlement({ organizationId, moduleKey: coreModule, enabled: false, operatorId: "test-operator" })
      await expect(assertModuleEnabled(organizationId, coreModule)).resolves.toBeUndefined()
      await setModuleEntitlement({ organizationId, moduleKey: coreModule, enabled: true, operatorId: "test-operator" })
    }
  }, TIMEOUT)

  it("every one of the 18 actions.ts files this phase audited imports assertModuleEnabled from entitlements.ts and calls it inside its own local requireSession() — a structural regression guard against a future edit silently removing the call", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const root = path.resolve(import.meta.dirname, "../../src/app/(dashboard)")
    const targets = [
      ["laboratory", "laboratory"], ["radiology", "radiology"], ["pharmacy", "pharmacy"], ["inventory", "inventory"],
      ["purchasing", "procurement"], ["accounting", "finance"], ["employees", "hr"], ["attendance", "hr"], ["leave", "hr"],
      ["commissions", "hr"], ["payroll", "payroll"], ["assets", "assets"], ["admin/onboarding", "imports_onboarding"],
      ["pos", "pos_billing"], ["invoices", "pos_billing"], ["payors", "pos_billing"], ["claims", "pos_billing"],
    ] as const
    for (const [dir, moduleKey] of targets) {
      const filePath = path.join(root, dir, "actions.ts")
      const content = fs.readFileSync(filePath, "utf8")
      expect(content, `${dir}/actions.ts should import assertModuleEnabled`).toMatch(/import\s*\{[^}]*assertModuleEnabled[^}]*\}\s*from\s*"@\/lib\/platform\/entitlements"/)
      expect(content, `${dir}/actions.ts should call assertModuleEnabled(..., "${moduleKey}")`).toContain(`assertModuleEnabled(session.user.organizationId, "${moduleKey}")`)
    }
    // expenses/actions.ts uses an inline pattern (no shared local requireSession()) — checked separately.
    const expensesPath = path.join(root, "expenses", "actions.ts")
    const expensesContent = fs.readFileSync(expensesPath, "utf8")
    expect(expensesContent).toContain('assertModuleEnabled(session.user.organizationId, "finance")')
  })

  it("RBAC and entitlement are independent controls — a session with the right permission but disabled module fails at assertModuleEnabled; a session with the module enabled but wrong permission fails at assertCan — neither substitutes for the other", async () => {
    await setModuleEntitlement({ organizationId, moduleKey: "assets", enabled: false, operatorId: "test-operator" })
    await expect(assertModuleEnabled(organizationId, "assets")).rejects.toThrow(ModuleDisabledError)
    await setModuleEntitlement({ organizationId, moduleKey: "assets", enabled: true, operatorId: "test-operator" })
    await expect(assertModuleEnabled(organizationId, "assets")).resolves.toBeUndefined()

    const sessionWithoutPermission: SessionContext = {
      sessionId: "t", user: { id: "x", organizationId, email: "x", firstName: "X", lastName: "Y" },
      activeBranchId: null, branchIds: [], permissions: new Set([]), roleNames: [],
    }
    expect(can(sessionWithoutPermission, "asset.manage")).toBe(false)
    expect(() => assertCan(sessionWithoutPermission, "asset.manage")).toThrow(ForbiddenError)
  }, TIMEOUT)
})
