import "server-only"
import { db } from "@/lib/db"
import { requiredString, requiredNumber, optionalNumber } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/** P4.6 §23 — mapped against inventory/schemas.ts's own `productSchema`. Never sets a stock quantity — that's Opening Inventory's job, through the ledger. */
export type ProductRow = {
  sku: string
  name: string
  category: string
  unit: string
  purchaseCost: number
  sellingPrice: number | null
  reorderLevel: number
}

export function createProductsImporter(): ImporterDefinition<ProductRow> {
  return {
    type: "products",
    group: "Inventory",
    templateVersion: "products-v1",
    label: "Products",
    requiredHeaders: ["sku", "name", "category", "unit", "purchaseCost"],
    optionalHeaders: ["sellingPrice", "reorderLevel"],
    helpText: [
      "sku must be unique within your organization.",
      "purchaseCost: a non-negative number — this becomes the product's default cost basis, not an opening stock quantity (use the Opening Inventory import for actual stock).",
      "sellingPrice (optional): a non-negative number.",
      "reorderLevel (optional, default 0): a non-negative whole number.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const sku = requiredString(raw.sku, "sku", 50)
      push(sku.error)
      const name = requiredString(raw.name, "name", 200)
      push(name.error)
      const category = requiredString(raw.category, "category", 100)
      push(category.error)
      const unit = requiredString(raw.unit, "unit", 30)
      push(unit.error)
      const purchaseCost = requiredNumber(raw.purchaseCost, "purchaseCost", { min: 0, max: 9999999 })
      push(purchaseCost.error)
      const sellingPrice = optionalNumber(raw.sellingPrice, "sellingPrice", { min: 0, max: 9999999 })
      push(sellingPrice.error)
      const reorderLevel = optionalNumber(raw.reorderLevel, "reorderLevel", { min: 0, max: 999999, integer: true })
      push(reorderLevel.error)

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: { sku: sku.value!, name: name.value!, category: category.value!, unit: unit.value!, purchaseCost: purchaseCost.value!, sellingPrice: sellingPrice.value, reorderLevel: reorderLevel.value ?? 0 },
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
          row.duplicateReason = `A product with SKU "${row.normalized!.sku}" already exists.`
        } else if (seen.has(sku)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate SKU within this same file."
        }
        seen.add(sku)
      }
    },

    async commitBatch(tx, rows, ctx) {
      const data = rows.map((r) => ({
        organizationId: ctx.organizationId,
        sku: r.normalized!.sku,
        name: r.normalized!.name,
        category: r.normalized!.category,
        unit: r.normalized!.unit,
        purchaseCost: r.normalized!.purchaseCost,
        sellingPrice: r.normalized!.sellingPrice,
        reorderLevel: r.normalized!.reorderLevel,
      }))
      const result = await tx.product.createMany({ data })
      return { imported: result.count, skipped: 0 }
    },
  }
}
