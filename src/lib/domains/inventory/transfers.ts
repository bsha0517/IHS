import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { StockTransferInput } from "@/lib/domains/inventory/schemas"
import type { SessionContext } from "@/lib/auth/session"

export async function createTransfer(session: SessionContext, input: StockTransferInput) {
  assertCan(session, "stock.transfer", { branchId: input.fromBranchId })
  if (input.fromBranchId === input.toBranchId) {
    throw new Error("Source and destination branches must be different.")
  }

  const created = await db.stockTransfer.create({
    data: {
      organizationId: session.user.organizationId,
      fromBranchId: input.fromBranchId,
      toBranchId: input.toBranchId,
      productId: input.productId,
      batchId: input.batchId ?? null,
      quantity: new Decimal(input.quantity),
      notes: input.notes ?? null,
      requestedBy: session.user.id,
    },
  })
  await auditFromSession(session, "create", "stock_transfer", created.id, {
    new: { productId: input.productId, quantity: input.quantity },
  })
  return created
}

/** Writes the matching transfer_out/transfer_in ledger pair — the actual stock movement. */
export async function completeTransfer(session: SessionContext, transferId: string) {
  assertCan(session, "stock.transfer")

  const transfer = await db.stockTransfer.findFirstOrThrow({
    where: { id: transferId, organizationId: session.user.organizationId },
  })
  if (transfer.status !== "pending" && transfer.status !== "in_transit") {
    throw new Error(`Cannot complete a transfer with status "${transfer.status}".`)
  }

  const balanceAtSource = await db.stockLedgerEntry.aggregate({
    where: {
      organizationId: session.user.organizationId,
      branchId: transfer.fromBranchId,
      productId: transfer.productId,
      batchId: transfer.batchId,
    },
    _sum: { quantity: true },
  })
  const available = new Decimal(balanceAtSource._sum.quantity ?? 0)
  if (available.lessThan(transfer.quantity)) {
    throw new Error(`Only ${available.toString()} units available at the source branch.`)
  }

  const updated = await db.$transaction(async (tx) => {
    await tx.stockLedgerEntry.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: transfer.fromBranchId,
        productId: transfer.productId,
        batchId: transfer.batchId,
        transactionType: "transfer_out",
        quantity: new Decimal(transfer.quantity).negated(),
        referenceType: "stock_transfer",
        referenceId: transfer.id,
        performedBy: session.user.id,
      },
    })
    await tx.stockLedgerEntry.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: transfer.toBranchId,
        productId: transfer.productId,
        batchId: transfer.batchId,
        transactionType: "transfer_in",
        quantity: new Decimal(transfer.quantity),
        referenceType: "stock_transfer",
        referenceId: transfer.id,
        performedBy: session.user.id,
      },
    })
    return tx.stockTransfer.update({ where: { id: transferId }, data: { status: "completed", completedAt: new Date() } })
  })

  await auditFromSession(session, "complete", "stock_transfer", transferId, { new: { status: "completed" } })
  return updated
}

export async function cancelTransfer(session: SessionContext, transferId: string, reason: string) {
  assertCan(session, "stock.transfer")
  const transfer = await db.stockTransfer.findFirstOrThrow({
    where: { id: transferId, organizationId: session.user.organizationId },
  })
  if (transfer.status === "completed") throw new Error("Cannot cancel a completed transfer.")

  const updated = await db.stockTransfer.update({
    where: { id: transferId },
    data: { status: "cancelled", notes: reason },
  })
  await auditFromSession(session, "cancel", "stock_transfer", transferId, { new: { status: "cancelled", reason } })
  return updated
}

export async function listTransfers(session: SessionContext, filters: { branchId?: string; status?: string } = {}) {
  assertCan(session, "inventory.view")
  return db.stockTransfer.findMany({
    where: {
      organizationId: session.user.organizationId,
      status: filters.status as never,
      OR: filters.branchId ? [{ fromBranchId: filters.branchId }, { toBranchId: filters.branchId }] : undefined,
    },
    include: { fromBranch: true, toBranch: true, product: true },
    orderBy: { requestedAt: "desc" },
    take: 100,
  })
}
