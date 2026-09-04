import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { assertExportRowLimit } from "@/lib/platform/reports"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

const SCREEN_PREVIEW_ROWS = 200

/**
 * P4.7 §29 — Import History Report. `/admin/onboarding` (P4.6) already
 * shows the last 20 ImportJobs inline for day-to-day onboarding use; this
 * is the same data reshaped as a real, filterable, exportable report for
 * management/audit purposes (a longer look-back, not just "the last 20").
 * Gated on the same `data_import.manage` permission P4.6 established — an
 * import job can reference which rows failed (row number/field/code/
 * message only, never source values, per ImportJobError's own schema), so
 * this stays as tightly gated as the onboarding workspace itself, not
 * folded into a broader reports.export-only gate.
 */
export async function getImportHistoryReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "data_import.manage")
  const organizationId = session.user.organizationId
  const where = {
    organizationId,
    branchId: filters.branchId,
    startedAt: { gte: filters.from, lte: filters.to },
  }
  const [total, rows] = await Promise.all([
    db.importJob.count({ where }),
    db.importJob.findMany({
      where,
      include: { startedByUser: { select: { firstName: true, lastName: true } } },
      orderBy: { startedAt: "desc" },
      take: SCREEN_PREVIEW_ROWS,
    }),
  ])
  return { total, rows, truncated: total > rows.length }
}

export async function exportImportHistoryRows(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "data_import.manage")
  const organizationId = session.user.organizationId
  const where = {
    organizationId,
    branchId: filters.branchId,
    startedAt: { gte: filters.from, lte: filters.to },
  }
  const total = await db.importJob.count({ where })
  assertExportRowLimit(total)
  return db.importJob.findMany({
    where,
    include: { startedByUser: { select: { firstName: true, lastName: true } } },
    orderBy: { startedAt: "desc" },
  })
}
