import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import type { SessionContext } from "@/lib/auth/session"
import type { PurchaseRequestInput } from "@/lib/domains/procurement/schemas"

const PR_INCLUDE = { lines: { include: { product: true } }, branch: true } as const

/** Purchase Request -> Approval -> Purchase Order (spec.md §46). */
export async function createPurchaseRequest(session: SessionContext, input: PurchaseRequestInput) {
  assertCan(session, "purchase_request.create", { branchId: input.branchId })

  const created = await db.$transaction(async (tx) => {
    const requestNumber = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "PR",
      prefix: "PR",
    })
    const pr = await tx.purchaseRequest.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        requestNumber,
        notes: input.notes ?? null,
        requestedBy: session.user.id,
      },
    })
    await tx.purchaseRequestLine.createMany({
      data: input.lines.map((line) => ({
        purchaseRequestId: pr.id,
        productId: line.productId,
        quantity: line.quantity,
        notes: line.notes ?? null,
      })),
    })
    return pr
  })

  await auditFromSession(session, "create", "purchase_request", created.id, {
    new: { requestNumber: created.requestNumber, lineCount: input.lines.length },
  })
  return created
}

export async function getPurchaseRequest(session: SessionContext, id: string) {
  assertCan(session, "purchase_request.create")
  return db.purchaseRequest.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: PR_INCLUDE,
  })
}

export async function listPurchaseRequests(session: SessionContext, filters: { status?: string } = {}) {
  assertCan(session, "purchase_request.create")
  return db.purchaseRequest.findMany({
    where: { organizationId: session.user.organizationId, status: filters.status as never },
    include: PR_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 100,
  })
}

/** Distinct permission from creation — segregation of duties (same pattern as Phase 4's refund.request/authorize). */
export async function approvePurchaseRequest(session: SessionContext, id: string) {
  assertCan(session, "purchase_request.approve")

  const pr = await db.purchaseRequest.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  if (pr.status !== "submitted") throw new Error(`Only a submitted request can be approved (this one is "${pr.status}").`)

  const updated = await db.purchaseRequest.update({
    where: { id },
    data: { status: "approved", approvedBy: session.user.id, approvedAt: new Date() },
  })
  await auditFromSession(session, "approve", "purchase_request", id, { new: { status: "approved" } })
  return updated
}

export async function rejectPurchaseRequest(session: SessionContext, id: string, reason: string) {
  assertCan(session, "purchase_request.approve")

  const pr = await db.purchaseRequest.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  if (pr.status !== "submitted") throw new Error(`Only a submitted request can be rejected (this one is "${pr.status}").`)

  const updated = await db.purchaseRequest.update({
    where: { id },
    data: { status: "rejected", approvedBy: session.user.id, approvedAt: new Date(), rejectionReason: reason },
  })
  await auditFromSession(session, "reject", "purchase_request", id, { new: { status: "rejected", reason } })
  return updated
}
