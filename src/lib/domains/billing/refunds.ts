import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"
import type { RequestRefundInput } from "@/lib/domains/billing/schemas"

/**
 * Request -> Authorization -> Refund/Credit Note -> Payment Reversal (where
 * appropriate) -> Accounting Adjustment (spec.md §36). Never deletes or
 * mutates the original Payment (spec.md §92) — this row is the reversal
 * record; `completeRefund` only ever decrements Invoice.paidAmount.
 */
export async function requestRefund(session: SessionContext, input: RequestRefundInput) {
  assertCan(session, "refund.request")

  const invoice = await db.invoice.findFirstOrThrow({
    where: { id: input.invoiceId, organizationId: session.user.organizationId },
  })
  if (new Decimal(input.amount).greaterThan(invoice.paidAmount)) {
    throw new Error(`Refund amount cannot exceed the ${Number(invoice.paidAmount).toFixed(2)} already paid on this invoice.`)
  }
  if (input.paymentId) {
    await db.payment.findFirstOrThrow({
      where: { id: input.paymentId, organizationId: session.user.organizationId, allocations: { some: { invoiceId: invoice.id } } },
    })
  }

  const refund = await db.refund.create({
    data: {
      organizationId: session.user.organizationId,
      branchId: invoice.branchId,
      invoiceId: invoice.id,
      paymentId: input.paymentId ?? null,
      method: input.method,
      amount: new Decimal(input.amount),
      reason: input.reason,
      requestedBy: session.user.id,
    },
  })
  await auditFromSession(session, "request", "refund", refund.id, { new: { invoiceId: invoice.id, amount: input.amount } })
  return refund
}

/** Approval only — no money movement yet. Distinct permission from request (segregation of duties). */
export async function authorizeRefund(session: SessionContext, refundId: string) {
  assertCan(session, "refund.authorize")

  const refund = await db.refund.findFirstOrThrow({
    where: { id: refundId, organizationId: session.user.organizationId },
  })
  if (refund.status !== "requested") {
    throw new Error(`Only a requested refund can be authorized (this one is "${refund.status}").`)
  }

  const updated = await db.refund.update({
    where: { id: refundId },
    data: { status: "authorized", authorizedBy: session.user.id, authorizedAt: new Date() },
  })
  await auditFromSession(session, "authorize", "refund", refundId, { new: { status: "authorized" } })
  return updated
}

export async function rejectRefund(session: SessionContext, refundId: string, reason: string) {
  assertCan(session, "refund.authorize")

  const refund = await db.refund.findFirstOrThrow({
    where: { id: refundId, organizationId: session.user.organizationId },
  })
  if (refund.status !== "requested") {
    throw new Error(`Only a requested refund can be rejected (this one is "${refund.status}").`)
  }

  const updated = await db.refund.update({
    where: { id: refundId },
    data: { status: "rejected", authorizedBy: session.user.id, authorizedAt: new Date(), rejectionReason: reason },
  })
  await auditFromSession(session, "reject", "refund", refundId, { new: { status: "rejected", reason } })
  return updated
}

/** The actual Payment Reversal step — decrements Invoice.paidAmount, never touches the original Payment row. */
export async function completeRefund(session: SessionContext, refundId: string, cashierSessionId?: string) {
  assertCan(session, "refund.authorize")

  const refund = await db.refund.findFirstOrThrow({
    where: { id: refundId, organizationId: session.user.organizationId },
    include: { invoice: true },
  })
  if (refund.status !== "authorized") {
    throw new Error(`Only an authorized refund can be completed (this one is "${refund.status}").`)
  }
  if (refund.method === "cash" && cashierSessionId) {
    const cashierSession = await db.cashierSession.findFirstOrThrow({
      where: { id: cashierSessionId, organizationId: session.user.organizationId },
    })
    if (cashierSession.status !== "open") throw new Error("The cashier session is closed.")
  }

  const updated = await db.$transaction(async (tx) => {
    const newPaidAmount = new Decimal(refund.invoice.paidAmount).sub(refund.amount)
    const newStatus =
      newPaidAmount.lessThanOrEqualTo(0) ? "issued" : newPaidAmount.lessThan(refund.invoice.totalAmount) ? "partially_paid" : "paid"
    await tx.invoice.update({
      where: { id: refund.invoiceId },
      data: { paidAmount: newPaidAmount.isNegative() ? new Decimal(0) : newPaidAmount, status: newStatus },
    })
    const result = await tx.refund.update({
      where: { id: refundId },
      data: { status: "completed", completedAt: new Date(), cashierSessionId: cashierSessionId ?? null },
    })
    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "RefundCompleted",
      payload: { refundId, invoiceId: refund.invoiceId, amount: Number(refund.amount) },
    })
    return result
  })

  await auditFromSession(session, "complete", "refund", refundId, { new: { status: "completed" } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}

export async function listInvoiceRefunds(session: SessionContext, invoiceId: string) {
  assertCan(session, "invoice.view")
  return db.refund.findMany({
    where: { organizationId: session.user.organizationId, invoiceId },
    orderBy: { requestedAt: "desc" },
  })
}

export async function listPendingRefundRequests(session: SessionContext) {
  assertCan(session, "refund.authorize")
  return db.refund.findMany({
    where: { organizationId: session.user.organizationId, status: { in: ["requested", "authorized"] } },
    include: { invoice: { include: { patient: true } } },
    orderBy: { requestedAt: "asc" },
  })
}
