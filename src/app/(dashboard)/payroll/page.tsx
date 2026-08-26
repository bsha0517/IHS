import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listPayrollRuns } from "@/lib/domains/payroll/payroll"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { NewRunDialog } from "@/app/(dashboard)/payroll/new-run-dialog"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  review: "secondary",
  approved: "secondary",
  paid: "default",
}

export default async function PayrollPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "payroll.view")) redirect("/dashboard")

  const canProcess = can(session, "payroll.process")
  const [runs, branches] = await Promise.all([listPayrollRuns(session), listAccessibleBranches(session)])
  const branchOptions = branches.map((b) => ({ id: b.id, name: b.name }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Payroll</h1>
        {canProcess && <NewRunDialog branches={branchOptions} />}
      </div>

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Employees</TableHead>
                <TableHead className="text-right">Total Net</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No payroll runs yet.
                  </TableCell>
                </TableRow>
              )}
              {runs.map((r) => {
                const totalNet = r.lines.reduce((sum, l) => sum + Number(l.netSalary), 0)
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/payroll/${r.id}`} className="font-medium hover:underline">
                        {formatDate(r.periodStart)} – {formatDate(r.periodEnd)}
                      </Link>
                    </TableCell>
                    <TableCell>{r.branch.name}</TableCell>
                    <TableCell>{r.lines.length}</TableCell>
                    <TableCell className="text-right">{totalNet.toFixed(2)}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
