import "server-only"
import { db } from "@/lib/db"
import { assertCan, can } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

/** spec.md §65's "HR" report bullets: Attendance, Leave, Payroll, Commission. */
export async function getHrReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "payroll.view")
  const organizationId = session.user.organizationId
  const branchWhere = filters.branchId ? { branchId: filters.branchId } : {}

  const [attendanceByStatus, leaveByStatus, leaveByType, payrollRuns, commissionByProvider] = await Promise.all([
    db.attendanceRecord.groupBy({ by: ["status"], where: { organizationId, ...branchWhere, date: { gte: filters.from, lte: filters.to } }, _count: { _all: true } }),
    db.leaveRequest.groupBy({ by: ["status"], where: { organizationId, requestedAt: { gte: filters.from, lte: filters.to } }, _count: { _all: true } }),
    db.leaveRequest.groupBy({ by: ["leaveType"], where: { organizationId, requestedAt: { gte: filters.from, lte: filters.to } }, _count: { _all: true } }),
    db.payrollRun.findMany({
      where: { organizationId, ...branchWhere, periodStart: { gte: filters.from }, periodEnd: { lte: filters.to } },
      include: { lines: true },
      orderBy: { periodStart: "desc" },
    }),
    can(session, "commission.view")
      ? db.commissionAccrual.groupBy({ by: ["providerId"], where: { organizationId, ...branchWhere, accruedAt: { gte: filters.from, lte: filters.to } }, _sum: { amount: true } })
      : Promise.resolve(null),
  ])

  const payrollTotals = payrollRuns.map((run) => ({
    id: run.id,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    status: run.status,
    netTotal: run.lines.reduce((sum, l) => sum + Number(l.netSalary), 0),
    employeeCount: run.lines.length,
  }))

  let commission: { providerId: string; providerName: string; amount: number }[] | null = null
  if (commissionByProvider) {
    const providers = await db.provider.findMany({ where: { id: { in: commissionByProvider.map((c) => c.providerId) } } })
    commission = commissionByProvider.map((c) => {
      const provider = providers.find((p) => p.id === c.providerId)
      return { providerId: c.providerId, providerName: provider ? `${provider.firstName} ${provider.lastName}` : "Unknown", amount: Number(c._sum.amount ?? 0) }
    })
  }

  return {
    attendanceByStatus: attendanceByStatus.map((a) => ({ status: a.status, count: a._count._all })),
    leaveByStatus: leaveByStatus.map((l) => ({ status: l.status, count: l._count._all })),
    leaveByType: leaveByType.map((l) => ({ type: l.leaveType, count: l._count._all })),
    payrollRuns: payrollTotals,
    commission,
  }
}
