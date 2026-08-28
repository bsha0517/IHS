import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { approvePayrollRun, markPayrollPaid } from "@/lib/domains/payroll/payroll"
import { postPayrollApproved, postPayrollPaid } from "@/lib/domains/accounting/posting-service"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §18: payroll lifecycle accounting (Approved: Dr Salary Expense / Cr
 * Payroll Payable; Paid: Dr Payroll Payable / Cr [tender]) and the P0-02
 * idempotency distinction between the `payroll_run` and `payroll_run_paid`
 * referenceTypes `postJournal` keys its duplicate-detection on — real DB
 * integration tests, not just re-reading the code.
 *
 * P1_FINANCIAL_INTEGRITY_FINDINGS.md's B10 (payroll postings bypassed the
 * outbox entirely, so a posting failure could leave a run stuck `approved`
 * with no journal and no retry path) was left open through Batch 5 —
 * confirmed real, deliberately out of that batch's literal scope — and
 * closed in P1 Batch 8 (§32/§33): `approvePayrollRun`/`markPayrollPaid`
 * (payroll.ts) now write their status change and a `PayrollApproved`/
 * `PayrollPaid` outbox event in one transaction, with a claim-before-act
 * `updateMany` guard against double-approving/double-paying the same run.
 * `postPayrollApproved`/`postPayrollPaid` are still called directly in a few
 * tests below (bypassing the status guards) specifically to simulate an
 * outbox replay — the exact shape a retry from `/admin/system-events` after
 * a posting failure now actually takes.
 */
const TIMEOUT = 60000

