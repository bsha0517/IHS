import { redirect } from "next/navigation"
import { Download } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listBranches } from "@/lib/domains/identity/org-structure"
import { listProviders } from "@/lib/domains/providers/service"
import { defaultReportFilters, REPORT_CATEGORIES, type ReportCategory } from "@/lib/domains/analytics/schemas"
import {
  REPORT_LABELS,
  REPORT_PURPOSE,
  canViewReportCategory,
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
} from "@/lib/domains/analytics/reports"
import { getInvoiceReport, getCollectionsReport, getRefundReport } from "@/lib/domains/analytics/reports/revenue-cycle"
import { toDateParam, formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardDescription, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { PageHeader } from "@/components/ui/page-header"
import { FilterBar, FilterField } from "@/components/ui/filter-bar"
import { MetricCard } from "@/components/ui/metric-card"
import { EmptyState } from "@/components/ui/empty-state"

async function loadReport(session: NonNullable<Awaited<ReturnType<typeof getCurrentSession>>>, category: ReportCategory, filters: ReturnType<typeof defaultReportFilters>) {
  switch (category) {
    case "practice":
      return getPracticeReport(session, filters)
    case "clinical":
      return getClinicalReport(session, filters)
    case "lab":
      return getLabReport(session, filters)
    case "radiology":
      return getRadiologyReport(session, filters)
    case "financial":
      return getFinancialReport(session, filters)
    case "revenue-cycle": {
      // Named invoiceReport/collectionsReport/refundReport, not
      // invoices/collections/refunds — `getRevenueCycleReport`'s own return
      // already has a `collections` field (the total collections amount, a
      // number); a same-named merge here silently overwrote it with
      // getCollectionsReport's {rows,total,truncated} object, breaking the
      // summary KPI's `.toFixed()` call. Caught live in the browser (P4.6's
      // own lesson: this class of bug is invisible to server-only tests).
      const [summary, invoiceReport, collectionsReport, refundReport] = await Promise.all([
        getRevenueCycleReport(session, filters),
        getInvoiceReport(session, filters),
        getCollectionsReport(session, filters),
        getRefundReport(session, filters),
      ])
      return { ...summary, invoiceReport, collectionsReport, refundReport }
    }
    case "inventory":
      return getInventoryReport(session, filters)
    case "hr":
      return getHrReport(session, filters)
    case "assets":
      return getAssetsReport(session, filters)
    case "daily-ops":
      // §8: one specific date, not a from/to range — reuses the filter
      // bar's own "to" date (defaults to today) as "the day this covers"
      // rather than adding a separate date control just for this one tab.
      return getDailyOperationsReport(session, { date: filters.to, branchId: filters.branchId })
    case "patients":
      return getPatientRegistrationReport(session, filters)
    case "import-history":
      return getImportHistoryReport(session, filters)
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
  const reportsByCategory = Object.fromEntries(visible.map((category, i) => [category, results[i]])) as Record<ReportCategory, unknown>

  const exportHref = (category: ReportCategory) => {
    const params = new URLSearchParams({ category, from: toDateParam(filters.from), to: toDateParam(filters.to) })
    if (filters.branchId) params.set("branchId", filters.branchId)
    if (filters.providerId) params.set("providerId", filters.providerId)
    return `/api/reports/export?${params.toString()}`
  }
  /** §31/§48's structured data-portability exports (Patient Master, General Ledger, Trial Balance, Collections, Refunds, Stock Movement) — a separate small route, not a report category, but sharing the same from/to/branch filters. */
  const dataExportHref = (type: string) => {
    const params = new URLSearchParams({ from: toDateParam(filters.from), to: toDateParam(filters.to) })
    if (filters.branchId) params.set("branchId", filters.branchId)
    return `/api/reports/export/data/${type}?${params.toString()}`
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Operational and financial reporting, filterable by date, branch, and provider — export any category as CSV."
      />

      {/* P4.7A.1 §36 — Reports' own filter form, now on the shared FilterBar
          shell instead of a bespoke `<form>`/`<Card>` pair. Native date/select
          controls are unchanged (still a plain GET form) — this is a
          presentation migration only, no server filtering semantics moved. */}
      <FilterBar method="get">
        <FilterField label="From" htmlFor="from">
          <input id="from" name="from" type="date" defaultValue={toDateParam(filters.from)} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs" />
        </FilterField>
        <FilterField label="To" htmlFor="to">
          <input id="to" name="to" type="date" defaultValue={toDateParam(filters.to)} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs" />
        </FilterField>
        <FilterField label="Branch" htmlFor="branchId">
          <select id="branchId" name="branchId" defaultValue={filters.branchId ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </FilterField>
        {providers.length > 0 && (
          <FilterField label="Provider" htmlFor="providerId">
            <select id="providerId" name="providerId" defaultValue={filters.providerId ?? ""} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
              <option value="">All providers</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>
              ))}
            </select>
          </FilterField>
        )}
        <Button type="submit" variant="secondary">Apply filters</Button>
      </FilterBar>

      <Tabs defaultValue={visible[0]}>
        <TabsList className="flex-wrap">
          {visible.map((category) => (
            <TabsTrigger key={category} value={category}>{REPORT_LABELS[category]}</TabsTrigger>
          ))}
        </TabsList>

        {visible.map((category) => (
          <TabsContent key={category} value={category} className="grid gap-4">
            <p className="text-sm text-muted-foreground">{REPORT_PURPOSE[category]}</p>
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
            {category === "lab" && <LabSection report={reportsByCategory.lab as Awaited<ReturnType<typeof getLabReport>>} />}
            {category === "radiology" && <RadiologySection report={reportsByCategory.radiology as Awaited<ReturnType<typeof getRadiologyReport>>} />}
            {category === "financial" && (
              <FinancialSection report={reportsByCategory.financial as Awaited<ReturnType<typeof getFinancialReport>>} canExport={canExport} dataExportHref={dataExportHref} />
            )}
            {category === "revenue-cycle" && (
              <RevenueCycleSection report={reportsByCategory["revenue-cycle"] as RevenueCycleReportShape} canExport={canExport} dataExportHref={dataExportHref} />
            )}
            {category === "inventory" && (
              <InventorySection report={reportsByCategory.inventory as Awaited<ReturnType<typeof getInventoryReport>>} canExport={canExport} dataExportHref={dataExportHref} />
            )}
            {category === "hr" && <HrSection report={reportsByCategory.hr as Awaited<ReturnType<typeof getHrReport>>} />}
            {category === "assets" && <AssetsSection report={reportsByCategory.assets as Awaited<ReturnType<typeof getAssetsReport>>} />}
            {category === "daily-ops" && <DailyOpsSection report={reportsByCategory["daily-ops"] as Awaited<ReturnType<typeof getDailyOperationsReport>>} />}
            {category === "patients" && (
              <PatientsSection report={reportsByCategory.patients as Awaited<ReturnType<typeof getPatientRegistrationReport>>} canExport={canExport} dataExportHref={dataExportHref} />
            )}
            {category === "import-history" && <ImportHistorySection report={reportsByCategory["import-history"] as Awaited<ReturnType<typeof getImportHistoryReport>>} />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

type RevenueCycleReportShape = Awaited<ReturnType<typeof getRevenueCycleReport>> & {
  invoiceReport: Awaited<ReturnType<typeof getInvoiceReport>>
  collectionsReport: Awaited<ReturnType<typeof getCollectionsReport>>
  refundReport: Awaited<ReturnType<typeof getRefundReport>>
}

// P4.7A.1 §36 — every report tab's own KPI tile now goes through the shared
// MetricCard rather than a bespoke Card/CardHeader/CardDescription trio.
function Kpi({ label, value }: { label: string; value: string | number }) {
  return <MetricCard label={label} value={value} />
}

function SectionTable({ title, headers, rows, empty, truncatedNote }: { title: string; headers: string[]; rows: (string | number)[][]; empty: string; truncatedNote?: string }) {
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
                <TableCell colSpan={headers.length} className="p-0">
                  <EmptyState title="No data" description={empty} className="border-none" />
                </TableCell>
              </TableRow>
            )}
            {rows.map((row, i) => (
              <TableRow key={i}>
                {row.map((cell, j) => <TableCell key={j}>{cell}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {truncatedNote && rows.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{truncatedNote}</p>}
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
      <SectionTable
        title="Appointments"
        headers={["Date/Time", "Provider", "Service", "Status", "Source"]}
        rows={report.appointmentRows.map((a) => [formatDateTime(a.startTime), a.providerName, a.serviceName, a.status.replace("_", " "), a.bookingSource.replace("_", " ")])}
        empty="No appointments in range."
        truncatedNote={report.appointmentRowsTruncated ? `Showing the first ${report.appointmentRows.length} appointments — export CSV for the complete filtered set.` : undefined}
      />
    </>
  )
}

function ClinicalSection({ report }: { report: Awaited<ReturnType<typeof getClinicalReport>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Kpi label="Total Encounters" value={report.totalEncounters} />
        <Kpi label="Prescriptions" value={report.prescriptionsCount} />
        <Kpi label="Lab Results Verified" value={report.labResultsVerified} />
        <Kpi label="Imaging Reports Verified" value={report.imagingReportsVerified} />
      </div>
      <SectionTable title="Encounters by Status" headers={["Status", "Count"]} rows={report.encountersByStatus.map((s) => [s.status, s.count])} empty="No encounters in range." />
      <SectionTable title="Encounters by Type" headers={["Type", "Count"]} rows={report.encountersByType.map((s) => [s.type.replace("_", " "), s.count])} empty="No encounters in range." />
      <SectionTable title="Diagnosis Trends" headers={["Diagnosis", "Count"]} rows={report.diagnosisTrends.map((d) => [d.diagnosis, d.count])} empty="No diagnoses recorded in range." />
      <SectionTable title="Orders by Type" headers={["Order Type", "Count"]} rows={report.ordersByType.map((o) => [o.orderType, o.count])} empty="No clinical orders in range." />
      <SectionTable title="Follow-ups by Status" headers={["Status", "Count"]} rows={report.followUpsByStatus.map((f) => [f.status, f.count])} empty="No follow-ups recommended in range." />
    </>
  )
}

function LabSection({ report }: { report: Awaited<ReturnType<typeof getLabReport>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Kpi label="Verified" value={report.verifiedCount} />
        <Kpi label="Avg Order → Result" value={report.avgOrderToResultMinutes !== null ? `${report.avgOrderToResultMinutes} min` : "—"} />
        <Kpi label="Avg Result → Verify" value={report.avgResultToVerifyMinutes !== null ? `${report.avgResultToVerifyMinutes} min` : "—"} />
      </div>
      <SectionTable title="Lab Orders by Status" headers={["Status", "Count"]} rows={report.byStatus.map((s) => [s.status, s.count])} empty="No lab orders in range." />
    </>
  )
}

function RadiologySection({ report }: { report: Awaited<ReturnType<typeof getRadiologyReport>> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Kpi label="Verified" value={report.verifiedCount} />
        <Kpi label="Avg Order → Perform" value={report.avgOrderToPerformMinutes !== null ? `${report.avgOrderToPerformMinutes} min` : "—"} />
        <Kpi label="Avg Perform → Report" value={report.avgPerformToReportMinutes !== null ? `${report.avgPerformToReportMinutes} min` : "—"} />
      </div>
      <SectionTable title="Radiology Orders by Status" headers={["Status", "Count"]} rows={report.byStatus.map((s) => [s.status, s.count])} empty="No radiology orders in range." />
    </>
  )
}

function ExportLink({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs">
      <a href={href}>
        <Download className="size-3" /> {label}
      </a>
    </Button>
  )
}

function FinancialSection({ report, canExport, dataExportHref }: { report: Awaited<ReturnType<typeof getFinancialReport>>; canExport: boolean; dataExportHref: (type: string) => string }) {
  return (
    <>
      {canExport && (
        <div className="flex justify-end gap-2">
          <ExportLink href={dataExportHref("general-ledger")} label="Export General Ledger" />
          <ExportLink href={dataExportHref("trial-balance")} label="Export Trial Balance" />
        </div>
      )}
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
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts Receivable Aging</CardTitle>
          <CardDescription>Aged from invoice date (this schema has no separate due-date field).</CardDescription>
        </CardHeader>
        <CardContent>
          <AgingTable aging={report.arAging} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts Payable Aging</CardTitle>
          <CardDescription>
            Aged from due date. {report.apAging.undated > 0 && `${report.apAging.undated} supplier invoice(s) totaling ${report.apAging.undatedAmount.toFixed(2)} have no due date recorded and are excluded from the buckets below.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AgingTable aging={report.apAging} />
        </CardContent>
      </Card>
    </>
  )
}

function AgingTable({ aging }: { aging: { current: number; d1to30: number; d31to60: number; d61to90: number; d90plus: number; total: number } }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Current</TableHead>
          <TableHead>1–30</TableHead>
          <TableHead>31–60</TableHead>
          <TableHead>61–90</TableHead>
          <TableHead>90+</TableHead>
          <TableHead>Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>{aging.current.toFixed(2)}</TableCell>
          <TableCell>{aging.d1to30.toFixed(2)}</TableCell>
          <TableCell>{aging.d31to60.toFixed(2)}</TableCell>
          <TableCell>{aging.d61to90.toFixed(2)}</TableCell>
          <TableCell>{aging.d90plus.toFixed(2)}</TableCell>
          <TableCell className="font-medium">{aging.total.toFixed(2)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  )
}

function RevenueCycleSection({ report, canExport, dataExportHref }: { report: RevenueCycleReportShape; canExport: boolean; dataExportHref: (type: string) => string }) {
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
      <SectionTable
        title="Invoice Report"
        headers={["Invoice #", "Patient", "Date", "Gross", "Discount", "Tax", "Net", "Paid", "Outstanding", "Status"]}
        rows={report.invoiceReport.rows.map((inv) => [
          inv.invoiceNumber, `${inv.patient.firstName} ${inv.patient.lastName}`, formatDate(inv.issuedAt),
          Number(inv.subtotal).toFixed(2), Number(inv.discountAmount).toFixed(2), Number(inv.taxAmount).toFixed(2),
          Number(inv.totalAmount).toFixed(2), Number(inv.paidAmount).toFixed(2), (Number(inv.totalAmount) - Number(inv.paidAmount)).toFixed(2), inv.status,
        ])}
        empty="No invoices in range."
        truncatedNote={report.invoiceReport.truncated ? `Showing the first ${report.invoiceReport.rows.length} of ${report.invoiceReport.total} invoices — export CSV for the complete filtered set.` : undefined}
      />
      {canExport && (
        <div className="flex justify-end gap-2">
          <ExportLink href={dataExportHref("collections")} label="Export Collections" />
          <ExportLink href={dataExportHref("refunds")} label="Export Refunds" />
        </div>
      )}
      <SectionTable
        title="Collections Report"
        headers={["Receipt #", "Date", "Patient/Invoice", "Method", "Amount", "Cashier"]}
        rows={report.collectionsReport.rows.map((p) => [
          p.receiptNumber, formatDateTime(p.receivedAt),
          p.allocations[0]?.invoice ? `${p.allocations[0].invoice.patient.firstName} ${p.allocations[0].invoice.patient.lastName} (${p.allocations[0].invoice.invoiceNumber})` : "—",
          p.method.replace("_", " "), Number(p.amount).toFixed(2), p.receivedByUser ? `${p.receivedByUser.firstName} ${p.receivedByUser.lastName}` : "—",
        ])}
        empty="No payments in range."
        truncatedNote={report.collectionsReport.truncated ? `Showing the first ${report.collectionsReport.rows.length} of ${report.collectionsReport.total} payments — export CSV for the complete filtered set.` : undefined}
      />
      <SectionTable
        title="Refund Report"
        headers={["Refund #", "Date", "Invoice", "Amount", "Reason", "Status", "Requested By"]}
        rows={report.refundReport.rows.map((r) => [
          r.refundNumber ?? "—", formatDateTime(r.requestedAt), r.invoice.invoiceNumber, Number(r.amount).toFixed(2), r.reason, r.status,
          r.requestedByUser ? `${r.requestedByUser.firstName} ${r.requestedByUser.lastName}` : "—",
        ])}
        empty="No refunds in range."
        truncatedNote={report.refundReport.truncated ? `Showing the first ${report.refundReport.rows.length} of ${report.refundReport.total} refunds — export CSV for the complete filtered set.` : undefined}
      />
    </>
  )
}

function InventorySection({ report, canExport, dataExportHref }: { report: Awaited<ReturnType<typeof getInventoryReport>>; canExport: boolean; dataExportHref: (type: string) => string }) {
  return (
    <>
      {canExport && (
        <div className="flex justify-end">
          <ExportLink href={dataExportHref("stock-movement")} label="Export Stock Movement" />
        </div>
      )}
      {report.openingInventorySetupNote && (
        <Alert>
          <AlertDescription>{report.openingInventorySetupNote}</AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Kpi label="Total Stock Valuation" value={report.totalValuation.toFixed(2)} />
        <Kpi label="Near-Expiry Batches" value={report.nearExpiryCount} />
        <Kpi label="Expired Batches" value={report.expiredCount} />
      </div>
      <SectionTable title="Stock Summary" headers={["Product", "Category", "Balance", "Reorder Level", "Low Stock"]} rows={report.stockSummary.map((p) => [p.name, p.category, p.balance, p.reorderLevel, p.isLowStock ? "Yes" : "No"])} empty="No products." />
      <SectionTable title="Low Stock" headers={["Product", "Category", "Balance", "Reorder Level"]} rows={report.lowStock.map((p) => [p.name, p.category, p.balance, p.reorderLevel])} empty="Nothing below reorder level." />
      <SectionTable title="Fast Moving" headers={["Product", "Consumed Qty"]} rows={report.fastMoving.map((c) => [c.productName, c.quantity])} empty="No consumption recorded in range." />
      <SectionTable title="Slow Moving" headers={["Product", "Consumed Qty"]} rows={report.slowMoving.map((c) => [c.productName, c.quantity])} empty="No consumption recorded in range." />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inventory Reconciliation</CardTitle>
          <CardDescription>Obvious integrity issues detected directly from the stock ledger — not an automated fix, a flag for review.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <SectionTable title="Negative Stock" headers={["Product", "Balance"]} rows={report.reconciliation.negativeStock.map((n) => [n.productName, n.balance])} empty="No negative balances." />
          <SectionTable title="Unvalued Positive Stock" headers={["Product", "Balance"]} rows={report.reconciliation.unvaluedPositiveStock.map((n) => [n.productName, n.balance])} empty="No unvalued positive stock." />
          <SectionTable title="Expired Saleable Stock" headers={["Product", "Batch", "Expiry", "Balance"]} rows={report.reconciliation.expiredSaleable.map((e) => [e.batch.product.name, e.batch.batchNumber, formatDate(e.batch.expiryDate!), e.balance.toString()])} empty="No expired stock with a positive balance." />
        </CardContent>
      </Card>
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

function DailyOpsSection({ report }: { report: Awaited<ReturnType<typeof getDailyOperationsReport>> }) {
  return (
    <>
      <p className="text-sm font-medium">{formatDate(report.date)}</p>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Kpi label="Appointments Scheduled" value={report.appointments.scheduled} />
        <Kpi label="Checked In" value={report.appointments.checkedIn} />
        <Kpi label="Completed" value={report.appointments.completed} />
        <Kpi label="Cancelled" value={report.appointments.cancelled} />
        <Kpi label="No-shows" value={report.appointments.noShow} />
        <Kpi label="Walk-ins" value={report.appointments.walkIn} />
      </div>
      <Kpi label="Encounters Completed" value={report.encountersCompleted} />
      {report.billing && (
        <SectionTable title="Billing (invoiced amount — not collections)" headers={["Invoices Raised", "Invoiced Amount"]} rows={[[report.billing.invoicesRaised, report.billing.invoicedAmount.toFixed(2)]]} empty="—" />
      )}
      {report.collections && (
        <SectionTable
          title="Collections (cash received — not invoiced revenue)"
          headers={["Payments Collected", "Collected Amount", "Refunds Issued", "Refunded Amount"]}
          rows={[[report.collections.paymentsCollected, report.collections.collectedAmount.toFixed(2), report.collections.refundsIssued, report.collections.refundedAmount.toFixed(2)]]}
          empty="—"
        />
      )}
      {report.pharmacy && <Kpi label="Pharmacy Dispenses" value={report.pharmacy.dispensesCompleted} />}
      {report.lab && <SectionTable title="Lab" headers={["Orders Placed", "Results Verified"]} rows={[[report.lab.ordersPlaced, report.lab.resultsVerified]]} empty="—" />}
      {report.imaging && <SectionTable title="Imaging" headers={["Orders Placed", "Reports Verified"]} rows={[[report.imaging.ordersPlaced, report.imaging.reportsVerified]]} empty="—" />}
    </>
  )
}

function PatientsSection({ report, canExport, dataExportHref }: { report: Awaited<ReturnType<typeof getPatientRegistrationReport>>; canExport: boolean; dataExportHref: (type: string) => string }) {
  return (
    <>
      {canExport && (
        <div className="flex justify-end">
          <ExportLink href={dataExportHref("patient-master")} label="Export Patient Master (full demographics)" />
        </div>
      )}
      <Kpi label="Total Registrations" value={report.total} />
      <SectionTable title="By Gender" headers={["Gender", "Count"]} rows={report.byGender.map((g) => [g.gender, g.count])} empty="No registrations in range." />
      <SectionTable title="By Status" headers={["Status", "Count"]} rows={report.byStatus.map((s) => [s.status, s.count])} empty="No registrations in range." />
      <SectionTable
        title="Patient Registration Report"
        headers={["MRN", "Name", "DOB", "Gender", "Mobile", "Branch", "Registered"]}
        rows={report.preview.map((p) => [p.mrn, `${p.firstName} ${p.lastName}`, formatDate(p.dob), p.gender, p.mobile, p.registrationBranch.name, formatDate(p.createdAt)])}
        empty="No patients registered in range."
        truncatedNote={report.previewTruncated ? `Showing the first ${report.preview.length} of ${report.total} registrations — export CSV for the complete filtered set.` : undefined}
      />
    </>
  )
}

function ImportHistorySection({ report }: { report: Awaited<ReturnType<typeof getImportHistoryReport>> }) {
  return (
    <SectionTable
      title="Import History"
      headers={["Type", "File", "Status", "Actor", "Started", "Imported / Skipped / Invalid"]}
      rows={report.rows.map((j) => [
        j.type, j.fileName, j.status, j.startedByUser ? `${j.startedByUser.firstName} ${j.startedByUser.lastName}` : "—",
        formatDateTime(j.startedAt), `${j.importedRows} / ${j.skippedRows} / ${j.invalidRows}`,
      ])}
      empty="No import jobs in range."
      truncatedNote={report.truncated ? `Showing the first ${report.rows.length} of ${report.total} import jobs — export CSV for the complete filtered set.` : undefined}
    />
  )
}
