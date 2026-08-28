import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { PayrollRunInput, PayrollLineInput } from "@/lib/domains/payroll/schemas"

const RUN_INCLUDE = { lines: { include: { employee: true, commissionAccruals: true } }, branch: true } as const

export async function listPayrollRuns(session: SessionContext, filters: { branchId?: string; status?: string } = {}) {
  assertCan(session, "payroll.view")
  const scope = getAuthorizedBranchScope(session)
  return db.payrollRun.findMany({
    where: { organizationId: session.user.organizationId, branchId: narrowBranchFilter(scope, filters.branchId), status: filters.status as never },
    include: RUN_INCLUDE,
    orderBy: { periodStart: "desc" },
  })
}

export async function getPayrollRun(session: SessionContext, id: string) {
  assertCan(session, "payroll.view")
  const run = await db.payrollRun.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId }, include: RUN_INCLUDE })
  assertBranchAccess(getAuthorizedBranchScope(session), run.branchId)
  return run
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

/**
 * Draft/Review -> Approved (spec.md §52). Posts Dr Salary Expense / Cr
 * Payroll Payable via the central posting service.
 *
 * P1 §32/§33 (finding B10): previously updated status and called
 * `postPayrollApproved` as two separate, unprotected steps — every other
 * financial-posting trigger in this codebase (Invoice, Payment, Refund,
 * GoodsReceipt, SupplierPayment, PackageSession) writes its state change
 * and an outbox event in ONE transaction, then dispatches, so a posting
 * failure lands in the P0-02 retry/dead-letter machinery (visible and
 * retryable from `/admin/system-events`) instead of leaving the run
 * permanently stuck. If `postPayrollApproved` threw before this fix (most
 * plausibly a missing account mapping), the run was already committed
 * `"approved"` with no journal and no way to retry short of a manual
 * journal entry — this closes that gap. The `updateMany` status
 * precondition is the same "claim before acting" idempotency guard as
 * `dispenseRecord`/`completeRefund`: a double-click/retry can't
 * double-approve the same run.
 */
export async function approvePayrollRun(session: SessionContext, payrollRunId: string) {
  assertCan(session, "payroll.process")

  const run = await db.payrollRun.findFirstOrThrow({ where: { id: payrollRunId, organizationId: session.user.organizationId } })
  if (run.status === "approved" || run.status === "paid") throw new Error(`This payroll run is already "${run.status}".`)

  const updated = await db.$transaction(async (tx) => {
    const claimed = await tx.payrollRun.updateMany({
      where: { id: payrollRunId, status: { in: ["draft", "review"] } },
      data: { status: "approved", approvedBy: session.user.id, approvedAt: new Date() },
    })
    if (claimed.count === 0) {
      throw new Error("This payroll run was already approved (or its status changed) — refresh and try again.")
    }
    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "PayrollApproved",
      payload: { payrollRunId },
    })
    return tx.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } })
  })

  await auditFromSession(session, "update", "payroll_run", payrollRunId, { new: { status: "approved" } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}

/**
 * Approved -> Paid. Posts Dr Payroll Payable / Cr [paidVia's resolved
 * account] and flips every included commission accrual to `paid`.
 *
 * P1 §32/§33 (finding B10, second half): same fix as `approvePayrollRun`
 * above — the status update, the commission-accrual flip, and the outbox
 * event now commit together in one transaction, with a claim-before-act
 * guard against double-marking the same run paid.
 */
export async function markPayrollPaid(session: SessionContext, payrollRunId: string, paidVia: string) {
  assertCan(session, "payroll.process")

  const run = await db.payrollRun.findFirstOrThrow({ where: { id: payrollRunId, organizationId: session.user.organizationId } })
  if (run.status !== "approved") throw new Error("Only an approved payroll run can be marked paid.")

  const updated = await db.$transaction(async (tx) => {
    const claimed = await tx.payrollRun.updateMany({
      where: { id: payrollRunId, status: "approved" },
      data: { status: "paid", paidVia: paidVia as never, paidAt: new Date() },
    })
    if (claimed.count === 0) {
      throw new Error("This payroll run was already marked paid (or its status changed) — refresh and try again.")
    }
    await tx.commissionAccrual.updateMany({
      where: { payrollRunLine: { payrollRunId } },
      data: { status: "paid" },
    })
    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "PayrollPaid",
      payload: { payrollRunId },
    })
    return tx.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId } })
  })

  await auditFromSession(session, "update", "payroll_run", payrollRunId, { new: { status: "paid", paidVia } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}
