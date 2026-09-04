import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { createPrescription, listPatientPrescriptions, getPrescription } from "@/lib/domains/clinical/prescriptions"
import { recommendFollowUp, listPatientFollowUps, listOpenFollowUps } from "@/lib/domains/clinical/follow-ups"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 60000

/**
 * P2 Batch 2 (§13, §14) — see P2_REMEDIATION_REPORT.md for the full record.
 *
 * §13: proves the real cross-branch leak found and fixed this batch is
 * actually closed — a session authorized only for Branch B, viewing a
 * patient who IS visible to it (registered/appointment at Branch B), must
 * not see that same patient's Prescriptions/FollowUpRecommendations from an
 * encounter at Branch A. Same fixture shape as
 * `branch-isolation.test.ts` (P0-01).
 *
 * §14: proves the FK relations added this batch are DB-enforced, not a
 * TypeScript-only convention — deleting a User row still referenced by a
 * high-value actor column is genuinely rejected by Postgres.
 */
describe("P2 §13: Prescription/FollowUpRecommendation branch scoping", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let providerId: string
  let patientId: string
  let encounterAId: string
  let encounterBId: string
  const prescriptionIds: string[] = []
  const followUpIds: string[] = []

  function branchBSession(): SessionContext {
    return {
      sessionId: "test-p2-batch2-branch-b",
      user: { id: "00000000-0000-0000-0000-0000000000e1", organizationId, email: "p2b2-branch-b@test.local", firstName: "Branch", lastName: "B" },
      activeBranchId: branchBId,
      branchIds: [branchBId],
      permissions: new Set(["encounter.view", "clinical_notes.view", "clinical_notes.edit", "prescription.create"]),
      roleNames: ["Doctor"],
    }
  }

  function orgWideSession(): SessionContext {
    return {
      sessionId: "test-p2-batch2-super-admin",
      user: { id: "00000000-0000-0000-0000-0000000000e2", organizationId, email: "p2b2-super-admin@test.local", firstName: "Super", lastName: "Admin" },
      activeBranchId: null,
      branchIds: [],
      permissions: new Set(["encounter.view", "clinical_notes.view", "clinical_notes.edit", "prescription.create"]),
      roleNames: ["Super Admin"],
    }
  }

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 2, orderBy: { createdAt: "asc" } })
    if (branches.length < 2) throw new Error("Test requires at least 2 seeded branches")
    branchAId = branches[0].id
    branchBId = branches[1].id
    organizationId = branches[0].organizationId
    providerId = (await db.provider.findFirstOrThrow({ where: { organizationId } })).id

    // One patient, visible at Branch B (registered there), but with real
    // clinical content at BOTH branches — the exact shape that made the old
    // patient-level-visibility-only check wrongly permissive.
    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchBId,
        mrn: `TESTP2B2-${Date.now()}`, firstName: "P2Batch2", lastName: "BranchScope",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P2B2-${Date.now()}`,
      },
    })
    patientId = patient.id

    const encA = await db.encounter.create({
      data: { organizationId, branchId: branchAId, patientId, providerId, encounterNumber: `TESTP2B2-A-${Date.now()}`, encounterType: "consultation", status: "active", startAt: new Date() },
    })
    encounterAId = encA.id
    const encB = await db.encounter.create({
      data: { organizationId, branchId: branchBId, patientId, providerId, encounterNumber: `TESTP2B2-B-${Date.now()}`, encounterType: "consultation", status: "active", startAt: new Date() },
    })
    encounterBId = encB.id
  }, TIMEOUT)

  afterAll(async () => {
    // P2 §7: listPatientPrescriptions/getPrescription now write a
    // ClinicalAccessLog row per call (this suite's own §13 tests call both)
    // — that table is deliberately insert-only for the app's real runtime
    // role (see audit-log-immutability.test.ts), and Patient's FK to it is
    // ON DELETE RESTRICT, so `patientId` can no longer be deleted below
    // without clearing these rows first via the schema-owner connection.
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
    await ownerDb.clinicalAccessLog.deleteMany({ where: { patientId } })
    await ownerDb.$disconnect()

    await db.followUpRecommendation.deleteMany({ where: { id: { in: followUpIds } } })
    await db.prescriptionItem.deleteMany({ where: { prescriptionId: { in: prescriptionIds } } })
    await db.prescription.deleteMany({ where: { id: { in: prescriptionIds } } })
    await db.encounter.deleteMany({ where: { id: { in: [encounterAId, encounterBId] } } })
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("a Branch-B-only session cannot see a prescription from the patient's Branch-A encounter, even though the patient is visible to it", async () => {
    const rxA = await createPrescription(orgWideSession(), encounterAId, {
      items: [{ medicationName: "P2 Batch 2 Test Med A", dose: "1 tab", frequency: "daily", route: "oral" }],
    })
    prescriptionIds.push(rxA.id)
    const rxB = await createPrescription(orgWideSession(), encounterBId, {
      items: [{ medicationName: "P2 Batch 2 Test Med B", dose: "1 tab", frequency: "daily", route: "oral" }],
    })
    prescriptionIds.push(rxB.id)

    const visibleToB = await listPatientPrescriptions(branchBSession(), patientId)
    expect(visibleToB.map((r) => r.id)).toContain(rxB.id)
    expect(visibleToB.map((r) => r.id)).not.toContain(rxA.id)

    await expect(getPrescription(branchBSession(), rxA.id)).rejects.toThrow()
    await expect(getPrescription(branchBSession(), rxB.id)).resolves.toMatchObject({ id: rxB.id })

    // Org-wide (Super Admin) sees both — the fix narrows a branch-scoped
    // session, not the org-wide bypass.
    const visibleOrgWide = await listPatientPrescriptions(orgWideSession(), patientId)
    expect(visibleOrgWide.map((r) => r.id)).toEqual(expect.arrayContaining([rxA.id, rxB.id]))
  })

  it("a Branch-B-only session cannot see a follow-up recommendation from the patient's Branch-A encounter", async () => {
    const fuA = await recommendFollowUp(orgWideSession(), encounterAId, { recommendedDate: new Date(Date.now() + 7 * 86400000), reason: "P2 Batch 2 test A" })
    followUpIds.push(fuA.id)
    const fuB = await recommendFollowUp(orgWideSession(), encounterBId, { recommendedDate: new Date(Date.now() + 7 * 86400000), reason: "P2 Batch 2 test B" })
    followUpIds.push(fuB.id)

    const visibleToB = await listPatientFollowUps(branchBSession(), patientId)
    expect(visibleToB.map((f) => f.id)).toContain(fuB.id)
    expect(visibleToB.map((f) => f.id)).not.toContain(fuA.id)

    const openAtBranchB = await listOpenFollowUps(branchBSession(), { branchId: branchBId })
    expect(openAtBranchB.map((f) => f.id)).toContain(fuB.id)
    expect(openAtBranchB.map((f) => f.id)).not.toContain(fuA.id)
  })
})

describe("P2 §14: actor FKs are DB-enforced, not TypeScript-only", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let testUserId: string

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTP2B2FK-${Date.now()}`, firstName: "P2Batch2", lastName: "ActorFk",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P2B2FK-${Date.now()}`,
      },
    })
    patientId = patient.id
    const user = await db.user.create({
      data: { organizationId, email: `p2b2-fk-test-${Date.now()}@test.local`, passwordHash: "not-a-real-hash", firstName: "ActorFk", lastName: "Test" },
    })
    testUserId = user.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("cannot delete a User row still referenced by PatientAllergy.notedBy (Restrict, not a silent no-op)", async () => {
    const allergy = await db.patientAllergy.create({
      data: { patientId, allergen: "P2 Batch 2 test allergen", severity: "moderate", notedBy: testUserId },
    })

    await expect(db.user.delete({ where: { id: testUserId } })).rejects.toThrow()

    // Confirm the row is genuinely unaffected by the rejected attempt, not
    // silently nulled or altered.
    const stillThere = await db.patientAllergy.findUniqueOrThrow({ where: { id: allergy.id } })
    expect(stillThere.notedBy).toBe(testUserId)

    await db.patientAllergy.delete({ where: { id: allergy.id } })
  })

  it("a NULL actor value is unaffected by the new FK (no violation on the common not-yet-attributed case)", async () => {
    const allergy = await db.patientAllergy.create({
      data: { patientId, allergen: "P2 Batch 2 test allergen (no actor)", severity: "mild", notedBy: null },
    })
    expect(allergy.notedBy).toBeNull()
    await db.patientAllergy.delete({ where: { id: allergy.id } })
  })
})
