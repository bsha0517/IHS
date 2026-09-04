import { NextResponse, type NextRequest } from "next/server"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { toCsv } from "@/lib/platform/csv"
import { ExportTooLargeError, logSensitiveExport } from "@/lib/platform/reports"
import { toDateParam } from "@/lib/utils/dates"
import { defaultReportFilters } from "@/lib/domains/analytics/schemas"
import { exportPatientMasterRows, exportGeneralLedgerRows } from "@/lib/domains/analytics/exports"
import { exportCollectionsRows, exportRefundRows } from "@/lib/domains/analytics/reports/revenue-cycle"
import { exportStockMovementRows } from "@/lib/domains/analytics/reports/inventory"
import { trialBalance } from "@/lib/domains/accounting/reports"
import { db } from "@/lib/db"
import { assertExportRowLimit } from "@/lib/platform/reports"

/**
 * P4.7 §31/§48 — structured data-portability exports that don't map onto
 * one of the twelve report categories `/api/reports/export` serves (a
 * Patient Master export isn't a filtered "report", it's the org's own
 * patient master data; General Ledger/Trial Balance exports are the
 * accounting ledger itself, not a report derived from it). Kept as a
 * separate small route rather than forcing these into `ReportCategory`,
 * which drives the Reports workspace's own tab list.
 */
const EXPORT_TYPES = ["patient-master", "general-ledger", "trial-balance", "collections", "refunds", "stock-movement", "audit-log", "clinical-access-log"] as const
type ExportType = (typeof EXPORT_TYPES)[number]

const REQUIRED_PERMISSION: Record<ExportType, string> = {
  "patient-master": "patient.view",
  "general-ledger": "accounting.view",
  "trial-balance": "accounting.view",
  collections: "payment.view",
  refunds: "payment.view",
  "stock-movement": "inventory.view",
  "audit-log": "audit.review",
  "clinical-access-log": "audit.review",
}

/**
 * P4.7 §30 — audit.review is ALREADY the maximally-restrictive permission
 * for these two (granted to Super Admin/Org Admin only, per seed.ts — no
 * operational role holds it) — requiring `reports.export` on top would be
 * redundant at best and, since none of the seeded management roles
 * (Clinic Manager/Accountant/HR Manager) hold `audit.review` either way,
 * makes no practical difference to who can reach it. Every other export
 * type below stays gated on `reports.export` + its own domain permission,
 * matching every other export in this phase.
 */
const SKIP_REPORTS_EXPORT_GATE: ReadonlySet<ExportType> = new Set(["audit-log", "clinical-access-log"])

export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string }> }) {
  const session = await getCurrentSession()
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in required." } }, { status: 401 })

  const { type } = await params
  if (!EXPORT_TYPES.includes(type as ExportType)) {
    return NextResponse.json({ error: { code: "invalid_type", message: "Unknown export type." } }, { status: 400 })
  }
  const exportType = type as ExportType

  const needsReportsExport = !SKIP_REPORTS_EXPORT_GATE.has(exportType)
  if ((needsReportsExport && !can(session, "reports.export")) || !can(session, REQUIRED_PERMISSION[exportType])) {
    return NextResponse.json({ error: { code: "forbidden", message: "Missing permission for this export." } }, { status: 403 })
  }

  const searchParams = request.nextUrl.searchParams
  const filters = defaultReportFilters({
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    branchId: searchParams.get("branchId") ?? undefined,
  })
  const filterSummary = { from: toDateParam(filters.from), to: toDateParam(filters.to), branchId: filters.branchId ?? null }

  try {
    const { csv, filename } = await buildExport(session, exportType, filters, filterSummary)
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    if (error instanceof ExportTooLargeError) {
      return NextResponse.json({ error: { code: "export_too_large", message: error.message } }, { status: 413 })
    }
    throw error
  }
}

