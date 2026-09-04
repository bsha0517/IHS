import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan, ForbiddenError } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { resolvePage, paginationSkipTake, totalPages } from "@/lib/platform/pagination"
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

/**
 * Bulk balance lookup for a set of already-fetched batches — one `groupBy`
 * aggregate for every batch at once, the same "one batch query + one
 * aggregate" discipline `listBatchSummaryByProduct` established, instead of
 * a `getBalance` call per batch (P3.8 §13: previously
 * `Promise.all(batches.map(...))`, an N+1 that scaled with how many batches
 * were near expiry/expired org-wide, not a bounded page size).
 */
async function balanceByBatchId(
  organizationId: string,
  batchIds: string[],
  branchId?: string | { in: string[] } | null
): Promise<Map<string, Decimal>> {
  if (batchIds.length === 0) return new Map()
  const grouped = await db.stockLedgerEntry.groupBy({
    by: ["batchId"],
    where: { organizationId, branchId: branchId ?? undefined, batchId: { in: batchIds } },
    _sum: { quantity: true },
  })
  return new Map(grouped.map((g) => [g.batchId as string, new Decimal(g._sum.quantity ?? 0)]))
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
  const balances = await balanceByBatchId(session.user.organizationId, batches.map((b) => b.id), scopedBranchId)
  return batches
    .map((batch) => ({ batch, balance: balances.get(batch.id) ?? new Decimal(0) }))
    .filter((b) => b.balance.greaterThan(0))
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
  const balances = await balanceByBatchId(session.user.organizationId, batches.map((b) => b.id), scopedBranchId)
  return batches
    .map((batch) => ({ batch, balance: balances.get(batch.id) ?? new Decimal(0) }))
    .filter((b) => b.balance.greaterThan(0))
}

const LEDGER_PAGE_SIZE = 50

/**
 * P2 §8: was `take: 200` with no page param — the original audit's own
 * "stock ledger hard cap" finding. Real server-side pagination now, not a
 * bigger cap.
 *
 * P3.8 §14-15: added transactionType/batchId/date-range filters (branch and
 * product already existed) — all narrow the same WHERE clause, no separate
 * analytics query engine. `performedBy` has no FK relation on
 * StockLedgerEntry (a bare string, unlike e.g. ImagingOrder's
 * performedByUser), so the actor name is resolved with one bulk
 * `user.findMany` for the distinct ids on THIS page only (bounded by
 * pageSize, not a per-row lookup) rather than a schema change.
 */
export async function listLedgerEntries(
  session: SessionContext,
  filters: {
    productId?: string
    branchId?: string
    batchId?: string
    transactionType?: string
    dateFrom?: Date
    dateTo?: Date
    page?: number
  } = {}
) {
  assertCan(session, "inventory.view")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where: Prisma.StockLedgerEntryWhereInput = {
    organizationId: session.user.organizationId,
    productId: filters.productId,
    branchId: narrowBranchFilter(scope, filters.branchId),
    batchId: filters.batchId,
    transactionType: filters.transactionType as never,
    createdAt:
      filters.dateFrom || filters.dateTo
        ? { gte: filters.dateFrom, lte: filters.dateTo }
        : undefined,
  }
  const [entries, total] = await Promise.all([
    db.stockLedgerEntry.findMany({
      where,
      include: { product: true, batch: true, branch: true },
      orderBy: { createdAt: "desc" },
      ...paginationSkipTake(page, LEDGER_PAGE_SIZE),
    }),
    db.stockLedgerEntry.count({ where }),
  ])
  const actorIds = [...new Set(entries.map((e) => e.performedBy).filter((id): id is string => !!id))]
  const actors =
    actorIds.length > 0 ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true } }) : []
  const actorById = new Map(actors.map((a) => [a.id, `${a.firstName} ${a.lastName}`]))
  const entriesWithActor = entries.map((e) => ({ ...e, actorName: e.performedBy ? (actorById.get(e.performedBy) ?? "Unknown") : null }))
  return { entries: entriesWithActor, total, page, pageSize: LEDGER_PAGE_SIZE, totalPages: totalPages(total, LEDGER_PAGE_SIZE) }
}

