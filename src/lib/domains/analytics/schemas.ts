import { z } from "zod"
import { endOfLocalDay } from "@/lib/utils/dates"

export const reportFiltersSchema = z.object({
  from: z.date(),
  to: z.date(),
  branchId: z.uuid().optional(),
  providerId: z.uuid().optional(),
})

export type ReportFilters = z.infer<typeof reportFiltersSchema>

// P4.7: "daily-ops", "patients", "lab", "radiology", and "import-history"
// are new this phase (§8/§9/§13/§14/§29) — added to the existing seven
// rather than a parallel category system, so the same Reports workspace,
// filter form, and /api/reports/export route serve all twelve.
export const REPORT_CATEGORIES = ["practice", "clinical", "financial", "revenue-cycle", "inventory", "hr", "assets", "daily-ops", "patients", "lab", "radiology", "import-history"] as const
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]

/** Same local-date "YYYY-MM-DDT00:00:00" parsing already used by appointments/page.tsx's date picker — never `new Date(value)` directly, which would reinterpret a date-only param as UTC midnight and shift it a day in a non-UTC server timezone. */
function parseDateParam(value: string | undefined, fallback: Date): Date {
  if (value) {
    const parsed = new Date(`${value}T00:00:00`)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return fallback
}

/**
 * P4.7 §45 — the report-wide "Date Range Rule": `from` is the inclusive
 * *beginning* of the selected local date (handled by `parseDateParam`
 * above, unchanged); `to` must be the inclusive *end* of the selected local
 * date, not its beginning. Every report/export in this codebase filters
 * with `{ gte: filters.from, lte: filters.to }`, so before this fix an
 * explicit `?to=2026-09-30` resolved to `2026-09-30T00:00:00` — midnight at
 * the *start* of that day — which silently excluded virtually all of that
 * day's real activity from every report and its export (a user who set
 * "From Sept 1 To Sept 30" got a report that actually stopped just after
 * midnight on Sept 1). Constructed from local Date components (year/month/
 * day, all read from the already-local-midnight `parseDateParam` result),
 * matching the same local-wall-clock-arithmetic discipline `dashboards.ts`'s
 * `todayRange()` and `kpis.ts`'s month ranges already use — never a raw
 * millisecond offset, which could double-count or skip an hour across a DST
 * transition. (`endOfLocalDay` itself now lives in `@/lib/utils/dates` —
 * the one shared implementation every report/export date boundary uses.)
 */

/** Defaults to the current month-to-date when no filters are supplied — every report page and the CSV export route share this. */
export function defaultReportFilters(searchParams: Record<string, string | undefined>): ReportFilters {
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const to = searchParams.to ? endOfLocalDay(parseDateParam(searchParams.to, now)) : now
  return reportFiltersSchema.parse({
    from: parseDateParam(searchParams.from, startOfMonth),
    to,
    branchId: searchParams.branchId || undefined,
    providerId: searchParams.providerId || undefined,
  })
}
