import { NextResponse, type NextRequest } from "next/server"
import { getCurrentSession } from "@/lib/auth/session"
import { assertCan, can } from "@/lib/platform/permissions-core"
import { toCsv } from "@/lib/domains/analytics/csv"
import { toDateParam } from "@/lib/utils/dates"
import { defaultReportFilters, REPORT_CATEGORIES, type ReportCategory } from "@/lib/domains/analytics/schemas"
import {
  canViewReportCategory,
  getPracticeReport,
  getClinicalReport,
  getFinancialReport,
  getRevenueCycleReport,
  getInventoryReport,
  getHrReport,
  getAssetsReport,
} from "@/lib/domains/analytics/reports"

/**
 * The first real /api/* Route Handler in this codebase (API.md's Status
 * paragraph named this as speculative until a real need for it showed up).
 * A file download needs correct Content-Disposition/Content-Type headers and
 * a browser-navigable URL — a Server Action can't produce either cleanly, so
 * this is a genuine, motivated first use of the Route Handler layer rather
 * than reaching for it out of habit.
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in required." } }, { status: 401 })
  }

  const searchParams = request.nextUrl.searchParams
  const category = searchParams.get("category") as ReportCategory | null
  if (!category || !REPORT_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: { code: "invalid_category", message: "Unknown report category." } }, { status: 400 })
  }

  if (!can(session, "reports.export") || !canViewReportCategory(session, category)) {
    return NextResponse.json({ error: { code: "forbidden", message: "Missing permission to export this report." } }, { status: 403 })
  }
  assertCan(session, "reports.export")

  const filters = defaultReportFilters({
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    branchId: searchParams.get("branchId") ?? undefined,
    providerId: searchParams.get("providerId") ?? undefined,
  })

  const csv = await buildCsv(session, category, filters)
  const filename = `${category}-report-${toDateParam(filters.from)}-to-${toDateParam(filters.to)}.csv`

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}

async function buildCsv(session: Awaited<ReturnType<typeof getCurrentSession>>, category: ReportCategory, filters: ReturnType<typeof defaultReportFilters>) {
  if (!session) throw new Error("unreachable")

  switch (category) {
    case "practice": {
      const report = await getPracticeReport(session, filters)
      return toCsv(
        ["Provider", "Appointments", "Booked Minutes", "Available Minutes", "Utilization %"],
        report.providerUtilization.map((p) => [p.providerName, p.appointmentCount, p.bookedMinutes, p.availableMinutes, p.utilizationPercent ?? ""])
      )
    }
    case "clinical": {
      const report = await getClinicalReport(session, filters)
      return toCsv(["Diagnosis", "Count"], report.diagnosisTrends.map((d) => [d.diagnosis, d.count]))
    }
    case "financial": {
      const report = await getFinancialReport(session, filters)
      const rows = [
        ...report.incomeStatement.revenueLines.map((l) => ["Revenue", l.code, l.name, l.amount]),
        ...report.incomeStatement.expenseLines.map((l) => ["Expense", l.code, l.name, l.amount]),
      ]
      return toCsv(["Type", "Code", "Name", "Amount"], rows)
    }
    case "revenue-cycle": {
      const report = await getRevenueCycleReport(session, filters)
      return toCsv(
        ["Claim Number", "Patient", "Payor", "Submitted Amount", "Rejected Amount", "Rejection Reason"],
        report.rejectedClaims.map((c) => [c.claimNumber, `${c.patient.firstName} ${c.patient.lastName}`, c.payor.name, Number(c.submittedAmount), Number(c.rejectedAmount ?? 0), c.rejectionReason ?? ""])
      )
    }
    case "inventory": {
      const report = await getInventoryReport(session, filters)
      return toCsv(
        ["Product", "Category", "Balance", "Reorder Level", "Low Stock"],
        report.stockSummary.map((p) => [p.name, p.category, p.balance, p.reorderLevel, p.isLowStock ? "Yes" : "No"])
      )
    }
    case "hr": {
      const report = await getHrReport(session, filters)
      return toCsv(
        ["Period Start", "Period End", "Status", "Employees", "Net Total"],
        report.payrollRuns.map((r) => [toDateParam(r.periodStart), toDateParam(r.periodEnd), r.status, r.employeeCount, r.netTotal])
      )
    }
    case "assets": {
      const report = await getAssetsReport(session, filters)
      return toCsv(
        ["Asset Number", "Name", "Category", "Branch", "Status", "Cost"],
        report.register.map((a) => [a.assetNumber, a.name, a.category, a.branch.name, a.status, a.cost ? Number(a.cost) : ""])
      )
    }
  }
}
