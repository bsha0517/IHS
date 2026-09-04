import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getPayrollRun } from "@/lib/domains/payroll/payroll"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { LineEditDialog } from "@/app/(dashboard)/payroll/[id]/line-edit-dialog"
import { MoveToReviewButton, ApproveRunButton, MarkPaidDialog } from "@/app/(dashboard)/payroll/[id]/workflow-actions"

export default async function PayrollRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "payroll.view")) redirect("/dashboard")

  const { id } = await params
  const canProcess = can(session, "payroll.process")
  const run = await getPayrollRun(session, id)
  const editable = run.status === "draft" || run.status === "review"

  const totalNet = run.lines.reduce((sum, l) => sum + Number(l.netSalary), 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Payroll — {formatDate(run.periodStart)} to {formatDate(run.periodEnd)}
          </h1>
          <p className="text-sm text-muted-foreground">
            {run.branch.name} · {run.lines.length} employee(s) · Total net {totalNet.toFixed(2)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={run.status === "paid" ? "default" : "outline"}>{run.status}</Badge>
          {canProcess && run.status === "draft" && <MoveToReviewButton payrollRunId={run.id} />}
          {canProcess && run.status === "review" && <ApproveRunButton payrollRunId={run.id} />}
          {canProcess && run.status === "approved" && <MarkPaidDialog payrollRunId={run.id} />}
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Basic</TableHead>
                <TableHead className="text-right">Allowances</TableHead>
                <TableHead className="text-right">Overtime</TableHead>
                <TableHead className="text-right">Commission</TableHead>
                <TableHead className="text-right">Bonus</TableHead>
                <TableHead className="text-right">Deductions</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.lines.map((l) => {
                const deductions = Number(l.advances) + Number(l.unpaidLeaveDeduction) + Number(l.otherDeductions)
                return (
                  <TableRow key={l.id}>
                    <TableCell>
                      {l.employee.firstName} {l.employee.lastName}
                    </TableCell>
                    <TableCell className="text-right">{Number(l.basicSalary).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(l.allowances).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(l.overtime).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(l.commission).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(l.bonus).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{deductions.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-medium">{Number(l.netSalary).toFixed(2)}</TableCell>
                    <TableCell className="flex items-center gap-1">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/payslips/${l.id}/print`} target="_blank">
                          Payslip
                        </Link>
                      </Button>
                      {editable && canProcess && (
                        <LineEditDialog
                          line={{
                            id: l.id,
                            payrollRunId: run.id,
                            allowances: Number(l.allowances),
                            overtime: Number(l.overtime),
                            bonus: Number(l.bonus),
                            advances: Number(l.advances),
                            unpaidLeaveDeduction: Number(l.unpaidLeaveDeduction),
                            otherDeductions: Number(l.otherDeductions),
                          }}
                        />
                      )}
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
