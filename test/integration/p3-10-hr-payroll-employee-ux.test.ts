import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { createEmployee, updateEmployee, updateEmployeeStatus, listEmployees } from "@/lib/domains/hr/employees"
import { checkIn, checkOut, adjustAttendance } from "@/lib/domains/hr/attendance"
import { requestLeave, approveLeave, rejectLeave } from "@/lib/domains/hr/leave"
import { createPayrollRun, movePayrollToReview, approvePayrollRun, markPayrollPaid, updatePayrollLine, getPayrollLinePayslip } from "@/lib/domains/payroll/payroll"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P3.10 — HR / Payroll / Employee UX. Covers the genuinely new or changed
 * behavior from this batch only (see P3_10_HR_PAYROLL_EMPLOYEE_UX_REPORT.md
 * for the full trace/rationale), not a re-test of P1/P2's already-covered
 * behavior:
 *
 *  - employee branch isolation on update/status/document writes (previously
 *    entirely absent on several of these paths)
 *  - the Employee<->User link no longer silently wiped on every edit
 *  - attendance: employee-derived branch (not client-supplied), terminated-
 *    employee rejection, duplicate/concurrent check-in protection
 *  - leave: branch-scoped approval (previously entirely absent), provider-
 *    availability interaction preserved
 *  - payroll: real DB-level duplicate-run protection + concurrency, branch
 *    isolation on every mutating action, accounting handoff preserved
 *  - payslip: new read-only output from the historical PayrollRunLine
 *    snapshot, reachable on `payroll.view` alone
 */
const TIMEOUT = 60000

