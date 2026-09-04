import "server-only"
import { db } from "@/lib/db"
import { receiveStock } from "@/lib/domains/inventory/stock"
import { requiredString, requiredNumber, optionalDate } from "@/lib/platform/import/parsers"
import type { ImporterDefinition, RowIssue } from "@/lib/platform/import/types"

/**
 * P4.6 §28-31 — CRITICAL: never sets a stock balance directly. Every row
 * becomes a real `ProductBatch` + a `purchase`-type `StockLedgerEntry`
 * through the exact same `receiveStock` primitive the goods-receipt flow
 * already uses (inventory/stock.ts) — this import IS the ledger-domain
 * architecture, not a bypass of it. `referenceType: "opening_balance"`
 * (§29) makes every imported movement traceable back to this ImportJob via
 * `referenceId`.
 *
 * §30 — cost is REQUIRED, never defaulted to zero: a missing/invalid cost
 * fails validation for that row rather than silently creating zero-cost
 * commercial stock.
 *
 * §31 — an already-expired batch is REJECTED by default (never becomes
 * FEFO-eligible stock); §31's "explicit write-off path" alternative was
 * judged out of this V1's scope (a real, separate feature, not a bulk
 * import concern) — an expired-stock row is reported as invalid with a
 * clear reason instead of silently imported or silently dropped.
 *
 * §32/§33 — deliberately does NOT post an accounting journal for the
 * imported value. `receiveStock` itself never has (only its *caller*
 * decides whether to fire an accounting-triggering Outbox event — the
 * regular goods-receipt flow does; this import does not), and inventing a
 * new PostingIntent solely to recognize an opening-balance-equity entry
 * would be new accounting semantics this phase's own scope explicitly
 * warns against building casually (§33: "never insert account balances
 * directly... only build a dedicated opening-balance importer if [it] can
 * preserve double-entry... clearly necessary"). See
 * docs/CLINIC_ONBOARDING.md's Accounting Setup section for the documented,
 * existing-architecture alternative: post a manual Journal (Dr Inventory
 * Asset / Cr Opening Balance Equity, using the existing Manual Journal
 * screen) for the imported batches' total value as one deliberate,
 * reviewed accounting step — not auto-generated per row.
 */
export type OpeningInventoryRow = {
  productId: string
  branchId: string
  batchNumber: string
  quantity: number
  unitCost: number
  expiryDate: Date | null
  supplierId: string | null
}

