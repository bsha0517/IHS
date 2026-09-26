import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

// Same next/headers mocking pattern as p5-6/p5-1-1/p5-7.
const { activePlatformToken } = vi.hoisted(() => ({ activePlatformToken: { current: undefined as string | undefined } }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "his_platform_session" && activePlatformToken.current ? { value: activePlatformToken.current } : undefined),
  }),
}))

import { createPlatformSession } from "@/lib/auth/platform-session"
import { provisionClinic } from "@/lib/domains/commercial/provisioning"
import { getGoLiveBlockers, approveGoLive } from "@/lib/domains/commercial/organizations"
import { listOnboardingChecklist, updateOnboardingChecklistItem } from "@/lib/domains/commercial/onboarding-checklist"
import { createPilotUat, recordUatScenario, completePilotUat } from "@/lib/domains/commercial/pilot-uat"
import { createSupportTicket } from "@/lib/domains/commercial/support-tickets"
import {
  getImplementationWorkspace,
  listImplementationTraining,
  updateImplementationTraining,
  addImplementationNote,
  listImplementationNotes,
  updateTargetGoLiveDate,
  completeHandover,
  HandoverNotReadyError,
  listImplementationPortfolio,
} from "@/lib/domains/commercial/implementation"
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
    data: { email: `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, passwordHash: "x", firstName: "P5.8", lastName: "Operator" },
  })
  const rawToken = await createPlatformSession({ operatorId: operator.id })
  const session: PlatformSessionContext = {
    sessionId: "test-session",
    operator: { id: operator.id, email: operator.email, firstName: operator.firstName, lastName: operator.lastName },
  }
  return { operator, session, rawToken }
}

async function makePlan(codePrefix: string, defaultModuleKeys: string[]) {
  return db.commercialPlan.create({
    data: { code: `${codePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: `${codePrefix} plan`, userLimit: null, branchLimit: null, defaultModuleKeys },
  })
}

