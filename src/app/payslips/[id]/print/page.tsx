import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getPayrollLinePayslip } from "@/lib/domains/payroll/payroll"
import { getOrganizationIdentity } from "@/lib/domains/identity/org-structure"
import { formatDate } from "@/lib/utils/dates"
import { PrintButton } from "@/app/prescriptions/[id]/print/print-button"

/**
 * P3.10 §39-43 — Case B: PayrollRun/PayrollRunLine already existed with a
 * full draft->review->approved->paid lifecycle, but nothing ever produced a
 * payslip from that data. This page is that missing read-only output, not a
 * new payroll model — every figure below comes straight from the stored
 * PayrollRunLine row (see getPayrollLinePayslip's own doc comment).
 *
 * Deliberately outside the (dashboard) route group — no sidebar/topbar
 * chrome — matching every other printable document in this codebase
 * (prescriptions/lab/radiology/invoice/payment). Uses the same narrow
 * `getOrganizationIdentity` read those pages use, never `settings.view`.
 * `[id]` is the PayrollRunLine id (the printable unit is one employee's one
 * payroll line, not the whole run).
 */
export default async function PayslipPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const { id } = await params
  const [line, organization] = await Promise.all([getPayrollLinePayslip(session, id), getOrganizationIdentity(session)])
  const { employee, payrollRun } = line

  const grossPay = Number(line.basicSalary) + Number(line.allowances) + Number(line.overtime) + Number(line.commission) + Number(line.bonus)
  const isDraft = payrollRun.status === "draft" || payrollRun.status === "review"

  return (
    <div className="mx-auto max-w-2xl p-8 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <div className="border-b border-border pb-4 text-center">
        <h1 className="text-xl font-semibold">{organization.displayName}</h1>
        <p className="text-sm text-muted-foreground">Payslip</p>
        <p className="text-sm text-muted-foreground">
          {formatDate(payrollRun.periodStart)} – {formatDate(payrollRun.periodEnd)}
        </p>
        {isDraft && (
          <p className="mt-1 text-xs font-medium text-amber-600">
            DRAFT — this payroll run has not been finalized yet; figures may still change.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 border-b border-border py-4 text-sm">
        <div>
          <p className="text-muted-foreground">Employee</p>
          <p className="font-medium">
            {employee.firstName} {employee.lastName} ({employee.employeeNumber})
          </p>
          <p className="text-muted-foreground">{employee.designation}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Branch / Department</p>
          <p className="font-medium">{employee.branch.name}</p>
          <p className="text-muted-foreground">{employee.department?.name ?? "—"}</p>
        </div>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-2">Earnings</th>
            <th className="py-2 text-right">Amount</th>
            <th className="py-2 pl-8">Deductions</th>
            <th className="py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border/50">
            <td className="py-2">Basic salary</td>
            <td className="py-2 text-right">{Number(line.basicSalary).toFixed(2)}</td>
            <td className="py-2 pl-8">Advances</td>
            <td className="py-2 text-right">{Number(line.advances).toFixed(2)}</td>
          </tr>
          <tr className="border-b border-border/50">
            <td className="py-2">Allowances</td>
            <td className="py-2 text-right">{Number(line.allowances).toFixed(2)}</td>
            <td className="py-2 pl-8">Unpaid leave</td>
            <td className="py-2 text-right">{Number(line.unpaidLeaveDeduction).toFixed(2)}</td>
          </tr>
          <tr className="border-b border-border/50">
            <td className="py-2">Overtime</td>
            <td className="py-2 text-right">{Number(line.overtime).toFixed(2)}</td>
            <td className="py-2 pl-8">Other deductions</td>
            <td className="py-2 text-right">{Number(line.otherDeductions).toFixed(2)}</td>
          </tr>
          <tr className="border-b border-border/50">
            <td className="py-2">Commission</td>
            <td className="py-2 text-right">{Number(line.commission).toFixed(2)}</td>
            <td className="py-2 pl-8" />
            <td className="py-2 text-right" />
          </tr>
          <tr className="border-b border-border/50">
            <td className="py-2">Bonus</td>
            <td className="py-2 text-right">{Number(line.bonus).toFixed(2)}</td>
            <td className="py-2 pl-8" />
            <td className="py-2 text-right" />
          </tr>
        </tbody>
      </table>

      <div className="mt-4 ml-auto grid w-full max-w-xs gap-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Gross pay</span>
          <span>{grossPay.toFixed(2)}</span>
        </div>
        <div className="flex justify-between border-t border-border pt-1 text-base font-semibold">
          <span>Net pay</span>
          <span>{Number(line.netSalary).toFixed(2)}</span>
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-4 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Payroll status</span>
          <span className="capitalize">{payrollRun.status}</span>
        </div>
        {payrollRun.status === "paid" && (
          <>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Paid via</span>
              <span className="capitalize">{payrollRun.paidVia ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Paid on</span>
              <span>{payrollRun.paidAt ? formatDate(payrollRun.paidAt) : "—"}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
