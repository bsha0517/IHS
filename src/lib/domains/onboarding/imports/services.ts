import "server-only"
import { db } from "@/lib/db"
import { requiredString, requiredNumber } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/** P4.6 §22 — mapped against services/schemas.ts's own `serviceSchema`. */
export type ServiceRow = {
  code: string
  name: string
  category: string
  departmentId: string | null
  durationMinutes: number
  price: number
}

export function createServicesImporter(departmentByName: Map<string, string>): ImporterDefinition<ServiceRow> {
  return {
    type: "services",
    group: "Clinical Catalogues",
    templateVersion: "services-v1",
    label: "Services",
    requiredHeaders: ["code", "name", "category", "durationMinutes", "price"],
    optionalHeaders: ["department"],
    helpText: [
      "code and name must each be unique within your organization.",
      "durationMinutes: whole minutes, 1-600.",
      "price: a non-negative number.",
      "department (optional): must match an existing department's name if given.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const code = requiredString(raw.code, "code", 30)
      push(code.error)
      const name = requiredString(raw.name, "name", 200)
      push(name.error)
      const category = requiredString(raw.category, "category", 100)
      push(category.error)
      const duration = requiredNumber(raw.durationMinutes, "durationMinutes", { min: 1, max: 600, integer: true })
      push(duration.error)
      const price = requiredNumber(raw.price, "price", { min: 0 })
      push(price.error)

      let departmentId: string | null = null
      const deptRaw = raw.department?.trim()
      if (deptRaw) {
        departmentId = departmentByName.get(deptRaw.toLowerCase()) ?? null
        if (!departmentId) issues.push({ field: "department", code: "UNKNOWN_DEPARTMENT", message: `department "${deptRaw}" does not match any department in this organization.` })
      }

      if (issues.length > 0) return { normalized: null, issues }
      return { normalized: { code: code.value!, name: name.value!, category: category.value!, departmentId, durationMinutes: duration.value!, price: price.value! }, issues: [] }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const codes = [...new Set(candidates.map((r) => r.normalized!.code))]
      const existing = await db.service.findMany({ where: { organizationId: ctx.organizationId, code: { in: codes } }, select: { code: true } })
      const existingCodes = new Set(existing.map((e) => e.code.toLowerCase()))
      const seen = new Set<string>()
      for (const row of candidates) {
        const code = row.normalized!.code.toLowerCase()
        if (existingCodes.has(code)) {
          row.duplicate = true
          row.duplicateReason = `A service with code "${row.normalized!.code}" already exists.`
        } else if (seen.has(code)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate code within this same file."
        }
        seen.add(code)
      }
    },

    async commitBatch(tx, rows, ctx) {
      const data = rows.map((r) => ({
        organizationId: ctx.organizationId,
        code: r.normalized!.code,
        name: r.normalized!.name,
        category: r.normalized!.category,
        departmentId: r.normalized!.departmentId,
        durationMinutes: r.normalized!.durationMinutes,
        price: r.normalized!.price,
        billable: true,
        isActive: true,
      }))
      const result = await tx.service.createMany({ data })
      return { imported: result.count, skipped: 0 }
    },
  }
}
