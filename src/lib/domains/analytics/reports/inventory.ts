import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { listStockSummary, listNearExpiryBatches, listExpiredBatches, listLowStock } from "@/lib/domains/inventory/stock"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import { assertExportRowLimit } from "@/lib/platform/reports"
import type { $Enums } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

const CONSUMPTION_TYPES = ["dispensing", "treatment_consumption", "sale"] as const

/**
 * spec.md §65's "Inventory" report bullets: Stock, Valuation, Consumption,
 * Expiry, Fast/slow moving.
 *
 * P1 §12: valuation is computed at the batch level — summing each batch's
 * remaining positive balance × that specific batch's own `purchaseCost` —
 * the same specific-identification cost basis
 * `postProductSaleCogs`/`postInventoryAdjustment` (accounting/posting-
 * service.ts) use when that stock is actually sold or written off. This
 * replaces the earlier simplification (balance × the product's single
 * current `purchaseCost`, ignoring which batch it actually came from) —
 * that mismatch would have meant this report and real COGS postings could
 * silently disagree about what the same unit of stock was worth. See
 * INVENTORY.md's "Valuation Method" for the full reasoning. A balance with
 * no batchId (a manual adjustment never tied to a specific receipt) falls
 * back to the product's own `purchaseCost`, the only basis available for it.
 */
