import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"
import type { RecordPaymentInput } from "@/lib/domains/billing/schemas"

/**
 * Records one or more tenders against an invoice in a single transaction
 * (spec.md §35 split-payment example: Cash 200 + Card 500 + Insurance 300).
 * Each tender becomes its own Payment + PaymentAllocation row — never a
 * single blended row — so each tender's method/reference stays individually
 * auditable and reversible. Every payment must be recorded against an open
 * CashierSession (spec.md §37's Open Register -> Transactions flow).
 */
export async function recordPayment(session: SessionContext, input: RecordPaymentInput) {
  assertCan(session, "payment.create")

  const invoice = await db.invoice.findFirstOrThrow({
    where: { id: input.invoiceId, organizationId: session.user.organizationId },
  })
  if (invoice.status === "void") throw new Error("Cannot record a payment against a void invoice.")
  if (invoice.status === "paid") throw new Error("This invoice is already fully paid.")

  const cashierSession = await db.cashierSession.findFirstOrThrow({
    where: { id: input.cashierSessionId, organizationId: session.user.organizationId },
  })
  if (cashierSession.status !== "open") throw new Error("The cashier session is closed.")
  if (cashierSession.cashierUserId !== session.user.id) {
    throw new Error("You can only record payments against your own open cashier session.")
  }

  const totalTendered = input.tenders.reduce((sum, t) => sum.add(t.amount), new Decimal(0))
  const outstanding = new Decimal(invoice.totalAmount).sub(invoice.paidAmount)
  if (totalTendered.greaterThan(outstanding)) {
    throw new Error(`Payment of ${totalTendered.toFixed(2)} exceeds the outstanding balance of ${outstanding.toFixed(2)}.`)
  }

  const payments = await db.$transaction(async (tx) => {
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

    const newPaidAmount = new Decimal(invoice.paidAmount).add(totalTendered)
    const newStatus = newPaidAmount.greaterThanOrEqualTo(invoice.totalAmount) ? "paid" : "partially_paid"
    await tx.invoice.update({ where: { id: invoice.id }, data: { paidAmount: newPaidAmount, status: newStatus } })

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

    return created
  })

  await auditFromSession(session, "create", "payment", payments.map((p) => p.id).join(","), {
    new: { invoiceId: invoice.id, tenders: input.tenders },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)

  return payments
}

export async function listInvoicePayments(session: SessionContext, invoiceId: string) {
  assertCan(session, "payment.view")
  return db.payment.findMany({
    where: { organizationId: session.user.organizationId, allocations: { some: { invoiceId } } },
    orderBy: { receivedAt: "asc" },
  })
}

export async function listPatientPayments(session: SessionContext, patientId: string) {
  assertCan(session, "payment.view")
  return db.payment.findMany({
    where: {
      organizationId: session.user.organizationId,
      allocations: { some: { invoice: { patientId } } },
    },
    include: { allocations: { include: { invoice: true } } },
    orderBy: { receivedAt: "desc" },
  })
}

export async function listPayments(session: SessionContext, filters: { branchId?: string } = {}) {
  assertCan(session, "payment.view")
  return db.payment.findMany({
    where: { organizationId: session.user.organizationId, branchId: filters.branchId },
    include: { allocations: { include: { invoice: { include: { patient: true } } } } },
    orderBy: { receivedAt: "desc" },
    take: 100,
  })
}
