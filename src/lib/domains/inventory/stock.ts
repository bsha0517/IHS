import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { Prisma } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"
import type { StockAdjustmentInput } from "@/lib/domains/inventory/schemas"

type Db = Prisma.TransactionClient | typeof db

const NEAR_EXPIRY_DAYS = 90

async function getBalance(
  tx: Db,
  where: { organizationId: string; branchId?: string | null; productId: string; batchId?: string | null }
) {
  const result = await tx.stockLedgerEntry.aggregate({
    where: {
      organizationId: where.organizationId,
      branchId: where.branchId ?? undefined,
      productId: where.productId,
      batchId: where.batchId ?? undefined,
    },
    _sum: { quantity: true },
  })
  return new Decimal(result._sum?.quantity ?? 0)
}

export async function getProductBalance(session: SessionContext, productId: string, branchId?: string) {
  assertCan(session, "inventory.view")
  return getBalance(db, { organizationId: session.user.organizationId, branchId, productId })
}

/** Per-product on-hand balance across all branches, or one branch if specified — for the inventory overview list. */
export async function listStockSummary(session: SessionContext, branchId?: string) {
  assertCan(session, "inventory.view")

  const products = await db.product.findMany({
    where: { organizationId: session.user.organizationId, isActive: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  })

  const grouped = await db.stockLedgerEntry.groupBy({
    by: ["productId"],
    where: { organizationId: session.user.organizationId, branchId },
    _sum: { quantity: true },
  })
  const balanceByProduct = new Map(grouped.map((g) => [g.productId, Number(g._sum.quantity ?? 0)]))

  return products.map((product) => {
    const balance = balanceByProduct.get(product.id) ?? 0
    return {
      ...product,
      balance,
      isLowStock: balance <= product.reorderLevel,
      isOutOfStock: balance <= 0,
    }
  })
}

/** FEFO-ordered batches with a remaining balance > 0 for one product at one branch. */
export async function listAvailableBatches(session: SessionContext, productId: string, branchId: string) {
  assertCan(session, "inventory.view")
  return listAvailableBatchesInternal(db, session.user.organizationId, productId, branchId)
}

async function listAvailableBatchesInternal(tx: Db, organizationId: string, productId: string, branchId: string) {
  const batches = await tx.productBatch.findMany({
    where: { organizationId, productId },
    orderBy: [{ expiryDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  })

  const withBalances = await Promise.all(
    batches.map(async (batch) => ({
      batch,
      balance: await getBalance(tx, { organizationId, branchId, productId, batchId: batch.id }),
    }))
  )
  return withBalances.filter((b) => b.balance.greaterThan(0))
}

export async function listLowStock(session: SessionContext, branchId?: string) {
  const summary = await listStockSummary(session, branchId)
  return summary.filter((p) => p.isLowStock)
}

export async function listNearExpiryBatches(session: SessionContext, branchId?: string, days = NEAR_EXPIRY_DAYS) {
  assertCan(session, "inventory.view")
  const threshold = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  const batches = await db.productBatch.findMany({
    where: {
      organizationId: session.user.organizationId,
      expiryDate: { not: null, lte: threshold, gte: new Date() },
    },
    include: { product: true },
    orderBy: { expiryDate: "asc" },
  })
  const withBalances = await Promise.all(
    batches.map(async (batch) => ({
      batch,
      balance: await getBalance(db, { organizationId: session.user.organizationId, branchId, productId: batch.productId, batchId: batch.id }),
    }))
  )
  return withBalances.filter((b) => b.balance.greaterThan(0))
}

export async function listExpiredBatches(session: SessionContext, branchId?: string) {
  assertCan(session, "inventory.view")
  const batches = await db.productBatch.findMany({
    where: { organizationId: session.user.organizationId, expiryDate: { not: null, lt: new Date() } },
    include: { product: true },
    orderBy: { expiryDate: "asc" },
  })
  const withBalances = await Promise.all(
    batches.map(async (batch) => ({
      batch,
      balance: await getBalance(db, { organizationId: session.user.organizationId, branchId, productId: batch.productId, batchId: batch.id }),
    }))
  )
  return withBalances.filter((b) => b.balance.greaterThan(0))
}

export async function listLedgerEntries(
  session: SessionContext,
  filters: { productId?: string; branchId?: string } = {}
) {
  assertCan(session, "inventory.view")
  return db.stockLedgerEntry.findMany({
    where: { organizationId: session.user.organizationId, productId: filters.productId, branchId: filters.branchId },
    include: { product: true, batch: true, branch: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  })
}

/** Manual correction (spec.md §43: adjustment/damage/expiry/return) — the only user-facing way to move stock outside a receipt/transfer/consumption. */
export async function recordAdjustment(session: SessionContext, input: StockAdjustmentInput) {
  assertCan(session, "inventory.adjust", { branchId: input.branchId })

  const signedQuantity = input.direction === "in" ? new Decimal(input.quantity) : new Decimal(input.quantity).negated()

  if (input.direction === "out") {
    const available = await getBalance(db, {
      organizationId: session.user.organizationId,
      branchId: input.branchId,
      productId: input.productId,
      batchId: input.batchId,
    })
    if (available.lessThan(input.quantity)) {
      throw new Error(`Only ${available.toString()} units available — cannot remove ${input.quantity}.`)
    }
  }

  const entry = await db.stockLedgerEntry.create({
    data: {
      organizationId: session.user.organizationId,
      branchId: input.branchId,
      productId: input.productId,
      batchId: input.batchId ?? null,
      transactionType: input.transactionType,
      quantity: signedQuantity,
      reason: input.reason,
      performedBy: session.user.id,
    },
  })
  await auditFromSession(session, "create", "stock_ledger_entry", entry.id, {
    new: { transactionType: input.transactionType, quantity: Number(signedQuantity), reason: input.reason },
  })
  return entry
}

/** Internal — used by goods receipt completion. Creates the batch and its `purchase` ledger entry together. */
export async function receiveStock(
  tx: Db,
  input: {
    organizationId: string
    branchId: string
    productId: string
    supplierId?: string | null
    batchNumber: string
    manufacturingDate?: Date | null
    expiryDate?: Date | null
    purchaseCost: number
    quantity: number
    referenceType: string
    referenceId: string
    performedBy: string | null
  }
) {
  const batch = await tx.productBatch.create({
    data: {
      organizationId: input.organizationId,
      productId: input.productId,
      batchNumber: input.batchNumber,
      manufacturingDate: input.manufacturingDate ?? null,
      expiryDate: input.expiryDate ?? null,
      supplierId: input.supplierId ?? null,
      purchaseCost: new Decimal(input.purchaseCost),
      receivedQuantity: input.quantity,
    },
  })
  await tx.stockLedgerEntry.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      productId: input.productId,
      batchId: batch.id,
      transactionType: "purchase",
      quantity: new Decimal(input.quantity),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      performedBy: input.performedBy,
    },
  })
  return batch
}

/**
 * Internal — FEFO consumption (spec.md §42: "use FEFO where appropriate")
 * across one or more batches until `quantity` is satisfied. Throws if the
 * branch doesn't have enough stock rather than letting a balance go
 * negative — the caller's transaction (e.g. charge creation) rolls back,
 * which is the intended behavior: you cannot bill for consuming stock that
 * isn't there.
 */
/**
 * Pure FEFO allocation decision, extracted from consumeStock for unit testing
 * (Phase 14) — given batches already ordered earliest-expiry-first (the
 * ordering itself is the DB query in listAvailableBatchesInternal, not
 * repeated here), decides how much to take from each until `quantity` is
 * satisfied. Throws the same "insufficient stock" shape the caller already
 * threw, so behavior is unchanged — only the decision logic moved.
 */
export function allocateFefo(
  available: { batchId: string; balance: Decimal }[],
  quantity: Decimal,
  productName: string
): { batchId: string; take: Decimal }[] {
  const totalAvailable = available.reduce((sum, b) => sum.add(b.balance), new Decimal(0))
  if (totalAvailable.lessThan(quantity)) {
    throw new Error(`Insufficient stock for "${productName}" — need ${quantity.toString()}, have ${totalAvailable.toString()}.`)
  }

  const allocations: { batchId: string; take: Decimal }[] = []
  let remaining = quantity
  for (const { batchId, balance } of available) {
    if (remaining.lessThanOrEqualTo(0)) break
    const take = Decimal.min(balance, remaining)
    allocations.push({ batchId, take })
    remaining = remaining.sub(take)
  }
  return allocations
}

export async function consumeStock(
  tx: Db,
  input: {
    organizationId: string
    branchId: string
    productId: string
    quantity: number
    referenceType: string
    referenceId: string
    performedBy: string | null
    /** Defaults to the original caller's meaning (automatic clinical consumption). Pharmacy dispensing (Phase 9) passes `"dispensing"` instead — same FEFO walk, different ledger label. */
    transactionType?: "treatment_consumption" | "dispensing"
  }
) {
  const available = await listAvailableBatchesInternal(tx, input.organizationId, input.productId, input.branchId)
  const product = await tx.product.findUnique({ where: { id: input.productId } })
  const allocations = allocateFefo(
    available.map((b) => ({ batchId: b.batch.id, balance: b.balance })),
    new Decimal(input.quantity),
    product?.name ?? input.productId
  )

  for (const { batchId, take } of allocations) {
    await tx.stockLedgerEntry.create({
      data: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        batchId,
        transactionType: input.transactionType ?? "treatment_consumption",
        quantity: take.negated(),
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        performedBy: input.performedBy,
      },
    })
  }
}
