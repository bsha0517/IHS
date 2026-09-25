import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listExpenses } from "@/lib/domains/accounting/expenses"
import { listAccounts } from "@/lib/domains/accounting/chart-of-accounts"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ExpenseDialog } from "@/app/(dashboard)/expenses/expense-dialog"

export default async function ExpensesPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "accounting.view")) redirect("/dashboard")

  const canCreate = can(session, "expense.create")

  const [expenses, accounts, branches] = await Promise.all([
    listExpenses(session),
    listAccounts(session),
    listAccessibleBranches(session),
  ])

  const expenseAccounts = accounts.filter((a) => a.type === "expense").map((a) => ({ id: a.id, code: a.code, name: a.name }))
  const branchOptions = branches.map((b) => ({ id: b.id, name: b.name }))
  const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Expenses"
        module="finance"
        description={`${expenses.length} expense(s) — ${total.toFixed(2)} total`}
        primaryAction={canCreate && <ExpenseDialog branches={branchOptions} expenseAccounts={expenseAccounts} />}
      />

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Paid via</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No expenses recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {expenses.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{formatDate(e.expenseDate)}</TableCell>
                  <TableCell>{e.branch.name}</TableCell>
                  <TableCell>
                    {e.expenseAccount.code} — {e.expenseAccount.name}
                  </TableCell>
                  <TableCell>{e.description}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{e.paidVia}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{Number(e.amount).toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