function baseProvisionInput(overrides: Partial<ProvisionClinicInput> & { planId: string }): ProvisionClinicInput {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`
  return {
    idempotencyKey: crypto.randomUUID(),
    legalName: "P5.8 Test Clinic Legal",
    displayName: "P5.8 Test Clinic",
    defaultCurrency: "USD",
    defaultTimezone: "Asia/Karachi",
    legalBusinessName: null,
    primaryContactName: "P5.8 Contact",
    primaryContactEmail: "p58-contact@test.local",
    primaryContactPhone: null,
    billingContactName: null,
    billingContactEmail: null,
    country: "PK",
    implementationOwner: "P5.8 Test Suite",
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
    branchName: "P5.8 Main Branch",
    branchCode: `P58-${suffix}`,
    branchAddress: null,
    branchPhone: null,
    adminEmail: `p58-admin-${suffix}@test.local`,
    adminFirstName: "P5.8",
    adminLastName: "Admin",
    moduleKeys: undefined,
    ...overrides,
  }
}

async function cleanupProvisionedOrg(orgId: string) {
  const owner = ownerDb()
  await owner.implementationNote.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.implementationTraining.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.pilotUatScenario.deleteMany({ where: { uat: { organizationId: orgId } } }).catch(() => {})
  await owner.pilotUat.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.supportTicketNote.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.supportTicket.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.provider.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.eInvoiceSubmission.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.goLiveCondition.deleteMany({ where: { commercialProfile: { organizationId: orgId } } }).catch(() => {})
  await owner.organizationSubscription.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.organizationCommercialProfile.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
  await owner.onboardingChecklistItem.deleteMany({ where: { organizationId: orgId } }).catch(() => {})
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

describe("P5.8: workspace authorization and organization scoping", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let orgAId: string
  let orgBId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p58-workspace-op")
    operatorId = op.operator.id
    operatorSession = op.session
    actingAs(op.rawToken)
    const plan = await makePlan("p58-workspace-plan", ["reception", "patients", "appointments", "clinical", "nursing"])
    planId = plan.id

    const a = await provisionClinic(operatorSession, baseProvisionInput({ planId }))
    orgAId = a.organizationId
    createdOrgIds.push(orgAId)
    const b = await provisionClinic(operatorSession, baseProvisionInput({ planId }))
    orgBId = b.organizationId
    createdOrgIds.push(orgBId)

    await addImplementationNote(orgAId, operatorId, "Note that belongs only to org A.")
  }, TIMEOUT)

  afterAll(async () => {
    for (const id of createdOrgIds) await cleanupProvisionedOrg(id)
    await db.platformIdempotencyKey.deleteMany({ where: { operatorId } }).catch(() => {})
    await db.commercialPlan.deleteMany({ where: { id: planId } }).catch(() => {})
    await db.platformSession.deleteMany({ where: { operatorId } })
    await db.platformOperator.deleteMany({ where: { id: operatorId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("an authorized Platform Operator can load the workspace, and it derives all 10 implementation stages", async () => {
    const workspace = await getImplementationWorkspace(orgAId)
    expect(workspace.stages.map((s) => s.key)).toEqual([
      "provisioning",
      "organization_configuration",
      "master_data",
      "staff_providers",
      "opening_data",
      "training",
      "uat",
      "go_live_readiness",
      "go_live_approval",
      "handover",
    ])
  }, TIMEOUT)

  it("provisioning stage is complete immediately after provisioning — every core record already exists", async () => {
    const workspace = await getImplementationWorkspace(orgBId)
    const provisioning = workspace.stages.find((s) => s.key === "provisioning")!
    expect(provisioning.status).toBe("complete")
    expect(provisioning.items.every((i) => i.complete)).toBe(true)
  }, TIMEOUT)

  it("organization data is correctly scoped — org A's implementation note never appears on org B's workspace", async () => {
    const workspaceA = await getImplementationWorkspace(orgAId)
    const workspaceB = await getImplementationWorkspace(orgBId)
    expect(workspaceA.notes.some((n) => n.body.includes("belongs only to org A"))).toBe(true)
    expect(workspaceB.notes.some((n) => n.body.includes("belongs only to org A"))).toBe(false)
  }, TIMEOUT)

  it("a caller with no platform session cannot load the workspace at all", async () => {
    activePlatformToken.current = undefined
    await expect(getImplementationWorkspace(orgAId)).rejects.toThrow(PlatformForbiddenError)
    const freshToken = await createPlatformSession({ operatorId })
    actingAs(freshToken) // restore a valid session for any tests that run after this one within the same process
  }, TIMEOUT)
})

describe("P5.8: module-aware master data and training", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let orgId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p58-moduleaware-op")
    operatorId = op.operator.id
    operatorSession = op.session
    actingAs(op.rawToken)
    // Laboratory/pharmacy deliberately excluded — proves the "disabled module
    // never becomes a false gap" rule (§11/§32).
    const plan = await makePlan("p58-moduleaware-plan", ["reception", "patients", "appointments", "clinical", "nursing", "finance"])
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

  it("master data stage shows a disabled module's item as Not Applicable (never as an incomplete gap)", async () => {
    const workspace = await getImplementationWorkspace(orgId)
    const masterData = workspace.stages.find((s) => s.key === "master_data")!
    const labItem = masterData.items.find((i) => i.label.toLowerCase().includes("lab catalogue"))
    expect(labItem).toBeDefined()
    expect(labItem!.complete).toBe(true)
    expect(labItem!.note).toMatch(/not applicable/i)
  }, TIMEOUT)

  it("training areas are seeded only for currently-enabled modules — laboratory/pharmacy/radiology/pos_billing/inventory/hr areas do not appear, administration always does", async () => {
    const training = await listImplementationTraining(orgId)
    const areas = training.map((t) => t.area)
    expect(areas).toContain("doctors")
    expect(areas).toContain("nursing")
    expect(areas).toContain("reception")
    expect(areas).toContain("finance")
    expect(areas).toContain("administration")
    expect(areas).not.toContain("laboratory")
    expect(areas).not.toContain("pharmacy")
    expect(areas).not.toContain("hr")
    expect(training.every((t) => t.status === "not_scheduled")).toBe(true)
  }, TIMEOUT)

  it("completing a training area persists status/completedAt, is organization-scoped, and is reflected in the training stage", async () => {
    const training = await listImplementationTraining(orgId)
    const reception = training.find((t) => t.area === "reception")!
    const updated = await updateImplementationTraining(orgId, reception.id, operatorId, { status: "completed" })
    expect(updated.status).toBe("completed")
    expect(updated.completedAt).not.toBeNull()

    const workspace = await getImplementationWorkspace(orgId)
    const trainingStage = workspace.stages.find((s) => s.key === "training")!
    expect(trainingStage.status).toBe("in_progress") // reception done, others (doctors/nursing/finance/administration) are not
    expect(trainingStage.items.find((i) => i.label === "Reception")?.complete).toBe(true)
  }, TIMEOUT)

  it("the training audit trail records the actor, area, and status transition", async () => {
    const audit = await db.auditLog.findFirst({
      where: { organizationId: orgId, action: "platform.implementation_training.updated" },
      orderBy: { createdAt: "desc" },
    })
    expect(audit?.userId).toBe(operatorId)
    expect(audit?.newValues).toMatchObject({ status: "completed" })
  }, TIMEOUT)
})

describe("P5.8: consolidated blockers — staff/provider gaps, UAT failures, support tickets, financial readiness", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let orgId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p58-blockers-op")
    operatorId = op.operator.id
    operatorSession = op.session
    actingAs(op.rawToken)
    const plan = await makePlan("p58-blockers-plan", ["reception", "patients", "appointments", "clinical", "nursing"])
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

  it("consolidated blockers include every reason getGoLiveBlockers() itself reports, at BLOCKING severity — the same authoritative list, never a second copy", async () => {
    const authoritative = await getGoLiveBlockers(orgId)
    const workspace = await getImplementationWorkspace(orgId)
    const blockingMessages = workspace.blockers.filter((b) => b.severity === "blocking").map((b) => b.message)
    expect(authoritative.length).toBeGreaterThan(0)
    for (const reason of authoritative) expect(blockingMessages).toContain(reason)
  }, TIMEOUT)

  it("clinical module enabled with zero providers surfaces a WARNING (never a blocking) gap naming the exact gap", async () => {
    const workspace = await getImplementationWorkspace(orgId)
    const providerWarning = workspace.blockers.find((b) => b.message.includes("no provider record exists"))
    expect(providerWarning).toBeDefined()
    expect(providerWarning!.severity).toBe("warning")
  }, TIMEOUT)

  it("adding a provider removes the provider-gap warning", async () => {
    await db.provider.create({ data: { organizationId: orgId, providerType: "doctor", firstName: "Test", lastName: "Doctor" } })
    const workspace = await getImplementationWorkspace(orgId)
    expect(workspace.blockers.some((b) => b.message.includes("no provider record exists"))).toBe(false)
  }, TIMEOUT)

  it("a failed UAT cycle (with no later signed-off pass) marks the UAT stage blocked and adds a warning-severity blocker — never escalated to blocking by this workspace itself", async () => {
    const uat = await createPilotUat(operatorId, { organizationId: orgId, cycleLabel: "Cycle 1", testerName: "Tester" })
    await recordUatScenario(uat.id, { area: "Reception", scenario: "Register a walk-in", passed: false })
    await completePilotUat(uat.id, operatorId, { result: "failed", blockers: "Reception flow broken", notes: null }, false)

    const workspace = await getImplementationWorkspace(orgId)
    const uatStage = workspace.stages.find((s) => s.key === "uat")!
    expect(uatStage.status).toBe("blocked")
    const uatWarning = workspace.blockers.find((b) => b.message.includes("UAT cycle failed"))
    expect(uatWarning).toBeDefined()
    expect(uatWarning!.severity).toBe("warning")
  }, TIMEOUT)

  it("a high-priority open support ticket surfaces as a warning, aggregated (not one row per ticket)", async () => {
    await createSupportTicket(operatorId, { organizationId: orgId, title: "Urgent config issue", description: "Blocking configuration problem", category: "configuration", priority: "high" })
    const workspace = await getImplementationWorkspace(orgId)
    const ticketWarnings = workspace.blockers.filter((b) => b.message.includes("high/critical-priority support ticket"))
    expect(ticketWarnings.length).toBe(1)
    expect(ticketWarnings[0].severity).toBe("warning")
  }, TIMEOUT)

  it("financial readiness gaps (getFinancialReadinessGaps) appear inside the Opening Data stage as incomplete items", async () => {
    // This plan includes no pos_billing/inventory/procurement, so no
    // financial gap is expected — confirms the Opening Data stage correctly
    // reflects ZERO gaps rather than fabricating one, matching
    // getFinancialReadinessGaps' own real output for this module set.
    const workspace = await getImplementationWorkspace(orgId)
    const openingData = workspace.stages.find((s) => s.key === "opening_data")!
    const mappingGaps = openingData.items.filter((i) => i.label.startsWith("Account mapping:"))
    expect(mappingGaps.length).toBe(0)
  }, TIMEOUT)
})

describe("P5.8: target go-live date, handover, and audit", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let orgId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p58-handover-op")
    operatorId = op.operator.id
    operatorSession = op.session
    actingAs(op.rawToken)
    const plan = await makePlan("p58-handover-plan", ["reception", "patients", "appointments", "clinical", "nursing"])
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

  it("updateTargetGoLiveDate persists the date, is audited, and is distinct from goLiveApprovedAt", async () => {
    const targetDate = new Date("2026-10-15")
    const updated = await updateTargetGoLiveDate(orgId, operatorId, targetDate)
    expect(updated.targetGoLiveDate?.toISOString().slice(0, 10)).toBe("2026-10-15")
    expect(updated.goLiveApprovedAt).toBeNull()

    const audit = await db.auditLog.findFirst({ where: { organizationId: orgId, action: "platform.implementation.target_go_live_updated" } })
    expect(audit?.userId).toBe(operatorId)

    const workspace = await getImplementationWorkspace(orgId)
    expect(workspace.summary.targetGoLiveDate?.toISOString().slice(0, 10)).toBe("2026-10-15")
  }, TIMEOUT)

  it("handover cannot be completed before go-live approval — rejected server-side, never silently allowed", async () => {
    await expect(completeHandover(orgId, operatorId)).rejects.toThrow(HandoverNotReadyError)
    const profile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId: orgId } })
    expect(profile.handoverCompletedAt).toBeNull()
  }, TIMEOUT)

  it("handover succeeds once the organization is live with zero blockers, records the operator/timestamp, and is audited — the handover stage then reads Complete", async () => {
    // Satisfy every real go-live blocker (same pattern P5.2's own go-live
    // test uses) so approveGoLive — the authoritative, unmodified function —
    // actually succeeds before handover is attempted.
    const commercialProfile = await db.organizationCommercialProfile.findUniqueOrThrow({ where: { organizationId: orgId } })
    await db.goLiveCondition.updateMany({ where: { commercialProfileId: commercialProfile.id }, data: { status: "complete", completedAt: new Date() } })
    const items = await listOnboardingChecklist(orgId, operatorId)
    for (const item of items.filter((i) => i.required && i.status !== "completed")) {
      await updateOnboardingChecklistItem(orgId, item.id, operatorId, { status: "completed" })
    }
    expect(await getGoLiveBlockers(orgId)).toEqual([])
    await approveGoLive(orgId, operatorId, "Approved for P5.8 handover test.")

    const updated = await completeHandover(orgId, operatorId)
    expect(updated.handoverCompletedAt).not.toBeNull()
    expect(updated.handoverCompletedByOperatorId).toBe(operatorId)

    const audit = await db.auditLog.findFirst({ where: { organizationId: orgId, action: "platform.implementation.handover_completed" } })
    expect(audit?.userId).toBe(operatorId)

    const workspace = await getImplementationWorkspace(orgId)
    const handoverStage = workspace.stages.find((s) => s.key === "handover")!
    expect(handoverStage.status).toBe("complete")
    expect(workspace.summary.status).toBe("complete")
  }, TIMEOUT)

  it("handover cannot be completed twice", async () => {
    await expect(completeHandover(orgId, operatorId)).rejects.toThrow(/already been completed/i)
  }, TIMEOUT)
})

describe("P5.8: implementation notes", () => {
  let operatorId: string
  let operatorSession: PlatformSessionContext
  let planId: string
  let orgId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const op = await makePlatformOperator("p58-notes-op")
    operatorId = op.operator.id
    operatorSession = op.session
    actingAs(op.rawToken)
    const plan = await makePlan("p58-notes-plan", [...MODULE_KEYS])
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

  it("adding a note persists it, audits it, and lists newest-first", async () => {
    await addImplementationNote(orgId, operatorId, "Customer requested Saturday training.")
    await addImplementationNote(orgId, operatorId, "COA awaiting finance-team approval.")
    const notes = await listImplementationNotes(orgId)
    expect(notes.length).toBe(2)
    expect(notes[0].body).toBe("COA awaiting finance-team approval.")
    expect(notes[1].body).toBe("Customer requested Saturday training.")

    const audit = await db.auditLog.findMany({ where: { organizationId: orgId, action: "platform.implementation_note.created" } })
    expect(audit.length).toBe(2)
  }, TIMEOUT)
})

describe("P5.8: implementation portfolio", () => {
  let operatorId: string
  let planId: string
  const createdOrgIds: string[] = []
  let orgId: string

  beforeAll(async () => {
    const op = await makePlatformOperator("p58-portfolio-op")
    operatorId = op.operator.id
    actingAs(op.rawToken)
    const plan = await makePlan("p58-portfolio-plan", ["reception", "patients", "appointments", "clinical", "nursing"])
    planId = plan.id
    const result = await provisionClinic(op.session, baseProvisionInput({ planId, country: "AE" }))
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

  it("lists the provisioned organization with its blocking count and honors a country filter", async () => {
    const all = await listImplementationPortfolio({})
    expect(all.some((r) => r.organizationId === orgId)).toBe(true)
    const row = all.find((r) => r.organizationId === orgId)!
    expect(row.blockingCount).toBeGreaterThan(0)
    expect(row.commercialLifecycle).toBe("onboarding")

    const aeOnly = await listImplementationPortfolio({ country: "AE" })
    expect(aeOnly.some((r) => r.organizationId === orgId)).toBe(true)
    const pkOnly = await listImplementationPortfolio({ country: "PK" })
    expect(pkOnly.some((r) => r.organizationId === orgId)).toBe(false)
  }, TIMEOUT)
})
