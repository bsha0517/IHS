import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan, ForbiddenError } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { Prisma } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"
import type { StockAdjustmentInput } from "@/lib/domains/inventory/schemas"

type Db = Prisma.TransactionClient | typeof db

const NEAR_EXPIRY_DAYS = 90

async function getBalance(
  tx: Db,
  where: { organizationId: string; branchId?: string | { in: string[] } | null; productId: string; batchId?: string | null }
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
  const scope = getAuthorizedBranchScope(session)
  return getBalance(db, { organizationId: session.user.organizationId, branchId: narrowBranchFilter(scope, branchId), productId })
}

/** Per-product on-hand balance across all branches, or one branch if specified — for the inventory overview list. */
export async function listStockSummary(session: SessionContext, branchId?: string) {
  assertCan(session, "inventory.view")
  const scope = getAuthorizedBranchScope(session)

  const products = await db.product.findMany({
    where: { organizationId: session.user.organizationId, isActive: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  })

  const grouped = await db.stockLedgerEntry.groupBy({
    by: ["productId"],
    where: { organizationId: session.user.organizationId, branchId: narrowBranchFilter(scope, branchId) },
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
  const scope = getAuthorizedBranchScope(session)
  if (!scope.isOrgWide && !scope.branchIds.includes(branchId)) {
    throw new ForbiddenError("branch.access")
  }
  return listAvailableBatchesInternal(db, session.user.organizationId, productId, branchId)
}

/**
 * P0-03: the FEFO candidate pool. Expired batches are excluded entirely, not
 * merely sorted after unexpired ones — leaving them in and relying on
 * ascending-expiry ordering means an expired batch (having the earliest
 * expiry date of all) would be consumed *first*, exactly backwards. Expired
 * stock remains fully visible elsewhere (listExpiredBatches, reporting) —
 * this function is only ever used to build what's allocatable.
 */
async function listAvailableBatchesInternal(tx: Db, organizationId: string, productId: string, branchId: string) {
  const batches = await tx.productBatch.findMany({
    where: {
      organizationId,
      productId,
      OR: [{ expiryDate: null }, { expiryDate: { gte: new Date() } }],
    },
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
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, branchId)
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
      balance: await getBalance(db, { organizationId: session.user.organizationId, branchId: scopedBranchId, productId: batch.productId, batchId: batch.id }),
    }))
  )
  return withBalances.filter((b) => b.balance.greaterThan(0))
}

export async function listExpiredBatches(session: SessionContext, branchId?: string) {
  assertCan(session, "inventory.view")
  const scope = getAuthorizedBranchScope(session)
  const scopedBranchId = narrowBranchFilter(scope, branchId)
  const batches = await db.productBatch.findMany({
    where: { organizationId: session.user.organizationId, expiryDate: { not: null, lt: new Date() } },
    include: { product: true },
    orderBy: { expiryDate: "asc" },
  })
  const withBalances = await Promise.all(
    batches.map(async (batch) => ({
      batch,
      balance: await getBalance(db, { organizationId: session.user.organizationId, branchId: scopedBranchId, productId: batch.productId, batchId: batch.id }),
    }))
  )
  return withBalances.filter((b) => b.balance.greaterThan(0))
}

