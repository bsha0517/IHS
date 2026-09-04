import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { resolvePage, paginationSkipTake, totalPages } from "@/lib/platform/pagination"
import { createNotificationOnce, createNotificationsOnce, notifyBestEffort, resolveBranchPermissionRecipientIds } from "@/lib/domains/notifications/service"
import type { Prisma } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"
import type { PurchaseRequestInput } from "@/lib/domains/procurement/schemas"

const PR_INCLUDE = { lines: { include: { product: true } }, branch: true } as const

/**
 * Purchase Request -> Approval -> Purchase Order (spec.md §46).
 *
 * P3.11 §28/§31: notifies every `purchase_request.approve` holder scoped to
 * the request's own branch — the same "approval requiring attention" shape
 * as the leave-request notification (hr/leave.ts), reusing the same
 * branch-aware recipient resolver. Best-effort — a notification failure
 * never blocks the purchase request itself from being recorded.
 */
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

  await notifyBestEffort(
    async () => {
      const recipientIds = await resolveBranchPermissionRecipientIds(session.user.organizationId, "purchase_request.approve", input.branchId)
      await createNotificationsOnce(
        db,
        recipientIds.map((recipientUserId) => ({
          organizationId: session.user.organizationId,
          recipientUserId,
          type: "purchase_request_submitted",
          title: "Purchase request awaiting approval",
          body: `${created.requestNumber} (${input.lines.length} line(s)) is awaiting approval.`,
          referenceType: "purchase_request",
          referenceId: created.id,
        }))
      )
    },
    { event: "notifications.purchase_request_submitted_failed", organizationId: session.user.organizationId }
  )

  return created
}

export async function getPurchaseRequest(session: SessionContext, id: string) {
  assertCan(session, "purchase_request.create")
  const pr = await db.purchaseRequest.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: PR_INCLUDE,
  })
  assertBranchAccess(getAuthorizedBranchScope(session), pr.branchId)
  return pr
}

const PURCHASE_REQUEST_PAGE_SIZE = 50

/** P3.8 §28: was `take: 100` with no page param. Real server-side pagination now, same convention as the rest of P2/P3.8 (resolvePage/paginationSkipTake/totalPages), preserving the existing status filter. */
export async function listPurchaseRequests(session: SessionContext, filters: { status?: string; page?: number } = {}) {
  assertCan(session, "purchase_request.create")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where: Prisma.PurchaseRequestWhereInput = { organizationId: session.user.organizationId, status: filters.status as never, branchId: narrowBranchFilter(scope) }
  const [requests, total] = await Promise.all([
    db.purchaseRequest.findMany({
      where,
      include: PR_INCLUDE,
      orderBy: { createdAt: "desc" },
      ...paginationSkipTake(page, PURCHASE_REQUEST_PAGE_SIZE),
    }),
    db.purchaseRequest.count({ where }),
  ])
  return { requests, total, page, pageSize: PURCHASE_REQUEST_PAGE_SIZE, totalPages: totalPages(total, PURCHASE_REQUEST_PAGE_SIZE) }
}

/** Distinct permission from creation — segregation of duties (same pattern as Phase 4's refund.request/authorize). */
export async function approvePurchaseRequest(session: SessionContext, id: string) {
  assertCan(session, "purchase_request.approve")

  const pr = await db.purchaseRequest.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  // P3.8 §46: previously unchecked — any session holding `purchase_request.approve`
  // anywhere could approve a request from a branch it has no access to.
  assertBranchAccess(getAuthorizedBranchScope(session), pr.branchId)
  if (pr.status !== "submitted") throw new Error(`Only a submitted request can be approved (this one is "${pr.status}").`)

  const updated = await db.purchaseRequest.update({
    where: { id },
    data: { status: "approved", approvedBy: session.user.id, approvedAt: new Date() },
  })
  await auditFromSession(session, "approve", "purchase_request", id, { new: { status: "approved" } })

  if (pr.requestedBy) {
    await notifyBestEffort(
      () =>
        createNotificationOnce(db, {
          organizationId: session.user.organizationId,
          recipientUserId: pr.requestedBy!,
          type: "purchase_request_decision",
          title: "Purchase request approved",
          body: `${pr.requestNumber} was approved.`,
          referenceType: "purchase_request",
          referenceId: id,
        }),
      { event: "notifications.purchase_request_decision_failed", organizationId: session.user.organizationId }
    )
  }

  return updated
}

export async function rejectPurchaseRequest(session: SessionContext, id: string, reason: string) {
  assertCan(session, "purchase_request.approve")

  const pr = await db.purchaseRequest.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  assertBranchAccess(getAuthorizedBranchScope(session), pr.branchId)
  if (pr.status !== "submitted") throw new Error(`Only a submitted request can be rejected (this one is "${pr.status}").`)

  const updated = await db.purchaseRequest.update({
    where: { id },
    data: { status: "rejected", approvedBy: session.user.id, approvedAt: new Date(), rejectionReason: reason },
  })
  await auditFromSession(session, "reject", "purchase_request", id, { new: { status: "rejected", reason } })

  if (pr.requestedBy) {
    await notifyBestEffort(
      () =>
        createNotificationOnce(db, {
          organizationId: session.user.organizationId,
          recipientUserId: pr.requestedBy!,
          type: "purchase_request_decision",
          title: "Purchase request rejected",
          body: `${pr.requestNumber} was rejected.`,
          referenceType: "purchase_request",
          referenceId: id,
        }),
      { event: "notifications.purchase_request_decision_failed", organizationId: session.user.organizationId }
    )
  }

  return updated
}
