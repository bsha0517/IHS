import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import { assertExportRowLimit } from "@/lib/platform/reports"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

const SCREEN_PREVIEW_ROWS = 200

const SELECT_FIELDS = {
  id: true,
  mrn: true,
  legacyMrn: true,
  firstName: true,
  middleName: true,
  lastName: true,
  dob: true,
  gender: true,
  mobile: true,
  status: true,
  createdAt: true,
  registrationBranch: { select: { name: true } },
} as const

function whereClause(organizationId: string, branchFilter: string | { in: string[] } | undefined, filters: ReportFilters) {
  return {
    organizationId,
    registrationBranchId: branchFilter,
    createdAt: { gte: filters.from, lte: filters.to },
  }
}

/**
 * P4.7 §9 — Patient Registration Report. Deliberately privacy-conscious per
 * §9's own instruction: no clinical fields, no email/national ID/address in
 * the default row shape (see `getPatientMasterExport` in exports.ts for the
 * fuller, more tightly-gated data-portability shape) — just what a front
 * desk/management view of "who registered, when, at which branch" needs.
 */
export async function getPatientRegistrationReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "patient.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = whereClause(organizationId, branchFilter, filters)

  const [total, byGender, byStatus, preview] = await Promise.all([
    db.patient.count({ where }),
    db.patient.groupBy({ by: ["gender"], where, _count: { _all: true } }),
    db.patient.groupBy({ by: ["status"], where, _count: { _all: true } }),
    db.patient.findMany({ where, select: SELECT_FIELDS, orderBy: { createdAt: "desc" }, take: SCREEN_PREVIEW_ROWS }),
  ])

  return {
    total,
    byGender: byGender.map((g) => ({ gender: g.gender, count: g._count._all })),
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
    preview,
    previewTruncated: total > preview.length,
  }
}

/** The export-side counterpart — same filters/where as the screen report above, but the full matching set (bounded by the shared export row limit) rather than a fixed screen preview. */
export async function exportPatientRegistrationRows(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "patient.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = whereClause(organizationId, branchFilter, filters)

  const total = await db.patient.count({ where })
  assertExportRowLimit(total)
  return db.patient.findMany({ where, select: SELECT_FIELDS, orderBy: { createdAt: "desc" } })
}
