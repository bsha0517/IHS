import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { listStockSummary, listNearExpiryBatches, listExpiredBatches } from "@/lib/domains/inventory/stock"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
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

  const [stockSummary, nearExpiry, expired, consumptionEntries, batchBalances] = await Promise.all([
    listStockSummary(session, filters.branchId),
    listNearExpiryBatches(session, filters.branchId),
    listExpiredBatches(session, filters.branchId),
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
  ])

  const batchIds = batchBalances.map((b) => b.batchId).filter((id): id is string => id !== null)
  const batches = await db.productBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, purchaseCost: true } })
  const batchCost = new Map(batches.map((b) => [b.id, Number(b.purchaseCost)]))
  const productCost = new Map(stockSummary.map((p) => [p.id, Number(p.purchaseCost)]))

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
  const productNames = await db.product.findMany({ where: { id: { in: consumption.map((c) => c.productId) } } })
  const consumptionWithNames = consumption.map((c) => ({ ...c, productName: productNames.find((p) => p.id === c.productId)?.name ?? "Unknown" }))

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
  }
}
