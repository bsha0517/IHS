import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { requiredString, requiredDate, optionalNumber } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.9.2 §21-25 — HIGH RISK, decision made explicit: DRAFT-ONLY import.
 *
 * `approvePayrollRun`/`markPayrollPaid` (payroll/payroll.ts) each post a
 * real double-entry journal through the outbox/posting-service pipeline
 * (Dr Salary Expense/Cr Payroll Payable, then Dr Payroll Payable/Cr
 * [tender]) — reproducing "already approved" or "already paid" history
 * through a bulk import would mean either fabricating those journals
 * outside the normal posting service (never acceptable — §24) or writing
 * PayrollRun rows with `status: "approved"`/`"paid"` and NO corresponding
 * journal, which would silently break the Trial Balance/reconciliation
 * story the moment anyone looked. Neither is safe. This importer therefore
 * creates ONLY `draft` PayrollRun/PayrollRunLine rows — a real starting
 * point an HR user then moves through Review -> Approve -> Paid via the
 * existing screens, posting real journals exactly the way every other
 * payroll run already does. No CommissionAccrual linking is attempted
 * either (unlike interactive `createPayrollRun`) — accruals are live,
 * current-state data; there is no safe way to retroactively attach
 * historical accruals to an imported run.
 *
 * One CSV row is one employee's line for one (branch, period) run — rows
 * sharing the same (branchCode, periodStart, periodEnd) become one
 * PayrollRun. If a PayrollRun already exists for that exact key (ANY
 * status, including an existing draft) the WHOLE group is treated as
 * duplicate and skipped — never appended to, never overwritten (§43 "no
 * silent upsert" applied to this importer's own higher-stakes case).
 */
export type PayrollRunImportRow = {
  branchId: string
  periodStart: Date
  periodEnd: Date
  employeeId: string
  basicSalary: number
  allowances: number
  overtime: number
  bonus: number
  advances: number
  unpaidLeaveDeduction: number
  otherDeductions: number
  netSalary: number
  groupKey: string
}

function computeNet(n: { basicSalary: number; allowances: number; overtime: number; bonus: number; advances: number; unpaidLeaveDeduction: number; otherDeductions: number }): number {
  return new Decimal(n.basicSalary)
    .add(n.allowances)
    .add(n.overtime)
    .add(n.bonus)
    .sub(n.advances)
    .sub(n.unpaidLeaveDeduction)
    .sub(n.otherDeductions)
    .toNumber()
}

export function createPayrollRunsImporter(branchByCode: Map<string, string>, employeeByNumber: Map<string, { id: string; basicSalary: number }>): ImporterDefinition<PayrollRunImportRow> {
  return {
    type: "payroll_runs",
    group: "Finance",
    riskLevel: "high",
    confirmationText: "I understand this import creates payroll financial records (as Draft only — no journal is posted until a person reviews and approves the run through the normal payroll screens).",
    templateVersion: "payroll-runs-v1",
    label: "Payroll Runs (Draft Only)",
    requiredHeaders: ["branchCode", "periodStart", "periodEnd", "employeeNumber"],
    optionalHeaders: ["basicSalary", "allowances", "overtime", "bonus", "advances", "unpaidLeaveDeduction", "otherDeductions"],
    helpText: [
      "This import creates DRAFT payroll runs only — no accounting journal is posted. Review, approve, and mark paid through the normal Payroll screens afterward; those steps post the real journals.",
      "periodStart/periodEnd: YYYY-MM-DD. All rows sharing the same branchCode+periodStart+periodEnd become one payroll run.",
      "employeeNumber must match an existing employee (import Employees first).",
      "basicSalary (optional): defaults to the employee's current basic salary if left blank.",
      "allowances/overtime/bonus/advances/unpaidLeaveDeduction/otherDeductions (all optional, default 0).",
      "If a payroll run already exists for a branch+period (in any status, including an existing draft), that entire group is skipped as a duplicate — it is never appended to or overwritten.",
      "This import never attaches commission accruals — commission is live, current-state data, not something a historical import can safely reconstruct.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const periodStart = requiredDate(raw.periodStart, "periodStart")
      push(periodStart.error)
      const periodEnd = requiredDate(raw.periodEnd, "periodEnd")
      push(periodEnd.error)
      if (periodStart.value && periodEnd.value && periodEnd.value.getTime() < periodStart.value.getTime()) {
        issues.push({ field: "periodEnd", code: "BUSINESS_RULE", message: "periodEnd cannot be before periodStart." })
      }

      const branchCodeRaw = raw.branchCode?.trim()
      let branchId: string | null = null
      if (!branchCodeRaw) {
        issues.push({ field: "branchCode", code: "REQUIRED_FIELD", message: "branchCode is required." })
      } else {
        branchId = branchByCode.get(branchCodeRaw.toLowerCase()) ?? null
        if (!branchId) issues.push({ field: "branchCode", code: "UNKNOWN_BRANCH", message: `branchCode "${branchCodeRaw}" does not match any branch in this organization.` })
      }

      const empRaw = requiredString(raw.employeeNumber, "employeeNumber", 50)
      push(empRaw.error)
      let employeeId: string | null = null
      let defaultBasicSalary = 0
      if (empRaw.value) {
        const emp = employeeByNumber.get(empRaw.value.toLowerCase())
        if (!emp) issues.push({ field: "employeeNumber", code: "UNKNOWN_REFERENCE", message: `employeeNumber "${empRaw.value}" does not match any existing employee.` })
        else {
          employeeId = emp.id
          defaultBasicSalary = emp.basicSalary
        }
      }

      const basicSalary = optionalNumber(raw.basicSalary, "basicSalary", { min: 0, max: 9999999 })
      push(basicSalary.error)
      const allowances = optionalNumber(raw.allowances, "allowances", { min: 0, max: 9999999 })
      push(allowances.error)
      const overtime = optionalNumber(raw.overtime, "overtime", { min: 0, max: 9999999 })
      push(overtime.error)
      const bonus = optionalNumber(raw.bonus, "bonus", { min: 0, max: 9999999 })
      push(bonus.error)
      const advances = optionalNumber(raw.advances, "advances", { min: 0, max: 9999999 })
      push(advances.error)
      const unpaidLeaveDeduction = optionalNumber(raw.unpaidLeaveDeduction, "unpaidLeaveDeduction", { min: 0, max: 9999999 })
      push(unpaidLeaveDeduction.error)
      const otherDeductions = optionalNumber(raw.otherDeductions, "otherDeductions", { min: 0, max: 9999999 })
      push(otherDeductions.error)

      if (issues.length > 0) return { normalized: null, issues }

      const resolved = {
        basicSalary: basicSalary.value ?? defaultBasicSalary,
        allowances: allowances.value ?? 0,
        overtime: overtime.value ?? 0,
        bonus: bonus.value ?? 0,
        advances: advances.value ?? 0,
        unpaidLeaveDeduction: unpaidLeaveDeduction.value ?? 0,
        otherDeductions: otherDeductions.value ?? 0,
      }
      const netSalary = computeNet(resolved)
      if (netSalary < 0) {
        return { normalized: null, issues: [{ field: "otherDeductions", code: "BUSINESS_RULE", message: "Computed net salary is negative — check earnings/deduction figures for this row." }] }
      }

      return {
        normalized: {
          branchId: branchId!,
          periodStart: periodStart.value!,
          periodEnd: periodEnd.value!,
          employeeId: employeeId!,
          ...resolved,
          netSalary,
          // Date-only (YYYY-MM-DD), not a full ISO timestamp: periodStart/
          // periodEnd are `@db.Date` columns, so Prisma reads a committed
          // row's value back as UTC midnight regardless of what time-of-day
          // the Date object carried when it was written (requiredDate
          // deliberately constructs UTC NOON, for its own, unrelated
          // timezone-safety reason — see parsers.ts). Keying on the full
          // ISO string here made this group-lookup silently never match the
          // group-lookup built from what the DB actually returns (below) —
          // caught by this importer's own duplicate-period test.
          groupKey: `${branchId}|${periodStart.value!.toISOString().slice(0, 10)}|${periodEnd.value!.toISOString().slice(0, 10)}`,
        },
        issues: [],
      }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return

      // Group key -> whether a PayrollRun already exists for it (any status).
      const groupKeys = [...new Set(candidates.map((r) => r.normalized!.groupKey))]
      const groups = groupKeys.map((k) => {
        const [branchId, periodStart, periodEnd] = k.split("|")
        return { key: k, branchId, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) }
      })
      const existingRuns = await db.payrollRun.findMany({
        where: { organizationId: ctx.organizationId, OR: groups.map((g) => ({ branchId: g.branchId, periodStart: g.periodStart, periodEnd: g.periodEnd })) },
        select: { branchId: true, periodStart: true, periodEnd: true, status: true },
      })
      const existingGroupKeys = new Map(existingRuns.map((r) => [`${r.branchId}|${r.periodStart.toISOString().slice(0, 10)}|${r.periodEnd.toISOString().slice(0, 10)}`, r.status]))

      const seenInFile = new Set<string>() // groupKey|employeeId
      for (const row of candidates) {
        const n = row.normalized!
        const existingStatus = existingGroupKeys.get(n.groupKey)
        if (existingStatus) {
          row.duplicate = true
          row.duplicateReason = `A payroll run already exists for this branch and period (status: ${existingStatus}) — this import never appends to or overwrites an existing run.`
          continue
        }
        const empKey = `${n.groupKey}|${n.employeeId}`
        if (seenInFile.has(empKey)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate employee within the same branch+period in this same file."
          continue
        }
        seenInFile.add(empKey)
      }
    },

    async commitBatch(tx, rows, ctx) {
      let imported = 0
      const runIdByGroup = new Map<string, string>()
      for (const row of rows) {
        const n = row.normalized!
        let runId = runIdByGroup.get(n.groupKey)
        if (!runId) {
          // Find-or-create — a batch runs in its own transaction, after any
          // earlier batch (same file, same group, split across the 200-row
          // boundary) has already committed its own run.
          const existing = await tx.payrollRun.findFirst({
            where: { organizationId: ctx.organizationId, branchId: n.branchId, periodStart: n.periodStart, periodEnd: n.periodEnd },
            select: { id: true },
          })
          if (existing) {
            runId = existing.id
          } else {
            const created = await tx.payrollRun.create({
              data: { organizationId: ctx.organizationId, branchId: n.branchId, periodStart: n.periodStart, periodEnd: n.periodEnd, createdBy: ctx.session.user.id },
            })
            runId = created.id
          }
          runIdByGroup.set(n.groupKey, runId)
        }
        await tx.payrollRunLine.create({
          data: {
            payrollRunId: runId,
            employeeId: n.employeeId,
            basicSalary: n.basicSalary,
            allowances: n.allowances,
            overtime: n.overtime,
            bonus: n.bonus,
            advances: n.advances,
            unpaidLeaveDeduction: n.unpaidLeaveDeduction,
            otherDeductions: n.otherDeductions,
            netSalary: n.netSalary,
          },
        })
        imported++
      }
      return { imported, skipped: 0 }
    },

    // P4.9.2 §41 — gross/deductions/net over committable rows, plus how many
    // distinct payroll runs (groups) this file will create.
    computeDomainSummary(rows) {
      const committable = rows.filter((r) => r.issues.length === 0 && !r.duplicate && r.normalized)
      let gross = 0, deductions = 0, net = 0
      const groups = new Set<string>()
      for (const r of committable) {
        const n = r.normalized!
        gross += n.basicSalary + n.allowances + n.overtime + n.bonus
        deductions += n.advances + n.unpaidLeaveDeduction + n.otherDeductions
        net += n.netSalary
        groups.add(n.groupKey)
      }
      const fmt = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      return [
        { label: "Payroll runs to create", value: String(groups.size) },
        { label: "Employee lines", value: String(committable.length) },
        { label: "Gross earnings", value: fmt(gross) },
        { label: "Total deductions", value: fmt(deductions) },
        { label: "Net payroll", value: fmt(net) },
      ]
    },
  }
}
