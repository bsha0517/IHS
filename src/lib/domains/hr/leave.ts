import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"
import type { LeaveRequestInput, LeaveBalanceInput } from "@/lib/domains/hr/schemas"

function daysBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
}

/** Employee -> Request -> Manager Approval -> HR (spec.md §51). */
export async function requestLeave(session: SessionContext, input: LeaveRequestInput) {
  assertCan(session, "leave.request")
  if (input.endDate < input.startDate) throw new Error("End date cannot be before the start date.")

  const days = daysBetween(input.startDate, input.endDate)
  const created = await db.leaveRequest.create({
    data: {
      organizationId: session.user.organizationId,
      employeeId: input.employeeId,
      leaveType: input.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      days,
      reason: input.reason ?? null,
    },
  })
  await auditFromSession(session, "create", "leave_request", created.id, {
    new: { employeeId: input.employeeId, leaveType: input.leaveType, days },
  })
  return created
}

/**
 * Approval creates a matching ProviderLeaveBlock when the employee is linked
 * to a Provider — "doctor leave must affect scheduling" (spec.md §51) is not
 * optional. Fired via the same outbox pattern as every other cross-domain
 * trigger (EmployeeLeaveApproved, reserved in ARCHITECTURE.md's event table
 * since Phase 2 but never wired until now).
 */
export async function approveLeave(session: SessionContext, leaveRequestId: string) {
  assertCan(session, "leave.approve")

  const request = await db.leaveRequest.findFirstOrThrow({
    where: { id: leaveRequestId, organizationId: session.user.organizationId },
  })
  if (request.status !== "requested") throw new Error(`This leave request is already "${request.status}".`)

  const updated = await db.$transaction(async (tx) => {
    const result = await tx.leaveRequest.update({
      where: { id: leaveRequestId },
      data: { status: "approved", decidedBy: session.user.id, decidedAt: new Date() },
    })
    await tx.employee.update({ where: { id: request.employeeId }, data: { status: "on_leave" } })
    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "EmployeeLeaveApproved",
      payload: {
        leaveRequestId: result.id,
        employeeId: request.employeeId,
        startDate: request.startDate.toISOString(),
        endDate: request.endDate.toISOString(),
        reason: request.reason,
      },
    })
    return result
  })

  await auditFromSession(session, "update", "leave_request", leaveRequestId, { old: { status: request.status }, new: { status: "approved" } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}

export async function rejectLeave(session: SessionContext, leaveRequestId: string, reason: string) {
  assertCan(session, "leave.approve")

  const request = await db.leaveRequest.findFirstOrThrow({ where: { id: leaveRequestId, organizationId: session.user.organizationId } })
  if (request.status !== "requested") throw new Error(`This leave request is already "${request.status}".`)

  const updated = await db.leaveRequest.update({
    where: { id: leaveRequestId },
    data: { status: "rejected", decidedBy: session.user.id, decidedAt: new Date(), rejectionReason: reason },
  })
  await auditFromSession(session, "update", "leave_request", leaveRequestId, { old: { status: request.status }, new: { status: "rejected", reason } })
  return updated
}

export async function listLeaveRequests(session: SessionContext, filters: { employeeId?: string; status?: string } = {}) {
  assertCan(session, "payroll.view")
  return db.leaveRequest.findMany({
    where: { organizationId: session.user.organizationId, employeeId: filters.employeeId, status: filters.status as never },
    include: { employee: true },
    orderBy: { requestedAt: "desc" },
    take: 200,
  })
}

export async function setLeaveBalance(session: SessionContext, input: LeaveBalanceInput) {
  assertCan(session, "employee.manage")

  const existing = await db.leaveBalance.findUnique({
    where: { employeeId_leaveType_year: { employeeId: input.employeeId, leaveType: input.leaveType, year: input.year } },
  })
  const result = existing
    ? await db.leaveBalance.update({ where: { id: existing.id }, data: { allocatedDays: input.allocatedDays } })
    : await db.leaveBalance.create({
        data: {
          organizationId: session.user.organizationId,
          employeeId: input.employeeId,
          leaveType: input.leaveType,
          year: input.year,
          allocatedDays: input.allocatedDays,
        },
      })
  await auditFromSession(session, existing ? "update" : "create", "leave_balance", result.id, { new: input })
  return result
}

/** usedDays is always derived from approved LeaveRequest.days, never a stored running balance (same discipline as every ledger since Phase 5). */
export async function listLeaveBalances(session: SessionContext, employeeId: string, year: number) {
  assertCan(session, "payroll.view")

  const [balances, approvedRequests] = await Promise.all([
    db.leaveBalance.findMany({ where: { organizationId: session.user.organizationId, employeeId, year } }),
    db.leaveRequest.findMany({
      where: { organizationId: session.user.organizationId, employeeId, status: "approved", startDate: { gte: new Date(`${year}-01-01`) }, endDate: { lte: new Date(`${year}-12-31`) } },
    }),
  ])

  return balances.map((b) => {
    const usedDays = approvedRequests.filter((r) => r.leaveType === b.leaveType).reduce((sum, r) => sum + r.days, 0)
    return { ...b, usedDays, remainingDays: b.allocatedDays - usedDays }
  })
}
