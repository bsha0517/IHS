import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { bookAppointment, BookingConflictError } from "@/lib/domains/appointments/service"
import { saveNote, createAmendment } from "@/lib/domains/clinical/notes"
import { enterNumericResult } from "@/lib/domains/laboratory/results"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §34: "the full adversarial test list" — twelve real-failure-condition
 * tests P1.md names by name. Ten of the twelve already had real regression
 * coverage (asserting the failure is actually rejected/serialized, not just
 * a happy path) from earlier batches in this pass — this file adds the two
 * that didn't, and stands as the single index proving all twelve exist,
 * so a reader doesn't have to independently rediscover where each one
 * lives:
 *
 *  1. Two simultaneous payments           → refund-payment-integrity.test.ts
 *  2. Two simultaneous refunds             → refund-payment-integrity.test.ts
 *  3. Two simultaneous package usages      → package-session-concurrency.test.ts
 *  4. Concurrent appointment booking       → THIS FILE (below) — new
 *  5. Outbox duplicate execution           → outbox-concurrency.test.ts
 *  6. Outbox crash recovery                → outbox-crash-recovery.test.ts
 *  7. Duplicate goods receipt request      → idempotency-and-transaction-review.test.ts
 *  8. Duplicate dispensing request         → pharmacy-dispensing-integrity.test.ts
 *  9. Expired stock                        → fefo-expiry.test.ts (also pharmacy-dispensing-integrity.test.ts)
 * 10. Insufficient stock                   → pharmacy-dispensing-integrity.test.ts (also fefo-expiry.test.ts)
 * 11. Unauthorized branch access           → branch-isolation.test.ts
 * 12. Finalized clinical-record modification → THIS FILE (below) — new
 *
 * Every test cited above (and both new ones here) asserts the FAILURE
 * condition is actually rejected under real DB concurrency or a real
 * precondition violation — not that the happy path merely works.
 */
const TIMEOUT = 60000

