import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { applyRefundAtomically } from "@/lib/domains/billing/invoices"
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
  // P3.7 §41: see charges.ts's `voidCharge` comment for the full reasoning
  // — this applies identically across every write in this file.
  assertBranchAccess(getAuthorizedBranchScope(session), invoice.branchId)
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
  assertBranchAccess(getAuthorizedBranchScope(session), refund.branchId)
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
  assertBranchAccess(getAuthorizedBranchScope(session), refund.branchId)
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
  assertBranchAccess(getAuthorizedBranchScope(session), refund.branchId)
  if (refund.status !== "authorized") {
    throw new Error(`Only an authorized refund can be completed (this one is "${refund.status}").`)
  }
  if (refund.method === "cash" && cashierSessionId) {
    const cashierSession = await db.cashierSession.findFirstOrThrow({
      where: { id: cashierSessionId, organizationId: session.user.organizationId },
    })
    if (cashierSession.status !== "open") throw new Error("The cashier session is closed.")
  }

  // Timeout widened from Prisma's 5000ms default — see posting-service.ts's
  // POSTING_TRANSACTION_OPTIONS for why this environment's real Supabase
  // latency needs the headroom.
  const updated = await db.$transaction(async (tx) => {
    // Atomically claim the refund itself first (authorized -> completed) —
    // guards against completeRefund being invoked twice for the SAME
    // refund (a double-click/retry, not two different refunds racing).
    // Without this, two concurrent calls for one refund could both pass
    // applyRefundAtomically's balance check below (if there's enough
    // headroom to absorb the same amount twice) and double-decrement
    // paid_amount even though only one Refund row exists — the same
    // "claim before acting" discipline the outbox dispatcher uses against
    // double-processing (P1 §33's idempotency review; see outbox.ts).
    // P1 §30: assigned here, not at request/authorize time, since this is
    // the first point a refund is guaranteed to actually happen — matches
    // nextNumber()'s existing "PAY"/"INV" call sites, which likewise number
    // the transaction only once it's real.
    const refundNumber = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "RFD",
      prefix: "RFD",
    })

    const claimed = await tx.refund.updateMany({
      where: { id: refundId, status: "authorized" },
      data: { status: "completed", completedAt: new Date(), cashierSessionId: cashierSessionId ?? null, refundNumber },
    })
    if (claimed.count === 0) {
      throw new Error("This refund was already completed (or its status changed) — refresh and try again.")
    }

    // P1 §7: the atomic guard against two DIFFERENT refunds combining to
    // exceed what was ever paid — see applyRefundAtomically's own doc
    // comment.
    await applyRefundAtomically(tx, refund.invoiceId, new Decimal(refund.amount))

    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "RefundCompleted",
      payload: { refundId, invoiceId: refund.invoiceId, amount: Number(refund.amount) },
    })
    return tx.refund.findUniqueOrThrow({ where: { id: refundId } })
  }, { timeout: 20_000, maxWait: 10_000 })

  await auditFromSession(session, "complete", "refund", refundId, { new: { status: "completed" } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}

export async function listInvoiceRefunds(session: SessionContext, invoiceId: string) {
  assertCan(session, "invoice.view")
  const scope = getAuthorizedBranchScope(session)
  return db.refund.findMany({
    where: { organizationId: session.user.organizationId, branchId: narrowBranchFilter(scope), invoiceId },
    orderBy: { requestedAt: "desc" },
  })
}

export async function listPendingRefundRequests(session: SessionContext) {
  assertCan(session, "refund.authorize")
  const scope = getAuthorizedBranchScope(session)
  return db.refund.findMany({
    where: {
      organizationId: session.user.organizationId,
      branchId: narrowBranchFilter(scope),
      status: { in: ["requested", "authorized"] },
    },
    include: { invoice: { include: { patient: true } } },
    orderBy: { requestedAt: "asc" },
  })
}