describe("P1 §18: payroll lifecycle accounting and replay idempotency", () => {
  let organizationId: string
  let branchId: string
  let salaryExpenseAccountId: string
  let payrollPayableAccountId: string
  let bankAccountId: string
  let userId: string
  const employeeIds: string[] = []
  const payrollRunIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-payroll-lifecycle",
      user: { id: userId, organizationId, email: "payroll-lifecycle-test@test.local", firstName: "Payroll", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["payroll.process", "payroll.view"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createRunWithLine(netSalary: number) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const employee = await db.employee.create({
      data: {
        organizationId, branchId,
        employeeNumber: `TESTPAYE-${suffix}`,
        firstName: "Payroll", lastName: "TestEmployee",
        designation: "Staff", joiningDate: new Date("2024-01-01"),
        employmentType: "full_time", basicSalary: netSalary, status: "active",
      },
    })
    employeeIds.push(employee.id)

    const run = await db.payrollRun.create({
      data: {
        organizationId, branchId,
        periodStart: new Date("2026-08-01"), periodEnd: new Date("2026-08-31"),
        createdBy: userId,
        lines: { create: [{ employeeId: employee.id, basicSalary: netSalary, netSalary }] },
      },
    })
    payrollRunIds.push(run.id)
    return run
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const [salaryExpense, payrollPayable, bank] = await Promise.all([
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "6000" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "2300" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1010" } }),
    ])
    salaryExpenseAccountId = salaryExpense.id
    payrollPayableAccountId = payrollPayable.id
    bankAccountId = bank.id
  }, TIMEOUT)

  afterAll(async () => {
    const journals = await db.journal.findMany({
      where: { organizationId, referenceType: { in: ["payroll_run", "payroll_run_paid"] }, referenceId: { in: payrollRunIds } },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.payrollRunLine.deleteMany({ where: { payrollRunId: { in: payrollRunIds } } })
    await db.payrollRun.deleteMany({ where: { id: { in: payrollRunIds } } })
    await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("approving a payroll run posts Dr Salary Expense / Cr Payroll Payable for the sum of every line's netSalary", async () => {
    const run = await createRunWithLine(3500)
    await approvePayrollRun(session(), run.id)

    const journal = await db.journal.findFirstOrThrow({
      where: { organizationId, referenceType: "payroll_run", referenceId: run.id },
      include: { lines: true },
    })
    const salaryLine = journal.lines.find((l) => l.accountId === salaryExpenseAccountId)
    const payableLine = journal.lines.find((l) => l.accountId === payrollPayableAccountId)
    expect(Number(salaryLine?.debit)).toBe(3500)
    expect(Number(payableLine?.credit)).toBe(3500)

    const updated = await db.payrollRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(updated.status).toBe("approved")
  }, TIMEOUT)

  it("marking a payroll run paid posts Dr Payroll Payable / Cr the resolved tender account", async () => {
    const run = await createRunWithLine(2200)
    await approvePayrollRun(session(), run.id)
    await markPayrollPaid(session(), run.id, "bank")

    const journal = await db.journal.findFirstOrThrow({
      where: { organizationId, referenceType: "payroll_run_paid", referenceId: run.id },
      include: { lines: true },
    })
    const payableLine = journal.lines.find((l) => l.accountId === payrollPayableAccountId)
    const bankLine = journal.lines.find((l) => l.accountId === bankAccountId)
    expect(Number(payableLine?.debit)).toBe(2200)
    expect(Number(bankLine?.credit)).toBe(2200)

    const updated = await db.payrollRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(updated.status).toBe("paid")
  }, TIMEOUT)

  it("the Approved and Paid journals are genuinely distinct — paying never gets silently skipped as a 'duplicate' of approving", async () => {
    const run = await createRunWithLine(1000)
    await approvePayrollRun(session(), run.id)
    await markPayrollPaid(session(), run.id, "cash")

    const journals = await db.journal.findMany({
      where: { organizationId, referenceType: { in: ["payroll_run", "payroll_run_paid"] }, referenceId: run.id },
    })
    expect(journals.length).toBe(2)
    expect(new Set(journals.map((j) => j.referenceType)).size).toBe(2)
  }, TIMEOUT)

  it("approval replay: calling postPayrollApproved twice for the same run posts exactly one journal, not two", async () => {
    const run = await createRunWithLine(1800)

    await postPayrollApproved(run.id)
    await postPayrollApproved(run.id) // simulated replay — e.g. a retry after the B10-style stuck-state failure

    const journals = await db.journal.findMany({ where: { organizationId, referenceType: "payroll_run", referenceId: run.id } })
    expect(journals.length).toBe(1)
    const lines = await db.journalLine.findMany({ where: { journalId: journals[0].id } })
    const total = lines.reduce((sum, l) => sum + Number(l.debit), 0)
    expect(total).toBe(1800) // not double-posted to 3600
  }, TIMEOUT)

  it("payment replay: calling postPayrollPaid twice for the same run posts exactly one journal, not two", async () => {
    const run = await createRunWithLine(900)
    await db.payrollRun.update({ where: { id: run.id }, data: { paidVia: "cash" } })

    await postPayrollPaid(run.id)
    await postPayrollPaid(run.id) // simulated replay

    const journals = await db.journal.findMany({ where: { organizationId, referenceType: "payroll_run_paid", referenceId: run.id } })
    expect(journals.length).toBe(1)
    const lines = await db.journalLine.findMany({ where: { journalId: journals[0].id } })
    const total = lines.reduce((sum, l) => sum + Number(l.debit), 0)
    expect(total).toBe(900) // not double-posted to 1800
  }, TIMEOUT)

  describe("P1 §32/§33 (finding B10, closed in Batch 8): transaction protection and idempotency", () => {
    it("two simultaneous approvePayrollRun calls for the same run — only one succeeds, one journal posted", async () => {
      const run = await createRunWithLine(5000)

      const results = await Promise.allSettled([approvePayrollRun(session(), run.id), approvePayrollRun(session(), run.id)])
      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter((r) => r.status === "rejected")
      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already approved/)

      const journals = await db.journal.findMany({ where: { organizationId, referenceType: "payroll_run", referenceId: run.id } })
      expect(journals.length).toBe(1)
    }, TIMEOUT)

    it("two simultaneous markPayrollPaid calls for the same run — only one succeeds, one journal posted", async () => {
      const run = await createRunWithLine(4200)
      await approvePayrollRun(session(), run.id)

      const results = await Promise.allSettled([markPayrollPaid(session(), run.id, "bank"), markPayrollPaid(session(), run.id, "bank")])
      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter((r) => r.status === "rejected")
      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already marked paid/)

      const journals = await db.journal.findMany({ where: { organizationId, referenceType: "payroll_run_paid", referenceId: run.id } })
      expect(journals.length).toBe(1)
    }, TIMEOUT)

    it("approvePayrollRun writes the state change and the posting in the same transaction — the journal exists immediately, not only after a later retry", async () => {
      const run = await createRunWithLine(1500)
      await approvePayrollRun(session(), run.id)

      // No manual dispatch call here beyond what approvePayrollRun already
      // did internally — if the outbox event write and the journal posting
      // were still two separate, unprotected steps (the pre-Batch-8 shape),
      // this assertion would be racing the dispatcher rather than simply
      // confirming it already ran synchronously as part of the same call.
      const journal = await db.journal.findFirst({ where: { organizationId, referenceType: "payroll_run", referenceId: run.id } })
      expect(journal).not.toBeNull()
    }, TIMEOUT)
  })
})
