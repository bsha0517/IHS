import "server-only"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P4.7 §38/§39 — shared across every report/data-portability export in this
 * codebase. A defensible V1 limit (the spec's own suggested figure): large
 * enough for any realistic single-clinic export (a full year of invoices or
 * GL activity for a busy multi-branch org is still well under this), small
 * enough that one browser request can never be asked to serialize an
 * unbounded result set. Exceeding it is a controlled, explained failure —
 * never a silent truncation to the first N rows.
 */
export const MAX_EXPORT_ROWS = 50_000

export class ExportTooLargeError extends Error {
  readonly rowCount: number
  readonly limit: number
  constructor(rowCount: number, limit: number = MAX_EXPORT_ROWS) {
    super(`This export matches ${rowCount.toLocaleString()} rows, which exceeds the ${limit.toLocaleString()}-row export limit. Narrow the date range or add more filters (branch, status, etc.) and try again.`)
    this.name = "ExportTooLargeError"
    this.rowCount = rowCount
    this.limit = limit
  }
}

/** Throws `ExportTooLargeError` (never silently truncates) if `count` exceeds the export row limit. Call with a real `COUNT(*)`/`.count()` result — never `rows.length` after already fetching an unbounded query, which would defeat the whole point. */
export function assertExportRowLimit(count: number, limit: number = MAX_EXPORT_ROWS): void {
  if (count > limit) throw new ExportTooLargeError(count, limit)
}

/**
 * P4.7 §55 — sensitive/high-value exports (patient master data, clinical
 * data, payroll, the accounting ledger, audit/access-log exports) get one
 * audit_log row per export: actor, organization, export type, timestamp,
 * the filters used, and the row count. Never the exported rows themselves
 * (§55's own explicit "do not log entire exported data") — `filters` here
 * must stay a small, structured summary (dates, branch id, status), not a
 * dump of every row's field values.
 */
export async function logSensitiveExport(
  session: SessionContext,
  exportType: string,
  details: { filters?: Record<string, unknown>; rowCount: number }
): Promise<void> {
  await auditFromSession(session, "export", "report_export", exportType, {
    new: { exportType, filters: details.filters ?? {}, rowCount: details.rowCount },
  })
}