export function createOpeningInventoryImporter(branchByCode: Map<string, string>, productBySku: Map<string, string>, supplierByCode: Map<string, string>): ImporterDefinition<OpeningInventoryRow> {
  return {
    type: "opening_inventory",
    templateVersion: "opening-inventory-v1",
    label: "Opening Inventory",
    requiredHeaders: ["sku", "branchCode", "batchNumber", "quantity", "unitCost"],
    optionalHeaders: ["expiryDate", "supplierCode"],
    helpText: [
      "sku must match an already-imported/existing Product.",
      "branchCode must match an existing branch.",
      "batchNumber: your own lot/batch identifier — must be unique for this product within the branch.",
      "quantity: a positive whole number.",
      "unitCost: REQUIRED, a non-negative number — never defaults to zero. This becomes the batch's real cost basis for future COGS.",
      "expiryDate (optional): YYYY-MM-DD. A date in the past is rejected — expired stock cannot be imported as available/saleable inventory.",
      "supplierCode (optional): must match an existing supplier if given.",
      "This import never posts an accounting journal by itself — see docs/CLINIC_ONBOARDING.md for the recommended manual opening-balance journal entry.",
    ],
    async parseRow(raw) {
      const issues: RowIssue[] = []
      const push = (i: RowIssue | null) => i && issues.push(i)

      const batchNumber = requiredString(raw.batchNumber, "batchNumber", 100)
      push(batchNumber.error)
      const quantity = requiredNumber(raw.quantity, "quantity", { min: 1, integer: true })
      push(quantity.error)
      // §30 — required, not optional; a missing/blank cost fails validation
      // (the "fail" branch of §30's two documented options), rather than a
      // silent zero.
      const unitCost = requiredNumber(raw.unitCost, "unitCost", { min: 0, max: 9999999 })
      push(unitCost.error)
      const expiryDate = optionalDate(raw.expiryDate, "expiryDate")
      push(expiryDate.error)
      if (expiryDate.value && expiryDate.value.getTime() < Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) {
        issues.push({ field: "expiryDate", code: "BUSINESS_RULE", message: "expiryDate is in the past — expired stock cannot be imported as available inventory." })
      }

      const skuRaw = raw.sku?.trim()
      let productId: string | null = null
      if (!skuRaw) {
        issues.push({ field: "sku", code: "REQUIRED_FIELD", message: "sku is required." })
      } else {
        productId = productBySku.get(skuRaw.toLowerCase()) ?? null
        if (!productId) issues.push({ field: "sku", code: "UNKNOWN_PRODUCT", message: `sku "${skuRaw}" does not match any existing product — import Products (or Medications) first.` })
      }

      const branchCodeRaw = raw.branchCode?.trim()
      let branchId: string | null = null
      if (!branchCodeRaw) {
        issues.push({ field: "branchCode", code: "REQUIRED_FIELD", message: "branchCode is required." })
      } else {
        branchId = branchByCode.get(branchCodeRaw.toLowerCase()) ?? null
        if (!branchId) issues.push({ field: "branchCode", code: "UNKNOWN_BRANCH", message: `branchCode "${branchCodeRaw}" does not match any branch in this organization.` })
      }

      let supplierId: string | null = null
      const supplierCodeRaw = raw.supplierCode?.trim()
      if (supplierCodeRaw) {
        supplierId = supplierByCode.get(supplierCodeRaw.toLowerCase()) ?? null
        if (!supplierId) issues.push({ field: "supplierCode", code: "UNKNOWN_SUPPLIER", message: `supplierCode "${supplierCodeRaw}" does not match any existing supplier.` })
      }

      if (issues.length > 0) return { normalized: null, issues }
      return {
        normalized: { productId: productId!, branchId: branchId!, batchNumber: batchNumber.value!, quantity: quantity.value!, unitCost: unitCost.value!, expiryDate: expiryDate.value, supplierId },
        issues: [],
      }
    },

    async detectDuplicates(rows, ctx) {
      const candidates = rows.filter((r) => r.normalized)
      if (candidates.length === 0) return
      const productIds = [...new Set(candidates.map((r) => r.normalized!.productId))]
      const existing = await db.productBatch.findMany({ where: { organizationId: ctx.organizationId, productId: { in: productIds } }, select: { productId: true, batchNumber: true } })
      const existingKeys = new Set(existing.map((e) => `${e.productId}|${e.batchNumber.toLowerCase()}`))
      const seen = new Set<string>()
      for (const row of candidates) {
        const n = row.normalized!
        const key = `${n.productId}|${n.batchNumber.toLowerCase()}`
        if (existingKeys.has(key)) {
          row.duplicate = true
          row.duplicateReason = `Batch "${n.batchNumber}" already exists for this product.`
        } else if (seen.has(key)) {
          row.duplicate = true
          row.duplicateReason = "Duplicate product+batchNumber within this same file."
        }
        seen.add(key)
      }
    },

    async commitBatch(tx, rows, ctx, jobId) {
      let imported = 0
      for (const row of rows) {
        const n = row.normalized!
        await receiveStock(tx, {
          organizationId: ctx.organizationId,
          branchId: n.branchId,
          productId: n.productId,
          supplierId: n.supplierId,
          batchNumber: n.batchNumber,
          expiryDate: n.expiryDate,
          purchaseCost: n.unitCost,
          quantity: n.quantity,
          referenceType: "opening_balance",
          referenceId: jobId,
          performedBy: ctx.session.user.id,
        })
        imported++
      }
      return { imported, skipped: 0 }
    },
  }
}
