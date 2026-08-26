import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { Prisma } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"

/**
 * Every report here is computed live from journal_line at read time — never
 * a stored/cached total (spec.md §92: "never trust frontend totals" extends
 * to never trusting a stale server-side aggregate either). Deliberately
 * simple SQL over Prisma's aggregate API since these need GROUP BY account
 * with type-aware sign flips that Prisma's query builder can't express in
 * one round trip.
 */

type AccountBalanceRow = { id: string; code: string; name: string; type: string; debit: number; credit: number }

async function accountBalances(organizationId: string, branchId?: string, asOf?: Date): Promise<AccountBalanceRow[]> {
  const branchFilter = branchId ? Prisma.sql`AND j.branch_id = ${branchId}` : Prisma.sql``
  const asOfFilter = asOf ? Prisma.sql`AND j.journal_date <= ${asOf}` : Prisma.sql``

  const rows = await db.$queryRaw<AccountBalanceRow[]>(Prisma.sql`
    SELECT
      a.id, a.code, a.name, a.type,
      COALESCE(SUM(jl.debit), 0)::float AS debit,
      COALESCE(SUM(jl.credit), 0)::float AS credit
    FROM "chart_of_account" a
    LEFT JOIN "journal_line" jl ON jl.account_id = a.id
    LEFT JOIN "journal" j ON j.id = jl.journal_id
      AND j.organization_id = ${organizationId}
      ${branchFilter}
      ${asOfFilter}
    WHERE a.organization_id = ${organizationId}
    GROUP BY a.id, a.code, a.name, a.type
    ORDER BY a.code
  `)
  return rows
}

/** Debit-normal (asset, expense) balance = debit - credit; credit-normal (liability, equity, revenue) = credit - debit. */
function netBalance(row: AccountBalanceRow): number {
  const isDebitNormal = row.type === "asset" || row.type === "expense"
  return isDebitNormal ? row.debit - row.credit : row.credit - row.debit
}

export async function trialBalance(session: SessionContext, filters: { branchId?: string; asOf?: Date } = {}) {
  assertCan(session, "accounting.view")
  const rows = await accountBalances(session.user.organizationId, filters.branchId, filters.asOf)
  const lines = rows
    .filter((r) => r.debit !== 0 || r.credit !== 0)
    .map((r) => {
      const isDebitNormal = r.type === "asset" || r.type === "expense"
      const balance = netBalance(r)
      return {
        accountId: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        debit: isDebitNormal ? Math.max(balance, 0) : Math.max(-balance, 0),
        credit: isDebitNormal ? Math.max(-balance, 0) : Math.max(balance, 0),
      }
    })
  const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0)
  const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0)
  return { lines, totalDebit, totalCredit, isBalanced: Math.abs(totalDebit - totalCredit) < 0.01 }
}

export async function incomeStatement(session: SessionContext, filters: { branchId?: string; asOf?: Date } = {}) {
  assertCan(session, "accounting.view")
  const rows = await accountBalances(session.user.organizationId, filters.branchId, filters.asOf)
  const revenueLines = rows.filter((r) => r.type === "revenue" && (r.debit !== 0 || r.credit !== 0)).map((r) => ({ code: r.code, name: r.name, amount: netBalance(r) }))
  const expenseLines = rows.filter((r) => r.type === "expense" && (r.debit !== 0 || r.credit !== 0)).map((r) => ({ code: r.code, name: r.name, amount: netBalance(r) }))
  const totalRevenue = revenueLines.reduce((sum, l) => sum + l.amount, 0)
  const totalExpense = expenseLines.reduce((sum, l) => sum + l.amount, 0)
  return { revenueLines, expenseLines, totalRevenue, totalExpense, netIncome: totalRevenue - totalExpense }
}

export async function balanceSheet(session: SessionContext, filters: { branchId?: string; asOf?: Date } = {}) {
  assertCan(session, "accounting.view")
  const rows = await accountBalances(session.user.organizationId, filters.branchId, filters.asOf)
  const assetLines = rows.filter((r) => r.type === "asset" && (r.debit !== 0 || r.credit !== 0)).map((r) => ({ code: r.code, name: r.name, amount: netBalance(r) }))
  const liabilityLines = rows.filter((r) => r.type === "liability" && (r.debit !== 0 || r.credit !== 0)).map((r) => ({ code: r.code, name: r.name, amount: netBalance(r) }))
  const equityLines = rows.filter((r) => r.type === "equity" && (r.debit !== 0 || r.credit !== 0)).map((r) => ({ code: r.code, name: r.name, amount: netBalance(r) }))

  // Retained earnings isn't its own account — it's the running net income
  // (revenue - expense) folded into equity, same as any standard balance
  // sheet where a "Close the books" step hasn't been run yet.
  const income = await incomeStatement(session, filters)
  const totalAssets = assetLines.reduce((sum, l) => sum + l.amount, 0)
  const totalLiabilities = liabilityLines.reduce((sum, l) => sum + l.amount, 0)
  const totalEquity = equityLines.reduce((sum, l) => sum + l.amount, 0) + income.netIncome

  return {
    assetLines,
    liabilityLines,
    equityLines: [...equityLines, { code: "—", name: "Retained Earnings (current period)", amount: income.netIncome }],
    totalAssets,
    totalLiabilities,
    totalEquity,
    isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  }
}

/** Simplified direct-method cash flow: every journal line touching a "cash"-mapped account, grouped by counterparty account. */
export async function cashFlow(session: SessionContext, filters: { branchId?: string; from?: Date; to?: Date } = {}) {
  assertCan(session, "accounting.view")

  const cashAccounts = await db.chartOfAccount.findMany({
    where: { organizationId: session.user.organizationId, code: { in: ["1000", "1010"] } },
  })
  const cashAccountIds = cashAccounts.map((a) => a.id)
  if (cashAccountIds.length === 0) return { inflows: [], outflows: [], netChange: 0 }

  const lines = await db.journalLine.findMany({
    where: {
      accountId: { in: cashAccountIds },
      journal: {
        organizationId: session.user.organizationId,
        branchId: filters.branchId,
        journalDate: { gte: filters.from, lte: filters.to },
      },
    },
    include: { journal: true },
    orderBy: { journal: { journalDate: "desc" } },
  })

  const inflows = lines.filter((l) => Number(l.debit) > 0).map((l) => ({ date: l.journal.journalDate, description: l.journal.description, amount: Number(l.debit) }))
  const outflows = lines.filter((l) => Number(l.credit) > 0).map((l) => ({ date: l.journal.journalDate, description: l.journal.description, amount: Number(l.credit) }))
  const netChange = inflows.reduce((sum, l) => sum + l.amount, 0) - outflows.reduce((sum, l) => sum + l.amount, 0)
  return { inflows, outflows, netChange }
}

export async function listJournals(session: SessionContext, filters: { branchId?: string; referenceType?: string } = {}) {
  assertCan(session, "accounting.view")
  return db.journal.findMany({
    where: { organizationId: session.user.organizationId, branchId: filters.branchId, referenceType: filters.referenceType },
    include: { lines: { include: { account: true } }, branch: true },
    orderBy: { journalDate: "desc" },
    take: 200,
  })
}

export async function getJournal(session: SessionContext, id: string) {
  assertCan(session, "accounting.view")
  return db.journal.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { lines: { include: { account: true } }, branch: true },
  })
}