export async function getInventoryReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "inventory.view")
  const organizationId = session.user.organizationId
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)

  const [stockSummary, nearExpiry, expired, lowStock, consumptionEntries, batchBalances, hasOpeningInventory] = await Promise.all([
    listStockSummary(session, filters.branchId),
    listNearExpiryBatches(session, filters.branchId),
    listExpiredBatches(session, filters.branchId),
    listLowStock(session, filters.branchId),
    db.stockLedgerEntry.groupBy({
      by: ["productId"],
      where: {
        organizationId,
        branchId: branchFilter,
        transactionType: { in: [...CONSUMPTION_TYPES] },
        createdAt: { gte: filters.from, lte: filters.to },
      },
      _sum: { quantity: true },
    }),
    db.stockLedgerEntry.groupBy({
      by: ["productId", "batchId"],
      where: { organizationId, branchId: branchFilter },
      _sum: { quantity: true },
    }),
    // P4.7 §18 — a cheap existence check, not a reconciliation engine: does
    // ANY opening-inventory-imported movement exist for this org at all?
    // Used only to surface the known P4.6 reservation (opening stock can
    // exist in the ledger before an admin posts the matching GL opening
    // balance) as a visible note — never to auto-post a journal, which
    // stays explicitly out of scope for this phase too.
    db.stockLedgerEntry.findFirst({ where: { organizationId, referenceType: "opening_balance" }, select: { id: true } }).then((row) => row !== null),
  ])

  const batchIds = batchBalances.map((b) => b.batchId).filter((id): id is string => id !== null)
  const batches = await db.productBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, purchaseCost: true, expiryDate: true } })
  const batchCost = new Map(batches.map((b) => [b.id, Number(b.purchaseCost)]))
  const productCost = new Map(stockSummary.map((p) => [p.id, Number(p.purchaseCost)]))
  const productNameForRecon = new Map(stockSummary.map((p) => [p.id, p.name]))

  // P4.7 §19 — Inventory Reconciliation: obvious integrity issues detectable
  // straight from the ledger/batch data already fetched above, not a
  // separate reconciliation engine. `expiredSaleable` reuses `expired`
  // (already balance > 0 by listExpiredBatches' own filter) rather than
  // recomputing it.
  const negativeStock: { productId: string; productName: string; batchId: string | null; balance: number }[] = []
  const unvaluedPositiveStock: { productId: string; productName: string; batchId: string; balance: number }[] = []
  for (const bb of batchBalances) {
    const balance = Number(bb._sum.quantity ?? 0)
    const productName = productNameForRecon.get(bb.productId) ?? "Unknown"
    if (balance < 0) {
      negativeStock.push({ productId: bb.productId, productName, batchId: bb.batchId, balance })
    }
    if (balance > 0 && bb.batchId) {
      const cost = batchCost.get(bb.batchId) ?? productCost.get(bb.productId) ?? 0
      if (cost <= 0) unvaluedPositiveStock.push({ productId: bb.productId, productName, batchId: bb.batchId, balance })
    }
  }

  const valueByProduct = new Map<string, { balance: number; value: number }>()
  for (const bb of batchBalances) {
    const balance = Number(bb._sum.quantity ?? 0)
    if (balance <= 0) continue // only value stock genuinely on hand
    const unitCost = bb.batchId ? (batchCost.get(bb.batchId) ?? productCost.get(bb.productId) ?? 0) : (productCost.get(bb.productId) ?? 0)
    const existing = valueByProduct.get(bb.productId) ?? { balance: 0, value: 0 }
    valueByProduct.set(bb.productId, { balance: existing.balance + balance, value: existing.value + balance * unitCost })
  }

  const valuation = stockSummary.map((p) => {
    const v = valueByProduct.get(p.id) ?? { balance: 0, value: 0 }
    return {
      productId: p.id,
      productName: p.name,
      balance: p.balance,
      // The weighted-average unit cost the batch-summed value above
      // actually implies — informational only; `value` is the real figure
      // and is what reconciles with COGS, not balance × this.
      unitCost: v.balance > 0 ? v.value / v.balance : Number(p.purchaseCost),
      value: v.value,
    }
  })
  const totalValuation = valuation.reduce((sum, v) => sum + v.value, 0)

  const consumption = consumptionEntries
    .map((c) => ({ productId: c.productId, quantity: Math.abs(Number(c._sum.quantity ?? 0)) }))
    .sort((a, b) => b.quantity - a.quantity)
  // P2 §9: was a second `db.product.findMany` purely to resolve names —
  // `stockSummary` (already fetched above) already carries every org
  // product's name, so this reuses it instead of a redundant round trip.
  const productNameById = new Map(stockSummary.map((p) => [p.id, p.name]))
  const consumptionWithNames = consumption.map((c) => ({ ...c, productName: productNameById.get(c.productId) ?? "Unknown" }))

  return {
    stockSummary,
    valuation,
    totalValuation,
    consumption: consumptionWithNames,
    fastMoving: consumptionWithNames.slice(0, 10),
    slowMoving: [...consumptionWithNames].reverse().slice(0, 10),
    nearExpiryCount: nearExpiry.length,
    expiredCount: expired.length,
    nearExpiry,
    expired,
    lowStock,
    reconciliation: {
      negativeStock,
      unvaluedPositiveStock,
      expiredSaleable: expired, // already balance > 0, per listExpiredBatches' own filter
    },
    // P4.7 §18 — the P4.6 reservation carried forward, not redesigned: true
    // only means "at least one opening-inventory-imported movement exists
    // for this org" — it says nothing about whether the corresponding
    // manual GL opening-balance journal has or hasn't been posted (this
    // schema has no link between a StockLedgerEntry and a Journal to check
    // that), so the note stays a prompt for a human to confirm, not an
    // automated reconciliation claim.
    openingInventorySetupNote: hasOpeningInventory
      ? "Opening inventory stock has been imported for this organization. Confirm the corresponding General Ledger opening balance has been posted (Accounting > Manual Journal) if it hasn't been already — see docs/CLINIC_ONBOARDING.md's Accounting Setup section."
      : null,
  }
}

const LEDGER_EXPORT_ROWS = 5000

/** P4.7 §17 — Stock Movement export: the full matching set of `listLedgerEntries` rows (already paginated for the screen at /inventory), bounded by its own smaller export cap — a stock ledger genuinely can run to hundreds of thousands of rows over an org's lifetime, so this additionally requires an explicit date range rather than defaulting to "everything ever". */
export async function exportStockMovementRows(session: SessionContext, filters: ReportFilters & { productId?: string; transactionType?: $Enums.StockTransactionType }) {
  assertCan(session, "inventory.view")
  const scope = getAuthorizedBranchScope(session)
  const branchFilter = narrowBranchFilter(scope, filters.branchId)
  const where = {
    organizationId: session.user.organizationId,
    branchId: branchFilter,
    productId: filters.productId,
    transactionType: filters.transactionType,
    createdAt: { gte: filters.from, lte: filters.to },
  }
  const total = await db.stockLedgerEntry.count({ where })
  assertExportRowLimit(total, LEDGER_EXPORT_ROWS)
  return db.stockLedgerEntry.findMany({ where, include: { product: true, batch: true, branch: true }, orderBy: { createdAt: "desc" } })
}
