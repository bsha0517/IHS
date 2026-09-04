import "server-only"
import { db } from "@/lib/db"
import { nextNumber } from "@/lib/platform/sequences"
import { requiredString, requiredDate, optionalNumber, requiredEnum } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "intern"] as const

/**
 * P4.6 §26 — master records only, never a login. `userId` is always left
 * null; linking a login stays the existing Admin action
 * (Employee<->User linking, P3.12). `managerId` is intentionally not
 * supported by this importer — resolving a self-referential manager
 * relationship from arbitrary CSV row order is a real ordering problem
 * this V1 scope doesn't take on; an imported employee's manager can be set
 * afterward through the existing Employee edit screen.
 */
export type EmployeeRow = {
  branchId: string
  departmentId: string | null
  firstName: string
  lastName: string
  designation: string
  joiningDate: Date
  employmentType: (typeof EMPLOYMENT_TYPES)[number]
  basicSalary: number
}

export function createEmployeesImporter(branchByCode: Map<string, string>, departmentByName: Map<string, string>): ImporterDefinition<EmployeeRow> {
  return {
    type: "employees",
    templateVersion: "employees-v1",
    label: "Employees",
    requiredHeaders: ["firstName", "lastName", "designation", "joiningDate", "employmentType", "branchCode"],
    optionalHeaders: ["department", "basicSalary"],
    helpText: [
      "joiningDate format: YYYY-MM-DD.",
      `employmentType: ${EMPLOYMENT_TYPES.join(", ")}.`,
      "branchCode must match an existing branch's code.",
      "department (optional): must match an existing department's name if given.",
      "This import never creates a login account — link a user to an imported employee afterward from the Employees page.",
      "manager is not supported by this import — set it afterward if needed.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const firstName = requiredString(raw.firstName, "firstName", 100)
      push(firstName.error)
      const lastName = requiredString(raw.lastName, "lastName", 100)
      push(lastName.error)
      const designation = requiredString(raw.designation, "designation", 200)
      push(designation.error)
      const joiningDate = requiredDate(raw.joiningDate, "joiningDate")
      push(joiningDate.error)
      const employmentType = requiredEnum(raw.employmentType, "employmentType", EMPLOYMENT_TYPES)
      push(employmentType.error)
      const basicSalary = optionalNumber(raw.basicSalary, "basicSalary", { min: 0, max: 9999999 })
      push(basicSalary.error)

      const branchCodeRaw = raw.branchCode?.trim()
      let branchId: string | null = null
      if (!branchCodeRaw) {
        issues.push({ field: "branchCode", code: "REQUIRED_FIELD", message: "branchCode is required." })
      } else {
        branchId = branchByCode.get(branchCodeRaw.toLowerCase()) ?? null
        if (!branchId) issues.push({ field: "branchCode", code: "UNKNOWN_BRANCH", message: `branchCode "${branchCodeRaw}" does not match any branch in this organization.` })
      }

      let departmentId: string | null = null
      const deptRaw = raw.department?.trim()
      if (deptRaw) {
        departmentId = departmentByName.get(deptRaw.toLowerCase()) ?? null
        if (!departmentId) issues.push({ field: "department", code: "UNKNOWN_DEPARTMENT", message: `department "${deptRaw}" does not match any department in this organization.` })
      }

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: {
          branchId: branchId!,
          departmentId,
          firstName: firstName.value!,
          lastName: lastName.value!,
          designation: designation.value!,
          joiningDate: joiningDate.value!,
          employmentType: employmentType.value!,
          basicSalary: basicSalary.value ?? 0,
        },
        issues: [],
      }
    },

    // No natural, stable, user-supplied key exists for an Employee (no code
    // field in this schema) — a same-name-same-branch-same-joining-date
    // match is a reasonable, conservative in-file/against-DB duplicate
    // signal without inventing a schema field this importer doesn't need.
    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const existing = await db.employee.findMany({
        where: { organizationId: ctx.organizationId },
        select: { firstName: true, lastName: true, branchId: true, joiningDate: true },
      })
      const seen = new Set<string>()
      for (const row of candidates) {
        const n = row.normalized!
        const key = `${n.firstName.toLowerCase()}|${n.lastName.toLowerCase()}|${n.branchId}|${n.joiningDate.getTime()}`
        const matchedExisting = existing.some(
          (e) => e.firstName.toLowerCase() === n.firstName.toLowerCase() && e.lastName.toLowerCase() === n.lastName.toLowerCase() && e.branchId === n.branchId && e.joiningDate.getTime() === n.joiningDate.getTime()
        )
        if (matchedExisting) {
          row.duplicate = true
          row.duplicateReason = "Matches an existing employee (same name, branch, and joining date)."
        } else if (seen.has(key)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate of an earlier row in this same file."
        }
        seen.add(key)
      }
    },

    async commitBatch(tx, rows, ctx) {
      let imported = 0
      for (const row of rows) {
        const n = row.normalized!
        const employeeNumber = await nextNumber({ organizationId: ctx.organizationId, sequenceType: "EMP", prefix: "EMP" })
        await tx.employee.create({
          data: {
            organizationId: ctx.organizationId,
            branchId: n.branchId,
            departmentId: n.departmentId,
            employeeNumber,
            firstName: n.firstName,
            lastName: n.lastName,
            designation: n.designation,
            joiningDate: n.joiningDate,
            employmentType: n.employmentType,
            basicSalary: n.basicSalary,
          },
        })
        imported++
      }
      return { imported, skipped: 0 }
    },
  }
}