export async function listLedgerEntries(
  session: SessionContext,
  filters: { productId?: string; branchId?: string } = {}
) {
  assertCan(session, "inventory.view")
  const scope = getAuthorizedBranchScope(session)
  return db.stockLedgerEntry.findMany({
    where: { organizationId: session.user.organizationId, productId: filters.productId, branchId: narrowBranchFilter(scope, filters.branchId) },
    include: { product: true, batch: true, branch: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  })
}

/**
 * Manual correction (spec.md §43: adjustment/damage/expiry/return) — the
 * only user-facing way to move stock outside a receipt/transfer/consumption.
 *
 * P1 §13: `damage`/`expiry` (always real loss) and `adjustment` (a count
 * correction — `direction: "out"` means the physical count found less than
 * the ledger recorded, `direction: "in"` means it found more) have real
 * financial impact and fire an `InventoryAdjusted` event valuing the move
 * at the specific batch's actual cost when `batchId` is given, falling
 * back to the product's own `purchaseCost` when it isn't (a count
 * correction typically isn't tied to one physical lot). `return`-type
 * adjustments are deliberately NOT posted — a manual "return to stock" has
 * no single original transaction this function can identify to reverse,
 * and guessing at one risks a wrong entry; this stays an inventory-only
 * movement until a real workflow names what it should reverse (see
 * INVENTORY.md).
 */
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

  const [product, batch] = await Promise.all([
    db.product.findUniqueOrThrow({ where: { id: input.productId } }),
    input.batchId ? db.productBatch.findUnique({ where: { id: input.batchId } }) : Promise.resolve(null),
  ])
  const unitCost = batch ? new Decimal(batch.purchaseCost) : new Decimal(product.purchaseCost)
  const amount = unitCost.mul(input.quantity)
  const isFinanciallyRelevant = input.transactionType !== "return"

  const entry = await db.$transaction(async (tx) => {
    const created = await tx.stockLedgerEntry.create({
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

    if (isFinanciallyRelevant && amount.greaterThan(0)) {
      await writeOutboxEvent(tx, {
        organizationId: session.user.organizationId,
        eventType: "InventoryAdjusted",
        payload: {
          branchId: input.branchId,
          stockLedgerEntryId: created.id,
          direction: input.direction,
          amount: Number(amount),
          description: `${input.transactionType} — ${product.name}: ${input.reason}`,
        },
      })
    }

    return created
  })

  await auditFromSession(session, "create", "stock_ledger_entry", entry.id, {
    new: { transactionType: input.transactionType, quantity: Number(signedQuantity), reason: input.reason },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)
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
    /** Defaults to the original caller's meaning (automatic clinical consumption). Pharmacy dispensing (Phase 9) passes `"dispensing"`; POS product sales (P1 §9) pass `"sale"` — same FEFO walk, different ledger label. */
    transactionType?: "treatment_consumption" | "dispensing" | "sale"
  }
): Promise<{ totalCost: Decimal; allocations: { batchId: string; quantity: Decimal; unitCost: Decimal }[] }> {
  // P1 §32 (finding A8): `stock_ledger_entry` is append-only — there's no
  // single mutable "current balance" row to lock the way
  // `applyPaymentAtomically` locks `invoice.paid_amount`. The balance is a
  // derived SUM, so the resource that actually needs locking is the set of
  // `ProductBatch` rows the SUM is computed over: without this, two
  // concurrent consumers of the same low-stock product both read the same
  // pre-consumption balance, both pass FEFO allocation, and both insert
  // negative ledger entries — oversold stock the "insufficient stock
  // throws" guard exists specifically to prevent, defeated by the race
  // rather than the logic being wrong in isolation. Locked by product, not
  // per-branch — `ProductBatch` has no branch column of its own (a batch's
  // balance is derived per-branch from the ledger via `stockTransfers`) —
  // broader than strictly necessary (concurrent consumption of the same
  // product at two different branches also serializes) but never narrower,
  // which is what correctness here requires. A no-op if the product has no
  // batches yet — `allocateFefo` below still correctly throws "insufficient
  // stock" for that case, same as before this lock existed.
  await tx.$queryRaw`SELECT "id" FROM "product_batch" WHERE "product_id" = ${input.productId} FOR UPDATE`

  const available = await listAvailableBatchesInternal(tx, input.organizationId, input.productId, input.branchId)
  const product = await tx.product.findUnique({ where: { id: input.productId } })
  const allocations = allocateFefo(
    available.map((b) => ({ batchId: b.batch.id, balance: b.balance })),
    new Decimal(input.quantity),
    product?.name ?? input.productId
  )
  // Batch cost lookup, for the cost basis below — specific identification
  // (P1 §12): each allocation is valued at the actual batch it came from,
  // never a product-level average, since FEFO already tells us exactly
  // which physical lot left the shelf.
  const costByBatch = new Map(available.map((b) => [b.batch.id, new Decimal(b.batch.purchaseCost)]))

  const costedAllocations: { batchId: string; quantity: Decimal; unitCost: Decimal }[] = []
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
    costedAllocations.push({ batchId, quantity: take, unitCost: costByBatch.get(batchId) ?? new Decimal(0) })
  }

  const totalCost = costedAllocations.reduce((sum, a) => sum.add(a.quantity.mul(a.unitCost)), new Decimal(0))
  return { totalCost, allocations: costedAllocations }
}
