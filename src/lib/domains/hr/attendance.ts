import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { ShiftInput, CheckInInput, AttendanceAdjustInput } from "@/lib/domains/hr/schemas"

export async function listShifts(session: SessionContext) {
  assertCan(session, "payroll.view")
  return db.shift.findMany({ where: { organizationId: session.user.organizationId }, orderBy: { name: "asc" } })
}

export async function createShift(session: SessionContext, input: ShiftInput) {
  assertCan(session, "employee.manage")
  const created = await db.shift.create({
    data: { organizationId: session.user.organizationId, name: input.name, startTime: input.startTime, endTime: input.endTime },
  })
  await auditFromSession(session, "create", "shift", created.id, { new: input })
  return created
}

function shiftMinutesFromMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

/**
 * One row per employee per date (@@unique) — the first check-in of the day
 * creates it, a same-day repeat is rejected rather than silently creating a
 * second row that would violate the constraint anyway.
 *
 * P3.10 §16/§50: `input.branchId` used to be trusted as-is for both the
 * `attendance.record` branch check AND the record's own `branchId` column —
 * a client-supplied value that happened to match the roster's own display,
 * but nothing ever verified it actually matched THIS employee's real
 * branch. A crafted call could record attendance for an employee at a
 * branch they don't belong to (wrong branch's roster, wrong branch-scoped
 * reporting). The employee's own `branchId` is now the sole source of
 * truth for both checks; `input.branchId` is no longer trusted.
 *
 * P3.10 §52: also now rejects a terminated employee with a clear message
 * instead of silently recording attendance for someone no longer employed.
 */
export async function checkIn(session: SessionContext, input: CheckInInput) {
  const employee = await db.employee.findFirstOrThrow({ where: { id: input.employeeId, organizationId: session.user.organizationId } })
  assertCan(session, "attendance.record", { branchId: employee.branchId })
  if (employee.status === "terminated") throw new Error("This employee is terminated and cannot be checked in.")

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const existing = await db.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: input.employeeId, date: today } } })
  if (existing?.checkInAt) throw new Error("This employee has already checked in today.")

  let record
  try {
    record = existing
      ? await db.attendanceRecord.update({
          where: { id: existing.id },
          data: { checkInAt: new Date(), shiftId: input.shiftId ?? existing.shiftId, recordedBy: session.user.id },
        })
      : await db.attendanceRecord.create({
          data: {
            organizationId: session.user.organizationId,
            branchId: employee.branchId,
            employeeId: input.employeeId,
            shiftId: input.shiftId ?? null,
            date: today,
            checkInAt: new Date(),
            recordedBy: session.user.id,
          },
        })
  } catch (e) {
    // P3.10 §16/§17: two simultaneous check-ins for the same employee/date
    // both reading `existing === null` would otherwise surface Postgres's
    // raw unique-constraint text (employee_id, date) straight to the user —
    // the DB constraint is still the real guard (same discipline as
    // encounters.ts's own appointmentId race), this only translates it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new Error("This employee has already checked in today.")
    }
    throw e
  }

  await auditFromSession(session, "create", "attendance_record", record.id, { new: { employeeId: input.employeeId, checkInAt: record.checkInAt } })
  return record
}

/**
 * workingMinutes/lateMinutes/earlyDepartureMinutes/overtimeMinutes are always
 * computed here, server-side, against the assigned Shift's times — never
 * accepted as a client-submitted value (same discipline as VitalSign.bmi).
 */
export async function checkOut(session: SessionContext, attendanceRecordId: string) {
  assertCan(session, "attendance.record")

  const record = await db.attendanceRecord.findFirstOrThrow({
    where: { id: attendanceRecordId, organizationId: session.user.organizationId },
    include: { shift: true },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), record.branchId)
  if (!record.checkInAt) throw new Error("This employee has not checked in yet.")
  if (record.checkOutAt) throw new Error("This employee has already checked out today.")

  const checkOutAt = new Date()
  const workingMinutes = Math.max(0, Math.round((checkOutAt.getTime() - record.checkInAt.getTime()) / 60000) - record.breakMinutes)

  let lateMinutes = 0
  let earlyDepartureMinutes = 0
  let overtimeMinutes = 0
  if (record.shift) {
    const shiftStart = shiftMinutesFromMidnight(record.shift.startTime)
    const shiftEnd = shiftMinutesFromMidnight(record.shift.endTime)
    const checkInMinutes = record.checkInAt.getUTCHours() * 60 + record.checkInAt.getUTCMinutes()
    const checkOutMinutes = checkOutAt.getUTCHours() * 60 + checkOutAt.getUTCMinutes()
    lateMinutes = Math.max(0, checkInMinutes - shiftStart)
    earlyDepartureMinutes = Math.max(0, shiftEnd - checkOutMinutes)
    overtimeMinutes = Math.max(0, checkOutMinutes - shiftEnd)
  }

  const updated = await db.attendanceRecord.update({
    where: { id: record.id },
    data: { checkOutAt, workingMinutes, lateMinutes, earlyDepartureMinutes, overtimeMinutes },
  })
  await auditFromSession(session, "update", "attendance_record", record.id, { new: { checkOutAt, workingMinutes } })
  return updated
}

/** HR adjustment (spec.md §50: "maintain adjustment audit trail") — captured by the standing audit_log mechanism, not a bespoke second log table. */
export async function adjustAttendance(session: SessionContext, attendanceRecordId: string, input: AttendanceAdjustInput) {
  assertCan(session, "employee.manage")

  const existing = await db.attendanceRecord.findFirstOrThrow({ where: { id: attendanceRecordId, organizationId: session.user.organizationId } })
  assertBranchAccess(getAuthorizedBranchScope(session), existing.branchId)
  const updated = await db.attendanceRecord.update({
    where: { id: attendanceRecordId },
    data: {
      checkInAt: input.checkInAt ?? null,
      checkOutAt: input.checkOutAt ?? null,
      breakMinutes: input.breakMinutes,
      status: input.status,
      notes: input.notes ?? null,
    },
  })
  await auditFromSession(session, "update", "attendance_record", attendanceRecordId, { old: existing, new: input })
  return updated
}

export async function listAttendance(session: SessionContext, filters: { employeeId?: string; branchId?: string; from?: Date; to?: Date } = {}) {
  assertCan(session, "payroll.view")
  const scope = getAuthorizedBranchScope(session)
  return db.attendanceRecord.findMany({
    where: {
      organizationId: session.user.organizationId,
      employeeId: filters.employeeId,
      branchId: narrowBranchFilter(scope, filters.branchId),
      date: { gte: filters.from, lte: filters.to },
    },
    include: { employee: true, shift: true },
    orderBy: { date: "desc" },
    take: 200,
  })
}
