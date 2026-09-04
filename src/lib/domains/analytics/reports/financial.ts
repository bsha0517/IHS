import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { getFinancialStatements, cashFlow } from "@/lib/domains/accounting/reports"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

/**
 * spec.md §65's "Financial" report bullets: Revenue, Collections, AR, AP,
 * Expenses, P&L, Balance Sheet, Cash Flow. P&L/Balance Sheet/Cash Flow are
 * NOT reimplemented here — they're the exact same live-computed functions
 * Phase 6 built in accounting/reports.ts for the /accounting workspace,
 * reused as-is (ARCHITECTURE.md §1's "no business rule implemented twice").
 * AR/AP are reported as their current outstanding balance rather than a
 * period-bounded figure — Invoice.paidAmount/SupplierInvoice.paidAmount are
 * current-state fields with no point-in-time snapshot history, so an
 * "AR as of a past date" figure isn't a real number this schema can produce
 * without a fake reconstruction — a documented simplification, not a faked one.
 */
export async function getFinancialReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "accounting.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, filters.branchId)
  const branchWhere = scopedBranchId !== undefined ? { branchId: scopedBranchId } : {}

  // P2 §9: income statement and balance sheet share the same underlying
  // account-balance aggregation and the same filters here — fetched once
  // via getFinancialStatements instead of two independent scans.
  const [revenue, collections, ar, ap, expenses, statements, cash] = await Promise.all([
    db.invoice.aggregate({ where: { organizationId, ...branchWhere, status: { not: "void" }, issuedAt: { gte: filters.from, lte: filters.to } }, _sum: { totalAmount: true } }),
    db.payment.aggregate({ where: { organizationId, ...branchWhere, status: "completed", receivedAt: { gte: filters.from, lte: filters.to } }, _sum: { amount: true } }),
    db.invoice.aggregate({ where: { organizationId, ...branchWhere, status: { in: ["issued", "partially_paid"] } }, _sum: { totalAmount: true, paidAmount: true } }),
    db.supplierInvoice.aggregate({ where: { organizationId, ...branchWhere, status: { in: ["pending", "partially_paid"] } }, _sum: { amount: true, paidAmount: true } }),
    db.expense.aggregate({ where: { organizationId, ...branchWhere, expenseDate: { gte: filters.from, lte: filters.to } }, _sum: { amount: true } }),
    getFinancialStatements(session, { branchId: filters.branchId, asOf: filters.to }),
    cashFlow(session, { branchId: filters.branchId, from: filters.from, to: filters.to }),
  ])

  const [arAging, apAging] = await Promise.all([
    agingBuckets(organizationId, branchWhere),
    apAgingBuckets(organizationId, branchWhere),
  ])

  return {
    revenue: Number(revenue._sum.totalAmount ?? 0),
    collections: Number(collections._sum.amount ?? 0),
    accountsReceivable: Number(ar._sum.totalAmount ?? 0) - Number(ar._sum.paidAmount ?? 0),
    accountsPayable: Number(ap._sum.amount ?? 0) - Number(ap._sum.paidAmount ?? 0),
    expenses: Number(expenses._sum.amount ?? 0),
    incomeStatement: statements.incomeStatement,
    balanceSheet: statements.balanceSheet,
    cashFlow: cash,
    arAging,
    apAging,
  }
}

type AgingBuckets = { current: number; d1to30: number; d31to60: number; d61to90: number; d90plus: number; total: number }

function bucketFor(daysOld: number): keyof Omit<AgingBuckets, "total"> {
  if (daysOld <= 0) return "current"
  if (daysOld <= 30) return "d1to30"
  if (daysOld <= 60) return "d31to60"
  if (daysOld <= 90) return "d61to90"
  return "d90plus"
}

/**
 * P4.7 §16 — Accounts Receivable Aging. `Invoice` has no `dueDate` field
 * (§16's own explicit instruction: "If due date is not modeled, use invoice
 * date and label agin accordingly. Do not invent due dates.") — every
 * bucket here is aged from `issuedAt`, exposed as `basis: "issuedAt"` so the
 * UI/export can label it honestly rather than implying a due-date basis
 * this schema doesn't have.
 */
async function agingBuckets(organizationId: string, branchWhere: { branchId?: string | { in: string[] } }): Promise<AgingBuckets & { basis: "issuedAt" }> {
  const outstanding = await db.invoice.findMany({
    where: { organizationId, ...branchWhere, status: { in: ["issued", "partially_paid"] } },
    select: { totalAmount: true, paidAmount: true, issuedAt: true },
  })
  const now = Date.now()
  const buckets: AgingBuckets = { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0, total: 0 }
  for (const inv of outstanding) {
    const balance = Number(inv.totalAmount) - Number(inv.paidAmount)
    if (balance <= 0) continue
    const daysOld = Math.floor((now - inv.issuedAt.getTime()) / 86_400_000)
    buckets[bucketFor(daysOld)] += balance
    buckets.total += balance
  }
  return { ...buckets, basis: "issuedAt" }
}

/**
 * P4.7 §21 — Accounts Payable Aging. `SupplierInvoice.dueDate` IS modeled
 * (unlike Invoice) but is nullable — a row with no due date recorded is
 * excluded from the aged buckets (there is no honest bucket to put it in)
 * and counted separately in `undated`/`undatedAmount`, rather than silently
 * treated as either current or invented a due date for it.
 */
async function apAgingBuckets(organizationId: string, branchWhere: { branchId?: string | { in: string[] } }): Promise<AgingBuckets & { basis: "dueDate"; undated: number; undatedAmount: number }> {
  const outstanding = await db.supplierInvoice.findMany({
    where: { organizationId, ...branchWhere, status: { in: ["pending", "partially_paid"] } },
    select: { amount: true, taxAmount: true, paidAmount: true, dueDate: true },
  })
  const now = Date.now()
  const buckets: AgingBuckets = { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0, total: 0 }
  let undated = 0
  let undatedAmount = 0
  for (const inv of outstanding) {
    const balance = Number(inv.amount) + Number(inv.taxAmount) - Number(inv.paidAmount)
    if (balance <= 0) continue
    if (!inv.dueDate) {
      undated += 1
      undatedAmount += balance
      continue
    }
    const daysOld = Math.floor((now - inv.dueDate.getTime()) / 86_400_000)
    buckets[bucketFor(daysOld)] += balance
    buckets.total += balance
  }
  return { ...buckets, basis: "dueDate", undated, undatedAmount }
}
