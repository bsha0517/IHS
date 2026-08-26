import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { postPayrollApproved, postPayrollPaid } from "@/lib/domains/accounting/posting-service"
import type { SessionContext } from "@/lib/auth/session"
import type { PayrollRunInput, PayrollLineInput } from "@/lib/domains/payroll/schemas"

const RUN_INCLUDE = { lines: { include: { employee: true, commissionAccruals: true } }, branch: true } as const

export async function listPayrollRuns(session: SessionContext, filters: { branchId?: string; status?: string } = {}) {
  assertCan(session, "payroll.view")
  return db.payrollRun.findMany({
    where: { organizationId: session.user.organizationId, branchId: filters.branchId, status: filters.status as never },
    include: RUN_INCLUDE,
    orderBy: { periodStart: "desc" },
  })
}

export async function getPayrollRun(session: SessionContext, id: string) {
  assertCan(session, "payroll.view")
  return db.payrollRun.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId }, include: RUN_INCLUDE })
}

/**
 * Creates the draft run and one line per active employee in the branch,
 * pulling basicSalary from Employee and — for employees linked to a
 * Provider — their pending CommissionAccrual total for this period, marking
 * those accruals `included_in_payroll` (never left dangling as still
 * "pending" once they're on a run, so a second run can't double-count them).
 */
export async function createPayrollRun(session: SessionContext, input: PayrollRunInput) {
  assertCan(session, "payroll.process", { branchId: input.branchId })

  const employees = await db.employee.findMany({
    where: { organizationId: session.user.organizationId, branchId: input.branchId, status: { not: "terminated" } },
    include: { providerProfile: true },
  })
  if (employees.length === 0) throw new Error("No active employees in this branch to run payroll for.")

  const run = await db.$transaction(async (tx) => {
    const created = await tx.payrollRun.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        createdBy: session.user.id,
      },
    })

    for (const employee of employees) {
      let commission = new Decimal(0)
      const pendingAccrualIds: string[] = []
      if (employee.providerProfile) {
        const accruals = await tx.commissionAccrual.findMany({
          where: { organizationId: session.user.organizationId, providerId: employee.providerProfile.id, status: "pending" },
        })
        for (const a of accruals) {
          commission = commission.add(a.amount)
          pendingAccrualIds.push(a.id)
        }
      }

      const netSalary = new Decimal(employee.basicSalary).add(commission)
      const line = await tx.payrollRunLine.create({
        data: {
          payrollRunId: created.id,
          employeeId: employee.id,
          basicSalary: employee.basicSalary,
          commission,
          netSalary,
        },
      })

      if (pendingAccrualIds.length > 0) {
        await tx.commissionAccrual.updateMany({
          where: { id: { in: pendingAccrualIds } },
          data: { status: "included_in_payroll", payrollRunLineId: line.id },
        })
      }
    }

    return created
  })

  await auditFromSession(session, "create", "payroll_run", run.id, {
    new: { branchId: input.branchId, periodStart: input.periodStart, periodEnd: input.periodEnd, employeeCount: employees.length },
  })
  return run
}

/** Editable while still draft/review — recomputes netSalary from the formula in spec.md §52. */
export async function updatePayrollLine(session: SessionContext, lineId: string, input: PayrollLineInput) {
  assertCan(session, "payroll.process")

  const line = await db.payrollRunLine.findFirstOrThrow({
    where: { id: lineId, payrollRun: { organizationId: session.user.organizationId } },
    include: { payrollRun: true },
  })
  if (line.payrollRun.status === "approved" || line.payrollRun.status === "paid") {
    throw new Error("Cannot edit a line on an approved or paid payroll run.")
  }

  const netSalary = new Decimal(line.basicSalary)
    .add(input.allowances)
    .add(input.overtime)
    .add(line.commission)
    .add(input.bonus)
    .sub(input.advances)
    .sub(input.unpaidLeaveDeduction)
    .sub(input.otherDeductions)

  const updated = await db.payrollRunLine.update({
    where: { id: lineId },
    data: {
      allowances: input.allowances,
      overtime: input.overtime,
      bonus: input.bonus,
      advances: input.advances,
      unpaidLeaveDeduction: input.unpaidLeaveDeduction,
      otherDeductions: input.otherDeductions,
      netSalary,
    },
  })
  await auditFromSession(session, "update", "payroll_run_line", lineId, { new: input })
  return updated
}

export async function movePayrollToReview(session: SessionContext, payrollRunId: string) {
  assertCan(session, "payroll.process")
  const run = await db.payrollRun.findFirstOrThrow({ where: { id: payrollRunId, organizationId: session.user.organizationId } })
  if (run.status !== "draft") throw new Error(`This payroll run is already "${run.status}".`)
  return db.payrollRun.update({ where: { id: payrollRunId }, data: { status: "review" } })
}

/** Draft/Review -> Approved (spec.md §52). Posts Dr Salary Expense / Cr Payroll Payable via the central posting service. */
export async function approvePayrollRun(session: SessionContext, payrollRunId: string) {
  assertCan(session, "payroll.process")

  const run = await db.payrollRun.findFirstOrThrow({ where: { id: payrollRunId, organizationId: session.user.organizationId } })
  if (run.status === "approved" || run.status === "paid") throw new Error(`This payroll run is already "${run.status}".`)

  const updated = await db.payrollRun.update({
    where: { id: payrollRunId },
    data: { status: "approved", approvedBy: session.user.id, approvedAt: new Date() },
  })
  await postPayrollApproved(payrollRunId)
  await auditFromSession(session, "update", "payroll_run", payrollRunId, { new: { status: "approved" } })
  return updated
}

/** Approved -> Paid. Posts Dr Payroll Payable / Cr [paidVia's resolved account] and flips every included commission accrual to `paid`. */
export async function markPayrollPaid(session: SessionContext, payrollRunId: string, paidVia: string) {
  assertCan(session, "payroll.process")

  const run = await db.payrollRun.findFirstOrThrow({ where: { id: payrollRunId, organizationId: session.user.organizationId } })
  if (run.status !== "approved") throw new Error("Only an approved payroll run can be marked paid.")

  const updated = await db.$transaction(async (tx) => {
    const result = await tx.payrollRun.update({
      where: { id: payrollRunId },
      data: { status: "paid", paidVia: paidVia as never, paidAt: new Date() },
    })
    await tx.commissionAccrual.updateMany({
      where: { payrollRunLine: { payrollRunId } },
      data: { status: "paid" },
    })
    return result
  })

  await postPayrollPaid(payrollRunId)
  await auditFromSession(session, "update", "payroll_run", payrollRunId, { new: { status: "paid", paidVia } })
  return updated
}
