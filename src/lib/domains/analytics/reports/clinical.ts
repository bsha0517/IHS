import "server-only"
import { db } from "@/lib/db"
import { assertCan, can, ForbiddenError } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

/** spec.md §65's "Clinical" report bullets: Encounters, Diagnosis trends, Procedures, Orders, Follow-ups. */
export async function getClinicalReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "encounter.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const encounterWhere = {
    organizationId,
    startAt: { gte: filters.from, lte: filters.to },
    ...(scopedBranchId !== undefined ? { branchId: scopedBranchId } : {}),
    ...(filters.providerId ? { providerId: filters.providerId } : {}),
  }
  const encounterFilterActive = scopedBranchId !== undefined || !!filters.providerId

  const [encountersByStatus, encountersByType, diagnoses, ordersByTypeAndStatus, followUpsByStatus, prescriptionsCount, labVerified, imagingVerified] = await Promise.all([
    db.encounter.groupBy({ by: ["status"], where: encounterWhere, _count: { _all: true } }),
    db.encounter.groupBy({ by: ["encounterType"], where: encounterWhere, _count: { _all: true } }),
    db.diagnosis.findMany({
      where: { organizationId, diagnosedAt: { gte: filters.from, lte: filters.to }, encounter: encounterFilterActive ? encounterWhere : undefined },
      select: { description: true, diagnosisCode: true },
    }),
    db.clinicalOrder.groupBy({
      by: ["orderType", "status"],
      where: { organizationId, orderedAt: { gte: filters.from, lte: filters.to }, ...(scopedBranchId !== undefined ? { branchId: scopedBranchId } : {}), ...(filters.providerId ? { orderingProviderId: filters.providerId } : {}) },
      _count: { _all: true },
    }),
    db.followUpRecommendation.groupBy({
      by: ["status"],
      where: { organizationId, recommendedDate: { gte: filters.from, lte: filters.to }, encounter: encounterFilterActive ? encounterWhere : undefined },
      _count: { _all: true },
    }),
    // P4.7 §12 — "prescriptions count" per §12's own bullet list.
    db.prescription.count({
      where: { organizationId, issuedAt: { gte: filters.from, lte: filters.to }, ...(filters.providerId ? { providerId: filters.providerId } : {}), encounter: encounterFilterActive ? encounterWhere : undefined },
    }),
    // P4.7 §13/§14 — lab/imaging "results verified" counts, folded into the
    // Clinical Operations report as small cross-references rather than a
    // fully separate report each: see getLabReport/getRadiologyReport below
    // for the fuller per-order-type breakdowns §13/§14 actually ask for.
    db.labOrderTest.count({
      where: { organizationId, isCurrent: true, status: "verified", verifiedAt: { gte: filters.from, lte: filters.to }, clinicalOrder: scopedBranchId !== undefined ? { branchId: scopedBranchId } : undefined },
    }),
    db.imagingOrder.count({
      where: { organizationId, status: "verified", verifiedAt: { gte: filters.from, lte: filters.to }, clinicalOrder: scopedBranchId !== undefined ? { branchId: scopedBranchId } : undefined },
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
    prescriptionsCount,
    labResultsVerified: labVerified,
    imagingReportsVerified: imagingVerified,
  }
}

/**
 * P4.7 §13 — Lab Reporting. Turnaround time is defined explicitly (per
 * §13's own "if timestamps permit, define TAT explicitly" instruction) as
 * `enteredAt - order.orderedAt` (order-to-result) and
 * `verifiedAt - enteredAt` (result-to-verification) — both real, reliable
 * LabOrderTest/ClinicalOrder timestamps already written by the actual
 * result-entry/verification workflow (laboratory/results.ts), not a
 * fabricated stage. Only verified (isCurrent) lines with both timestamps
 * present contribute to the TAT averages; a line still pending doesn't
 * pull the average toward zero.
 */
export async function getLabReport(session: SessionContext, filters: ReportFilters) {
  // Both the clinical-oversight audience (encounter.view: Doctor, Nurse,
  // Clinic Manager) and the lab's own operational role (Laboratory
  // Technician, who never holds encounter.view — seed.ts) can see this;
  // same "gate on either of two existing capabilities" pattern
  // getRevenueCycleReport already uses for invoice.view|claim.create.
  if (!can(session, "encounter.view") && !can(session, "lab_result.verify") && !can(session, "lab_result.enter")) {
    throw new ForbiddenError("encounter.view|lab_result.verify")
  }
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const clinicalOrderWhere = scopedBranchId !== undefined ? { branchId: scopedBranchId } : undefined

  const [byStatus, verifiedLines] = await Promise.all([
    db.labOrderTest.groupBy({
      by: ["status"],
      where: { organizationId, isCurrent: true, createdAt: { gte: filters.from, lte: filters.to }, clinicalOrder: clinicalOrderWhere },
      _count: { _all: true },
    }),
    db.labOrderTest.findMany({
      where: { organizationId, isCurrent: true, status: "verified", verifiedAt: { gte: filters.from, lte: filters.to }, clinicalOrder: clinicalOrderWhere },
      select: { enteredAt: true, verifiedAt: true, clinicalOrder: { select: { orderedAt: true } } },
    }),
  ])

  const orderToResultMinutes: number[] = []
  const resultToVerifyMinutes: number[] = []
  for (const line of verifiedLines) {
    if (line.enteredAt) orderToResultMinutes.push((line.enteredAt.getTime() - line.clinicalOrder.orderedAt.getTime()) / 60000)
    if (line.enteredAt && line.verifiedAt) resultToVerifyMinutes.push((line.verifiedAt.getTime() - line.enteredAt.getTime()) / 60000)
  }
  const avg = (arr: number[]) => (arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null)

  return {
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
    verifiedCount: verifiedLines.length,
    avgOrderToResultMinutes: avg(orderToResultMinutes),
    avgResultToVerifyMinutes: avg(resultToVerifyMinutes),
  }
}

/** P4.7 §14 — Radiology Reporting, the same shape as Lab above (orders by status; report/verify TAT where timestamps allow). Report-amendment history is deliberately excluded (§14's own "does not need management-report detail unless clinically authorized"). */
export async function getRadiologyReport(session: SessionContext, filters: ReportFilters) {
  if (!can(session, "encounter.view") && !can(session, "imaging_result.verify") && !can(session, "imaging_order.perform")) {
    throw new ForbiddenError("encounter.view|imaging_result.verify")
  }
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const clinicalOrderWhere = scopedBranchId !== undefined ? { branchId: scopedBranchId } : undefined

  const [byStatus, verifiedOrders] = await Promise.all([
    db.imagingOrder.groupBy({
      by: ["status"],
      where: { organizationId, createdAt: { gte: filters.from, lte: filters.to }, clinicalOrder: clinicalOrderWhere },
      _count: { _all: true },
    }),
    db.imagingOrder.findMany({
      where: { organizationId, status: "verified", verifiedAt: { gte: filters.from, lte: filters.to }, clinicalOrder: clinicalOrderWhere },
      select: { performedAt: true, reportedAt: true, verifiedAt: true, clinicalOrder: { select: { orderedAt: true } } },
    }),
  ])

  const orderToPerformMinutes: number[] = []
  const performToReportMinutes: number[] = []
  for (const order of verifiedOrders) {
    if (order.performedAt) orderToPerformMinutes.push((order.performedAt.getTime() - order.clinicalOrder.orderedAt.getTime()) / 60000)
    if (order.performedAt && order.reportedAt) performToReportMinutes.push((order.reportedAt.getTime() - order.performedAt.getTime()) / 60000)
  }
  const avg = (arr: number[]) => (arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null)

  return {
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
    verifiedCount: verifiedOrders.length,
    avgOrderToPerformMinutes: avg(orderToPerformMinutes),
    avgPerformToReportMinutes: avg(performToReportMinutes),
  }
}
