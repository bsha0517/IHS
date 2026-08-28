import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { postExpense } from "@/lib/domains/accounting/posting-service"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { ExpenseInput } from "@/lib/domains/accounting/schemas"

/**
 * A direct accountant action, unlike the outbox-driven postings — the user
 * is sitting at the Expense form expecting immediate confirmation the entry
 * posted, so this posts synchronously in the same transaction as the row
 * rather than via the async outbox pattern used for cross-domain triggers.
 */
export async function createExpense(session: SessionContext, input: ExpenseInput) {
  assertCan(session, "expense.create", { branchId: input.branchId })

  const result = await db.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        expenseAccountId: input.expenseAccountId,
        description: input.description,
        amount: new Decimal(input.amount),
        paidVia: input.paidVia,
        expenseDate: input.expenseDate,
        paidBy: session.user.id,
      },
    })

    await postExpense(tx, {
      organizationId: session.user.organizationId,
      branchId: input.branchId,
      expenseId: expense.id,
      expenseAccountId: input.expenseAccountId,
      amount: input.amount,
      paidVia: input.paidVia,
      description: input.description,
      postedBy: session.user.id,
    })

    return expense
  })

  await auditFromSession(session, "create", "expense", result.id, {
    new: { description: result.description, amount: input.amount },
  })
  return result
}

export async function listExpenses(session: SessionContext, filters: { branchId?: string } = {}) {
  assertCan(session, "accounting.view")
  const scope = getAuthorizedBranchScope(session)
  return db.expense.findMany({
    where: { organizationId: session.user.organizationId, branchId: narrowBranchFilter(scope, filters.branchId) },
    include: { expenseAccount: true, branch: true },
    orderBy: { expenseDate: "desc" },
    take: 200,
  })
}
