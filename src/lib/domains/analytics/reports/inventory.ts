import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { listStockSummary, listNearExpiryBatches, listExpiredBatches } from "@/lib/domains/inventory/stock"
import type { SessionContext } from "@/lib/auth/session"
import type { ReportFilters } from "@/lib/domains/analytics/schemas"

const CONSUMPTION_TYPES = ["dispensing", "treatment_consumption", "sale"] as const

/**
 * spec.md §65's "Inventory" report bullets: Stock, Valuation, Consumption,
 * Expiry, Fast/slow moving. Valuation uses each product's current
 * `purchaseCost` against its on-hand balance — a simpler per-unit figure than
 * a FEFO batch-weighted average cost, a documented simplification (same
 * spirit as accounting/reports.ts's simplified direct-method cash flow).
 */
export async function getInventoryReport(session: SessionContext, filters: ReportFilters) {
  assertCan(session, "inventory.view")
  const organizationId = session.user.organizationId

  const [stockSummary, nearExpiry, expired, consumptionEntries] = await Promise.all([
    listStockSummary(session, filters.branchId),
    listNearExpiryBatches(session, filters.branchId),
    listExpiredBatches(session, filters.branchId),
    db.stockLedgerEntry.groupBy({
      by: ["productId"],
      where: {
        organizationId,
        ...(filters.branchId ? { branchId: filters.branchId } : {}),
        transactionType: { in: [...CONSUMPTION_TYPES] },
        createdAt: { gte: filters.from, lte: filters.to },
      },
      _sum: { quantity: true },
    }),
  ])

  const valuation = stockSummary.map((p) => ({ productId: p.id, productName: p.name, balance: p.balance, unitCost: Number(p.purchaseCost), value: p.balance * Number(p.purchaseCost) }))
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
