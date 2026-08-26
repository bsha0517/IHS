import "server-only"
import { db } from "@/lib/db"
import { nextNumber } from "@/lib/platform/sequences"
import { writeAuditLog } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { assertNoLeaveConflict, translateBookingError, BookingConflictError } from "@/lib/domains/appointments/service"
import type { $Enums } from "@/generated/prisma/client"
import type { PublicBookingInput } from "@/lib/domains/booking/schemas"

const OCCUPIED_STATUSES: $Enums.AppointmentStatus[] = [
  "scheduled",
  "confirmed",
  "arrived",
  "checked_in",
  "waiting",
  "in_consultation",
  "completed",
]
const MAX_BOOKINGS_PER_MOBILE_PER_DAY = 5

/** "Select Branch" (spec.md §58) — the org's active branches. Single-org deployment assumption already implicit throughout this codebase (every seed/admin screen resolves "the" organization via findFirst). */
export async function listPublicBranches() {
  const organization = await db.organization.findFirstOrThrow()
  return db.branch.findMany({ where: { organizationId: organization.id, status: "active" }, orderBy: { name: "asc" } })
}

/** "Specialty" (spec.md §58) — distinct specialties among providers linked to this branch. */
export async function listPublicSpecialties(branchId: string) {
  const providers = await db.provider.findMany({
    where: { status: "active", branches: { some: { branchId } }, specialty: { not: null } },
    select: { specialty: true },
    distinct: ["specialty"],
  })
  return providers.map((p) => p.specialty!).sort()
}

/** "Provider" (spec.md §58) — active providers linked to the branch, optionally filtered by specialty. */
export async function listPublicProviders(branchId: string, specialty?: string) {
  return db.provider.findMany({
    where: {
      status: "active",
      branches: { some: { branchId } },
      specialty: specialty ? specialty : undefined,
    },
    orderBy: { firstName: "asc" },
  })
}

/** "Service" (spec.md §58) — active, billable services this provider is eligible to deliver. */
export async function listPublicServices(providerId: string) {
  return db.service.findMany({
    where: { isActive: true, billable: true, providers: { some: { providerId } } },
    orderBy: { name: "asc" },
  })
}

function parseHHMM(value: string, onDate: Date): Date {
  const [hours, minutes] = value.split(":").map(Number)
  const result = new Date(onDate)
  result.setHours(hours, minutes, 0, 0)
  return result
}

/**
 * "Date -> Available Slot" (spec.md §58) — real slot generation, not a
 * placeholder list. Walks each matching ProviderSchedule row's working-hours
 * range at its own slot granularity, offering only slots where the full
 * service duration fits before the schedule ends and doesn't overlap an
 * existing (non-cancelled) Appointment or an approved ProviderLeaveBlock.
 * This computes *candidate* slots for display; the actual race-condition
 * prevention is the DB exclusion constraint `submitPublicBooking()` writes
 * through (see its own doc comment) — this function only makes the UI not
 * offer an obviously-taken slot, it is not itself the safety mechanism.
 */
export async function listAvailableSlots(providerId: string, branchId: string, date: Date, serviceDurationMinutes: number) {
  const dayOfWeek = date.getDay()
  const schedules = await db.providerSchedule.findMany({
    where: { providerId, branchId, dayOfWeek, isActive: true },
  })
  if (schedules.length === 0) return []

  const dayStart = new Date(date)
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(23, 59, 59, 999)

  const [appointments, leaveBlocks] = await Promise.all([
    db.appointment.findMany({
      where: { providerId, startTime: { lte: dayEnd }, endTime: { gte: dayStart }, status: { in: OCCUPIED_STATUSES } },
      select: { startTime: true, endTime: true },
    }),
    db.providerLeaveBlock.findMany({
      where: { providerId, startAt: { lte: dayEnd }, endAt: { gte: dayStart } },
      select: { startAt: true, endAt: true },
    }),
  ])

  const now = new Date()
  const slots: Date[] = []

  for (const schedule of schedules) {
    const scheduleStart = parseHHMM(schedule.startTime, date)
    const scheduleEnd = parseHHMM(schedule.endTime, date)
    const step = schedule.slotDurationMinutes * 60_000

    for (let start = scheduleStart.getTime(); start + serviceDurationMinutes * 60_000 <= scheduleEnd.getTime(); start += step) {
      const slotStart = new Date(start)
      const slotEnd = new Date(start + serviceDurationMinutes * 60_000)
      if (slotStart < now) continue

      const overlapsAppointment = appointments.some((a) => slotStart < a.endTime && slotEnd > a.startTime)
      const overlapsLeave = leaveBlocks.some((l) => slotStart < l.endAt && slotEnd > l.startAt)
      if (!overlapsAppointment && !overlapsLeave) slots.push(slotStart)
    }
  }

  return slots.sort((a, b) => a.getTime() - b.getTime())
}

