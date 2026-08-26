import { redirect } from "next/navigation"
import { Download } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listBranches } from "@/lib/domains/identity/org-structure"
import { listProviders } from "@/lib/domains/providers/service"
import { defaultReportFilters, REPORT_CATEGORIES, type ReportCategory } from "@/lib/domains/analytics/schemas"
import {
  REPORT_LABELS,
  canViewReportCategory,
  getPracticeReport,
  getClinicalReport,
  getFinancialReport,
  getRevenueCycleReport,
  getInventoryReport,
  getHrReport,
  getAssetsReport,
} from "@/lib/domains/analytics/reports"
import { toDateParam, formatDate } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardDescription, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"

type ReportData = Awaited<ReturnType<typeof loadReport>>

async function loadReport(session: NonNullable<Awaited<ReturnType<typeof getCurrentSession>>>, category: ReportCategory, filters: ReturnType<typeof defaultReportFilters>) {
  switch (category) {
    case "practice":
      return getPracticeReport(session, filters)
    case "clinical":
      return getClinicalReport(session, filters)
    case "financial":
      return getFinancialReport(session, filters)
    case "revenue-cycle":
      return getRevenueCycleReport(session, filters)
    case "inventory":
      return getInventoryReport(session, filters)
    case "hr":
      return getHrReport(session, filters)
    case "assets":
      return getAssetsReport(session, filters)
  }
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; branchId?: string; providerId?: string }>
}) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const sp = await searchParams
  const filters = defaultReportFilters(sp)
  const visible = REPORT_CATEGORIES.filter((c) => canViewReportCategory(session, c))
  if (visible.length === 0) redirect("/dashboard")

  const canExport = can(session, "reports.export")

  const [branches, providers, ...results] = await Promise.all([
    listBranches(session),
    can(session, "appointment.view") ? listProviders(session) : Promise.resolve([]),
    ...visible.map((category) => loadReport(session, category, filters)),
  ])
  const reportsByCategory = Object.fromEntries(visible.map((category, i) => [category, results[i]])) as Record<ReportCategory, ReportData>

  const exportHref = (category: ReportCategory) => {
    const params = new URLSearchParams({ category, from: toDateParam(filters.from), to: toDateParam(filters.to) })
    if (filters.branchId) params.set("branchId", filters.branchId)
    if (filters.providerId) params.set("providerId", filters.providerId)
    return `/api/reports/export?${params.toString()}`
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">spec.md §65 — Practice, Clinical, Financial, Revenue Cycle, Inventory, HR, and Assets reporting, filterable by date, branch, and provider.</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form method="get" className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="from" className="text-xs font-medium text-muted-foreground">From</label>
              <input id="from" name="from" type="date" defaultValue={toDateParam(filters.from)} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="to" className="text-xs font-medium text-muted-foreground">To</label>
              <input id="to" name="to" type="date" defaultValue={toDateParam(filters.to)} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs" />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="branchId" className="text-xs font-medium text-muted-foreground">Branch</label>
              <select id="branchId" name="branchId" defaultValue={filters.branchId ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
                <option value="">All branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            {providers.length > 0 && (
              <div className="flex flex-col gap-1">
                <label htmlFor="providerId" className="text-xs font-medium text-muted-foreground">Provider</label>
                <select id="providerId" name="providerId" defaultValue={filters.providerId ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
                  <option value="">All providers</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </div>
            )}
            <Button type="submit" variant="secondary">Apply filters</Button>
          </form>
        </CardContent>
      </Card>

      <Tabs defaultValue={visible[0]}>
        <TabsList className="flex-wrap">
          {visible.map((category) => (
            <TabsTrigger key={category} value={category}>{REPORT_LABELS[category]}</TabsTrigger>
          ))}
        </TabsList>

        {visible.map((category) => (
          <TabsContent key={category} value={category} className="grid gap-4">
            {canExport && (
              <div className="flex justify-end">
                <Button asChild size="sm" variant="outline">
                  <a href={exportHref(category)}>
                    <Download className="size-4" /> Export CSV
                  </a>
                </Button>
              </div>
            )}
            {category === "practice" && <PracticeSection report={reportsByCategory.practice as Awaited<ReturnType<typeof getPracticeReport>>} />}
            {category === "clinical" && <ClinicalSection report={reportsByCategory.clinical as Awaited<ReturnType<typeof getClinicalReport>>} />}
            {category === "financial" && <FinancialSection report={reportsByCategory.financial as Awaited<ReturnType<typeof getFinancialReport>>} />}
            {category === "revenue-cycle" && <RevenueCycleSection report={reportsByCategory["revenue-cycle"] as Awaited<ReturnType<typeof getRevenueCycleReport>>} />}
            {category === "inventory" && <InventorySection report={reportsByCategory.inventory as Awaited<ReturnType<typeof getInventoryReport>>} />}
            {category === "hr" && <HrSection report={reportsByCategory.hr as Awaited<ReturnType<typeof getHrReport>>} />}
            {category === "assets" && <AssetsSection report={reportsByCategory.assets as Awaited<ReturnType<typeof getAssetsReport>>} />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}

function SectionTable({ title, headers, rows, empty }: { title: string; headers: string[]; rows: (string | number)[][]; empty: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((h) => <TableHead key={h}>{h}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={headers.length} className="text-center text-muted-foreground">{empty}</TableCell>
              </TableRow>
            )}
            {rows.map((row, i) => (
              <TableRow key={i}>
                {row.map((cell, j) => <TableCell key={j}>{cell}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function PracticeSection({ report }: { report: Awaited<ReturnType<typeof getPracticeReport>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="Total Appointments" value={report.totalAppointments} />
        <Kpi label="No-show Rate" value={`${report.noShowRate}%`} />
        <Kpi label="Avg Waiting Time" value={report.avgWaitingMinutes !== null ? `${report.avgWaitingMinutes} min` : "—"} />
        <Kpi label="Patient Visits" value={report.patientVisits} />
      </div>
      <SectionTable title="Appointments by Status" headers={["Status", "Count"]} rows={report.statusBreakdown.map((s) => [s.status.replace("_", " "), s.count])} empty="No appointments in range." />
      <SectionTable
        title="Provider Utilization"
        headers={["Provider", "Appointments", "Booked Min", "Available Min", "Utilization %"]}
        rows={report.providerUtilization.map((p) => [p.providerName, p.appointmentCount, p.bookedMinutes, p.availableMinutes, p.utilizationPercent !== null ? `${p.utilizationPercent}%` : "—"])}
        empty="No provider activity in range."
      />
      <SectionTable
        title="Room Utilization"
        headers={["Room", "Appointments", "Booked Minutes"]}
        rows={report.roomUtilization.map((r) => [r.roomName, r.appointmentCount, r.bookedMinutes])}
        empty="No room-scheduled appointments in range."
      />
    </>
  )
}

function ClinicalSection({ report }: { report: Awaited<ReturnType<typeof getClinicalReport>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="Total Encounters" value={report.totalEncounters} />
      </div>
      <SectionTable title="Encounters by Status" headers={["Status", "Count"]} rows={report.encountersByStatus.map((s) => [s.status, s.count])} empty="No encounters in range." />
      <SectionTable title="Encounters by Type" headers={["Type", "Count"]} rows={report.encountersByType.map((s) => [s.type.replace("_", " "), s.count])} empty="No encounters in range." />
      <SectionTable title="Diagnosis Trends" headers={["Diagnosis", "Count"]} rows={report.diagnosisTrends.map((d) => [d.diagnosis, d.count])} empty="No diagnoses recorded in range." />
      <SectionTable title="Orders by Type" headers={["Order Type", "Count"]} rows={report.ordersByType.map((o) => [o.orderType, o.count])} empty="No clinical orders in range." />
      <SectionTable title="Follow-ups by Status" headers={["Status", "Count"]} rows={report.followUpsByStatus.map((f) => [f.status, f.count])} empty="No follow-ups recommended in range." />
    </>
  )
}

function FinancialSection({ report }: { report: Awaited<ReturnType<typeof getFinancialReport>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Kpi label="Revenue" value={report.revenue.toFixed(2)} />
        <Kpi label="Collections" value={report.collections.toFixed(2)} />
        <Kpi label="Accounts Receivable" value={report.accountsReceivable.toFixed(2)} />
        <Kpi label="Accounts Payable" value={report.accountsPayable.toFixed(2)} />
        <Kpi label="Expenses" value={report.expenses.toFixed(2)} />
      </div>
      <SectionTable
        title="Income Statement (P&L)"
        headers={["Type", "Code", "Name", "Amount"]}
        rows={[
          ...report.incomeStatement.revenueLines.map((l) => ["Revenue", l.code, l.name, l.amount.toFixed(2)]),
          ...report.incomeStatement.expenseLines.map((l) => ["Expense", l.code, l.name, l.amount.toFixed(2)]),
        ]}
        empty="No posted journal activity in range."
      />
      <Card>
        <CardHeader><CardTitle className="text-base">Net Income</CardTitle></CardHeader>
        <CardContent className="text-lg font-semibold">{report.incomeStatement.netIncome.toFixed(2)}</CardContent>
      </Card>
      <SectionTable
        title="Balance Sheet (as of period end)"
        headers={["Section", "Code", "Name", "Amount"]}
        rows={[
          ...report.balanceSheet.assetLines.map((l) => ["Asset", l.code, l.name, l.amount.toFixed(2)]),
          ...report.balanceSheet.liabilityLines.map((l) => ["Liability", l.code, l.name, l.amount.toFixed(2)]),
          ...report.balanceSheet.equityLines.map((l) => ["Equity", l.code, l.name, l.amount.toFixed(2)]),
        ]}
        empty="No posted journal activity."
      />
      <SectionTable
        title="Cash Flow"
        headers={["Direction", "Date", "Description", "Amount"]}
        rows={[
          ...report.cashFlow.inflows.map((l) => ["Inflow", formatDate(l.date), l.description, l.amount.toFixed(2)]),
          ...report.cashFlow.outflows.map((l) => ["Outflow", formatDate(l.date), l.description, l.amount.toFixed(2)]),
        ]}
        empty="No cash account activity in range."
      />
    </>
  )
}

function RevenueCycleSection({ report }: { report: Awaited<ReturnType<typeof getRevenueCycleReport>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Kpi label="Collections" value={report.collections.toFixed(2)} />
        <Kpi label="Est. Patient Responsibility" value={report.estimatedPatientResponsibility.toFixed(2)} />
        <Kpi label="Final Patient Responsibility" value={report.finalPatientResponsibility.toFixed(2)} />
      </div>
      <SectionTable title="Charges by Status" headers={["Status", "Count", "Amount"]} rows={report.chargesByStatus.map((c) => [c.status, c.count, c.amount.toFixed(2)])} empty="No charges in range." />
      <SectionTable title="Claims by Status" headers={["Status", "Count", "Amount"]} rows={report.claimsByStatus.map((c) => [c.status, c.count, c.amount.toFixed(2)])} empty="No claims in range." />
      <SectionTable
        title="Rejected Claims"
        headers={["Patient", "Payor", "Submitted", "Rejected", "Reason"]}
        rows={report.rejectedClaims.map((c) => [`${c.patient.firstName} ${c.patient.lastName}`, c.payor.name, Number(c.submittedAmount).toFixed(2), Number(c.rejectedAmount ?? 0).toFixed(2), c.rejectionReason ?? "—"])}
        empty="No rejected claims in range."
      />
    </>
  )
}

function InventorySection({ report }: { report: Awaited<ReturnType<typeof getInventoryReport>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Kpi label="Total Stock Valuation" value={report.totalValuation.toFixed(2)} />
        <Kpi label="Near-Expiry Batches" value={report.nearExpiryCount} />
        <Kpi label="Expired Batches" value={report.expiredCount} />
      </div>
      <SectionTable title="Stock Summary" headers={["Product", "Category", "Balance", "Reorder Level", "Low Stock"]} rows={report.stockSummary.map((p) => [p.name, p.category, p.balance, p.reorderLevel, p.isLowStock ? "Yes" : "No"])} empty="No products." />
      <SectionTable title="Fast Moving" headers={["Product", "Consumed Qty"]} rows={report.fastMoving.map((c) => [c.productName, c.quantity])} empty="No consumption recorded in range." />
      <SectionTable title="Slow Moving" headers={["Product", "Consumed Qty"]} rows={report.slowMoving.map((c) => [c.productName, c.quantity])} empty="No consumption recorded in range." />
    </>
  )
}

function HrSection({ report }: { report: Awaited<ReturnType<typeof getHrReport>> }) {
  return (
    <>
      <SectionTable title="Attendance by Status" headers={["Status", "Count"]} rows={report.attendanceByStatus.map((a) => [a.status.replace("_", " "), a.count])} empty="No attendance records in range." />
      <SectionTable title="Leave by Status" headers={["Status", "Count"]} rows={report.leaveByStatus.map((l) => [l.status, l.count])} empty="No leave requests in range." />
      <SectionTable title="Leave by Type" headers={["Type", "Count"]} rows={report.leaveByType.map((l) => [l.type, l.count])} empty="No leave requests in range." />
      <SectionTable title="Payroll Runs" headers={["Period Start", "Period End", "Status", "Employees", "Net Total"]} rows={report.payrollRuns.map((r) => [formatDate(r.periodStart), formatDate(r.periodEnd), r.status, r.employeeCount, r.netTotal.toFixed(2)])} empty="No payroll runs in range." />
      {report.commission && (
        <SectionTable title="Commission by Provider" headers={["Provider", "Amount"]} rows={report.commission.map((c) => [c.providerName, c.amount.toFixed(2)])} empty="No commission accrued in range." />
      )}
    </>
  )
}

function AssetsSection({ report }: { report: Awaited<ReturnType<typeof getAssetsReport>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="Total Assets" value={report.totalAssets} />
        <Kpi label="Maintenance Cost" value={report.maintenanceCost.toFixed(2)} />
        <Kpi label="Acquisition Cost" value={report.acquisitionCost.toFixed(2)} />
        <Kpi label="Total Costs" value={report.totalCosts.toFixed(2)} />
      </div>
      <SectionTable title="Register by Status" headers={["Status", "Count"]} rows={report.registerByStatus.map((r) => [r.status, r.count])} empty="No assets." />
      <SectionTable title="Register by Category" headers={["Category", "Count"]} rows={report.registerByCategory.map((r) => [r.category, r.count])} empty="No assets." />
      <SectionTable
        title="Maintenance Records"
        headers={["Asset", "Type", "Service Date", "Cost", "Next Service"]}
        rows={report.maintenanceRecords.map((m) => [m.asset.name, m.maintenanceType, formatDate(m.serviceDate), m.cost ? Number(m.cost).toFixed(2) : "—", m.nextServiceDate ? formatDate(m.nextServiceDate) : "—"])}
        empty="No maintenance records in range."
      />
      <SectionTable
        title="Calibration Records"
        headers={["Asset", "Date", "Result", "Next Calibration"]}
        rows={report.calibrationRecords.map((c) => [c.asset.name, formatDate(c.calibrationDate), c.result, c.nextCalibrationDate ? formatDate(c.nextCalibrationDate) : "—"])}
        empty="No calibration records in range."
      />
    </>
  )
}
