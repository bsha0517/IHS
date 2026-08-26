import { z } from "zod"

export const reportFiltersSchema = z.object({
  from: z.date(),
  to: z.date(),
  branchId: z.uuid().optional(),
  providerId: z.uuid().optional(),
})

export type ReportFilters = z.infer<typeof reportFiltersSchema>

export const REPORT_CATEGORIES = ["practice", "clinical", "financial", "revenue-cycle", "inventory", "hr", "assets"] as const
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]

/** Same local-date "YYYY-MM-DDT00:00:00" parsing already used by appointments/page.tsx's date picker — never `new Date(value)` directly, which would reinterpret a date-only param as UTC midnight and shift it a day in a non-UTC server timezone. */
function parseDateParam(value: string | undefined, fallback: Date): Date {
  if (value) {
    const parsed = new Date(`${value}T00:00:00`)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return fallback
}

/** Defaults to the current month-to-date when no filters are supplied — every report page and the CSV export route share this. */
export function defaultReportFilters(searchParams: Record<string, string | undefined>): ReportFilters {
  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  return reportFiltersSchema.parse({
    from: parseDateParam(searchParams.from, startOfMonth),
    to: parseDateParam(searchParams.to, now),
    branchId: searchParams.branchId || undefined,
    providerId: searchParams.providerId || undefined,
  })
}
