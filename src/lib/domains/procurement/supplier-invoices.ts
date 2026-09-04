import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { resolvePage, paginationSkipTake, totalPages } from "@/lib/platform/pagination"
import { claimIdempotencyKey, recordIdempotentResult, resolveDuplicateRequest, isIdempotencyKeyConflict } from "@/lib/platform/idempotency"
import type { SessionContext } from "@/lib/auth/session"
import type { SupplierInvoiceInput, SupplierPaymentInput } from "@/lib/domains/procurement/schemas"

const SUPPLIER_INVOICE_IDEMPOTENCY_SCOPE = "supplier_invoice.create"

/**
 * P1 §32 (finding A3, same shape as `applyPaymentAtomically` /
 * `billing/invoices.ts`): the AP-side mirror of the exact race that finding
 * named on the patient-billing side — `recordSupplierPayment` used to read
 * `paidAmount` outside any transaction, validate against that snapshot, then
 * write `newPaidAmount` unconditionally inside one. Two concurrent supplier
 * payments against the same invoice could both read the same stale
 * `paidAmount`, both pass validation, both commit — overpaying the supplier
 * past what was ever actually owed. Fixed with the identical single atomic
 * `UPDATE ... WHERE paid_amount + amount <= total_payable` pattern.
 */
async function applySupplierPaymentAtomically(
  tx: Prisma.TransactionClient,
  supplierInvoiceId: string,
  amount: Decimal
): Promise<{ status: string }> {
  const updated = await tx.$queryRaw<{ status: string }[]>(Prisma.sql`
    UPDATE "supplier_invoice"
    SET
      "paid_amount" = "paid_amount" + ${amount.toFixed(2)}::numeric,
      "status" = CASE
        WHEN "paid_amount" + ${amount.toFixed(2)}::numeric >= "amount" + "tax_amount" THEN 'paid'::"SupplierInvoiceStatus"
        ELSE 'partially_paid'::"SupplierInvoiceStatus"
      END
    WHERE "id" = ${supplierInvoiceId}
      AND "status" != 'cancelled'
      AND "paid_amount" + ${amount.toFixed(2)}::numeric <= "amount" + "tax_amount"
    RETURNING "status"
  `)
  if (updated.length === 0) {
    throw new Error(
      `Payment of ${amount.toFixed(2)} exceeds the supplier invoice's outstanding balance — another payment was recorded first, or the invoice was cancelled. Refresh and try again.`
    )
  }
  return updated[0]
}

/**
 * Supplier invoice creates the accounts-payable obligation (spec.md §46,
 * P1 §15) — deliberately independent of any purchase order/goods receipt
 * (`purchaseOrderId` is optional) and of any patient billing, matching P1
 * §15's explicit "supplier invoices can exist independently of patient
 * billing" ask. Posts asynchronously via the outbox (postSupplierInvoiceCreated,
 * posting-service.ts) rather than synchronously in this transaction — same
 * cross-domain-trigger reasoning as postGoodsReceiptCompleted, not the
 * direct-user-action reasoning postExpense/postAssetAcquired use.
 *
 * P3.8 §41: `idempotencyKey`, when the caller supplies one (the
 * SupplierInvoiceDialog generates one per dialog-open, the same pattern
 * ReceiveDialog already used — see createGoodsReceiptAction/
 * createAdHocCharge), makes a double-submitted request (double-click,
 * network retry) return the SAME invoice instead of creating a second real
 * AP liability. This dialog is a genuine operational step on the P3.8
 * procurement screen (Purchasing page and the PO detail page both render
 * it), so the same double-submit risk `createGoodsReceipt`/
 * `createAdHocCharge` were already fixed for applies here too.
 */
