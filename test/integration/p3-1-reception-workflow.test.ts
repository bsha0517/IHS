import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { listPatients } from "@/lib/domains/patients/service"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listBranches } from "@/lib/domains/identity/org-structure"
import {
  bookAppointment,
  checkIn,
  rescheduleAppointment,
  getAppointment,
  listStaffAvailableSlots,
} from "@/lib/domains/appointments/service"
import { listBranchQueue } from "@/lib/domains/appointments/queue"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 20000

/**
 * P3.1 (Reception & Appointment Workflow) — targeted tests for the actual
 * behavior changed this batch, per p3.md §26: patient search now also
 * matches national ID, the walk-in flow reuses the existing `Appointment`
 * model end-to-end (booking → check-in → branch queue, not a parallel
 * model), the appointment detail page's reschedule-chain data
 * (`getAppointment`'s new `rescheduledFrom`/`rescheduledTo` include) is
 * correct in both directions, and the new staff slot-availability wrapper
 * (`listStaffAvailableSlots`) both respects branch isolation and excludes a
 * genuinely conflicting appointment — not cosmetic/layout behavior, which
 * this file deliberately does not test.
 */
describe("P3.1: reception & appointment workflow", () => {
  let organizationId: string
  let branchId: string
  let branchBId: string
  let providerId: string
  let userId: string
  let patientId: string
  const createdAppointmentIds: string[] = []
  const createdPatientIds: string[] = []
  let createdScheduleId: string | null = null

  function session(branchIds: string[] = [branchId]): SessionContext {
    return {
      sessionId: "test-p3-1-reception",
      user: { id: userId, organizationId, email: "p3-1-reception@test.local", firstName: "P3.1", lastName: "Reception" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "patient.view",
        "patient.create",
        "appointment.view",
        "appointment.create",
        "appointment.checkin",
        "appointment.reschedule",
        "appointment.cancel",
      ]),
      roleNames: ["Receptionist"],
    }
  }

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 2, orderBy: { createdAt: "asc" } })
    if (branches.length < 2) throw new Error("Test requires at least 2 seeded branches (see LOCAL_DATABASE_SETUP.md).")
    organizationId = branches[0].organizationId
    branchId = branches[0].id
    branchBId = branches[1].id

    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
    const provider = await db.provider.findFirstOrThrow({ where: { organizationId } })
    providerId = provider.id

    const patient = await db.patient.create({
      data: {
        organizationId,
        registrationBranchId: branchId,
        mrn: `TESTP31-${Date.now()}`,
        firstName: "P3.1",
        lastName: "SearchTarget",
        dob: new Date("1990-01-01"),
        gender: "unknown",
        mobile: `P31M${Date.now()}`,
        nationalId: `P31NID${Date.now()}`,
      },
    })
    createdPatientIds.push(patient.id)
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    if (createdScheduleId) await db.providerSchedule.delete({ where: { id: createdScheduleId } }).catch(() => {})
    if (createdAppointmentIds.length > 0) {
      await db.queueEntry.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } })
      await db.appointmentStatusHistory.deleteMany({ where: { appointmentId: { in: createdAppointmentIds } } })
      await db.appointment.deleteMany({ where: { id: { in: createdAppointmentIds } } })
    }
    if (createdPatientIds.length > 0) {
      // Real event-driven side effects of booking/check-in (Phase 12's
      // "Appointment confirmation"/"Patient waiting" sends) create
      // CommMessage/Notification rows referencing the patient — clean those
      // up first, the same "delete children before the parent" discipline
      // this suite's own cascade-delete-protection test establishes.
      await db.commMessage.deleteMany({ where: { patientId: { in: createdPatientIds } } })
      await db.notification.deleteMany({ where: { referenceType: "appointment", referenceId: { in: createdAppointmentIds } } })
      await db.patient.deleteMany({ where: { id: { in: createdPatientIds } } })
    }
    await db.$disconnect()
  }, TIMEOUT)

  it("P3.3 §4: reception/page.tsx and appointments/page.tsx use listAccessibleBranches, not listBranches — the Receptionist session shape above genuinely lacks branch.view", async () => {
    // Confirms the actual bug: the seeded Receptionist role (mirrored by
    // this suite's own `session()` helper) does not hold `branch.view`, so
    // the org-wide listBranches — which both pages called unconditionally
    // before this fix — really does throw for it.
    await expect(listBranches(session())).rejects.toThrow(ForbiddenError)
    // The fix: listAccessibleBranches needs no permission beyond an
    // authenticated session with branchIds, and returns the same shape
    // (a Branch[] scoped to session.branchIds) both pages actually need.
    const accessible = await listAccessibleBranches(session())
    expect(accessible.length).toBeGreaterThan(0)
    expect(accessible.every((b) => b.id === branchId)).toBe(true)
  }, TIMEOUT)

  it("§10: patient search also matches by national ID, not just name/MRN/mobile", async () => {
    const patient = await db.patient.findUniqueOrThrow({ where: { id: patientId } })
    const result = await listPatients(session(), { search: patient.nationalId! })
    expect(result.patients.some((p) => p.id === patientId)).toBe(true)
  }, TIMEOUT)

  it("§9: a walk-in booking uses the existing Appointment model end-to-end — booked, checked in, and visible in the branch queue", async () => {
    const start = new Date(Date.now() + 6 * 60 * 60 * 1000) // 6h out — clear of same-second collisions
    const appt = await bookAppointment(session(), {
      branchId,
      patientId,
      providerId,
      startTime: start,
      durationMinutes: 30,
      bookingSource: "walk_in",
    })
    createdAppointmentIds.push(appt.id)
    expect(appt.bookingSource).toBe("walk_in")
    expect(appt.status).toBe("scheduled")

    await checkIn(session(), appt.id)
    const queue = await listBranchQueue(session(), branchId)
    expect(queue.some((a) => a.id === appt.id)).toBe(true)
  }, TIMEOUT)

  it("§14: getAppointment shows the reschedule chain in both directions, and the original is not left in an active queue state", async () => {
    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const original = await bookAppointment(session(), { branchId, patientId, providerId, startTime: start, durationMinutes: 30, bookingSource: "staff" })
    createdAppointmentIds.push(original.id)

    const newStart = new Date(start.getTime() + 2 * 60 * 60 * 1000)
    const rebooked = await rescheduleAppointment(session(), original.id, {
      startTime: newStart,
      durationMinutes: 30,
      reason: "P3.1 test reschedule",
    })
    createdAppointmentIds.push(rebooked.id)

    const originalDetail = await getAppointment(session(), original.id)
    expect(originalDetail.status).toBe("rescheduled")
    expect(originalDetail.rescheduledTo.map((r) => r.id)).toContain(rebooked.id)

    const newDetail = await getAppointment(session(), rebooked.id)
    expect(newDetail.rescheduledFrom?.id).toBe(original.id)
    expect(newDetail.status).toBe("scheduled")
  }, TIMEOUT)

  it("§20: listStaffAvailableSlots refuses a branch the session isn't authorized for", async () => {
    await expect(
      listStaffAvailableSlots(session([branchBId]), { providerId, branchId, date: new Date(), serviceDurationMinutes: 30 })
    ).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§13: listStaffAvailableSlots returns real, schedule-derived slots and excludes one already taken by a conflicting appointment", async () => {
    // No schedule at all yet for this provider/branch — must return no slots,
    // not a fabricated placeholder list.
    const noScheduleDay = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
    const emptySlots = await listStaffAvailableSlots(session(), {
      providerId,
      branchId,
      date: noScheduleDay,
      serviceDurationMinutes: 30,
    })
    expect(emptySlots).toHaveLength(0)

    // Give the provider a real working-hours schedule for that specific day
    // (test-provider fixtures carry none by default), wide enough to offer
    // several slots.
    const schedule = await db.providerSchedule.create({
      data: {
        providerId,
        branchId,
        dayOfWeek: noScheduleDay.getDay(),
        startTime: "08:00",
        endTime: "17:00",
        slotDurationMinutes: 30,
      },
    })
    createdScheduleId = schedule.id

    const beforeBooking = await listStaffAvailableSlots(session(), {
      providerId,
      branchId,
      date: noScheduleDay,
      serviceDurationMinutes: 30,
    })
    expect(beforeBooking.length).toBeGreaterThan(0)

    // Book the very first offered slot directly (bypassing the service
    // layer's own leave-conflict check, matching this suite's established
    // "insert directly to isolate the thing under test" pattern for
    // exclusion-constraint-adjacent fixtures) and confirm it disappears
    // from the next availability read.
    const takenSlot = beforeBooking[0]
    const takenAppt = await db.appointment.create({
      data: {
        organizationId,
        branchId,
        appointmentNumber: `TESTP31SLOT-${Date.now()}`,
        patientId,
        providerId,
        startTime: takenSlot,
        endTime: new Date(takenSlot.getTime() + 30 * 60 * 1000),
        status: "scheduled",
      },
    })
    createdAppointmentIds.push(takenAppt.id)

    const afterBooking = await listStaffAvailableSlots(session(), {
      providerId,
      branchId,
      date: noScheduleDay,
      serviceDurationMinutes: 30,
    })
    expect(afterBooking.some((s) => s.getTime() === takenSlot.getTime())).toBe(false)
    expect(afterBooking.length).toBe(beforeBooking.length - 1)
  }, TIMEOUT)
})
