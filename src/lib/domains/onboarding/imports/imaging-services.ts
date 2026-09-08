import "server-only"
import { db } from "@/lib/db"
import { requiredString, requiredNumber, optionalString, optionalNumber } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.9.2 §7 — Imaging Service Catalogue master data. Mapped against
 * `ImagingService` (prisma/schema.prisma) — organization-wide, no branchId
 * (unlike Service, this model has no per-branch availability field, so
 * §7's "branch availability" is not imported — nothing to map it to).
 * `category` is this model's own field for what §7 calls "modality"
 * (X-Ray, Ultrasound, CT, MRI, ...) — free text, never hardcoded here.
 * Catalogue only — never creates an ImagingOrder (§61).
 */
export type ImagingServiceRow = {
  code: string
  name: string
  category: string
  bodyPart: string | null
  price: number
  turnaroundHours: number | null
}

export function createImagingServicesImporter(): ImporterDefinition<ImagingServiceRow> {
  return {
    type: "imaging_services",
    group: "Clinical Catalogues",
    templateVersion: "imaging-services-v1",
    label: "Imaging Service Catalogue",
    requiredHeaders: ["code", "name", "category", "price"],
    optionalHeaders: ["bodyPart", "turnaroundHours"],
    helpText: [
      "code must be unique within your organization.",
      "category: the modality — e.g. X-Ray, Ultrasound, CT, MRI, Mammography, DEXA (free text).",
      "price: a non-negative number.",
      "This import creates catalogue master data only — it never creates an imaging order.",
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
      const price = requiredNumber(raw.price, "price", { min: 0, max: 9999999 })
      push(price.error)
      const turnaroundHours = optionalNumber(raw.turnaroundHours, "turnaroundHours", { min: 0, max: 8760, integer: true })
      push(turnaroundHours.error)

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: {
          code: code.value!,
          name: name.value!,
          category: category.value!,
          bodyPart: optionalString(raw.bodyPart, "bodyPart", 100).value,
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
      const existing = await db.imagingService.findMany({ where: { organizationId: ctx.organizationId, code: { in: codes } }, select: { code: true } })
      const existingCodes = new Set(existing.map((e) => e.code.toLowerCase()))
      const seen = new Set<string>()
      for (const row of candidates) {
        const code = row.normalized!.code.toLowerCase()
        if (existingCodes.has(code)) {
          row.duplicate = true
          row.duplicateReason = `An imaging service with code "${row.normalized!.code}" already exists.`
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
        bodyPart: r.normalized!.bodyPart,
        price: r.normalized!.price,
        turnaroundHours: r.normalized!.turnaroundHours,
      }))
      const result = await tx.imagingService.createMany({ data })
      return { imported: result.count, skipped: 0 }
    },
  }
}