/**
 * P2 §5: every batch (any status, including expired — unlike
 * listAvailableBatchesInternal's FEFO pool, see recordAdjustment's own doc
 * comment for why) for every product in `productIds`, with its current
 * balance at `branchId`. Backs the Adjustment dialog's batch selector.
 * Batched across the whole inventory page — 2 queries total regardless of
 * how many products are on it, not one query per product row, the same
 * discipline P2 Batch 3 established for the commission/tax N+1s.
 */
export async function listBatchSummaryByProduct(
  session: SessionContext,
  productIds: string[],
  branchId: string
): Promise<Map<string, { id: string; batchNumber: string; expiryDate: Date | null; balance: number }[]>> {
  assertCan(session, "inventory.view")
  const scope = getAuthorizedBranchScope(session)
  if (!scope.isOrgWide && !scope.branchIds.includes(branchId)) {
    throw new ForbiddenError("branch.access")
  }
  if (productIds.length === 0) return new Map()

  const batches = await db.productBatch.findMany({
    where: { organizationId: session.user.organizationId, productId: { in: productIds } },
    orderBy: [{ expiryDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  })
  const grouped = await db.stockLedgerEntry.groupBy({
    by: ["batchId"],
    where: { organizationId: session.user.organizationId, branchId, batchId: { in: batches.map((b) => b.id) } },
    _sum: { quantity: true },
  })
  const balanceByBatch = new Map(grouped.map((g) => [g.batchId as string, Number(g._sum.quantity ?? 0)]))

  const result = new Map<string, { id: string; batchNumber: string; expiryDate: Date | null; balance: number }[]>()
  for (const batch of batches) {
    const list = result.get(batch.productId) ?? []
    list.push({ id: batch.id, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, balance: balanceByBatch.get(batch.id) ?? 0 })
    result.set(batch.productId, list)
  }
  return result
}

/**
 * Manual correction (spec.md §43: adjustment/damage/expiry/return) — the
 * only user-facing way to move stock outside a receipt/transfer/consumption.
 *
 * P2 §5: previously batch-optional in both directions — the UI never asked
 * for one, so a manual adjustment routinely posted a batch-less ledger
 * entry even though every OTHER path stock can move through (receiveStock,
 * consumeStock, transfers) always ties the movement to a real
 * `ProductBatch`. That's the batch-blindness SYSTEM_AUDIT #23 named: a
 * batch-less reduction has no way to know WHICH physical lot actually lost
 * units, and a batch-less addition creates stock the FEFO pool can never
 * sort correctly (no batch to attach an expiry to). Closed in both
 * directions, enforced twice — once by `stockAdjustmentSchema`'s own
 * refinements (a fast, friendly rejection before this function ever runs),
 * and again here (never trust a client-supplied `batchId` at face value):
 *
 *   - "out": always removes from one specific, already-existing batch,
 *     re-verified inside the transaction to actually belong to this
 *     product/org and to actually hold enough balance at this branch —
 *     the same "don't trust a pre-transaction read alone" discipline
 *     `applyPaymentAtomically`'s own doc comment describes, just for a
 *     batch balance instead of an invoice total.
 *   - "in": either `batchId` (add to an existing batch, re-verified the
 *     same way) or the `newBatch*` fields (create a batch inline, in the
 *     same transaction as the ledger entry). A `newBatchNumber` matching
 *     one already on file for this product is treated as selecting that
 *     batch — `ProductBatch.@@unique([productId, batchNumber])` makes this
 *     an upsert-by-number, not a duplicate-key error, since "add more of
 *     this exact lot" and "pick it from the dropdown" are the same intent.
 *
 * Either way the ledger entry this creates always carries a real batchId —
 * batch-level stock (SUM of that batch's own entries) and the product's
 * overall stock ledger can never diverge, because after this change they
 * were never two different things to begin with. FEFO consumption
 * (allocateFefo/consumeStock/listAvailableBatchesInternal) is untouched —
 * this function has never fed that path and still doesn't.
 *
 * `damage`/`expiry` (always real loss) and `adjustment` (a count
 * correction — `direction: "out"` means the physical count found less than
 * the ledger recorded, `direction: "in"` means it found more) have real
 * financial impact and fire an `InventoryAdjusted` event valuing the move
 * at the specific batch's actual cost — always available now that a batch
 * is mandatory, closing the old "falls back to the product's own
 * purchaseCost when batchId isn't given" branch this function used to need.
 * `return`-type adjustments are deliberately NOT posted — a manual "return
 * to stock" has no single original transaction this function can identify
 * to reverse, and guessing at one risks a wrong entry; this stays an
 * inventory-only movement until a real workflow names what it should
 * reverse (see INVENTORY.md).
 */
export async function recordAdjustment(session: SessionContext, input: StockAdjustmentInput) {
  assertCan(session, "inventory.adjust", { branchId: input.branchId })

  const product = await db.product.findFirstOrThrow({
    where: { id: input.productId, organizationId: session.user.organizationId },
  })
  const signedQuantity = input.direction === "in" ? new Decimal(input.quantity) : new Decimal(input.quantity).negated()
  const isFinanciallyRelevant = input.transactionType !== "return"

  const entry = await db.$transaction(async (tx) => {
    let batchId: string
    let unitCost: Decimal

    if (input.direction === "out") {
      // P3.8 §19/§48: same race class `consumeStock` locks against — without
      // this, two concurrent "out" adjustments against the same batch both
      // read the same pre-adjustment balance, both pass the check below, and
      // both commit, driving the batch negative. Locked by product (not just
      // this one batch) for the same reason consumeStock's own doc comment
      // gives: `product_batch` has no branch column, so this also correctly
      // serializes concurrent out-adjustments of the same product across
      // different branches, which is broader than strictly necessary but
      // never narrower.
      await tx.$queryRaw`SELECT "id" FROM "product_batch" WHERE "product_id" = ${input.productId} FOR UPDATE`

      const batch = await tx.productBatch.findFirst({
        where: { id: input.batchId as string, productId: input.productId, organizationId: session.user.organizationId },
      })
      if (!batch) throw new Error("Selected batch was not found for this product.")
      const available = await getBalance(tx, {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        batchId: batch.id,
      })
      if (available.lessThan(input.quantity)) {
        throw new Error(`Only ${available.toString()} units available in batch ${batch.batchNumber} — cannot remove ${input.quantity}.`)
      }
      batchId = batch.id
      unitCost = new Decimal(batch.purchaseCost)
    } else if (input.batchId) {
      const batch = await tx.productBatch.findFirst({
        where: { id: input.batchId, productId: input.productId, organizationId: session.user.organizationId },
      })
      if (!batch) throw new Error("Selected batch was not found for this product.")
      batchId = batch.id
      unitCost = new Decimal(batch.purchaseCost)
    } else {
      const batchNumber = input.newBatchNumber as string
      const existing = await tx.productBatch.findUnique({
        where: { productId_batchNumber: { productId: input.productId, batchNumber } },
      })
      const batch =
        existing ??
        (await tx.productBatch.create({
          data: {
            organizationId: session.user.organizationId,
            productId: input.productId,
            batchNumber,
            manufacturingDate: input.newBatchManufacturingDate ?? null,
            expiryDate: input.newBatchExpiryDate ?? null,
            purchaseCost: new Decimal(input.newBatchPurchaseCost ?? product.purchaseCost),
            // ProductBatch.receivedQuantity is Int (a historical "how much
            // arrived in this lot" fact, spec.md §42) — StockAdjustmentInput's
            // quantity allows the same fractional precision the ledger itself
            // carries (Decimal(14,3)), so this rounds rather than risk a
            // Prisma runtime error inserting a fractional value into an Int
            // column. receiveStock's own identical assignment has carried
            // the same implicit whole-number assumption since Phase 5.
            receivedQuantity: Math.round(input.quantity),
          },
        }))
      batchId = batch.id
      unitCost = new Decimal(batch.purchaseCost)
    }

    const created = await tx.stockLedgerEntry.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        productId: input.productId,
        batchId,
        transactionType: input.transactionType,
        quantity: signedQuantity,
        // P2 §5: see stockAdjustmentSchema's own comment on `reference` —
        // the existing referenceType/referenceId polymorphic pointer, used
        // here for its own documented "manual adjustment with no other
        // record" case rather than a new column.
        referenceType: input.reference ? "manual_adjustment" : null,
        referenceId: input.reference ?? null,
        reason: input.reason,
        performedBy: session.user.id,
      },
    })

    const amount = unitCost.mul(input.quantity)
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
  }, { timeout: 20_000, maxWait: 10_000 })

  await auditFromSession(session, "create", "stock_ledger_entry", entry.id, {
    new: {
      transactionType: input.transactionType,
      quantity: Number(signedQuantity),
      reason: input.reason,
      batchId: entry.batchId,
      reference: input.reference ?? null,
    },
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
