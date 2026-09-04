import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { resolvePage, paginationSkipTake, totalPages } from "@/lib/platform/pagination"
import { applyPaymentAtomically } from "@/lib/domains/billing/invoices"
import { claimIdempotencyKey, recordIdempotentResult, resolveDuplicateRequest, isIdempotencyKeyConflict } from "@/lib/platform/idempotency"
import type { SessionContext } from "@/lib/auth/session"
import type { RecordPaymentInput } from "@/lib/domains/billing/schemas"

const IDEMPOTENCY_SCOPE = "payment.record"

/**
 * Records one or more tenders against an invoice in a single transaction
 * (spec.md §35 split-payment example: Cash 200 + Card 500 + Insurance 300).
 * Each tender becomes its own Payment + PaymentAllocation row — never a
 * single blended row — so each tender's method/reference stays individually
 * auditable and reversible. Every payment must be recorded against an open
 * CashierSession (spec.md §37's Open Register -> Transactions flow).
 *
 * P1 §33: `applyPaymentAtomically` alone only prevents OVERPAYMENT — two
 * *different*, legitimate concurrent payments can never together exceed the
 * balance. It does nothing for the *same* tender submitted twice (a
 * double-click, or a network retry after the first request actually
 * succeeded but the client never saw the response): if there's enough
 * headroom, both would pass the balance check and both would create a real
 * Payment row, overcounting cash actually collected once. `idempotencyKey`,
 * when the caller supplies one (the POS/cashier UI generates one per
 * payment-form-open), closes that gap — see platform/idempotency.ts.
 */
