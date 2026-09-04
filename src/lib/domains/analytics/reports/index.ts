import { getPracticeReport } from "@/lib/domains/analytics/reports/practice"
import { getClinicalReport, getLabReport, getRadiologyReport } from "@/lib/domains/analytics/reports/clinical"
import { getFinancialReport } from "@/lib/domains/analytics/reports/financial"
import { getRevenueCycleReport } from "@/lib/domains/analytics/reports/revenue-cycle"
import { getInventoryReport } from "@/lib/domains/analytics/reports/inventory"
import { getHrReport } from "@/lib/domains/analytics/reports/hr"
import { getAssetsReport } from "@/lib/domains/analytics/reports/assets"
import { getDailyOperationsReport } from "@/lib/domains/analytics/reports/daily-operations"
import { getPatientRegistrationReport } from "@/lib/domains/analytics/reports/patients"
import { getImportHistoryReport } from "@/lib/domains/analytics/reports/import-history"
import { can } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportCategory } from "@/lib/domains/analytics/schemas"

export const REPORT_LABELS: Record<ReportCategory, string> = {
  practice: "Practice",
  clinical: "Clinical",
  financial: "Financial",
  "revenue-cycle": "Billing / Revenue",
  inventory: "Inventory",
  hr: "HR",
  assets: "Assets",
  "daily-ops": "Daily Operations",
  patients: "Patients",
  lab: "Lab",
  radiology: "Radiology",
  "import-history": "Import History",
}

/** One line of purpose text per category, shown on the Reports workspace (§6's own "short purpose" requirement) — never shown for a tab the caller can't see. */
export const REPORT_PURPOSE: Record<ReportCategory, string> = {
  practice: "Appointments, no-shows, waiting times, provider/room utilization, patient visits.",
  clinical: "Encounter volume, diagnosis trends, orders, follow-ups, prescriptions.",
  financial: "Revenue, collections, AR/AP aging, income statement, balance sheet, cash flow.",
  "revenue-cycle": "Invoices, collections, refunds, claims, and rejections.",
  inventory: "Stock on hand, valuation, expiry, low stock, and reconciliation checks.",
  hr: "Attendance, leave, payroll runs, and commission.",
  assets: "Asset register, maintenance, and calibration records.",
  "daily-ops": "One day's operational activity — appointments, billing, pharmacy, lab, imaging.",
  patients: "Patient registrations over the selected period.",
  lab: "Lab orders by status and turnaround time.",
  radiology: "Radiology orders by status and turnaround time.",
  "import-history": "Data-import jobs run through the onboarding workspace (P4.6).",
}

/** Whether the signed-in user can see this category's tab at all — mirrors each get*Report()'s own assertCan gate, checked up front so the UI never renders a tab that would 403. */
export function canViewReportCategory(session: SessionContext, category: ReportCategory): boolean {
  switch (category) {
    case "practice":
    case "daily-ops":
      return can(session, "appointment.view")
    case "patients":
      return can(session, "patient.view")
    case "clinical":
      return can(session, "encounter.view")
    case "lab":
      return can(session, "encounter.view") || can(session, "lab_result.verify") || can(session, "lab_result.enter")
    case "radiology":
      return can(session, "encounter.view") || can(session, "imaging_result.verify") || can(session, "imaging_order.perform")
    case "financial":
      return can(session, "accounting.view")
    case "revenue-cycle":
      return can(session, "invoice.view") || can(session, "claim.create")
    case "inventory":
      return can(session, "inventory.view")
    case "hr":
      return can(session, "payroll.view")
    case "assets":
      return can(session, "inventory.view")
    case "import-history":
      return can(session, "data_import.manage")
  }
}

export {
  getPracticeReport,
  getClinicalReport,
  getLabReport,
  getRadiologyReport,
  getFinancialReport,
  getRevenueCycleReport,
  getInventoryReport,
  getHrReport,
  getAssetsReport,
  getDailyOperationsReport,
  getPatientRegistrationReport,
  getImportHistoryReport,
}
