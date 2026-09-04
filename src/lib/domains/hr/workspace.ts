import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P3.10 §45: the HR landing view spec.md asks for — "active employees,
 * today's attendance, pending leave requests, payroll status/current
 * period, upcoming leave" — using only bulk/aggregate queries (§53), never
 * one query per employee. Deliberately separate from
 * analytics/reports/hr.ts's `getHrReport`, which is a date-ranged,
 * `reports.export`-gated analytics report (spec.md §65) — this is a small,
 * fixed, operational "what needs my attention right now" summary, gated on
 * the same `payroll.view` every other HR operational page already uses.
 */
export async function getHrWorkspaceSummary(session: SessionContext) {
  assertCan(session, "payroll.view")
  const scope = getAuthorizedBranchScope(session)
  const organizationId = session.user.organizationId
  const branchFilter = narrowBranchFilter(scope)

  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const in7Days = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)

  const pendingLeaveWhere = { organizationId, status: "requested" as const, ...(scope.isOrgWide ? {} : { employee: { branchId: { in: scope.branchIds } } }) }

  const [activeEmployeeCount, checkedInToday, pendingLeaveCount, pendingLeave, upcomingLeave, latestPayrollRun] = await Promise.all([
    db.employee.count({ where: { organizationId, branchId: branchFilter, status: "active" } }),
    // §15/§45: genuinely "checked in" — `checkInAt` actually set, not just
    // "an attendance record exists for today" (a record can exist with no
    // check-in at all, e.g. a manual `absent`/`holiday` adjustment via
    // adjustAttendance — counting those as "checked in" would be wrong).
    db.attendanceRecord.count({ where: { organizationId, branchId: branchFilter, date: today, checkInAt: { not: null } } }),
    db.leaveRequest.count({ where: pendingLeaveWhere }),
    db.leaveRequest.findMany({
      where: pendingLeaveWhere,
      include: { employee: true },
      orderBy: { requestedAt: "asc" },
      take: 5,
    }),
    db.leaveRequest.findMany({
      where: {
        organizationId,
        status: "approved",
        startDate: { gte: today, lte: in7Days },
        ...(scope.isOrgWide ? {} : { employee: { branchId: { in: scope.branchIds } } }),
      },
      include: { employee: true },
      orderBy: { startDate: "asc" },
      take: 5,
    }),
    db.payrollRun.findFirst({
      where: { organizationId, branchId: branchFilter },
      include: { branch: true },
      orderBy: { createdAt: "desc" },
    }),
  ])

  return {
    activeEmployeeCount,
    checkedInToday,
    // §25: deliberately NOT an "on leave today" count — nothing in this
    // codebase auto-creates an attendance row when leave is approved (see
    // this file's own doc comment and BACKLOG.md), so any such count would
    // almost always read as zero even on a day someone genuinely is on
    // approved leave. `notCheckedInToday` only claims what's actually
    // knowable: how many currently-active employees have no check-in yet.
    notCheckedInToday: Math.max(0, activeEmployeeCount - checkedInToday),
    pendingLeave: { count: pendingLeaveCount, items: pendingLeave },
    upcomingLeave,
    latestPayrollRun,
  }
}