/**
 * "Patient Details -> Confirmation" (spec.md §58) — no session, deliberately:
 * this is the public entry point, the same "internal/public function with no
 * user-facing permission check, doing its own validation" reasoning as
 * `generateSystemCharge()` (Phase 4), extended here to a public-facing
 * rather than trusted-internal caller. Exact-mobile-number match reuses an
 * existing Patient; anything else creates a new, minimal one — deliberately
 * simpler than staff registration's fuzzy duplicate-detection dialog, which
 * needs a human to interactively resolve a "maybe" match and no such human
 * is in this loop. "Prevent slot race conditions" (spec.md §58) is enforced
 * by the exact same DB exclusion constraint verified live back in Phase 2 —
 * this function does nothing new for that guarantee, it just reaches the
 * same `appointment` INSERT every other booking path already goes through.
 */
export async function submitPublicBooking(input: PublicBookingInput) {
  const organization = await db.organization.findFirstOrThrow()

  const recentCount = await db.appointment.count({
    where: {
      organizationId: organization.id,
      bookingSource: "online",
      patient: { mobile: input.mobile },
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  })
  if (recentCount >= MAX_BOOKINGS_PER_MOBILE_PER_DAY) {
    throw new BookingConflictError("Too many booking attempts from this phone number today. Please call the clinic directly.")
  }

  const service = await db.service.findFirstOrThrow({ where: { id: input.serviceId, organizationId: organization.id } })
  const endTime = new Date(input.startTime.getTime() + service.durationMinutes * 60_000)
  await assertNoLeaveConflict(input.providerId, input.startTime, endTime)

  try {
    const appointment = await db.$transaction(async (tx) => {
      let patient = await tx.patient.findFirst({ where: { organizationId: organization.id, mobile: input.mobile } })
      if (!patient) {
        const mrn = await nextNumber({ organizationId: organization.id, sequenceType: "MRN", prefix: "MRN" })
        patient = await tx.patient.create({
          data: {
            organizationId: organization.id,
            registrationBranchId: input.branchId,
            mrn,
            firstName: input.firstName,
            lastName: input.lastName,
            dob: input.dob,
            gender: input.gender,
            mobile: input.mobile,
            email: input.email ?? null,
            createdBy: null,
          },
        })
      }

      const appointmentNumber = await nextNumber({
        organizationId: organization.id,
        branchId: input.branchId,
        sequenceType: "APT",
        prefix: "APT",
      })

      const created = await tx.appointment.create({
        data: {
          organizationId: organization.id,
          branchId: input.branchId,
          appointmentNumber,
          patientId: patient.id,
          providerId: input.providerId,
          serviceId: input.serviceId,
          startTime: input.startTime,
          endTime,
          bookingSource: "online",
          notes: input.notes ?? null,
          status: "scheduled",
          createdBy: null,
        },
      })

      await tx.appointmentStatusHistory.create({
        data: { appointmentId: created.id, fromStatus: null, toStatus: "scheduled", changedBy: null },
      })

      await writeOutboxEvent(tx, {
        organizationId: organization.id,
        eventType: "AppointmentBooked",
        payload: { appointmentId: created.id, patientId: created.patientId, providerId: created.providerId },
      })

      return { appointment: created, patient }
    })

    await writeAuditLog({
      organizationId: organization.id,
      userId: null,
      action: "create",
      entityType: "appointment",
      entityId: appointment.appointment.id,
      newValues: { appointmentNumber: appointment.appointment.appointmentNumber, bookingSource: "online" },
    })
    await dispatchPendingOutboxEvents(organization.id)

    return appointment
  } catch (error) {
    translateBookingError(error)
  }
}
