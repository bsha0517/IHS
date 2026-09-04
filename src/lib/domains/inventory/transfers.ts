import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, assertBranchAccess } from "@/lib/platform/branch-scope"
import { resolvePage, paginationSkipTake, totalPages } from "@/lib/platform/pagination"
import type { Prisma } from "@/generated/prisma/client"
import type { StockTransferInput } from "@/lib/domains/inventory/schemas"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P3.8 §22/§46: source AND destination branches must both be authorized —
 * cross-branch stock movement is intentional and neither side is implicit.
 * Previously only `fromBranchId` was checked; a session authorized for
 * branch A could transfer stock INTO an arbitrary branch B it has no access
 * to at all.
 */
export async function createTransfer(session: SessionContext, input: StockTransferInput) {
  assertCan(session, "stock.transfer", { branchId: input.fromBranchId })
  assertCan(session, "stock.transfer", { branchId: input.toBranchId })
  if (input.fromBranchId === input.toBranchId) {
    throw new Error("Source and destination branches must be different.")
  }

  // P3.8 §21: never trust a client-supplied batchId at face value — verify
  // it actually belongs to this product/org, isn't expired, and actually
  // holds enough balance at the SOURCE branch before ever creating the
  // transfer record (completeTransfer re-verifies again under lock at
  // completion time, since balance can change between request and
  // completion — this is the fast, friendly, non-authoritative check).
  const batch = await db.productBatch.findFirst({
    where: { id: input.batchId, productId: input.productId, organizationId: session.user.organizationId },
  })
  if (!batch) throw new Error("Selected batch was not found for this product.")
  if (batch.expiryDate && batch.expiryDate < new Date()) {
    throw new Error(`Batch ${batch.batchNumber} is expired and cannot be transferred.`)
  }
  const balanceAtSource = await db.stockLedgerEntry.aggregate({
    where: { organizationId: session.user.organizationId, branchId: input.fromBranchId, productId: input.productId, batchId: batch.id },
    _sum: { quantity: true },
  })
  const available = new Decimal(balanceAtSource._sum.quantity ?? 0)
  if (available.lessThan(input.quantity)) {
    throw new Error(`Only ${available.toString()} units of batch ${batch.batchNumber} available at the source branch.`)
  }

  const created = await db.stockTransfer.create({
    data: {
      organizationId: session.user.organizationId,
      fromBranchId: input.fromBranchId,
      toBranchId: input.toBranchId,
      productId: input.productId,
      batchId: input.batchId,
      quantity: new Decimal(input.quantity),
      notes: input.notes ?? null,
      requestedBy: session.user.id,
    },
  })
  await auditFromSession(session, "create", "stock_transfer", created.id, {
    new: { productId: input.productId, batchId: input.batchId, quantity: input.quantity },
  })
  return created
}