export async function recordPayment(session: SessionContext, input: RecordPaymentInput & { idempotencyKey?: string }) {
  assertCan(session, "payment.create")

  const invoice = await db.invoice.findFirstOrThrow({
    where: { id: input.invoiceId, organizationId: session.user.organizationId },
  })
  // P3.7 §41: previously absent — see charges.ts's `voidCharge` comment for
  // the full reasoning. Every other write in this file already narrows read
  // lists by branch; this write path had no equivalent check at all.
  assertBranchAccess(getAuthorizedBranchScope(session), invoice.branchId)
  if (invoice.status === "void") throw new Error("Cannot record a payment against a void invoice.")
  if (invoice.status === "paid") throw new Error("This invoice is already fully paid.")

  const cashierSession = await db.cashierSession.findFirstOrThrow({
    where: { id: input.cashierSessionId, organizationId: session.user.organizationId },
  })
  if (cashierSession.status !== "open") throw new Error("The cashier session is closed.")
  if (cashierSession.cashierUserId !== session.user.id) {
    throw new Error("You can only record payments against your own open cashier session.")
  }
  // A register opened at one branch shouldn't collect payment for an
  // invoice billed at a different one, even if the cashier's own account is
  // nominally authorized across several branches — the payment's own
  // branchId (below) is always the invoice's, so this keeps the register
  // that physically took the money aligned with what it's recorded against.
  if (cashierSession.branchId !== invoice.branchId) {
    throw new Error("This invoice belongs to a different branch than your open register — open a register at the correct branch.")
  }

  const totalTendered = input.tenders.reduce((sum, t) => sum.add(t.amount), new Decimal(0))
  // Fast, pre-transaction check for the common (non-racing) case — a
  // friendly error without even opening a transaction. This is NOT the
  // safety mechanism: applyPaymentAtomically below is what actually
  // prevents two concurrent payments (or a payment racing an insurance
  // remittance — claims/service.ts's recordRemittance touches the same
  // paid_amount column through the same helper) from both succeeding and
  // together overpaying (P1 §29). A stale read here can only produce a
  // false "looks fine", never a false rejection, so it's safe as a pure
  // optimization, not load-bearing.
  const preliminaryOutstanding = new Decimal(invoice.totalAmount).sub(invoice.paidAmount)
  if (totalTendered.greaterThan(preliminaryOutstanding)) {
    throw new Error(`Payment of ${totalTendered.toFixed(2)} exceeds the outstanding balance of ${preliminaryOutstanding.toFixed(2)}.`)
  }

  // Timeout widened from Prisma's 5000ms default — see posting-service.ts's
  // POSTING_TRANSACTION_OPTIONS for why this environment's real Supabase
  // latency needs the headroom once applyPaymentAtomically's extra round
  // trip is added to the existing per-tender nextNumber()+create()+create().
  let payments
  try {
    payments = await db.$transaction(async (tx) => {
      if (input.idempotencyKey) {
        await claimIdempotencyKey(tx, { organizationId: session.user.organizationId, scope: IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
      }

      // P1 §29: the atomic guard — see applyPaymentAtomically's own doc
      // comment for why this, not the plain read-then-write this replaced,
      // is what actually prevents concurrent payments from combining to
      // overpay an invoice.
      await applyPaymentAtomically(tx, invoice.id, totalTendered)

      const created = []
      for (const tender of input.tenders) {
        const receiptNumber = await nextNumber({
          organizationId: session.user.organizationId,
          sequenceType: "PAY",
          prefix: "PAY",
        })
        const payment = await tx.payment.create({
          data: {
            organizationId: session.user.organizationId,
            branchId: invoice.branchId,
            receiptNumber,
            method: tender.method,
            amount: new Decimal(tender.amount),
            reference: tender.reference ?? null,
            cashierSessionId: input.cashierSessionId,
            receivedBy: session.user.id,
          },
        })
        await tx.paymentAllocation.create({
          data: { paymentId: payment.id, invoiceId: invoice.id, amount: new Decimal(tender.amount) },
        })
        created.push(payment)
      }

      await writeOutboxEvent(tx, {
        organizationId: session.user.organizationId,
        eventType: "PaymentReceived",
        payload: {
          invoiceId: invoice.id,
          patientId: invoice.patientId,
          amount: Number(totalTendered),
          tenders: input.tenders.map((t) => ({ method: t.method, amount: t.amount })),
          paymentIds: created.map((p) => p.id),
        },
      })

      if (input.idempotencyKey) {
        // Multiple Payment rows can come out of one call (split tenders) —
        // IdempotencyKey.resultId is a single string column, so the set of
        // ids is JSON-encoded into it rather than adding a join table for
        // what's still fundamentally one scalar "what did this attempt
        // produce" value.
        await recordIdempotentResult(tx, {
          organizationId: session.user.organizationId,
          scope: IDEMPOTENCY_SCOPE,
          key: input.idempotencyKey,
          resultId: JSON.stringify(created.map((p) => p.id)),
        })
      }

      return created
    }, { timeout: 20_000, maxWait: 10_000 })
  } catch (error) {
    if (input.idempotencyKey && isIdempotencyKeyConflict(error)) {
      const resultId = await resolveDuplicateRequest({ organizationId: session.user.organizationId, scope: IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
      const paymentIds: string[] = JSON.parse(resultId)
      return db.payment.findMany({ where: { id: { in: paymentIds } } }) // idempotent replay — the original request's own payments, not new ones
    }
    throw error
  }

  await auditFromSession(session, "create", "payment", payments.map((p) => p.id).join(","), {
    new: { invoiceId: invoice.id, tenders: input.tenders },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)

  return payments
}

/**
 * P3.7 §21: backs the new payment-receipt print view — a single Payment
 * (with its allocated invoice(s) and patient) is a different, narrower read
 * than any of the list functions below, which is why none of them fit.
 */
export async function getPayment(session: SessionContext, id: string) {
  assertCan(session, "payment.view")
  const payment = await db.payment.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { allocations: { include: { invoice: { include: { patient: true } } } } },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), payment.branchId)
  return payment
}

export async function listInvoicePayments(session: SessionContext, invoiceId: string) {
  assertCan(session, "payment.view")
  const scope = getAuthorizedBranchScope(session)
  return db.payment.findMany({
    where: {
      organizationId: session.user.organizationId,
      branchId: narrowBranchFilter(scope),
      allocations: { some: { invoiceId } },
    },
    orderBy: { receivedAt: "asc" },
  })
}

export async function listPatientPayments(session: SessionContext, patientId: string) {
  assertCan(session, "payment.view")
  const scope = getAuthorizedBranchScope(session)
  return db.payment.findMany({
    where: {
      organizationId: session.user.organizationId,
      branchId: narrowBranchFilter(scope),
      allocations: { some: { invoice: { patientId } } },
    },
    include: { allocations: { include: { invoice: true } } },
    orderBy: { receivedAt: "desc" },
  })
}

const PAYMENT_LIST_PAGE_SIZE = 50

/** P2 §8: was `take: 100` with no page param. Real server-side pagination now. */
export async function listPayments(session: SessionContext, filters: { branchId?: string; page?: number } = {}) {
  assertCan(session, "payment.view")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where: Prisma.PaymentWhereInput = { organizationId: session.user.organizationId, branchId: narrowBranchFilter(scope, filters.branchId) }
  const [payments, total] = await Promise.all([
    db.payment.findMany({
      where,
      include: { allocations: { include: { invoice: { include: { patient: true } } } } },
      orderBy: { receivedAt: "desc" },
      ...paginationSkipTake(page, PAYMENT_LIST_PAGE_SIZE),
    }),
    db.payment.count({ where }),
  ])
  return { payments, total, page, pageSize: PAYMENT_LIST_PAGE_SIZE, totalPages: totalPages(total, PAYMENT_LIST_PAGE_SIZE) }
}
