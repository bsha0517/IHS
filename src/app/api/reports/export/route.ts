import { NextResponse, type NextRequest } from "next/server"
import { getCurrentSession } from "@/lib/auth/session"
import { assertCan, can } from "@/lib/platform/permissions-core"
import { toCsv } from "@/lib/platform/csv"
import { assertExportRowLimit, ExportTooLargeError, logSensitiveExport } from "@/lib/platform/reports"
import { toDateParam } from "@/lib/utils/dates"
import { defaultReportFilters, REPORT_CATEGORIES, type ReportCategory } from "@/lib/domains/analytics/schemas"
import {
  canViewReportCategory,
  getClinicalReport,
  getLabReport,
  getRadiologyReport,
  getFinancialReport,
  getInventoryReport,
  getHrReport,
  getAssetsReport,
  getDailyOperationsReport,
} from "@/lib/domains/analytics/reports"
import { exportAppointmentRows } from "@/lib/domains/analytics/reports/practice"
import { exportInvoiceRows } from "@/lib/domains/analytics/reports/revenue-cycle"
import { exportPatientRegistrationRows } from "@/lib/domains/analytics/reports/patients"
import { exportImportHistoryRows } from "@/lib/domains/analytics/reports/import-history"

/**
 * The first real /api/* Route Handler in this codebase (API.md's Status
 * paragraph named this as speculative until a real need for it showed up).
 * A file download needs correct Content-Disposition/Content-Type headers and
 * a browser-navigable URL — a Server Action can't produce either cleanly, so
 * this is a genuine, motivated first use of the Route Handler layer rather
 * than reaching for it out of habit.
 *
 * P4.7 §25/§52 — every failure path below returns a clean, safe JSON error
 * (never a raw Prisma error, stack trace, or SQL) — including the one new
 * failure mode this phase adds, `ExportTooLargeError` (§39: a controlled,
 * explained refusal, never a silent truncation to the row limit).
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

  try {
    const csv = await buildCsv(session, category, filters)
    const filename = `${category}-report-${toDateParam(filters.from)}-to-${toDateParam(filters.to)}.csv`

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // P4.3 §58: financial/clinical CSV export — must never be cached by a
        // shared/public cache.
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    if (error instanceof ExportTooLargeError) {
      return NextResponse.json({ error: { code: "export_too_large", message: error.message } }, { status: 413 })
    }
    throw error // let the global error boundary render a safe, generic failure — never leak this error's own message/stack to the response
  }
}

async function buildCsv(session: Awaited<ReturnType<typeof getCurrentSession>>, category: ReportCategory, filters: ReturnType<typeof defaultReportFilters>) {
  if (!session) throw new Error("unreachable")

  let csv: string
  let rowCount = 0

  switch (category) {
    case "practice": {
      const rows = await exportAppointmentRows(session, filters)
      rowCount = rows.length
      csv = toCsv(
        ["Date/Time", "Patient", "MRN", "Provider", "Service", "Branch", "Status", "Source"],
        rows.map((a) => [a.startTime, a.patientName, a.patientMrn, a.providerName, a.serviceName, a.branchName, a.status, a.bookingSource]),
        { bom: true }
      )
      break
    }
    case "clinical": {
      const report = await getClinicalReport(session, filters)
      rowCount = report.diagnosisTrends.length
      csv = toCsv(["Diagnosis", "Count"], report.diagnosisTrends.map((d) => [d.diagnosis, d.count]), { bom: true })
      break
    }
    case "lab": {
      const report = await getLabReport(session, filters)
      rowCount = report.byStatus.length
      csv = toCsv(["Status", "Count"], report.byStatus.map((s) => [s.status, s.count]), { bom: true })
      break
    }
    case "radiology": {
      const report = await getRadiologyReport(session, filters)
      rowCount = report.byStatus.length
      csv = toCsv(["Status", "Count"], report.byStatus.map((s) => [s.status, s.count]), { bom: true })
      break
    }
    case "financial": {
      const report = await getFinancialReport(session, filters)
      rowCount = report.incomeStatement.revenueLines.length + report.incomeStatement.expenseLines.length
      const rows = [
        ...report.incomeStatement.revenueLines.map((l) => ["Revenue", l.code, l.name, l.amount]),
        ...report.incomeStatement.expenseLines.map((l) => ["Expense", l.code, l.name, l.amount]),
      ]
      csv = toCsv(["Type", "Code", "Name", "Amount"], rows, { bom: true })
      await logSensitiveExport(session, "financial-report", { filters: exportFilterSummary(filters), rowCount })
      break
    }
    case "revenue-cycle": {
      const rows = await exportInvoiceRows(session, filters)
      rowCount = rows.length
      csv = toCsv(
        ["Invoice #", "Patient", "MRN", "Branch", "Date", "Gross", "Discount", "Tax", "Net", "Paid", "Outstanding", "Status"],
        rows.map((inv) => [
          inv.invoiceNumber, `${inv.patient.firstName} ${inv.patient.lastName}`, inv.patient.mrn, inv.branch.name, inv.issuedAt,
          Number(inv.subtotal), Number(inv.discountAmount), Number(inv.taxAmount), Number(inv.totalAmount), Number(inv.paidAmount),
          Number(inv.totalAmount) - Number(inv.paidAmount), inv.status,
        ]),
        { bom: true }
      )
      break
    }
    case "inventory": {
      const report = await getInventoryReport(session, filters)
      rowCount = report.stockSummary.length
      csv = toCsv(
        ["Product", "Category", "Balance", "Reorder Level", "Low Stock", "Unit Cost", "Value"],
        report.stockSummary.map((p) => {
          const v = report.valuation.find((x) => x.productId === p.id)
          return [p.name, p.category, p.balance, p.reorderLevel, p.isLowStock ? "Yes" : "No", v?.unitCost.toFixed(2) ?? "", v?.value.toFixed(2) ?? ""]
        }),
        { bom: true }
      )
      break
    }
    case "hr": {
      const report = await getHrReport(session, filters)
      rowCount = report.payrollRuns.length
      csv = toCsv(
        ["Period Start", "Period End", "Status", "Employees", "Net Total"],
        report.payrollRuns.map((r) => [toDateParam(r.periodStart), toDateParam(r.periodEnd), r.status, r.employeeCount, r.netTotal]),
        { bom: true }
      )
      await logSensitiveExport(session, "hr-payroll-report", { filters: exportFilterSummary(filters), rowCount })
      break
    }
    case "assets": {
      const report = await getAssetsReport(session, filters)
      rowCount = report.register.length
      csv = toCsv(
        ["Asset Number", "Name", "Category", "Branch", "Status", "Cost"],
        report.register.map((a) => [a.assetNumber, a.name, a.category, a.branch.name, a.status, a.cost ? Number(a.cost) : ""]),
        { bom: true }
      )
      break
    }
    case "daily-ops": {
      const report = await getDailyOperationsReport(session, { date: filters.to, branchId: filters.branchId })
      rowCount = 1
      csv = toCsv(
        ["Date", "Appointments Scheduled", "Checked In", "Completed", "Cancelled", "No-shows", "Walk-ins", "Encounters Completed", "Invoices Raised", "Invoiced Amount", "Payments Collected", "Collected Amount", "Refunds Issued", "Refunded Amount", "Pharmacy Dispenses", "Lab Orders", "Lab Verified", "Imaging Orders", "Imaging Verified"],
        [[
          report.date, report.appointments.scheduled, report.appointments.checkedIn, report.appointments.completed, report.appointments.cancelled, report.appointments.noShow, report.appointments.walkIn,
          report.encountersCompleted,
          report.billing?.invoicesRaised ?? "", report.billing?.invoicedAmount ?? "",
          report.collections?.paymentsCollected ?? "", report.collections?.collectedAmount ?? "", report.collections?.refundsIssued ?? "", report.collections?.refundedAmount ?? "",
          report.pharmacy?.dispensesCompleted ?? "",
          report.lab?.ordersPlaced ?? "", report.lab?.resultsVerified ?? "",
          report.imaging?.ordersPlaced ?? "", report.imaging?.reportsVerified ?? "",
        ]],
        { bom: true }
      )
      break
    }
    case "patients": {
      const rows = await exportPatientRegistrationRows(session, filters)
      rowCount = rows.length
      csv = toCsv(
        ["MRN", "Legacy MRN", "First Name", "Middle Name", "Last Name", "DOB", "Gender", "Mobile", "Status", "Branch", "Registered"],
        rows.map((p) => [p.mrn, p.legacyMrn ?? "", p.firstName, p.middleName ?? "", p.lastName, p.dob, p.gender, p.mobile, p.status, p.registrationBranch.name, p.createdAt]),
        { bom: true }
      )
      await logSensitiveExport(session, "patient-registration-report", { filters: exportFilterSummary(filters), rowCount })
      break
    }
    case "import-history": {
      const rows = await exportImportHistoryRows(session, filters)
      rowCount = rows.length
      csv = toCsv(
        ["Type", "File", "Status", "Actor", "Started", "Completed", "Total Rows", "Valid", "Invalid", "Duplicate", "Imported", "Skipped"],
        rows.map((j) => [
          j.type, j.fileName, j.status, j.startedByUser ? `${j.startedByUser.firstName} ${j.startedByUser.lastName}` : "", j.startedAt, j.completedAt ?? "",
          j.totalRows, j.validRows, j.invalidRows, j.duplicateRows, j.importedRows, j.skippedRows,
        ]),
        { bom: true }
      )
      await logSensitiveExport(session, "import-history-report", { filters: exportFilterSummary(filters), rowCount })
      break
    }
  }

  assertExportRowLimit(rowCount)
  return csv
}

/** A small, structured filter summary safe to persist in an audit log row — never the exported rows themselves (P4.7 §55). */
function exportFilterSummary(filters: ReturnType<typeof defaultReportFilters>) {
  return { from: toDateParam(filters.from), to: toDateParam(filters.to), branchId: filters.branchId ?? null, providerId: filters.providerId ?? null }
}
