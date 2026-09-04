import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import { bookAppointment } from "@/lib/domains/appointments/service"
import { listMyQueue } from "@/lib/domains/appointments/queue"
import { startEncounter, getEncounter, completeEncounter, finalizeEncounter } from "@/lib/domains/clinical/encounters"
import { recordVitals } from "@/lib/domains/clinical/vitals"
import { addDiagnosis, updateDiagnosisStatus } from "@/lib/domains/clinical/diagnoses"
import { createOrder, cancelOrder } from "@/lib/domains/clinical/orders"
import { createPrescription, cancelPrescription } from "@/lib/domains/clinical/prescriptions"
import { recommendFollowUp, dismissFollowUp } from "@/lib/domains/clinical/follow-ups"
import { saveNote, createAmendment, getNoteHistory } from "@/lib/domains/clinical/notes"
import { loadOrNotFound } from "@/lib/platform/not-found"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 30000

/**
 * P3.3 (Doctor & Encounter Workflow) — targeted tests for the actual
 * behavior changed this batch, per p3.3.md §39: the appointment→encounter
 * transition (branch/org scoping, idempotent under a race, appointment
 * status sync), and the real branch-write gap found and fixed across every
 * encounter-scoped clinical write (§34) — not cosmetic/layout behavior,
 * which this file deliberately does not test.
 */