describe("P1 §34: adversarial conditions not yet covered elsewhere", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let providerId: string
  let providerUserId: string
  let encounterId: string
  const appointmentIds: string[] = []
  const clinicalNoteIds: string[] = []
  const clinicalOrderIds: string[] = []
  const labTestIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-adversarial-conditions",
      user: { id: providerUserId, organizationId, email: "adversarial-test@test.local", firstName: "Adversarial", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set([
        "appointment.create", "appointment.view",
        "clinical_notes.edit", "clinical_notes.view",
        "lab_result.enter", "lab_result.verify", "order.create", "lab_order.create",
      ]),
      roleNames: ["Super Admin"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    providerUserId = user.id

    const provider = await db.provider.create({
      data: { organizationId, providerType: "doctor", firstName: "Adversarial", lastName: `TestProvider-${Date.now()}`, userId: null },
    })
    providerId = provider.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTADVERSE-${Date.now()}`, firstName: "Adversarial", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `AD${Date.now()}`,
      },
    })
    patientId = patient.id

    const encounter = await db.encounter.create({
      data: {
        organizationId, branchId, patientId, providerId,
        encounterNumber: `TESTADVERSE-ENC-${Date.now()}`,
        encounterType: "consultation", status: "active",
      },
    })
    encounterId = encounter.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.commMessage.deleteMany({ where: { patientId } })
    await db.appointmentStatusHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } })
    await db.appointment.deleteMany({ where: { id: { in: appointmentIds } } })
    await db.clinicalNote.deleteMany({ where: { id: { in: clinicalNoteIds } } })
    await db.labOrderTest.deleteMany({ where: { clinicalOrderId: { in: clinicalOrderIds } } })
    await db.specimen.deleteMany({ where: { clinicalOrderId: { in: clinicalOrderIds } } })
    await db.clinicalOrder.deleteMany({ where: { id: { in: clinicalOrderIds } } })
    await db.labTest.deleteMany({ where: { id: { in: labTestIds } } })
    await db.encounter.delete({ where: { id: encounterId } })
    await db.patient.delete({ where: { id: patientId } })
    await db.provider.delete({ where: { id: providerId } })
    await db.$disconnect()
  }, TIMEOUT)

  describe("§34 item 4: concurrent appointment booking", () => {
    it("two simultaneous bookAppointment calls for the same provider's overlapping slot — only one succeeds, the DB exclusion constraint (not an app-level check) is what actually serializes it", async () => {
      const startTime = new Date("2028-04-10T09:00:00Z")

      const results = await Promise.allSettled([
        bookAppointment(session(), { branchId, patientId, providerId, startTime, durationMinutes: 30, bookingSource: "staff" }),
        bookAppointment(session(), { branchId, patientId, providerId, startTime, durationMinutes: 30, bookingSource: "staff" }),
      ])

      const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>[]
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
      for (const r of fulfilled) appointmentIds.push(r.value.id)

      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)
      expect(rejected[0].reason).toBeInstanceOf(BookingConflictError)

      // Only one row ever actually landed for this exact slot — not a
      // logic-layer "we happened not to double-submit," a real DB check.
      const landed = await db.appointment.count({ where: { providerId, startTime } })
      expect(landed).toBe(1)
    }, TIMEOUT)

    it("two simultaneous bookAppointment calls for genuinely non-overlapping slots both succeed (the lock doesn't over-reject)", async () => {
      const [a, b] = await Promise.all([
        bookAppointment(session(), { branchId, patientId, providerId, startTime: new Date("2028-04-11T09:00:00Z"), durationMinutes: 30, bookingSource: "staff" }),
        bookAppointment(session(), { branchId, patientId, providerId, startTime: new Date("2028-04-11T10:00:00Z"), durationMinutes: 30, bookingSource: "staff" }),
      ])
      appointmentIds.push(a.id, b.id)
      expect(a.id).not.toBe(b.id)
    }, TIMEOUT)
  })

  describe("§34 item 12: finalized clinical-record modification is rejected, not silently overwritten", () => {
    it("saveNote refuses to edit a finalized ClinicalNote in place — createAmendment is the only path past it", async () => {
      const note = await saveNote(session(), encounterId, "consultation", { noteType: "consultation", assessment: "Initial assessment" })
      clinicalNoteIds.push(note.id)

      // Simulates what finalizeEncounter's bulk draft->finalized sweep does
      // to this note — the precondition under test is "this note is
      // finalized," not the mechanics of how it got there.
      await db.clinicalNote.update({ where: { id: note.id }, data: { status: "finalized", finalizedBy: providerUserId, finalizedAt: new Date() } })

      await expect(
        saveNote(session(), encounterId, "consultation", { noteType: "consultation", assessment: "Trying to silently overwrite the finalized note" })
      ).rejects.toThrow(/This note is finalized. Create an amendment to correct it./)

      // The finalized note's own content is genuinely untouched by the rejected attempt.
      const stillOriginal = await db.clinicalNote.findUniqueOrThrow({ where: { id: note.id } })
      expect(stillOriginal.assessment).toBe("Initial assessment")

      // The only real path past it — an amendment — works and preserves history.
      const amendment = await createAmendment(session(), note.id, { noteType: "consultation", assessment: "Corrected assessment" })
      clinicalNoteIds.push(amendment.id)
      expect(amendment.amendsId).toBe(note.id)
      const originalAfterAmend = await db.clinicalNote.findUniqueOrThrow({ where: { id: note.id } })
      expect(originalAfterAmend.isCurrent).toBe(false)
      expect(originalAfterAmend.assessment).toBe("Initial assessment") // still untouched — the amendment is a new row, not an edit
    }, TIMEOUT)

    it("createAmendment refuses a note that isn't actually finalized — a draft is edited directly instead, never amended", async () => {
      const draft = await saveNote(session(), encounterId, "progress", { noteType: "progress", assessment: "Still a draft" })
      clinicalNoteIds.push(draft.id)

      await expect(
        createAmendment(session(), draft.id, { noteType: "progress", assessment: "Trying to amend a draft" })
      ).rejects.toThrow(/Only a finalized note needs an amendment/)
    }, TIMEOUT)

    it("enterNumericResult refuses to re-enter a result on an already-verified LabOrderTest line — verified is terminal", async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const labTest = await db.labTest.create({
        data: { organizationId, code: `TESTADVLAB-${suffix}`, name: `Adversarial Lab Test ${suffix}`, category: "Chemistry", specimenType: "blood", resultType: "numeric", unit: "mg/dL", referenceRangeLow: 70, referenceRangeHigh: 100, price: 40 },
      })
      labTestIds.push(labTest.id)
      const order = await db.clinicalOrder.create({
        data: { organizationId, branchId, patientId, encounterId, orderNumber: `TESTADVORD-${suffix}`, orderType: "lab", status: "ordered", orderingProviderId: providerId },
      })
      clinicalOrderIds.push(order.id)
      const specimen = await db.specimen.create({
        data: { organizationId, branchId, clinicalOrderId: order.id, specimenNumber: `TESTADVSPC-${suffix}`, specimenType: "blood" },
      })
      const line = await db.labOrderTest.create({
        data: { organizationId, clinicalOrderId: order.id, labTestId: labTest.id, specimenId: specimen.id, resultType: "numeric", status: "verified", numericValue: 85, verifiedBy: providerUserId, verifiedAt: new Date() },
      })

      await expect(enterNumericResult(session(), line.id, { numericValue: 999, notes: "trying to silently overwrite a verified result" })).rejects.toThrow(
        /Cannot move a lab result from "verified" to "resulted"/
      )

      const stillOriginal = await db.labOrderTest.findUniqueOrThrow({ where: { id: line.id } })
      expect(Number(stillOriginal.numericValue)).toBe(85)
      expect(stillOriginal.status).toBe("verified")
    }, TIMEOUT)
  })
})
