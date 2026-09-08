import "server-only"
import { db } from "@/lib/db"
import { requiredString, optionalString, requiredNumber, optionalNumber, optionalBoolean } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.6 §24 — one row creates BOTH the linked Product and Medication rows,
 * exactly the way the interactive `createMedication` (pharmacy/medications.ts)
 * already does in one call — no fuzzy Product matching, no separate
 * "link to an existing product" step, because the existing domain function
 * already makes this deterministic (§24's own requirement).
 */
export type MedicationRow = {
  sku: string
  name: string
  unit: string
  purchaseCost: number
  sellingPrice: number | null
  dosageForm: string
  genericName: string | null
  strength: string | null
  route: string | null
  controlledSubstance: boolean
  requiresPrescription: boolean
}

export function createMedicationsImporter(): ImporterDefinition<MedicationRow> {
  return {
    type: "medications",
    group: "Clinical Catalogues",
    templateVersion: "medications-v2",
    label: "Medications",
    requiredHeaders: ["sku", "name", "unit", "purchaseCost", "dosageForm"],
    // P4.9.2 §6: route/controlledSubstance/requiresPrescription added —
    // every other schema-backed Medication field (genericName, strength)
    // was already covered; sku doubles as the deterministic Product/
    // Medication link this section requires (no fuzzy name matching), and
    // there is no separate "medication code" or "brand name" field on
    // either model to import. requiresPrescription now defaults true only
    // when the column is blank/omitted (previously hardcoded true always),
    // preserving existing template compatibility.
    optionalHeaders: ["sellingPrice", "genericName", "strength", "route", "controlledSubstance", "requiresPrescription"],
    helpText: [
      "sku must be unique within your organization — creates a linked catalog Product automatically, one per row.",
      "dosageForm: e.g. tablet, capsule, syrup, injection (free text, matches the existing Medication catalog).",
      "route (optional): e.g. oral, IV, IM, topical (free text).",
      "controlledSubstance (optional, default false): true or false.",
      "requiresPrescription (optional, default true): true or false.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const sku = requiredString(raw.sku, "sku", 50)
      push(sku.error)
      const name = requiredString(raw.name, "name", 200)
      push(name.error)
      const unit = requiredString(raw.unit, "unit", 30)
      push(unit.error)
      const purchaseCost = requiredNumber(raw.purchaseCost, "purchaseCost", { min: 0, max: 9999999 })
      push(purchaseCost.error)
      const dosageForm = requiredString(raw.dosageForm, "dosageForm", 100)
      push(dosageForm.error)
      const sellingPrice = optionalNumber(raw.sellingPrice, "sellingPrice", { min: 0, max: 9999999 })
      push(sellingPrice.error)
      const controlledSubstance = optionalBoolean(raw.controlledSubstance, "controlledSubstance", false)
      push(controlledSubstance.error)
      const requiresPrescription = optionalBoolean(raw.requiresPrescription, "requiresPrescription", true)
      push(requiresPrescription.error)

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: {
          sku: sku.value!,
          name: name.value!,
          unit: unit.value!,
          purchaseCost: purchaseCost.value!,
          route: optionalString(raw.route, "route", 100).value,
          controlledSubstance: controlledSubstance.value!,
          requiresPrescription: requiresPrescription.value!,
          sellingPrice: sellingPrice.value,
          dosageForm: dosageForm.value!,
          genericName: optionalString(raw.genericName, "genericName", 200).value,
          strength: optionalString(raw.strength, "strength", 100).value,
        },
        issues: [],
      }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const skus = [...new Set(candidates.map((r) => r.normalized!.sku))]
      const existing = await db.product.findMany({ where: { organizationId: ctx.organizationId, sku: { in: skus } }, select: { sku: true } })
      const existingSkus = new Set(existing.map((e) => e.sku.toLowerCase()))
      const seen = new Set<string>()
      for (const row of candidates) {
        const sku = row.normalized!.sku.toLowerCase()
        if (existingSkus.has(sku)) {
          row.duplicate = true
          row.duplicateReason = `A product/medication with SKU "${row.normalized!.sku}" already exists.`
        } else if (seen.has(sku)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate SKU within this same file."
        }
        seen.add(sku)
      }
    },

    async commitBatch(tx, rows, ctx) {
      let imported = 0
      for (const row of rows) {
        const n = row.normalized!
        const product = await tx.product.create({
          data: {
            organizationId: ctx.organizationId,
            sku: n.sku,
            name: n.name,
            category: "Medication",
            unit: n.unit,
            purchaseCost: n.purchaseCost,
            sellingPrice: n.sellingPrice,
          },
        })
        await tx.medication.create({
          data: {
            organizationId: ctx.organizationId,
            productId: product.id,
            genericName: n.genericName,
            strength: n.strength,
            dosageForm: n.dosageForm,
            route: n.route,
            controlledSubstance: n.controlledSubstance,
            requiresPrescription: n.requiresPrescription,
          },
        })
        imported++
      }
      return { imported, skipped: 0 }
    },
  }
}
