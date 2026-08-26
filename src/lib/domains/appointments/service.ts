import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"
import type { $Enums } from "@/generated/prisma/client"
import type { BookAppointmentInput, RescheduleAppointmentInput } from "@/lib/domains/appointments/schemas"

type AppointmentStatus = $Enums.AppointmentStatus

export class BookingConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BookingConflictError"
  }
}

export async function assertNoLeaveConflict(providerId: string, startTime: Date, endTime: Date) {
  const conflict = await db.providerLeaveBlock.findFirst({
    where: { providerId, startAt: { lt: endTime }, endAt: { gt: startTime } },
  })
  if (conflict) {
    throw new BookingConflictError("This provider is on approved leave during the requested time.")
  }
}

/** Postgres reports an exclusion-constraint violation as a plain error whose
 * message names the constraint — this maps that to what a receptionist should
 * see instead of a raw database error leaking through. The DB constraint
 * (see the timestamptz_and_booking_exclusion migration) is what actually
 * prevents the race, not this check; this only makes the failure legible. */
export function translateBookingError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("appointment_provider_no_overlap")) {
    throw new BookingConflictError("This provider already has an appointment that overlaps this time.")
  }
  if (message.includes("appointment_room_no_overlap")) {
    throw new BookingConflictError("This room is already booked for an overlapping time.")
  }
  throw error
}

export async function bookAppointment(session: SessionContext, input: BookAppointmentInput) {
  assertCan(session, "appointment.create", { branchId: input.branchId })

  const endTime = new Date(input.startTime.getTime() + input.durationMinutes * 60_000)
  await assertNoLeaveConflict(input.providerId, input.startTime, endTime)

  try {
    const appointment = await db.$transaction(async (tx) => {
      const appointmentNumber = await nextNumber({
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        sequenceType: "APT",
        prefix: "APT",
      })

      const created = await tx.appointment.create({
        data: {
          organizationId: session.user.organizationId,
          branchId: input.branchId,
          appointmentNumber,
          patientId: input.patientId,
          providerId: input.providerId,
          serviceId: input.serviceId ?? null,
          departmentId: input.departmentId ?? null,
          roomId: input.roomId ?? null,
          startTime: input.startTime,
          endTime,
          bookingSource: input.bookingSource,
          notes: input.notes ?? null,
          status: "scheduled",
          createdBy: session.user.id,
        },
      })

      await tx.appointmentStatusHistory.create({
        data: { appointmentId: created.id, fromStatus: null, toStatus: "scheduled", changedBy: session.user.id },
      })

      await writeOutboxEvent(tx, {
        organizationId: session.user.organizationId,
        eventType: "AppointmentBooked",
        payload: { appointmentId: created.id, patientId: created.patientId, providerId: created.providerId },
      })

      return created
    })

    await auditFromSession(session, "create", "appointment", appointment.id, {
      new: { appointmentNumber: appointment.appointmentNumber, startTime: appointment.startTime },
    })
    await dispatchPendingOutboxEvents(session.user.organizationId)

    return appointment
  } catch (error) {
    translateBookingError(error)
  }
}

export async function listAppointments(
  session: SessionContext,
  params: { branchId?: string; providerId?: string; from: Date; to: Date; statuses?: AppointmentStatus[] }
) {
  assertCan(session, "appointment.view")
  return db.appointment.findMany({
    where: {
      organizationId: session.user.organizationId,
      ...(params.branchId ? { branchId: params.branchId } : {}),
      ...(params.providerId ? { providerId: params.providerId } : {}),
      startTime: { gte: params.from, lt: params.to },
      ...(params.statuses ? { status: { in: params.statuses } } : {}),
    },
    include: { patient: true, provider: true, service: true, room: true, department: true, queueEntry: true, encounter: true },
    orderBy: { startTime: "asc" },
  })
}

export async function listPatientAppointments(session: SessionContext, patientId: string) {
  assertCan(session, "appointment.view")
  return db.appointment.findMany({
    where: { organizationId: session.user.organizationId, patientId },
    include: { provider: true, service: true, queueEntry: true, statusHistory: { orderBy: { changedAt: "asc" } } },
    orderBy: { startTime: "desc" },
  })
}

export async function getAppointment(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.view")
  return db.appointment.findFirstOrThrow({
    where: { id: appointmentId, organizationId: session.user.organizationId },
    include: {
      patient: true,
      provider: true,
      service: true,
      room: true,
      department: true,
      queueEntry: true,
      statusHistory: { orderBy: { changedAt: "asc" } },
    },
  })
}

async function transition(
  session: SessionContext,
  appointmentId: string,
  allowedFrom: AppointmentStatus[],
  toStatus: AppointmentStatus,
  reason?: string
) {
  const appointment = await db.appointment.findFirstOrThrow({
    where: { id: appointmentId, organizationId: session.user.organizationId },
  })
  if (!allowedFrom.includes(appointment.status)) {
    throw new Error(`Cannot move an appointment from "${appointment.status}" to "${toStatus}".`)
  }

  await db.$transaction([
    db.appointment.update({ where: { id: appointmentId }, data: { status: toStatus } }),
    db.appointmentStatusHistory.create({
      data: { appointmentId, fromStatus: appointment.status, toStatus, changedBy: session.user.id, reason },
    }),
  ])

  return { ...appointment, status: toStatus }
}

export async function confirmAppointment(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.view")
  return transition(session, appointmentId, ["scheduled"], "confirmed")
}

export async function markArrived(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.checkin")
  return transition(session, appointmentId, ["scheduled", "confirmed"], "arrived")
}

