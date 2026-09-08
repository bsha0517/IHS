import "server-only"
import { db } from "@/lib/db"
import { requiredString, requiredNumber } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.9.2 §9 — Lab Panels (e.g. CBC, LFT — never hardcoded, this importer
 * has no knowledge of any specific panel). One CSV row is one panel PLUS
 * its member test codes in one semicolon-separated column — matches
 * Providers' own `branchCodes` convention (§9's "one row" shape is simpler
 * than a two-file/parent-child import for what's usually a handful of
 * member tests per panel). Every referenced test code must already exist
 * (Lab Tests import first — see docs/CLINIC_ONBOARDING.md's dependency
 * order) — an unresolved test code fails the WHOLE row as INVALID (§9: "do
 * NOT silently ignore it"), never a partially-created panel.
 */
export type LabPanelRow = {
  code: string
  name: string
  price: number
  testIds: string[]
}

export function createLabPanelsImporter(testCodeById: Map<string, string>): ImporterDefinition<LabPanelRow> {
  return {
    type: "lab_panels",
    group: "Clinical Catalogues",
    templateVersion: "lab-panels-v1",
    label: "Laboratory Panels",
    requiredHeaders: ["code", "name", "price", "testCodes"],
    optionalHeaders: [],
    helpText: [
      "code must be unique within your organization.",
      "testCodes: one or more existing Lab Test codes, separated by \";\" — import Laboratory Test Catalogue first.",
      "A panel with any unresolved test code is rejected entirely (invalid), not created with only the tests that did resolve.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const code = requiredString(raw.code, "code", 30)
      push(code.error)
      const name = requiredString(raw.name, "name", 200)
      push(name.error)
      const price = requiredNumber(raw.price, "price", { min: 0, max: 9999999 })
      push(price.error)

      const codesRaw = raw.testCodes?.trim()
      const testIds: string[] = []
      if (!codesRaw) {
        issues.push({ field: "testCodes", code: "REQUIRED_FIELD", message: "testCodes is required (at least one lab test code)." })
      } else {
        for (const testCode of codesRaw.split(";").map((c) => c.trim()).filter(Boolean)) {
          const id = testCodeById.get(testCode.toLowerCase())
          if (!id) issues.push({ field: "testCodes", code: "UNKNOWN_REFERENCE", message: `testCodes: "${testCode}" does not match any existing lab test — import Laboratory Test Catalogue first.` })
          else testIds.push(id)
        }
      }

      if (issues.length > 0) return { normalized: null, issues }
      return { normalized: { code: code.value!, name: name.value!, price: price.value!, testIds: [...new Set(testIds)] }, issues: [] }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const codes = [...new Set(candidates.map((r) => r.normalized!.code))]
      const existing = await db.labPanel.findMany({ where: { organizationId: ctx.organizationId, code: { in: codes } }, select: { code: true } })
      const existingCodes = new Set(existing.map((e) => e.code.toLowerCase()))
      const seen = new Set<string>()
      for (const row of candidates) {
        const code = row.normalized!.code.toLowerCase()
        if (existingCodes.has(code)) {
          row.duplicate = true
          row.duplicateReason = `A lab panel with code "${row.normalized!.code}" already exists.`
        } else if (seen.has(code)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate code within this same file."
        }
        seen.add(code)
      }
    },

    async commitBatch(tx, rows, ctx) {
      let imported = 0
      for (const row of rows) {
        const n = row.normalized!
        const panel = await tx.labPanel.create({
          data: { organizationId: ctx.organizationId, code: n.code, name: n.name, price: n.price },
        })
        await tx.labPanelTest.createMany({ data: n.testIds.map((labTestId) => ({ labPanelId: panel.id, labTestId })) })
        imported++
      }
      return { imported, skipped: 0 }
    },
  }
}