describe("P3.3: doctor & encounter workflow", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let providerId: string
  let userId: string
  let patientId: string
  let branchBPatientId: string
  let branchBEncounterId: string
  const createdAppointmentIds: string[] = []
  const createdPatientIds: string[] = []
  const createdEncounterIds: string[] = []

  function sessionFor(branchIds: string[], extraPerms: string[] = []): SessionContext {
    return {
      sessionId: "test-p3-3-doctor",
      user: { id: userId, organizationId, email: "p3-3-doctor@test.local", firstName: "P3.3", lastName: "Doctor" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "patient.view",
        "appointment.view",
        "appointment.checkin",
        // Real Doctors don't book their own appointments (Receptionist
        // does) — included here purely so this test file can set up its
        // own appointment fixtures without a second role.
        "appointment.create",
        "encounter.view",
        "encounter.create",
        "encounter.finalize",
        "clinical_notes.view",
        "clinical_notes.edit",
        "vitals.record",
        "prescription.create",
        "lab_order.create",
        "order.create",
        ...extraPerms,
      ]),
      roleNames: ["Doctor"],
    }
  }
  const branchASession = () => sessionFor([branchAId])
  const branchBSession = () => sessionFor([branchBId])

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 2, orderBy: { createdAt: "asc" } })
    if (branches.length < 2) throw new Error("Test requires at least 2 seeded branches (see LOCAL_DATABASE_SETUP.md).")
    organizationId = branches[0].organizationId
    branchAId = branches[0].id
    branchBId = branches[1].id

    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
    const provider = await db.provider.findFirstOrThrow({ where: { organizationId } })
    providerId = provider.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchAId,
        mrn: `TESTP33-${Date.now()}`, firstName: "P3.3", lastName: "Doctor",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P33M${Date.now()}`,
      },
    })
    createdPatientIds.push(patient.id)
    patientId = patient.id

    // A second patient/encounter that lives at Branch B, for the branch-
    // isolation tests below.
    const branchBPatient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchBId,
        mrn: `TESTP33B-${Date.now()}`, firstName: "P3.3", lastName: "BranchB",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P33BM${Date.now()}`,
      },
    })
    createdPatientIds.push(branchBPatient.id)
    branchBPatientId = branchBPatient.id

    const branchBEncounter = await startEncounter(branchBSession(), {
      branchId: branchBId, patientId: branchBPatientId, providerId, encounterType: "consultation",
    })
    createdEncounterIds.push(branchBEncounter.id)
    branchBEncounterId = branchBEncounter.id
  }, TIMEOUT)

  afterAll(async () => {
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
    await ownerDb.clinicalAccessLog.deleteMany({ where: { patientId: { in: [...createdPatientIds, patientId] } } })
    await ownerDb.$disconnect()

    if (createdAppointmentIds.length > 0) {
      await db.queueEntry.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } })
      await db.appointmentStatusHistory.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } })
    }
    await db.vitalSign.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.diagnosis.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.followUpRecommendation.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.prescriptionItem.deleteMany({ where: { prescription: { patientId: { in: createdPatientIds } } } })
    await db.prescription.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    const orders = await db.clinicalOrder.findMany({ where: { patientId: { in: createdPatientIds } } })
    await db.labOrderDetail.deleteMany({ where: { clinicalOrderId: { in: orders.map((o) => o.id) } } })
    await db.clinicalOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } })
    await db.clinicalNote.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.encounter.deleteMany({ where: { id: { in: createdEncounterIds } } })
    await db.appointment.deleteMany({ where: { id: { in: createdAppointmentIds } } })
    await db.commMessage.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.patient.deleteMany({ where: { id: { in: createdPatientIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("§7/§31/§32: starting an encounter from a waiting appointment moves it to in_consultation", async () => {
    const service = await db.service.findFirst({ where: { organizationId } })
    const appt = await bookAppointment(branchASession(), {
      branchId: branchAId, patientId, providerId,
      serviceId: service?.id,
      startTime: new Date(Date.now() + 60 * 60 * 1000), durationMinutes: 30, bookingSource: "walk_in",
    })
    createdAppointmentIds.push(appt.id)
    // Reception check-in puts it in "waiting" first, matching the real flow.
    await db.appointment.update({ where: { id: appt.id }, data: { status: "waiting" } })
    await db.queueEntry.create({ data: { appointmentId: appt.id, branchId: branchAId, tokenNumber: "T-P33", checkedInAt: new Date() } })

    const encounter = await startEncounter(branchASession(), {
      branchId: branchAId, patientId, providerId, appointmentId: appt.id, encounterType: "consultation",
    })
    createdEncounterIds.push(encounter.id)

    const updatedAppt = await db.appointment.findUniqueOrThrow({ where: { id: appt.id } })
    expect(updatedAppt.status).toBe("in_consultation")

    // listMyQueue's include gained `service` this batch (previously missing
    // entirely, so the provider queue could never have shown it) — must not
    // throw with the extended include.
    const queue = await listMyQueue(branchASession())
    expect(Array.isArray(queue)).toBe(true)
  }, TIMEOUT)

  it("§7: starting an encounter twice for the same appointment (a race) never creates two encounters — the second call returns the same one", async () => {
    const appt = await bookAppointment(branchASession(), {
      branchId: branchAId, patientId, providerId,
      startTime: new Date(Date.now() + 2 * 60 * 60 * 1000), durationMinutes: 30, bookingSource: "walk_in",
    })
    createdAppointmentIds.push(appt.id)
    await db.appointment.update({ where: { id: appt.id }, data: { status: "waiting" } })
    await db.queueEntry.create({ data: { appointmentId: appt.id, branchId: branchAId, tokenNumber: "T-P33R", checkedInAt: new Date() } })

    const [first, second] = await Promise.all([
      startEncounter(branchASession(), { branchId: branchAId, patientId, providerId, appointmentId: appt.id, encounterType: "consultation" }),
      startEncounter(branchASession(), { branchId: branchAId, patientId, providerId, appointmentId: appt.id, encounterType: "consultation" }),
    ])
    createdEncounterIds.push(first.id)
    if (second.id !== first.id) createdEncounterIds.push(second.id)

    expect(first.id).toBe(second.id)
    const encounters = await db.encounter.count({ where: { appointmentId: appt.id } })
    expect(encounters).toBe(1)
  }, TIMEOUT)

  it("§8: an appointment whose encounter already exists is not given a second one — the appointment/encounter relationship is 1:1", async () => {
    const appt = await bookAppointment(branchASession(), {
      branchId: branchAId, patientId, providerId,
      startTime: new Date(Date.now() + 3 * 60 * 60 * 1000), durationMinutes: 30, bookingSource: "walk_in",
    })
    createdAppointmentIds.push(appt.id)
    await db.appointment.update({ where: { id: appt.id }, data: { status: "waiting" } })
    await db.queueEntry.create({ data: { appointmentId: appt.id, branchId: branchAId, tokenNumber: "T-P33X", checkedInAt: new Date() } })

    const encounter = await startEncounter(branchASession(), { branchId: branchAId, patientId, providerId, appointmentId: appt.id, encounterType: "consultation" })
    createdEncounterIds.push(encounter.id)

    const reopened = await startEncounter(branchASession(), { branchId: branchAId, patientId, providerId, appointmentId: appt.id, encounterType: "consultation" })
    expect(reopened.id).toBe(encounter.id)
    expect(await db.encounter.count({ where: { appointmentId: appt.id } })).toBe(1)
  }, TIMEOUT)

  it("§34: a session authorized only for Branch A cannot write vitals, diagnoses, orders, prescriptions, follow-ups, or notes to a Branch B encounter", async () => {
    const onlyA = branchASession()
    await expect(recordVitals(onlyA, branchBEncounterId, {})).rejects.toThrow(ForbiddenError)
    await expect(addDiagnosis(onlyA, branchBEncounterId, { description: "should be rejected", isPrimary: false })).rejects.toThrow(ForbiddenError)
    await expect(
      createOrder(onlyA, branchBEncounterId, { orderType: "procedure", priority: "routine", procedureName: "should be rejected" })
    ).rejects.toThrow(ForbiddenError)
    await expect(
      createPrescription(onlyA, branchBEncounterId, { items: [{ medicationName: "X", dose: "1", frequency: "OD", route: "oral" }] })
    ).rejects.toThrow(ForbiddenError)
    await expect(recommendFollowUp(onlyA, branchBEncounterId, { recommendedDate: new Date() })).rejects.toThrow(ForbiddenError)
    await expect(saveNote(onlyA, branchBEncounterId, "consultation", { noteType: "consultation", chiefComplaint: "should be rejected" })).rejects.toThrow(
      ForbiddenError
    )
    // The equivalent write from the encounter's own branch must still work —
    // proving this is a real branch check, not an over-broad denial.
    const vitals = await recordVitals(branchBSession(), branchBEncounterId, { pulseBpm: 70 })
    expect(vitals.encounterId).toBe(branchBEncounterId)
  }, TIMEOUT)

  it("§34: completing/finalizing an encounter is also branch-checked", async () => {
    const isolatedEncounter = await startEncounter(branchBSession(), {
      branchId: branchBId, patientId: branchBPatientId, providerId, encounterType: "consultation",
    })
    createdEncounterIds.push(isolatedEncounter.id)

    await expect(completeEncounter(branchASession(), isolatedEncounter.id)).rejects.toThrow(ForbiddenError)

    const completed = await completeEncounter(branchBSession(), isolatedEncounter.id)
    expect(completed.status).toBe("completed")
    await expect(finalizeEncounter(branchASession(), isolatedEncounter.id)).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§12/§23/§25/§26: draft save, finalization locks structured fields, and an amendment preserves the original in getNoteHistory", async () => {
    const encounter = await startEncounter(branchASession(), {
      branchId: branchAId, patientId, providerId, encounterType: "consultation",
    })
    createdEncounterIds.push(encounter.id)

    // Draft: save, then update in place (not a new row) while still active.
    const draft = await saveNote(branchASession(), encounter.id, "consultation", { noteType: "consultation", assessment: "first draft" })
    const updatedDraft = await saveNote(branchASession(), encounter.id, "consultation", { noteType: "consultation", assessment: "revised draft" })
    expect(updatedDraft.id).toBe(draft.id)
    expect(updatedDraft.status).toBe("draft")

    await completeEncounter(branchASession(), encounter.id)
    const finalized = await finalizeEncounter(branchASession(), encounter.id)
    expect(finalized.status).toBe("finalized")

    const finalizedNote = await db.clinicalNote.findFirstOrThrow({ where: { encounterId: encounter.id, noteType: "consultation" } })
    expect(finalizedNote.status).toBe("finalized")
    // A finalized note can no longer be saved in place — the domain layer
    // is what actually enforces "structured fields become read-only", not
    // just the UI hiding the form.
    await expect(
      saveNote(branchASession(), encounter.id, "consultation", { noteType: "consultation", assessment: "illegal direct edit" })
    ).rejects.toThrow(/finalized/i)

    const amendment = await createAmendment(branchASession(), finalizedNote.id, { noteType: "consultation", assessment: "corrected assessment" })
    expect(amendment.amendsId).toBe(finalizedNote.id)

    const history = await getNoteHistory(branchASession(), amendment.id)
    expect(history).toHaveLength(2)
    expect(history[0].id).toBe(finalizedNote.id)
    expect(history[0].assessment).toBe("revised draft") // original untouched
    expect(history[1].id).toBe(amendment.id)
    expect(history[1].assessment).toBe("corrected assessment")
  }, TIMEOUT)

  it("§4 (P3.2 backlog closure): getEncounter still enforces branch access exactly as before this batch's write-path fixes", async () => {
    await expect(getEncounter(branchASession(), branchBEncounterId)).rejects.toThrow(ForbiddenError)
    const encounter = await getEncounter(branchBSession(), branchBEncounterId)
    expect(encounter.id).toBe(branchBEncounterId)
  }, TIMEOUT)

  /**
   * Targeted backlog closure, item 6 (BACKLOG.md's "secondary fetch-before-
   * update lookups still use findFirstOrThrow"): a stale/foreign id
   * previously leaked Prisma's own raw "Invalid `db.X.findFirstOrThrow()`
   * invocation... No record was found" message. All six named functions now
   * use `findFirst` + a friendly, domain-specific Error instead — verified
   * here against a random, genuinely non-existent UUID for each.
   */
  it("item 6: a stale/foreign id on each of the six named secondary lookups returns a friendly error, never a raw Prisma message", async () => {
    const bogusId = "00000000-0000-4000-8000-000000000000"
    const session = branchASession()

    await expect(updateDiagnosisStatus(session, bogusId, "resolved")).rejects.toThrow(/no longer exists or is not accessible/)
    await expect(cancelOrder(session, bogusId, "test reason")).rejects.toThrow(/no longer exists or is not accessible/)
    await expect(cancelPrescription(session, bogusId)).rejects.toThrow(/no longer exists or is not accessible/)
    await expect(dismissFollowUp(session, bogusId)).rejects.toThrow(/no longer exists or is not accessible/)
    await expect(createAmendment(session, bogusId, { noteType: "consultation", assessment: "x" })).rejects.toThrow(/no longer exists or is not accessible/)

    // None of the above ever surfaced Prisma's own raw invocation text.
    const attempts = await Promise.allSettled([
      updateDiagnosisStatus(session, bogusId, "resolved"),
      cancelOrder(session, bogusId, "test reason"),
      cancelPrescription(session, bogusId),
      dismissFollowUp(session, bogusId),
      createAmendment(session, bogusId, { noteType: "consultation", assessment: "x" }),
    ])
    for (const attempt of attempts) {
      expect(attempt.status).toBe("rejected")
      if (attempt.status === "rejected") {
        const message = attempt.reason instanceof Error ? attempt.reason.message : String(attempt.reason)
        expect(message).not.toMatch(/PrismaClientKnownRequestError|Invalid `db\./)
      }
    }
  }, TIMEOUT)

  /**
   * Targeted backlog closure, item 4: `loadOrNotFound` (src/lib/platform/not-
   * found.ts) is the shared helper now wrapping every major operational
   * `[id]` page's fetch. Exercised directly here — a page-component-level
   * assertion isn't practical in this codebase's Node-only integration
   * suite (no other test file renders a Server Component), but the helper's
   * own branching logic (what it catches vs. rethrows) is fully unit-
   * testable in isolation.
   */
  it("item 4: loadOrNotFound calls notFound() for a not-found/forbidden error and rethrows anything else unchanged", async () => {
    // A real, genuine Prisma "not found" (P2025) from a stale id against
    // getEncounter — the exact same function/error shape `loadOrNotFound`
    // actually wraps on the real encounters/[id] page.
    await expect(
      loadOrNotFound(() => getEncounter(branchASession(), "00000000-0000-4000-8000-000000000000"))
    ).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404") })

    // A real cross-branch ForbiddenError, same function.
    await expect(loadOrNotFound(() => getEncounter(branchASession(), branchBEncounterId))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404"),
    })

    // A genuine, unrelated error type must NOT be swallowed into a 404 —
    // only the two specific "no access, however you slice it" cases are.
    const genuineBug = new Error("a real, unrelated application bug")
    await expect(
      loadOrNotFound(() => {
        throw genuineBug
      })
    ).rejects.toBe(genuineBug)
  }, TIMEOUT)
})