async function buildExport(
  session: NonNullable<Awaited<ReturnType<typeof getCurrentSession>>>,
  type: ExportType,
  filters: ReturnType<typeof defaultReportFilters>,
  filterSummary: Record<string, unknown>
) {
  switch (type) {
    case "patient-master": {
      const rows = await exportPatientMasterRows(session, filters)
      await logSensitiveExport(session, "patient-master-export", { filters: filterSummary, rowCount: rows.length })
      const csv = toCsv(
        ["MRN", "Legacy MRN", "First Name", "Middle Name", "Last Name", "DOB", "Gender", "Nationality", "Mobile", "WhatsApp", "Email", "Address", "City", "Country", "Preferred Language", "Status", "Branch", "Registered"],
        rows.map((p) => [
          p.mrn, p.legacyMrn ?? "", p.firstName, p.middleName ?? "", p.lastName, p.dob, p.gender, p.nationality ?? "",
          p.mobile, p.whatsapp ?? "", p.email ?? "", p.addressLine ?? "", p.city ?? "", p.country ?? "", p.preferredLanguage ?? "",
          p.status, p.registrationBranch.name, p.createdAt,
        ]),
        { bom: true }
      )
      return { csv, filename: `patient-master-export-${toDateParam(new Date())}.csv` }
    }
    case "general-ledger": {
      const rows = await exportGeneralLedgerRows(session, filters)
      await logSensitiveExport(session, "general-ledger-export", { filters: filterSummary, rowCount: rows.length })
      const csv = toCsv(
        ["Journal #", "Date", "Account Code", "Account Name", "Debit", "Credit", "Reference Type", "Reference ID", "Branch", "Memo"],
        rows.map((l) => [
          l.journal.journalNumber, l.journal.journalDate, l.account.code, l.account.name, Number(l.debit), Number(l.credit),
          l.journal.referenceType, l.journal.referenceId ?? "", l.journal.branch.name, l.description ?? l.journal.description,
        ]),
        { bom: true }
      )
      return { csv, filename: `general-ledger-${toDateParam(filters.from)}-to-${toDateParam(filters.to)}.csv` }
    }
    case "trial-balance": {
      const tb = await trialBalance(session, { branchId: filters.branchId, asOf: filters.to })
      await logSensitiveExport(session, "trial-balance-export", { filters: filterSummary, rowCount: tb.lines.length })
      const rows: (string | number)[][] = tb.lines.map((l) => [l.code, l.name, l.type, l.debit, l.credit])
      rows.push(["", "", "TOTAL", tb.totalDebit, tb.totalCredit])
      const csv = toCsv(["Code", "Name", "Type", "Debit", "Credit"], rows, { bom: true })
      return { csv, filename: `trial-balance-as-of-${toDateParam(filters.to)}.csv` }
    }
    case "collections": {
      const rows = await exportCollectionsRows(session, filters)
      const csv = toCsv(
        ["Receipt #", "Date", "Patient/Invoice", "Method", "Amount", "Cashier"],
        rows.map((p) => [
          p.receiptNumber, p.receivedAt,
          p.allocations[0]?.invoice ? `${p.allocations[0].invoice.patient.firstName} ${p.allocations[0].invoice.patient.lastName} (${p.allocations[0].invoice.invoiceNumber})` : "",
          p.method, Number(p.amount), p.receivedByUser ? `${p.receivedByUser.firstName} ${p.receivedByUser.lastName}` : "",
        ]),
        { bom: true }
      )
      return { csv, filename: `collections-${toDateParam(filters.from)}-to-${toDateParam(filters.to)}.csv` }
    }
    case "refunds": {
      const rows = await exportRefundRows(session, filters)
      const csv = toCsv(
        ["Refund #", "Date", "Invoice", "Amount", "Reason", "Status", "Requested By", "Authorized By"],
        rows.map((r) => [
          r.refundNumber ?? "", r.requestedAt, r.invoice.invoiceNumber, Number(r.amount), r.reason, r.status,
          r.requestedByUser ? `${r.requestedByUser.firstName} ${r.requestedByUser.lastName}` : "",
          r.authorizedByUser ? `${r.authorizedByUser.firstName} ${r.authorizedByUser.lastName}` : "",
        ]),
        { bom: true }
      )
      return { csv, filename: `refunds-${toDateParam(filters.from)}-to-${toDateParam(filters.to)}.csv` }
    }
    case "stock-movement": {
      const rows = await exportStockMovementRows(session, filters)
      const csv = toCsv(
        ["Date", "Product", "Batch", "Branch", "Transaction Type", "Quantity", "Reference Type", "Reference ID", "Actor"],
        rows.map((e) => [e.createdAt, e.product.name, e.batch?.batchNumber ?? "", e.branch.name, e.transactionType, Number(e.quantity), e.referenceType ?? "", e.referenceId ?? "", e.performedBy ?? ""]),
        { bom: true }
      )
      return { csv, filename: `stock-movement-${toDateParam(filters.from)}-to-${toDateParam(filters.to)}.csv` }
    }
    case "audit-log": {
      const where = { organizationId: session.user.organizationId, createdAt: { gte: filters.from, lte: filters.to } }
      const total = await db.auditLog.count({ where })
      assertExportRowLimit(total)
      const rows = await db.auditLog.findMany({ where, orderBy: { createdAt: "desc" } })
      const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))]
      const users = userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } }) : []
      const userById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]))
      await logSensitiveExport(session, "audit-log-export", { filters: filterSummary, rowCount: rows.length })
      // §30 — excludes oldValues/newValues (the technical mutation payload)
      // and ip/userAgent from the export entirely: this is an activity
      // trail for review, not a raw table dump.
      const csv = toCsv(
        ["When", "User", "Action", "Entity Type", "Entity ID"],
        rows.map((r) => [r.createdAt, r.userId ? (userById.get(r.userId) ?? "Unknown") : "System", r.action, r.entityType, r.entityId]),
        { bom: true }
      )
      return { csv, filename: `audit-log-${toDateParam(filters.from)}-to-${toDateParam(filters.to)}.csv` }
    }
    case "clinical-access-log": {
      const where = { organizationId: session.user.organizationId, createdAt: { gte: filters.from, lte: filters.to } }
      const total = await db.clinicalAccessLog.count({ where })
      assertExportRowLimit(total)
      const rows = await db.clinicalAccessLog.findMany({
        where,
        include: { patient: { select: { mrn: true } } },
        orderBy: { createdAt: "desc" },
      })
      const userIds = [...new Set(rows.map((r) => r.userId))]
      const users = userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } }) : []
      const userById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]))
      await logSensitiveExport(session, "clinical-access-log-export", { filters: filterSummary, rowCount: rows.length })
      const csv = toCsv(
        ["When", "User", "Patient MRN", "Resource Type", "Resource ID", "Action"],
        rows.map((r) => [r.createdAt, userById.get(r.userId) ?? "Unknown", r.patient.mrn, r.resourceType, r.resourceId ?? "", r.action]),
        { bom: true }
      )
      return { csv, filename: `clinical-access-log-${toDateParam(filters.from)}-to-${toDateParam(filters.to)}.csv` }
    }
  }
}
