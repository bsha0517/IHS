import "server-only"
import { db } from "@/lib/db"
import { requiredString, requiredNumber, optionalString, optionalNumber, requiredEnum } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.9.2 §8 — Laboratory Test Catalogue master data. Mapped against
 * `LabTest` (prisma/schema.prisma): organization-wide (no branchId, same
 * precedent as Service/Product/Package), `code` is the deterministic
 * external identifier Lab Panel import resolves against (§9). Catalogue
 * migration only — never creates a `LabOrderTest`/patient result (§61).
 */
const RESULT_TYPES = ["numeric", "text"] as const

export type LabTestRow = {
  code: string
  name: string
  category: string
  specimenType: string
  resultType: (typeof RESULT_TYPES)[number]
  unit: string | null
  referenceRangeLow: number | null
  referenceRangeHigh: number | null
  referenceRangeText: string | null
  price: number
  turnaroundHours: number | null
}

export function createLabTestsImporter(): ImporterDefinition<LabTestRow> {
  return {
    type: "lab_tests",
    group: "Clinical Catalogues",
    templateVersion: "lab-tests-v1",
    label: "Laboratory Test Catalogue",
    requiredHeaders: ["code", "name", "category", "specimenType", "resultType", "price"],
    optionalHeaders: ["unit", "referenceRangeLow", "referenceRangeHigh", "referenceRangeText", "turnaroundHours"],
    helpText: [
      "code must be unique within your organization — Lab Panel import resolves member tests by this code.",
      `resultType: ${RESULT_TYPES.join(" or ")}.`,
      "referenceRangeLow/High (optional): numeric bounds — leave both blank for a text-only reference (use referenceRangeText instead), e.g. a qualitative test.",
      "price: a non-negative number — the amount charged when this test is ordered.",
      "This import creates catalogue master data only — it never creates a lab order or patient result.",
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
      const specimenType = requiredString(raw.specimenType, "specimenType", 100)
      push(specimenType.error)
      const resultType = requiredEnum(raw.resultType, "resultType", RESULT_TYPES)
      push(resultType.error)
      const price = requiredNumber(raw.price, "price", { min: 0, max: 9999999 })
      push(price.error)
      const referenceRangeLow = optionalNumber(raw.referenceRangeLow, "referenceRangeLow")
      push(referenceRangeLow.error)
      const referenceRangeHigh = optionalNumber(raw.referenceRangeHigh, "referenceRangeHigh")
      push(referenceRangeHigh.error)
      if (referenceRangeLow.value != null && referenceRangeHigh.value != null && referenceRangeLow.value > referenceRangeHigh.value) {
        issues.push({ field: "referenceRangeHigh", code: "BUSINESS_RULE", message: "referenceRangeHigh must be greater than or equal to referenceRangeLow." })
      }
      const turnaroundHours = optionalNumber(raw.turnaroundHours, "turnaroundHours", { min: 0, max: 8760, integer: true })
      push(turnaroundHours.error)

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: {
          code: code.value!,
          name: name.value!,
          category: category.value!,
          specimenType: specimenType.value!,
          resultType: resultType.value!,
          unit: optionalString(raw.unit, "unit", 30).value,
          referenceRangeLow: referenceRangeLow.value,
          referenceRangeHigh: referenceRangeHigh.value,
          referenceRangeText: optionalString(raw.referenceRangeText, "referenceRangeText", 200).value,
          price: price.value!,
          turnaroundHours: turnaroundHours.value,
        },
        issues: [],
      }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const codes = [...new Set(candidates.map((r) => r.normalized!.code))]
      const existing = await db.labTest.findMany({ where: { organizationId: ctx.organizationId, code: { in: codes } }, select: { code: true } })
      const existingCodes = new Set(existing.map((e) => e.code.toLowerCase()))
      const seen = new Set<string>()
      for (const row of candidates) {
        const code = row.normalized!.code.toLowerCase()
        if (existingCodes.has(code)) {
          row.duplicate = true
          row.duplicateReason = `A lab test with code "${row.normalized!.code}" already exists.`
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
        specimenType: r.normalized!.specimenType,
        resultType: r.normalized!.resultType,
        unit: r.normalized!.unit,
        referenceRangeLow: r.normalized!.referenceRangeLow,
        referenceRangeHigh: r.normalized!.referenceRangeHigh,
        referenceRangeText: r.normalized!.referenceRangeText,
        price: r.normalized!.price,
        turnaroundHours: r.normalized!.turnaroundHours,
      }))
      const result = await tx.labTest.createMany({ data })
      return { imported: result.count, skipped: 0 }
    },
  }
}
