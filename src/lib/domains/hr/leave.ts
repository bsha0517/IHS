import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, assertBranchAccess } from "@/lib/platform/branch-scope"
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
 * since Phase 2 but never wired until now). The same handler also checks
 * existing appointments against the newly-approved leave window (P1 §25) —
 * see event-handlers.ts.
 *
 * P1 §25: this used to approve unconditionally, with no check against the
 * employee's configured leave entitlement at all — `listLeaveBalances`
 * computes `remainingDays` correctly, but nothing ever called it before
 * approving. `unpaid` leave is exempt by construction (that leave type
 * exists specifically to NOT draw against an allocated-days entitlement —
 * spec.md never asks for an "unpaid leave balance", and there isn't one).
 * For every other leave type, the check only runs when a `LeaveBalance` row
 * exists for that (employee, leaveType, year) — no configured entitlement
 * means nothing to violate, the same "don't invent a limit nobody
 * configured" reasoning `getTaxRate` already applies when no TaxRule
 * exists. `allowOverride: true` is the explicit-authorization escape hatch
 * P1 §25 itself allows ("unless ... an authorized override exists") — any
 * user who can approve leave at all can also check it, the same
 * no-separate-permission precedent Batch 4's goods-receipt over-receiving
 * override already established.
 *
 * "Use transaction-safe validation": `SELECT ... FOR UPDATE` locks the
 * balance row so two concurrent approvals against the same employee's same
 * entitlement can't both read the same stale `usedDays` and both pass —
 * the same discipline Batch 4's `returnDispensingRecord` over-return guard
 * established for an aggregate that isn't a single counter column. The
 * `updateMany` claim below is the separate, standard "claim before acting"
 * guard against double-approving this ONE request (a double-click/retry).
 */
export async function approveLeave(session: SessionContext, leaveRequestId: string, options: { allowOverride?: boolean } = {}) {
  assertCan(session, "leave.approve")

  const request = await db.leaveRequest.findFirstOrThrow({
    where: { id: leaveRequestId, organizationId: session.user.organizationId },
  })
  if (request.status !== "requested") throw new Error(`This leave request is already "${request.status}".`)

  const updated = await db.$transaction(async (tx) => {
    if (request.leaveType !== "unpaid" && !options.allowOverride) {
      const year = request.startDate.getUTCFullYear()
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "leave_balance"
        WHERE employee_id = ${request.employeeId} AND leave_type = ${request.leaveType}::"LeaveType" AND year = ${year}
        FOR UPDATE
      `
      if (locked.length > 0) {
        const balance = await tx.leaveBalance.findUniqueOrThrow({ where: { id: locked[0].id } })
        const approved = await tx.leaveRequest.findMany({
          where: {
            organizationId: session.user.organizationId,
            employeeId: request.employeeId,
            leaveType: request.leaveType,
            status: "approved",
            startDate: { gte: new Date(Date.UTC(year, 0, 1)) },
            endDate: { lte: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)) },
          },
        })
        const usedDays = approved.reduce((sum, r) => sum + r.days, 0)
        const remainingDays = balance.allocatedDays - usedDays
        if (request.days > remainingDays) {
          throw new Error(
            `Approving this would exceed the employee's ${request.leaveType} leave entitlement (${remainingDays} day(s) remaining, ${request.days} requested). Use the override to approve anyway.`
          )
        }
      }
    }

    // "Claim before acting" — guards against this SPECIFIC request being
    // approved twice (double-click/retry), independent of the balance lock
    // above (which guards two DIFFERENT requests racing the same balance).
    const claimed = await tx.leaveRequest.updateMany({
      where: { id: leaveRequestId, status: "requested" },
      data: { status: "approved", decidedBy: session.user.id, decidedAt: new Date() },
    })
    if (claimed.count === 0) {
      throw new Error("This leave request was already decided — refresh and try again.")
    }
    const result = await tx.leaveRequest.findUniqueOrThrow({ where: { id: leaveRequestId } })

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
  }, { timeout: 20_000, maxWait: 10_000 })

  await auditFromSession(session, "update", "leave_request", leaveRequestId, { old: { status: request.status }, new: { status: "approved", allowOverride: options.allowOverride ?? false } })
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
  const scope = getAuthorizedBranchScope(session)
  return db.leaveRequest.findMany({
    where: {
      organizationId: session.user.organizationId,
      employeeId: filters.employeeId,
      status: filters.status as never,
      ...(scope.isOrgWide ? {} : { employee: { branchId: { in: scope.branchIds } } }),
    },
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
  const employee = await db.employee.findFirstOrThrow({ where: { id: employeeId, organizationId: session.user.organizationId } })
  assertBranchAccess(getAuthorizedBranchScope(session), employee.branchId)

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
