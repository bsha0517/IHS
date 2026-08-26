import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

/** spec.md §65's "Clinical" report bullets: Encounters, Diagnosis trends, Procedures, Orders, Follow-ups. */
export async function getClinicalReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "encounter.view")
  const organizationId = session.user.organizationId
  const encounterWhere = {
    organizationId,
    startAt: { gte: filters.from, lte: filters.to },
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
    ...(filters.providerId ? { providerId: filters.providerId } : {}),
  }

  const [encountersByStatus, encountersByType, diagnoses, ordersByTypeAndStatus, followUpsByStatus] = await Promise.all([
    db.encounter.groupBy({ by: ["status"], where: encounterWhere, _count: { _all: true } }),
    db.encounter.groupBy({ by: ["encounterType"], where: encounterWhere, _count: { _all: true } }),
    db.diagnosis.findMany({
      where: { organizationId, diagnosedAt: { gte: filters.from, lte: filters.to }, encounter: filters.branchId || filters.providerId ? encounterWhere : undefined },
      select: { description: true, diagnosisCode: true },
    }),
    db.clinicalOrder.groupBy({
      by: ["orderType", "status"],
      where: { organizationId, orderedAt: { gte: filters.from, lte: filters.to }, ...(filters.branchId ? { branchId: filters.branchId } : {}), ...(filters.providerId ? { orderingProviderId: filters.providerId } : {}) },
      _count: { _all: true },
    }),
    db.followUpRecommendation.groupBy({
      by: ["status"],
      where: { organizationId, recommendedDate: { gte: filters.from, lte: filters.to }, encounter: filters.branchId || filters.providerId ? encounterWhere : undefined },
      _count: { _all: true },
    }),
  ])

  const diagnosisTrend = new Map<string, number>()
  for (const d of diagnoses) {
    const key = d.diagnosisCode ? `${d.diagnosisCode} — ${d.description}` : d.description
    diagnosisTrend.set(key, (diagnosisTrend.get(key) ?? 0) + 1)
  }
  const diagnosisTrends = [...diagnosisTrend.entries()]
    .map(([diagnosis, count]) => ({ diagnosis, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)

  const ordersByType = new Map<string, number>()
  for (const row of ordersByTypeAndStatus) ordersByType.set(row.orderType, (ordersByType.get(row.orderType) ?? 0) + row._count._all)

  return {
    totalEncounters: encountersByStatus.reduce((sum, s) => sum + s._count._all, 0),
    encountersByStatus: encountersByStatus.map((s) => ({ status: s.status, count: s._count._all })),
    encountersByType: encountersByType.map((t) => ({ type: t.encounterType, count: t._count._all })),
    diagnosisTrends,
    ordersByType: [...ordersByType.entries()].map(([orderType, count]) => ({ orderType, count })),
    procedureOrdersByStatus: ordersByTypeAndStatus.filter((r) => r.orderType === "procedure").map((r) => ({ status: r.status, count: r._count._all })),
    followUpsByStatus: followUpsByStatus.map((f) => ({ status: f.status, count: f._count._all })),
  }
}