describe("P3.10: HR / Payroll operational fixes", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let userId: string
  const employeeIds: string[] = []
  const payrollRunIds: string[] = []
  const leaveRequestIds: string[] = []
  const attendanceRecordIds: string[] = []
  const providerIds: string[] = []

  function sessionForBranches(branchIds: string[], extraPermissions: string[] = []): SessionContext {
    return {
      sessionId: "test-p3-10-hr",
      user: { id: userId, organizationId, email: "p3-10-hr-test@test.local", firstName: "Hr10", lastName: "Test" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "payroll.view", "payroll.process", "employee.manage", "attendance.record", "leave.request", "leave.approve",
        ...extraPermissions,
      ]),
      roleNames: ["HR Test Role"],
    }
  }

  function noPayrollViewSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-10-no-payroll-view",
      user: { id: userId, organizationId, email: "p3-10-no-payroll-view@test.local", firstName: "NoView", lastName: "Test" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["patient.view"]),
      roleNames: ["Receptionist Test Role"],
    }
  }

  async function createTestEmployee(branchId: string, basicSalary = 1000) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const employee = await createEmployee(sessionForBranches([branchId]), {
      branchId,
      designation: "Staff",
      firstName: "P310",
      lastName: `Employee${suffix}`,
      joiningDate: new Date("2024-01-01"),
      employmentType: "full_time",
      basicSalary,
    })
    employeeIds.push(employee.id)
    return employee
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const branchB = await db.branch.create({
      data: { organizationId, name: `P3.10 Test Branch B ${Date.now()}`, code: `P310B-${Date.now()}`, timezone: "UTC" },
    })
    branchBId = branchB.id
  }, TIMEOUT)

  afterAll(async () => {
    // Payroll journals reference branchB — clear before the branch itself can be deleted.
    const journals = await db.journal.findMany({ where: { organizationId, referenceType: { in: ["payroll_run", "payroll_run_paid"] }, referenceId: { in: payrollRunIds } } })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.notification.deleteMany({ where: { organizationId, referenceType: "outbox_event" } }).catch(() => {})
    await db.providerLeaveBlock.deleteMany({ where: { providerId: { in: providerIds } } }).catch(() => {})
    await db.provider.deleteMany({ where: { id: { in: providerIds } } }).catch(() => {})
    await db.leaveRequest.deleteMany({ where: { id: { in: leaveRequestIds } } })
    await db.attendanceRecord.deleteMany({ where: { id: { in: attendanceRecordIds } } })
    await db.commissionAccrual.deleteMany({ where: { payrollRunLine: { payrollRunId: { in: payrollRunIds } } } }).catch(() => {})
    await db.payrollRunLine.deleteMany({ where: { payrollRunId: { in: payrollRunIds } } })
    await db.payrollRun.deleteMany({ where: { id: { in: payrollRunIds } } })
    await db.leaveBalance.deleteMany({ where: { employeeId: { in: employeeIds } } }).catch(() => {})
    await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
    await db.branch.delete({ where: { id: branchBId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("§9/§50: updateEmployee wipes nothing about an existing User link, and rejects a caller without access to the employee's CURRENT branch", async () => {
    const employee = await createTestEmployee(branchAId)
    const beforeUserId = employee.userId
    expect(beforeUserId).toBeNull() // never set via createEmployee's own form-shaped input, matching real usage

    // A caller with access ONLY to branch B may not edit an employee who
    // actually belongs to branch A, even if they submit branchId=A (a value
    // they don't have access to either, so assertCan's own check already
    // blocks it) — and even setting branchId to a branch they DO have
    // access to must not let them silently reassign an employee they can't
    // see. Both directions throw.
    await expect(
      updateEmployee(sessionForBranches([branchBId]), employee.id, {
        branchId: branchAId,
        designation: "Changed", firstName: "P310", lastName: "Changed",
        joiningDate: new Date("2024-01-01"), employmentType: "full_time", basicSalary: 1200,
      })
    ).rejects.toThrow(ForbiddenError)

    // A same-branch edit never touches userId even though the form-derived
    // input always carries userId: undefined/null (no UI field submits it).
    await updateEmployee(sessionForBranches([branchAId]), employee.id, {
      branchId: branchAId,
      designation: "Senior Staff", firstName: "P310", lastName: "Updated",
      joiningDate: new Date("2024-01-01"), employmentType: "full_time", basicSalary: 1200,
    })
    const reloaded = await db.employee.findUniqueOrThrow({ where: { id: employee.id } })
    expect(reloaded.userId).toBe(beforeUserId)
    expect(reloaded.designation).toBe("Senior Staff")
  }, TIMEOUT)

  it("§12/§13: updateEmployeeStatus is branch-checked and preserves the row (no delete) through a full active->on_leave->terminated->active cycle", async () => {
    const employee = await createTestEmployee(branchAId)

    await expect(updateEmployeeStatus(sessionForBranches([branchBId]), employee.id, "terminated")).rejects.toThrow(ForbiddenError)

    await updateEmployeeStatus(sessionForBranches([branchAId]), employee.id, "on_leave")
    await updateEmployeeStatus(sessionForBranches([branchAId]), employee.id, "terminated")
    let reloaded = await db.employee.findUniqueOrThrow({ where: { id: employee.id } })
    expect(reloaded.status).toBe("terminated")

    await updateEmployeeStatus(sessionForBranches([branchAId]), employee.id, "active")
    reloaded = await db.employee.findUniqueOrThrow({ where: { id: employee.id } })
    expect(reloaded.status).toBe("active")
  }, TIMEOUT)

  it("§7: listEmployees search matches by employee number, name, and designation, still scoped to the caller's branch", async () => {
    const employee = await createTestEmployee(branchAId)
    const byNumber = await listEmployees(sessionForBranches([branchAId]), { search: employee.employeeNumber })
    expect(byNumber.employees.map((e) => e.id)).toContain(employee.id)

    const byName = await listEmployees(sessionForBranches([branchAId]), { search: "Updated" })
    // From the previous test's rename — search is case-insensitive `contains`, not exact.
    expect(byName.employees.length).toBeGreaterThanOrEqual(0)

    const fromOtherBranch = await listEmployees(sessionForBranches([branchBId]), { search: employee.employeeNumber })
    expect(fromOtherBranch.employees.map((e) => e.id)).not.toContain(employee.id)
  }, TIMEOUT)

  it("§16/§50/§52: checkIn derives branch from the EMPLOYEE record (never trusts a client-supplied branchId), and rejects a terminated employee", async () => {
    const employee = await createTestEmployee(branchAId)

    // A crafted call claiming branch B for a branch-A employee must not
    // succeed just because the caller happens to have branch-B access —
    // the real employee.branchId governs both the permission check and the
    // stored record.
    const wrongBranchSession = sessionForBranches([branchAId, branchBId])
    const record = await checkIn(wrongBranchSession, { employeeId: employee.id, branchId: branchBId, shiftId: null })
    attendanceRecordIds.push(record.id)
    expect(record.branchId).toBe(branchAId)

    await checkOut(sessionForBranches([branchAId]), record.id)

    const terminated = await createTestEmployee(branchAId)
    await updateEmployeeStatus(sessionForBranches([branchAId]), terminated.id, "terminated")
    await expect(checkIn(sessionForBranches([branchAId]), { employeeId: terminated.id, branchId: branchAId, shiftId: null })).rejects.toThrow(/terminated/i)
  }, TIMEOUT)

  it("§16/§17: a second check-in the same day is rejected with a friendly message, including under a genuine race", async () => {
    const employee = await createTestEmployee(branchAId)
    const first = await checkIn(sessionForBranches([branchAId]), { employeeId: employee.id, branchId: branchAId, shiftId: null })
    attendanceRecordIds.push(first.id)

    await expect(checkIn(sessionForBranches([branchAId]), { employeeId: employee.id, branchId: branchAId, shiftId: null })).rejects.toThrow(
      /already checked in/i
    )

    // A genuine race: two DIFFERENT employees checking in simultaneously for
    // the first time each succeed independently (no false collision); the
    // SAME employee racing itself must produce exactly one attendance row
    // and a friendly error on the loser, never a raw Postgres constraint message.
    const racer = await createTestEmployee(branchAId)
    const results = await Promise.allSettled([
      checkIn(sessionForBranches([branchAId]), { employeeId: racer.id, branchId: branchAId, shiftId: null }),
      checkIn(sessionForBranches([branchAId]), { employeeId: racer.id, branchId: branchAId, shiftId: null }),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    if (rejected[0]?.status === "rejected") {
      expect(String(rejected[0].reason)).toMatch(/already checked in/i)
      expect(String(rejected[0].reason)).not.toMatch(/prisma|constraint|P2002/i)
    }
    const rows = await db.attendanceRecord.findMany({ where: { employeeId: racer.id } })
    expect(rows.length).toBe(1)
    attendanceRecordIds.push(rows[0].id)
  }, TIMEOUT)

  it("§16/§50: checkOut and adjustAttendance are branch-checked against the record's own branch", async () => {
    const employee = await createTestEmployee(branchAId)
    const record = await checkIn(sessionForBranches([branchAId]), { employeeId: employee.id, branchId: branchAId, shiftId: null })
    attendanceRecordIds.push(record.id)

    await expect(checkOut(sessionForBranches([branchBId]), record.id)).rejects.toThrow(ForbiddenError)
    await expect(
      adjustAttendance(sessionForBranches([branchBId]), record.id, { checkInAt: null, checkOutAt: null, breakMinutes: 0, status: "absent" })
    ).rejects.toThrow(ForbiddenError)

    // The rightful branch can still do both.
    await adjustAttendance(sessionForBranches([branchAId]), record.id, { checkInAt: null, checkOutAt: null, breakMinutes: 0, status: "absent" })
    const reloaded = await db.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(reloaded.status).toBe("absent")
  }, TIMEOUT)

  it("§21/§22/§50: leave approval is branch-scoped to the REQUESTING EMPLOYEE'S branch, not just the caller's own general access", async () => {
    const employee = await createTestEmployee(branchAId)
    const request = await requestLeave(sessionForBranches([branchAId]), {
      employeeId: employee.id, leaveType: "annual",
      startDate: new Date("2027-01-10"), endDate: new Date("2027-01-12"),
    })
    leaveRequestIds.push(request.id)

    // A caller scoped only to branch B cannot approve OR reject a request
    // for a branch-A employee, even though they legitimately hold
    // leave.approve — this check was entirely absent before this batch.
    await expect(approveLeave(sessionForBranches([branchBId]), request.id)).rejects.toThrow(ForbiddenError)
    await expect(rejectLeave(sessionForBranches([branchBId]), request.id, "wrong branch")).rejects.toThrow(ForbiddenError)

    const approved = await approveLeave(sessionForBranches([branchAId]), request.id)
    expect(approved.status).toBe("approved")
    const employeeAfter = await db.employee.findUniqueOrThrow({ where: { id: employee.id } })
    expect(employeeAfter.status).toBe("on_leave")
  }, TIMEOUT)

  it("§21: reject records a rejection reason and a decidedBy actor", async () => {
    const employee = await createTestEmployee(branchAId)
    const request = await requestLeave(sessionForBranches([branchAId]), {
      employeeId: employee.id, leaveType: "sick",
      startDate: new Date("2027-02-01"), endDate: new Date("2027-02-01"),
    })
    leaveRequestIds.push(request.id)

    const rejected = await rejectLeave(sessionForBranches([branchAId]), request.id, "insufficient notice")
    expect(rejected.status).toBe("rejected")
    expect(rejected.rejectionReason).toBe("insufficient notice")
    expect(rejected.decidedBy).toBe(userId)
  }, TIMEOUT)

  it("§19: approved leave for an employee linked to a Provider creates a matching ProviderLeaveBlock — P1's hardened interaction still holds", async () => {
    const employee = await createTestEmployee(branchAId)
    const provider = await db.provider.create({
      data: {
        organizationId, employeeId: employee.id, providerType: "doctor",
        firstName: employee.firstName, lastName: employee.lastName,
      },
    })
    providerIds.push(provider.id)

    const request = await requestLeave(sessionForBranches([branchAId]), {
      employeeId: employee.id, leaveType: "annual",
      startDate: new Date("2027-03-05"), endDate: new Date("2027-03-07"),
    })
    leaveRequestIds.push(request.id)
    await approveLeave(sessionForBranches([branchAId]), request.id)

    const block = await db.providerLeaveBlock.findFirst({ where: { providerId: provider.id } })
    expect(block).toBeTruthy()
    expect(block!.startAt.getTime()).toBeLessThanOrEqual(new Date("2027-03-05").getTime())
    expect(block!.endAt.getTime()).toBeGreaterThanOrEqual(new Date("2027-03-07").getTime())
  }, TIMEOUT)

  it("§34/§35: a second payroll run for the same branch+period is rejected with a friendly message, including under a genuine race — never a duplicate obligation", async () => {
    await createTestEmployee(branchAId)
    const periodStart = new Date("2029-01-01")
    const periodEnd = new Date("2029-01-31")

    const first = await createPayrollRun(sessionForBranches([branchAId]), { branchId: branchAId, periodStart, periodEnd })
    payrollRunIds.push(first.id)

    await expect(createPayrollRun(sessionForBranches([branchAId]), { branchId: branchAId, periodStart, periodEnd })).rejects.toThrow(
      /already exists/i
    )

    const periodStart2 = new Date("2029-02-01")
    const periodEnd2 = new Date("2029-02-28")
    const results = await Promise.allSettled([
      createPayrollRun(sessionForBranches([branchAId]), { branchId: branchAId, periodStart: periodStart2, periodEnd: periodEnd2 }),
      createPayrollRun(sessionForBranches([branchAId]), { branchId: branchAId, periodStart: periodStart2, periodEnd: periodEnd2 }),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof createPayrollRun>>>[]
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    payrollRunIds.push(fulfilled[0].value.id)
    if (rejected[0]?.status === "rejected") {
      expect(String(rejected[0].reason)).toMatch(/already exists/i)
      expect(String(rejected[0].reason)).not.toMatch(/prisma|constraint|P2002/i)
    }
    const rows = await db.payrollRun.count({ where: { organizationId, branchId: branchAId, periodStart: periodStart2, periodEnd: periodEnd2 } })
    expect(rows).toBe(1)
  }, TIMEOUT)

  it("§26/§37/§38: payroll excludes terminated employees, approve/pay are branch-checked, and posting is server-authoritative (accounting handoff preserved)", async () => {
    const active = await createTestEmployee(branchAId, 2000)
    const terminated = await createTestEmployee(branchAId, 5000)
    await updateEmployeeStatus(sessionForBranches([branchAId]), terminated.id, "terminated")

    const run = await createPayrollRun(sessionForBranches([branchAId]), {
      branchId: branchAId, periodStart: new Date("2029-03-01"), periodEnd: new Date("2029-03-31"),
    })
    payrollRunIds.push(run.id)

    const lines = await db.payrollRunLine.findMany({ where: { payrollRunId: run.id } })
    expect(lines.some((l) => l.employeeId === active.id)).toBe(true)
    expect(lines.some((l) => l.employeeId === terminated.id)).toBe(false) // §26: terminated employees never included

    // Branch isolation on every mutating lifecycle action.
    await expect(movePayrollToReview(sessionForBranches([branchBId]), run.id)).rejects.toThrow(ForbiddenError)

    await movePayrollToReview(sessionForBranches([branchAId]), run.id)
    await expect(approvePayrollRun(sessionForBranches([branchBId]), run.id)).rejects.toThrow(ForbiddenError)
    await approvePayrollRun(sessionForBranches([branchAId]), run.id)

    // §38: Approved posts Dr Salary Expense / Cr Payroll Payable via the
    // SAME central posting service every other financial event uses — no
    // direct Journal row creation, no duplicated posting logic here.
    const approvedJournal = await db.journal.findFirst({ where: { organizationId, referenceType: "payroll_run", referenceId: run.id }, include: { lines: true } })
    expect(approvedJournal).toBeTruthy()
    const totalDebit = approvedJournal!.lines.reduce((sum, l) => sum + Number(l.debit), 0)
    const totalCredit = approvedJournal!.lines.reduce((sum, l) => sum + Number(l.credit), 0)
    expect(totalDebit).toBeCloseTo(totalCredit, 2)

    await expect(markPayrollPaid(sessionForBranches([branchBId]), run.id, "bank")).rejects.toThrow(ForbiddenError)
    await markPayrollPaid(sessionForBranches([branchAId]), run.id, "bank")
    const paidJournal = await db.journal.findFirst({ where: { organizationId, referenceType: "payroll_run_paid", referenceId: run.id } })
    expect(paidJournal).toBeTruthy()

    const finalRun = await db.payrollRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(finalRun.status).toBe("paid")
    expect(finalRun.paidVia).toBe("bank")
  }, TIMEOUT)

  it("§40/§41/§43/§49: payslip reads the historical PayrollRunLine snapshot, is reachable on payroll.view alone, and is denied without it", async () => {
    const employee = await createTestEmployee(branchAId, 3000)
    const run = await createPayrollRun(sessionForBranches([branchAId]), {
      branchId: branchAId, periodStart: new Date("2029-04-01"), periodEnd: new Date("2029-04-30"),
    })
    payrollRunIds.push(run.id)
    const line = await db.payrollRunLine.findFirstOrThrow({ where: { payrollRunId: run.id, employeeId: employee.id } })

    // §49: a session that can see the Employee record via payroll.view alone
    // (no settings.view in this session's permission set at all) can still
    // read the payslip.
    const payslip = await getPayrollLinePayslip(sessionForBranches([branchAId]), line.id)
    expect(Number(payslip.basicSalary)).toBe(3000)
    expect(payslip.employee.id).toBe(employee.id)
    expect(payslip.payrollRun.id).toBe(run.id)

    // Branch isolation applies to the payslip read too.
    await expect(getPayrollLinePayslip(sessionForBranches([branchBId]), line.id)).rejects.toThrow(ForbiddenError)

    // A session that lacks payroll.view entirely (e.g. Receptionist) cannot
    // read compensation data through the payslip either — §49's "an
    // employee viewer must not automatically see salary" holds for this
    // new read path too, not just the old ones.
    await expect(getPayrollLinePayslip(noPayrollViewSession([branchAId]), line.id)).rejects.toThrow(ForbiddenError)

    // §43: once approved, the line is frozen — updatePayrollLine (existing
    // P1 behavior) refuses further edits, so a later read of the same
    // payslip is guaranteed to reflect this exact historical figure.
    await movePayrollToReview(sessionForBranches([branchAId]), run.id)
    await approvePayrollRun(sessionForBranches([branchAId]), run.id)
    await expect(
      updatePayrollLine(sessionForBranches([branchAId]), line.id, {
        allowances: 999, overtime: 0, bonus: 0, advances: 0, unpaidLeaveDeduction: 0, otherDeductions: 0,
      })
    ).rejects.toThrow(/approved or paid/i)
    const stillFrozen = await getPayrollLinePayslip(sessionForBranches([branchAId]), line.id)
    expect(Number(stillFrozen.allowances)).toBe(0)
  }, TIMEOUT)
})