export async function createSupplierInvoice(session: SessionContext, input: SupplierInvoiceInput & { idempotencyKey?: string }) {
  assertCan(session, "supplier_invoice.manage", { branchId: input.branchId })

  let created
  try {
    created = await db.$transaction(async (tx) => {
      if (input.idempotencyKey) {
        await claimIdempotencyKey(tx, { organizationId: session.user.organizationId, scope: SUPPLIER_INVOICE_IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
      }

      const invoice = await tx.supplierInvoice.create({
        data: {
          organizationId: session.user.organizationId,
          branchId: input.branchId,
          supplierId: input.supplierId,
          purchaseOrderId: input.purchaseOrderId ?? null,
          invoiceNumber: input.invoiceNumber,
          amount: new Decimal(input.amount),
          taxAmount: new Decimal(input.taxAmount ?? 0),
          dueDate: input.dueDate ?? null,
          createdBy: session.user.id,
        },
      })

      await writeOutboxEvent(tx, {
        organizationId: session.user.organizationId,
        eventType: "SupplierInvoiceCreated",
        payload: { supplierInvoiceId: invoice.id },
      })

      if (input.idempotencyKey) {
        await recordIdempotentResult(tx, { organizationId: session.user.organizationId, scope: SUPPLIER_INVOICE_IDEMPOTENCY_SCOPE, key: input.idempotencyKey, resultId: invoice.id })
      }

      return invoice
    })
  } catch (error) {
    if (input.idempotencyKey && isIdempotencyKeyConflict(error)) {
      const resultId = await resolveDuplicateRequest({ organizationId: session.user.organizationId, scope: SUPPLIER_INVOICE_IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
      return getSupplierInvoice(session, resultId) // idempotent replay — the original request's own result, not a new invoice
    }
    throw error
  }

  await auditFromSession(session, "create", "supplier_invoice", created.id, {
    new: { invoiceNumber: created.invoiceNumber, amount: input.amount, taxAmount: input.taxAmount ?? 0 },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return created
}

/** Simpler 1:N against SupplierInvoice — spec.md §46 describes one invoice paid at a time, not a batched AP settlement. */
export async function recordSupplierPayment(session: SessionContext, input: SupplierPaymentInput) {
  assertCan(session, "supplier_invoice.manage")

  const invoice = await db.supplierInvoice.findFirstOrThrow({
    where: { id: input.supplierInvoiceId, organizationId: session.user.organizationId },
  })
  // P3.8 §46: previously unchecked — any session holding `supplier_invoice.manage`
  // anywhere could pay ANY branch's supplier invoice. getSupplierInvoice/
  // listSupplierInvoices already enforced this on the read side; this write
  // path did not.
  assertBranchAccess(getAuthorizedBranchScope(session), invoice.branchId)
  if (invoice.status === "cancelled") throw new Error("Cannot pay a cancelled supplier invoice.")
  // Total AP obligation is amount + taxAmount (P1 §15) — matching the total
  // credited to Accounts Payable by postSupplierInvoiceCreated, not `amount`
  // alone.
  //
  // P1 §32: fast, pre-transaction check for the common (non-racing) case
  // only — NOT the safety mechanism, same discipline as recordPayment's own
  // preliminary check. applySupplierPaymentAtomically below is what actually
  // prevents two concurrent supplier payments from combining to overpay.
  const totalPayable = new Decimal(invoice.amount).add(invoice.taxAmount)
  const outstanding = totalPayable.sub(invoice.paidAmount)
  if (new Decimal(input.amount).greaterThan(outstanding)) {
    throw new Error(`Payment of ${input.amount} exceeds the outstanding balance of ${outstanding.toFixed(2)}.`)
  }

  const result = await db.$transaction(async (tx) => {
    await applySupplierPaymentAtomically(tx, invoice.id, new Decimal(input.amount))

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

const SUPPLIER_INVOICE_PAGE_SIZE = 50

/** P2 §8: was `take: 100` with no page param. Real server-side pagination now. */
export async function listSupplierInvoices(session: SessionContext, filters: { supplierId?: string; status?: string; page?: number } = {}) {
  assertCan(session, "supplier_invoice.manage")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where: Prisma.SupplierInvoiceWhereInput = {
    organizationId: session.user.organizationId,
    supplierId: filters.supplierId,
    status: filters.status as never,
    branchId: narrowBranchFilter(scope),
  }
  const [invoices, total] = await Promise.all([
    db.supplierInvoice.findMany({
      where,
      include: { supplier: true, purchaseOrder: true, payments: true },
      orderBy: { createdAt: "desc" },
      ...paginationSkipTake(page, SUPPLIER_INVOICE_PAGE_SIZE),
    }),
    db.supplierInvoice.count({ where }),
  ])
  return { invoices, total, page, pageSize: SUPPLIER_INVOICE_PAGE_SIZE, totalPages: totalPages(total, SUPPLIER_INVOICE_PAGE_SIZE) }
}

/**
 * Backs the Payables page — every supplier invoice still owed money.
 *
 * P2 §8: previously the page fetched `listSupplierInvoices` (all
 * statuses, unbounded) and filtered to pending/partially_paid in
 * JavaScript — exactly the "load everything, filter/paginate only in the
 * browser-side code" pattern this section exists to close, even though
 * the filtering happened in a server component rather than the browser
 * itself. The status filter now runs in the WHERE clause, so pagination
 * and the "total owed" figure are both correct regardless of how many
 * paid/cancelled invoices exist alongside the outstanding ones.
 */
export async function listOutstandingSupplierInvoices(session: SessionContext, filters: { page?: number } = {}) {
  assertCan(session, "supplier_invoice.manage")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where: Prisma.SupplierInvoiceWhereInput = {
    organizationId: session.user.organizationId,
    branchId: narrowBranchFilter(scope),
    status: { in: ["pending", "partially_paid"] },
  }
  const [invoices, total, sums] = await Promise.all([
    db.supplierInvoice.findMany({
      where,
      include: { supplier: true, purchaseOrder: true, payments: true },
      orderBy: { createdAt: "desc" },
      ...paginationSkipTake(page, SUPPLIER_INVOICE_PAGE_SIZE),
    }),
    db.supplierInvoice.count({ where }),
    db.supplierInvoice.aggregate({ where, _sum: { amount: true, taxAmount: true, paidAmount: true } }),
  ])
  // P3.9 §27: was `amount - paidAmount` — omitted taxAmount entirely, so any
  // taxed supplier invoice understated both this row's own "Outstanding"
  // figure and the Payables page's "total owed" banner by exactly its tax
  // amount. The real AP obligation is amount + taxAmount (P1 §15) — the
  // same total postSupplierInvoiceCreated actually credited to Accounts
  // Payable, and what recordSupplierPayment's own outstanding-balance guard
  // (above) already checks against; this was the one place still using the
  // narrower, wrong total.
  const totalOutstanding = Number(sums._sum.amount ?? 0) + Number(sums._sum.taxAmount ?? 0) - Number(sums._sum.paidAmount ?? 0)
  return { invoices, total, totalOutstanding, page, pageSize: SUPPLIER_INVOICE_PAGE_SIZE, totalPages: totalPages(total, SUPPLIER_INVOICE_PAGE_SIZE) }
}

export async function getSupplierInvoice(session: SessionContext, id: string) {
  assertCan(session, "supplier_invoice.manage")
  const invoice = await db.supplierInvoice.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { supplier: true, purchaseOrder: true, payments: true },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), invoice.branchId)
  return invoice
}