/** Writes the matching transfer_out/transfer_in ledger pair — the actual stock movement. */
export async function completeTransfer(session: SessionContext, transferId: string) {
  const transfer = await db.stockTransfer.findFirstOrThrow({
    where: { id: transferId, organizationId: session.user.organizationId },
  })
  // P3.8 §22/§46: previously unchecked entirely — any session holding
  // `stock.transfer` anywhere could complete ANY org transfer regardless of
  // branch. Both sides must be authorized, matching createTransfer.
  assertCan(session, "stock.transfer", { branchId: transfer.fromBranchId })
  assertCan(session, "stock.transfer", { branchId: transfer.toBranchId })

  if (transfer.status !== "pending" && transfer.status !== "in_transit") {
    throw new Error(`Cannot complete a transfer with status "${transfer.status}".`)
  }

  const updated = await db.$transaction(async (tx) => {
    // P3.8 §24/§48: lock the same way consumeStock/recordAdjustment do —
    // without this, two concurrent completions of transfers drawing on the
    // same batch (or two completions of the very same transfer) could both
    // read the same pre-completion balance and both pass the check below,
    // driving the source branch's balance negative.
    await tx.$queryRaw`SELECT "id" FROM "product_batch" WHERE "product_id" = ${transfer.productId} FOR UPDATE`

    const fresh = await tx.stockTransfer.findFirstOrThrow({ where: { id: transferId } })
    if (fresh.status !== "pending" && fresh.status !== "in_transit") {
      throw new Error(`Cannot complete a transfer with status "${fresh.status}".`)
    }

    if (fresh.batchId) {
      const batch = await tx.productBatch.findFirst({ where: { id: fresh.batchId } })
      if (batch?.expiryDate && batch.expiryDate < new Date()) {
        throw new Error(`Batch ${batch.batchNumber} has expired since this transfer was requested and cannot be completed.`)
      }
    }

    const balanceAtSource = await tx.stockLedgerEntry.aggregate({
      where: {
        organizationId: session.user.organizationId,
        branchId: fresh.fromBranchId,
        productId: fresh.productId,
        batchId: fresh.batchId,
      },
      _sum: { quantity: true },
    })
    const available = new Decimal(balanceAtSource._sum.quantity ?? 0)
    if (available.lessThan(fresh.quantity)) {
      throw new Error(`Only ${available.toString()} units available at the source branch.`)
    }

    await tx.stockLedgerEntry.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: fresh.fromBranchId,
        productId: fresh.productId,
        batchId: fresh.batchId,
        transactionType: "transfer_out",
        quantity: new Decimal(fresh.quantity).negated(),
        referenceType: "stock_transfer",
        referenceId: fresh.id,
        performedBy: session.user.id,
      },
    })
    await tx.stockLedgerEntry.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: fresh.toBranchId,
        productId: fresh.productId,
        // P3.8 §25: same ProductBatch record reused across branches — it has
        // no branchId column of its own, and a batch's per-branch balance is
        // always derived from StockLedgerEntry.branchId. Correct as-is: this
        // is not a merge of two different lots, it's the one lot now also
        // having stock at the destination branch.
        batchId: fresh.batchId,
        transactionType: "transfer_in",
        quantity: new Decimal(fresh.quantity),
        referenceType: "stock_transfer",
        referenceId: fresh.id,
        performedBy: session.user.id,
      },
    })
    return tx.stockTransfer.update({ where: { id: transferId }, data: { status: "completed", completedAt: new Date() } })
  }, { timeout: 20_000, maxWait: 10_000 })

  await auditFromSession(session, "complete", "stock_transfer", transferId, { new: { status: "completed" } })
  return updated
}

export async function cancelTransfer(session: SessionContext, transferId: string, reason: string) {
  const transfer = await db.stockTransfer.findFirstOrThrow({
    where: { id: transferId, organizationId: session.user.organizationId },
  })
  assertCan(session, "stock.transfer", { branchId: transfer.fromBranchId })
  if (transfer.status === "completed") throw new Error("Cannot cancel a completed transfer.")

  const updated = await db.stockTransfer.update({
    where: { id: transferId },
    data: { status: "cancelled", notes: reason },
  })
  await auditFromSession(session, "cancel", "stock_transfer", transferId, { new: { status: "cancelled", reason } })
  return updated
}

const TRANSFER_PAGE_SIZE = 50

/** P3.8 §46 (related finding, fixed alongside the named PR/PO pagination items): was `take: 100` with no page param. */
export async function listTransfers(session: SessionContext, filters: { branchId?: string; status?: string; page?: number } = {}) {
  assertCan(session, "inventory.view")
  const scope = getAuthorizedBranchScope(session)
  if (filters.branchId) assertBranchAccess(scope, filters.branchId)
  const page = resolvePage(filters.page)
  const branchTouch = filters.branchId
    ? [{ fromBranchId: filters.branchId }, { toBranchId: filters.branchId }]
    : scope.isOrgWide
      ? undefined
      : [{ fromBranchId: { in: scope.branchIds } }, { toBranchId: { in: scope.branchIds } }]
  const where: Prisma.StockTransferWhereInput = {
    organizationId: session.user.organizationId,
    status: filters.status as never,
    OR: branchTouch,
  }
  const [transfers, total] = await Promise.all([
    db.stockTransfer.findMany({
      where,
      include: { fromBranch: true, toBranch: true, product: true, batch: true },
      orderBy: { requestedAt: "desc" },
      ...paginationSkipTake(page, TRANSFER_PAGE_SIZE),
    }),
    db.stockTransfer.count({ where }),
  ])
  return { transfers, total, page, pageSize: TRANSFER_PAGE_SIZE, totalPages: totalPages(total, TRANSFER_PAGE_SIZE) }
}
