import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import { assertValidTransition } from "@/lib/platform/state-machine"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { listAvailableSlots } from "@/lib/domains/booking/service"
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

/**
 * P1 §27: single source of truth for every appointment status change, so
 * "nonsensical" is defined once rather than re-decided per call site. The
 * happy path (scheduled → confirmed → arrived → waiting → in_consultation →
 * completed) plus the controlled branches P1.md names by example (Scheduled
 * → Cancelled, Scheduled → No Show, Confirmed → Rescheduled) and the ones
 * this codebase already exercised before this map existed (arrived/waiting
 * → cancelled; the DB's own AppointmentStatus enum still has "checked_in" as
 * a status value even though checkIn() below never leaves the appointment
 * row sitting in it — see that function's own comment — so it's listed here
 * too for completeness, not because any write ever targets it). completed,
 * cancelled, rescheduled, and no_show are terminal: no further transition
 * moves an appointment away from them through this guard.
 */
export const APPOINTMENT_TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> = {
  scheduled: ["confirmed", "arrived", "waiting", "cancelled", "no_show", "rescheduled"],
  confirmed: ["arrived", "waiting", "cancelled", "no_show", "rescheduled"],
  arrived: ["waiting", "cancelled"],
  checked_in: ["waiting", "cancelled"],
  waiting: ["in_consultation", "cancelled"],
  in_consultation: ["completed"],
  completed: [],
  cancelled: [],
  rescheduled: [],
  no_show: [],
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

/**
 * P3.1 §12/§13: the staff-facing (New Appointment / Reschedule dialogs)
 * entry point for real slot availability — reuses `listAvailableSlots`
 * (booking/service.ts), the exact same schedule/leave/conflict-aware
 * computation Phase 12's public booking wizard already uses, rather than
 * building a second one. The only thing added here is what the public path
 * doesn't need: a permission check and branch-access enforcement, since
 * this is called by an authenticated staff session, not an anonymous one.
 */
export async function listStaffAvailableSlots(
  session: SessionContext,
  input: { providerId: string; branchId: string; date: Date; serviceDurationMinutes: number }
) {
  assertCan(session, "appointment.view")
  assertBranchAccess(getAuthorizedBranchScope(session), input.branchId)
  return listAvailableSlots(input.providerId, input.branchId, input.date, input.serviceDurationMinutes)
}

export async function bookAppointment(session: SessionContext, input: BookAppointmentInput) {
  assertCan(session, "appointment.create", { branchId: input.branchId })

  const endTime = new Date(input.startTime.getTime() + input.durationMinutes * 60_000)
  await assertNoLeaveConflict(input.providerId, input.startTime, endTime)

  try {
    const appointment = await db.$transaction(async (tx) => {
      // P1 §30: org-wide, not branch-scoped — Appointment.appointmentNumber's
      // own unique constraint (`@@unique([organizationId, appointmentNumber])`)
      // is org-wide, matching every other numbered entity (Invoice, Payment,
      // Refund, Claim, PO, Asset, Employee, MRN, Encounter — none pass
      // branchId to nextNumber). Passing branchId here used to give this one
      // entity a branch-scoped counter feeding an org-wide-unique column — two
      // branches of the same org would eventually both mint "APT-000047" and
      // the second insert would fail the DB constraint. A concurrency test
      // that raced a from-scratch sequence reproduced exactly this collision.
      const appointmentNumber = await nextNumber({
        organizationId: session.user.organizationId,
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
      // Widened from Prisma's 5000ms default below — nextNumber() above
      // opens its own nested transaction/connection (see sequences.ts's own
      // comment), on top of the create + history-create + outbox write
      // here; a real P2028 ("5000ms timeout, 6289ms passed") was observed
      // directly from this exact transaction during this batch's own tests.
    }, { timeout: 20_000, maxWait: 10_000 })

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
  const scope = getAuthorizedBranchScope(session)
  return db.appointment.findMany({
    where: {
      organizationId: session.user.organizationId,
      branchId: narrowBranchFilter(scope, params.branchId),
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
  const scope = getAuthorizedBranchScope(session)
  return db.appointment.findMany({
    where: { organizationId: session.user.organizationId, patientId, branchId: narrowBranchFilter(scope) },
    include: {
      provider: true,
      service: true,
      // P3.2 §12/§6: branch is now shown in Patient 360's Appointments tab
      // (a multi-branch org's staff previously couldn't tell which branch a
      // past appointment happened at without opening its detail page), and
      // `encounter` powers the Overview tab's "current context" summary —
      // both are cheap `select`s added to an include already being fetched,
      // not a new query.
      branch: { select: { name: true } },
      encounter: { select: { id: true, encounterNumber: true, status: true } },
      queueEntry: true,
      statusHistory: { orderBy: { changedAt: "asc" } },
      rescheduledTo: { select: { id: true, appointmentNumber: true } },
    },
    orderBy: { startTime: "desc" },
  })
}

export async function getAppointment(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.view")
  const appointment = await db.appointment.findFirstOrThrow({
    where: { id: appointmentId, organizationId: session.user.organizationId },
    include: {
      patient: true,
      provider: true,
      service: true,
      room: true,
      department: true,
      branch: true,
      queueEntry: true,
      encounter: true,
      statusHistory: {
        orderBy: { changedAt: "asc" },
        include: { changedByUser: { select: { firstName: true, lastName: true } } },
      },
      // P3.1 §14: the reschedule chain already exists on the schema
      // (`rescheduledFromId`/its inverse relation) but nothing rendered it
      // — this is what lets the detail page show "Original → Rescheduled →
      // New appointment" without any new column or table.
      rescheduledFrom: { select: { id: true, appointmentNumber: true, startTime: true, status: true } },
      rescheduledTo: { select: { id: true, appointmentNumber: true, startTime: true, status: true } },
    },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), appointment.branchId)
  return appointment
}

async function transition(
  session: SessionContext,
  appointmentId: string,
  toStatus: AppointmentStatus,
  reason?: string
) {
  const appointment = await db.appointment.findFirstOrThrow({
    where: { id: appointmentId, organizationId: session.user.organizationId },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), appointment.branchId)
  assertValidTransition(APPOINTMENT_TRANSITIONS, appointment.status, toStatus, "an appointment")

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
  return transition(session, appointmentId, "confirmed")
}

export async function markArrived(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.checkin")
  return transition(session, appointmentId, "arrived")
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
  assertBranchAccess(getAuthorizedBranchScope(session), appointment.branchId)
  assertValidTransition(APPOINTMENT_TRANSITIONS, appointment.status, "waiting", "an appointment")

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
  const result = await transition(session, appointmentId, "in_consultation")
  const now = new Date()
  await db.queueEntry.update({
    where: { appointmentId },
    data: { calledAt: now, consultationStartAt: now },
  })
  return result
}

export async function completeConsultation(session: SessionContext, appointmentId: string) {
  assertCan(session, "appointment.checkin")
  const result = await transition(session, appointmentId, "completed")
  await db.queueEntry.update({ where: { appointmentId }, data: { consultationEndAt: new Date() } })
  return result
}

export async function cancelAppointment(session: SessionContext, appointmentId: string, reason: string) {
  assertCan(session, "appointment.cancel")
  const result = await transition(session, appointmentId, "cancelled", reason)
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
  return transition(session, appointmentId, "no_show")
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
  assertBranchAccess(getAuthorizedBranchScope(session), original.branchId)
  assertValidTransition(APPOINTMENT_TRANSITIONS, original.status, "rescheduled", "an appointment")

  const providerId = input.providerId ?? original.providerId
  const endTime = new Date(input.startTime.getTime() + input.durationMinutes * 60_000)
  await assertNoLeaveConflict(providerId, input.startTime, endTime)

  try {
    const rebooked = await db.$transaction(async (tx) => {
      // P1 §30: org-wide — see bookAppointment's identical comment above.
      const appointmentNumber = await nextNumber({
        organizationId: session.user.organizationId,
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
          // P1 §26: the actual reason the staff member gave, not just the
          // mechanical "what happened" note — original.startTime/original.id
          // stay on the original row untouched (nothing here overwrites the
          // original appointment's own date/time), and rescheduledFromId on
          // the new row is what lets a reader walk from either end of the
          // chain.
          reason: `${input.reason} (rebooked as ${created.appointmentNumber})`,
        },
      })

      return created
      // Widened from Prisma's 5000ms default — same reasoning as
      // bookAppointment's identical fix above (nested nextNumber() call plus
      // a create, two history-creates, and an update, all in one transaction).
    }, { timeout: 20_000, maxWait: 10_000 })

    await auditFromSession(session, "reschedule", "appointment", original.id, {
      old: { startTime: original.startTime },
      new: { rebookedAs: rebooked.appointmentNumber, startTime: rebooked.startTime, reason: input.reason },
    })

    return rebooked
  } catch (error) {
    translateBookingError(error)
  }
}
