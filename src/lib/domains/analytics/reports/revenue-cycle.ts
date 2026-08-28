import "server-only"
import { db } from "@/lib/db"
import { can, ForbiddenError } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

/**
 * spec.md §65's "Revenue Cycle" report bullets: Charges, Claims, Rejections,
 * Collections, Patient responsibility. Spans both the billing-ops staff who
 * hold invoice.view and the insurance staff who hold claim.create — gated on
 * either rather than inventing a new permission for a category that's really
 * two existing capabilities' data viewed together.
 */
export async function getRevenueCycleReport(session: SessionContext, filters: ReportFilters) {
  if (!can(session, "invoice.view") && !can(session, "claim.create")) {
    throw new ForbiddenError("invoice.view|claim.create")
  }
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const branchWhere = scopedBranchId !== undefined ? { branchId: scopedBranchId } : {}

  const [chargesByStatus, claimsByStatus, rejectedClaims, collections, patientResponsibility] = await Promise.all([
    db.charge.groupBy({ by: ["status"], where: { organizationId, ...branchWhere, createdAt: { gte: filters.from, lte: filters.to } }, _count: { _all: true }, _sum: { amount: true } }),
    db.claim.groupBy({ by: ["status"], where: { organizationId, ...branchWhere, createdAt: { gte: filters.from, lte: filters.to } }, _count: { _all: true }, _sum: { submittedAmount: true } }),
    db.claim.findMany({ where: { organizationId, ...branchWhere, status: "rejected", createdAt: { gte: filters.from, lte: filters.to } }, include: { patient: true, payor: true }, orderBy: { createdAt: "desc" } }),
    db.payment.aggregate({ where: { organizationId, ...branchWhere, status: "completed", receivedAt: { gte: filters.from, lte: filters.to } }, _sum: { amount: true } }),
    db.invoice.aggregate({
      where: { organizationId, ...branchWhere, issuedAt: { gte: filters.from, lte: filters.to }, status: { not: "void" } },
      _sum: { estimatedPatientResponsibility: true, finalPatientResponsibility: true },
    }),
  ])

  return {
    chargesByStatus: chargesByStatus.map((c) => ({ status: c.status, count: c._count._all, amount: Number(c._sum.amount ?? 0) })),
    claimsByStatus: claimsByStatus.map((c) => ({ status: c.status, count: c._count._all, amount: Number(c._sum.submittedAmount ?? 0) })),
    rejectedClaims,
    rejectedAmount: rejectedClaims.reduce((sum, c) => sum + Number(c.rejectedAmount ?? c.submittedAmount ?? 0), 0),
    collections: Number(collections._sum.amount ?? 0),
    estimatedPatientResponsibility: Number(patientResponsibility._sum.estimatedPatientResponsibility ?? 0),
    finalPatientResponsibility: Number(patientResponsibility._sum.finalPatientResponsibility ?? 0),
  }
}
