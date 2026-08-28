import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { incomeStatement, balanceSheet, cashFlow } from "@/lib/domains/accounting/reports"
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

  const [revenue, collections, ar, ap, expenses, income, balance, cash] = await Promise.all([
    db.invoice.aggregate({ where: { organizationId, ...branchWhere, status: { not: "void" }, issuedAt: { gte: filters.from, lte: filters.to } }, _sum: { totalAmount: true } }),
    db.payment.aggregate({ where: { organizationId, ...branchWhere, status: "completed", receivedAt: { gte: filters.from, lte: filters.to } }, _sum: { amount: true } }),
    db.invoice.aggregate({ where: { organizationId, ...branchWhere, status: { in: ["issued", "partially_paid"] } }, _sum: { totalAmount: true, paidAmount: true } }),
    db.supplierInvoice.aggregate({ where: { organizationId, ...branchWhere, status: { in: ["pending", "partially_paid"] } }, _sum: { amount: true, paidAmount: true } }),
    db.expense.aggregate({ where: { organizationId, ...branchWhere, expenseDate: { gte: filters.from, lte: filters.to } }, _sum: { amount: true } }),
    incomeStatement(session, { branchId: filters.branchId, asOf: filters.to }),
    balanceSheet(session, { branchId: filters.branchId, asOf: filters.to }),
    cashFlow(session, { branchId: filters.branchId, from: filters.from, to: filters.to }),
  ])

  return {
    revenue: Number(revenue._sum.totalAmount ?? 0),
    collections: Number(collections._sum.amount ?? 0),
    accountsReceivable: Number(ar._sum.totalAmount ?? 0) - Number(ar._sum.paidAmount ?? 0),
    accountsPayable: Number(ap._sum.amount ?? 0) - Number(ap._sum.paidAmount ?? 0),
    expenses: Number(expenses._sum.amount ?? 0),
    incomeStatement: income,
    balanceSheet: balance,
    cashFlow: cash,
  }
}
