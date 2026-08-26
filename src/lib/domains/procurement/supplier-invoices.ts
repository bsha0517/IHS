import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"
import type { SupplierInvoiceInput, SupplierPaymentInput } from "@/lib/domains/procurement/schemas"

/** Supplier invoice creates the accounts-payable obligation (spec.md §46) — the AP ledger posting itself is Phase 6. */
export async function createSupplierInvoice(session: SessionContext, input: SupplierInvoiceInput) {
  assertCan(session, "supplier_invoice.manage", { branchId: input.branchId })

  const created = await db.supplierInvoice.create({
    data: {
      organizationId: session.user.organizationId,
      branchId: input.branchId,
      supplierId: input.supplierId,
      purchaseOrderId: input.purchaseOrderId ?? null,
      invoiceNumber: input.invoiceNumber,
      amount: new Decimal(input.amount),
      dueDate: input.dueDate ?? null,
      createdBy: session.user.id,
    },
  })
  await auditFromSession(session, "create", "supplier_invoice", created.id, {
    new: { invoiceNumber: created.invoiceNumber, amount: input.amount },
  })
  return created
}

/** Simpler 1:N against SupplierInvoice — spec.md §46 describes one invoice paid at a time, not a batched AP settlement. */
export async function recordSupplierPayment(session: SessionContext, input: SupplierPaymentInput) {
  assertCan(session, "supplier_invoice.manage")

  const invoice = await db.supplierInvoice.findFirstOrThrow({
    where: { id: input.supplierInvoiceId, organizationId: session.user.organizationId },
  })
  if (invoice.status === "cancelled") throw new Error("Cannot pay a cancelled supplier invoice.")
  const outstanding = new Decimal(invoice.amount).sub(invoice.paidAmount)
  if (new Decimal(input.amount).greaterThan(outstanding)) {
    throw new Error(`Payment of ${input.amount} exceeds the outstanding balance of ${outstanding.toFixed(2)}.`)
  }

  const result = await db.$transaction(async (tx) => {
    const payment = await tx.supplierPayment.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: invoice.branchId,
        supplierInvoiceId: invoice.id,
        method: input.method,
        amount: new Decimal(input.amount),
        reference: input.reference ?? null,
        paidBy: session.user.id,
      },
    })
    const newPaidAmount = new Decimal(invoice.paidAmount).add(input.amount)
    await tx.supplierInvoice.update({
      where: { id: invoice.id },
      data: {
        paidAmount: newPaidAmount,
        status: newPaidAmount.greaterThanOrEqualTo(invoice.amount) ? "paid" : "partially_paid",
      },
    })

    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "SupplierPaymentRecorded",
      payload: { supplierPaymentId: payment.id },
    })

    return payment
  })

  await auditFromSession(session, "create", "supplier_payment", result.id, {
    new: { supplierInvoiceId: invoice.id, amount: input.amount },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return result
}

export async function listSupplierInvoices(session: SessionContext, filters: { supplierId?: string; status?: string } = {}) {
  assertCan(session, "supplier_invoice.manage")
  return db.supplierInvoice.findMany({
    where: {
      organizationId: session.user.organizationId,
      supplierId: filters.supplierId,
      status: filters.status as never,
    },
    include: { supplier: true, purchaseOrder: true, payments: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
}

export async function getSupplierInvoice(session: SessionContext, id: string) {
  assertCan(session, "supplier_invoice.manage")
  return db.supplierInvoice.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { supplier: true, purchaseOrder: true, payments: true },
  })
}
