import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import {
  bookAppointment,
  confirmAppointment,
  markArrived,
  checkIn,
  callPatient,
  completeConsultation,
  cancelAppointment,
  rescheduleAppointment,
  BookingConflictError,
} from "@/lib/domains/appointments/service"
import { rescheduleAppointmentSchema } from "@/lib/domains/appointments/schemas"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §26 (reschedule preserves history + rejects new-slot conflicts) and
 * §27 (centralized status transitions, nonsensical moves rejected, status
 * history stored) — real DB integration tests. Session is a hand-built
 * Super Admin context (same precedent as refund-payment-integrity.test.ts):
 * this file tests workflow/transactional correctness, not authorization.
 */
const TIMEOUT = 60000

describe("P1 §26/§27: appointment reschedule and status transition integrity", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let providerId: string
  let userId: string
  const appointmentIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-appointment-integrity",
      user: { id: userId, organizationId, email: "appt-integrity-test@test.local", firstName: "Appt", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set([
        "appointment.create", "appointment.view", "appointment.reschedule",
        "appointment.checkin", "appointment.cancel",
      ]),
      roleNames: ["Super Admin"],
    }
  }

  async function book(startTime: Date, durationMinutes = 30, overrideProviderId?: string) {
    const appointment = await bookAppointment(session(), {
      branchId, patientId, providerId: overrideProviderId ?? providerId,
      startTime, durationMinutes, bookingSource: "staff",
    })
    appointmentIds.push(appointment.id)
    return appointment
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const provider = await db.provider.create({
      data: { organizationId, providerType: "doctor", firstName: "ApptIntegrity", lastName: `TestProvider-${Date.now()}` },
    })
    providerId = provider.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTAPPTINT-${Date.now()}`, firstName: "ApptIntegrity", lastName: "Test",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `AI${Date.now()}`,
      },
    })
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    // AppointmentBooked/AppointmentCancelled's outbox handlers queue a
    // CommMessage against this patient — must clear those before the
    // patient itself (Patient's own FK from CommMessage has no cascade).
    await db.commMessage.deleteMany({ where: { patientId } })
    await db.appointmentStatusHistory.deleteMany({ where: { appointmentId: { in: appointmentIds } } })
    await db.appointment.deleteMany({ where: { id: { in: appointmentIds } } })
    await db.patient.delete({ where: { id: patientId } })
    await db.provider.delete({ where: { id: providerId } })
    await db.$disconnect()
  }, TIMEOUT)

  describe("§26: reschedule maintains real history, never overwrites", () => {
    it("preserves the original appointment, records changed-by/reason/timestamp, and creates a new row with the new date/time", async () => {
      const original = await book(new Date("2027-03-01T09:00:00Z"))
      const newStart = new Date("2027-03-02T10:00:00Z")

      const rebooked = await rescheduleAppointment(session(), original.id, {
        startTime: newStart, durationMinutes: 45, reason: "Patient requested a later date",
      })
      appointmentIds.push(rebooked.id)

      // Original untouched except its own status — its startTime is NOT
      // overwritten with the new slot.
      const originalAfter = await db.appointment.findUniqueOrThrow({ where: { id: original.id } })
      expect(originalAfter.startTime.toISOString()).toBe(original.startTime.toISOString())
      expect(originalAfter.status).toBe("rescheduled")

      // New appointment carries the new date/time and links back.
      expect(rebooked.startTime.toISOString()).toBe(newStart.toISOString())
      expect(rebooked.rescheduledFromId).toBe(original.id)

      // History on the original captures who/why/when, not just what.
      const history = await db.appointmentStatusHistory.findMany({
        where: { appointmentId: original.id }, orderBy: { changedAt: "asc" },
      })
      const rescheduleEntry = history.find((h) => h.toStatus === "rescheduled")
      expect(rescheduleEntry).toBeDefined()
      expect(rescheduleEntry?.changedBy).toBe(userId)
      expect(rescheduleEntry?.reason).toContain("Patient requested a later date")
      expect(rescheduleEntry?.changedAt).toBeInstanceOf(Date)

      // New appointment has its own fresh history entry too.
      const newHistory = await db.appointmentStatusHistory.findMany({ where: { appointmentId: rebooked.id } })
      expect(newHistory.length).toBe(1)
      expect(newHistory[0].toStatus).toBe("scheduled")
    }, TIMEOUT)

    it("rejects rescheduling into a slot that conflicts with another appointment for the same provider", async () => {
      const blocker = await book(new Date("2027-03-05T09:00:00Z"), 60)
      const toMove = await book(new Date("2027-03-05T14:00:00Z"), 30)

      await expect(
        rescheduleAppointment(session(), toMove.id, {
          startTime: new Date("2027-03-05T09:30:00Z"), // overlaps blocker's 09:00-10:00
          durationMinutes: 30,
          reason: "Trying to double-book",
        })
      ).rejects.toThrow(BookingConflictError)

      // The original appointment being rescheduled was NOT moved to
      // "rescheduled" by the rejected attempt — the whole operation rolled back.
      const toMoveAfter = await db.appointment.findUniqueOrThrow({ where: { id: toMove.id } })
      expect(toMoveAfter.status).toBe("scheduled")
      void blocker
    }, TIMEOUT)

    it("the input schema requires a non-empty reason (enforced at the Server Action boundary, same layer cancelAppointment's own reason validation lives)", () => {
      const missing = rescheduleAppointmentSchema.safeParse({ startTime: new Date(), durationMinutes: 30 })
      expect(missing.success).toBe(false)

      const empty = rescheduleAppointmentSchema.safeParse({ startTime: new Date(), durationMinutes: 30, reason: "" })
      expect(empty.success).toBe(false)

      const valid = rescheduleAppointmentSchema.safeParse({ startTime: new Date(), durationMinutes: 30, reason: "Provider unavailable" })
      expect(valid.success).toBe(true)
    })
  })

  describe("§27: centralized status transitions reject nonsensical moves and store history", () => {
    it("allows the full happy path and stores a history row for every step", async () => {
      const appt = await book(new Date("2027-03-10T09:00:00Z"))
      await confirmAppointment(session(), appt.id)
      await markArrived(session(), appt.id)
      await checkIn(session(), appt.id)
      await callPatient(session(), appt.id)
      await completeConsultation(session(), appt.id)

      const final = await db.appointment.findUniqueOrThrow({ where: { id: appt.id } })
      expect(final.status).toBe("completed")

      const history = await db.appointmentStatusHistory.findMany({
        where: { appointmentId: appt.id }, orderBy: { changedAt: "asc" },
      })
      // scheduled(create) -> confirmed -> arrived -> checked_in -> waiting -> in_consultation -> completed
      expect(history.map((h) => h.toStatus)).toEqual([
        "scheduled", "confirmed", "arrived", "checked_in", "waiting", "in_consultation", "completed",
      ])
    }, TIMEOUT)

    it("rejects a skip-ahead transition (scheduled directly to completed)", async () => {
      const appt = await book(new Date("2027-03-11T09:00:00Z"))
      await expect(completeConsultation(session(), appt.id)).rejects.toThrow(/Cannot move an appointment from "scheduled" to "completed"/)
    }, TIMEOUT)

    it("rejects any transition away from a terminal status (completed)", async () => {
      const appt = await book(new Date("2027-03-12T09:00:00Z"))
      await confirmAppointment(session(), appt.id)
      await markArrived(session(), appt.id)
      await checkIn(session(), appt.id)
      await callPatient(session(), appt.id)
      await completeConsultation(session(), appt.id)

      await expect(cancelAppointment(session(), appt.id, "too late")).rejects.toThrow(/Cannot move an appointment from "completed"/)
      await expect(confirmAppointment(session(), appt.id)).rejects.toThrow(/Cannot move an appointment from "completed"/)
    }, TIMEOUT)

    it("rejects any transition away from a cancelled appointment", async () => {
      const appt = await book(new Date("2027-03-13T09:00:00Z"))
      await cancelAppointment(session(), appt.id, "patient cancelled")
      await expect(markArrived(session(), appt.id)).rejects.toThrow(/Cannot move an appointment from "cancelled"/)
    }, TIMEOUT)
  })
})