/**
 * Check-in produces both the "checked_in" and "waiting" status-history entries
 * in one action (spec.md §20's workflow has no distinct human action between
 * them) and creates the QueueEntry with its daily-reset token number.
 */
export async function checkIn(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.checkin")

  const appointment = await db.appointment.findFirstOrThrow({
    where: { id: appointmentId, organizationId: session.user.organizationId },
  })
  if (!["scheduled", "confirmed", "arrived"].includes(appointment.status)) {
    throw new Error(`Cannot check in an appointment with status "${appointment.status}".`)
  }

  const now = new Date()
  const tokenNumber = await nextNumber({
    organizationId: session.user.organizationId,
    branchId: appointment.branchId,
    sequenceType: "QUEUE",
    prefix: "Q",
    padding: 3,
    resetPeriod: "daily",
  })

  await db.$transaction(async (tx) => {
    await tx.appointment.update({ where: { id: appointmentId }, data: { status: "waiting" } })
    await tx.appointmentStatusHistory.createMany({
      data: [
        { appointmentId, fromStatus: appointment.status, toStatus: "checked_in", changedBy: session.user.id },
        { appointmentId, fromStatus: "checked_in", toStatus: "waiting", changedBy: session.user.id },
      ],
    })
    await tx.queueEntry.create({
      data: {
        appointmentId,
        branchId: appointment.branchId,
        tokenNumber,
        arrivedAt: appointment.status === "arrived" ? undefined : now,
        checkedInAt: now,
      },
    })
    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "AppointmentCheckedIn",
      payload: { appointmentId, patientId: appointment.patientId, providerId: appointment.providerId },
    })
  })

  await dispatchPendingOutboxEvents(session.user.organizationId)

  return tokenNumber
}

export async function callPatient(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.checkin")
  const result = await transition(session, appointmentId, ["waiting"], "in_consultation")
  const now = new Date()
  await db.queueEntry.update({
    where: { appointmentId },
    data: { calledAt: now, consultationStartAt: now },
  })
  return result
}

export async function completeConsultation(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.checkin")
  const result = await transition(session, appointmentId, ["in_consultation"], "completed")
  await db.queueEntry.update({ where: { appointmentId }, data: { consultationEndAt: new Date() } })
  return result
}

export async function cancelAppointment(session: SessionContext, appointmentId: string, reason: string) {
  assertCan(session, "appointment.cancel")
  const result = await transition(
    session,
    appointmentId,
    ["scheduled", "confirmed", "arrived", "checked_in", "waiting"],
    "cancelled",
    reason
  )
  // Best-effort patient notification (spec.md §56's "Cancellation" template).
  // Written as a separate outbox event rather than inside transition()'s own
  // transaction — a notification failing to queue should never block the
  // cancellation itself, and transition() is shared by six other status
  // changes that don't need this side effect.
  await writeOutboxEvent(db, {
    organizationId: session.user.organizationId,
    eventType: "AppointmentCancelled",
    payload: { appointmentId: result.id, patientId: result.patientId, providerId: result.providerId },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return result
}

export async function markNoShow(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.cancel")
  return transition(session, appointmentId, ["scheduled", "confirmed"], "no_show")
}

export async function rescheduleAppointment(
  session: SessionContext,
  appointmentId: string,
  input: RescheduleAppointmentInput
) {
  assertCan(session, "appointment.reschedule")

  const original = await db.appointment.findFirstOrThrow({
    where: { id: appointmentId, organizationId: session.user.organizationId },
  })
  if (!["scheduled", "confirmed"].includes(original.status)) {
    throw new Error(`Cannot reschedule an appointment with status "${original.status}".`)
  }

  const providerId = input.providerId ?? original.providerId
  const endTime = new Date(input.startTime.getTime() + input.durationMinutes * 60_000)
  await assertNoLeaveConflict(providerId, input.startTime, endTime)

  try {
    const rebooked = await db.$transaction(async (tx) => {
      const appointmentNumber = await nextNumber({
        organizationId: session.user.organizationId,
        branchId: original.branchId,
        sequenceType: "APT",
        prefix: "APT",
      })

      const created = await tx.appointment.create({
        data: {
          organizationId: session.user.organizationId,
          branchId: original.branchId,
          appointmentNumber,
          patientId: original.patientId,
          providerId,
          serviceId: original.serviceId,
          departmentId: original.departmentId,
          roomId: input.roomId ?? original.roomId,
          startTime: input.startTime,
          endTime,
          bookingSource: original.bookingSource,
          notes: original.notes,
          status: "scheduled",
          rescheduledFromId: original.id,
          createdBy: session.user.id,
        },
      })
      await tx.appointmentStatusHistory.create({
        data: { appointmentId: created.id, fromStatus: null, toStatus: "scheduled", changedBy: session.user.id },
      })
      await tx.appointment.update({ where: { id: original.id }, data: { status: "rescheduled" } })
      await tx.appointmentStatusHistory.create({
        data: {
          appointmentId: original.id,
          fromStatus: original.status,
          toStatus: "rescheduled",
          changedBy: session.user.id,
          reason: `Rebooked as ${created.appointmentNumber}`,
        },
      })

      return created
    })

    await auditFromSession(session, "reschedule", "appointment", original.id, {
      old: { startTime: original.startTime },
      new: { rebookedAs: rebooked.appointmentNumber, startTime: rebooked.startTime },
    })

    return rebooked
  } catch (error) {
    translateBookingError(error)
  }
}
