import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { assertBranchAccess, getAuthorizedBranchScope } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P2 §6: "Instead ensure the existing journal/reference architecture is
 * traceable" — this file is that traceability layer, not a second ledger.
 * It never stores anything; every function here reads `Journal`'s own
 * `referenceType`/`referenceId` (posting-service.ts's `postJournal` is
 * still the only writer) and resolves it against whatever business record
 * that reference actually points to, for display only.
 *
 * `referenceType` catalog (every value `postJournal` is ever called with —
 * see posting-service.ts and accounting/journals.ts):
 *   invoice, invoice_void, payment, refund, goods_receipt, supplier_invoice,
 *   supplier_payment, charge_cogs, charge_cogs_void, stock_ledger_entry,
 *   patient_package_session, expense, asset, payroll_run, payroll_run_paid,
 *   manual, manual_reversal.
 *
 * A human label for each, plus the P2.md §6 name it corresponds to where
 * one was given ("Stock Adjustment" for stock_ledger_entry, "Package
 * Recognition" for patient_package_session, "Payroll Approval"/"Payroll
 * Payment" for payroll_run/payroll_run_paid, "Manual Journal" for manual).
 */
export const REFERENCE_TYPE_LABELS: Record<string, string> = {
  invoice: "Invoice",
  invoice_void: "Invoice Void",
  payment: "Payment",
  refund: "Refund",
  goods_receipt: "Goods Receipt",
  supplier_invoice: "Supplier Invoice",
  supplier_payment: "Supplier Payment",
  charge_cogs: "Product Sale (COGS)",
  charge_cogs_void: "Product Sale Voided (COGS reversal)",
  stock_ledger_entry: "Stock Adjustment",
  patient_package_session: "Package Recognition",
  expense: "Expense",
  asset: "Asset Acquisition",
  payroll_run: "Payroll Approval",
  payroll_run_paid: "Payroll Payment",
  manual: "Manual Journal",
  manual_reversal: "Manual Journal Reversal",
}

export type SourceReference = { label: string; summary: string; href: string | null } | null

/**
 * Resolves a Journal's `referenceType`/`referenceId` to a human-readable
 * summary of the actual business transaction that triggered it, and a link
 * to that record's own page where one exists. One query, only run when a
 * journal's detail is actually opened (see getJournalTrace below) — never
 * for every row of a journal list, which would turn a 200-row page into
 * 200 extra queries for data most rows' viewers never look at.
 */
export async function resolveSourceReference(
  organizationId: string,
  referenceType: string,
  referenceId: string | null
): Promise<SourceReference> {
  const label = REFERENCE_TYPE_LABELS[referenceType] ?? referenceType
  if (!referenceId) {
    return { label, summary: "No source transaction — a standalone manual entry.", href: null }
  }

  switch (referenceType) {
    case "invoice":
    case "invoice_void": {
      const invoice = await db.invoice.findFirst({ where: { id: referenceId, organizationId }, include: { patient: true } })
      if (!invoice) return { label, summary: "Invoice not found (may have been deleted).", href: null }
      return {
        label,
        summary: `${invoice.invoiceNumber} — ${invoice.patient.firstName} ${invoice.patient.lastName} — ${Number(invoice.totalAmount).toFixed(2)}`,
        href: `/invoices/${invoice.id}`,
      }
    }
    case "payment": {
      const payment = await db.payment.findFirst({ where: { id: referenceId, organizationId } })
      if (!payment) return { label, summary: "Payment not found (may have been deleted).", href: null }
      // Targeted backlog closure, item 9 (P3.13's own known radar: a single
      // recordPayment() call can create MULTIPLE Payment rows — one per
      // split tender — but postPaymentReceived (posting-service.ts) keys the
      // Journal's referenceId on only the first (`paymentIds[0]`), by design
      // (matches `tenders`, which already aggregates one call's tenders into
      // one journal — see that function's own comment). The journal's own
      // debit lines are always complete (one per tender, already correct);
      // this only widens what the trace VIEW surfaces, so every sibling
      // tender is visible from here too, not just the first.
      //
      // Sibling payments are found via the durable `PaymentReceived`
      // OutboxEvent recordPayment itself writes — its payload already
      // carries the FULL `paymentIds` array for that one call (payments.ts's
      // own comment: "Multiple Payment rows can come out of one call...").
      // An earlier version of this fix tried grouping by
      // (cashierSessionId, receivedAt), assuming Postgres's transaction-
      // frozen `now()` would make every sibling's receivedAt identical —
      // empirically wrong (Prisma computes `@default(now())` client-side
      // per statement, not via a true SQL column default, so sibling
      // timestamps differ by several milliseconds). The OutboxEvent payload
      // is the actual ground truth of what one call produced, not a
      // heuristic.
      const event = await db.outboxEvent.findFirst({
        where: { organizationId, eventType: "PaymentReceived", payload: { path: ["paymentIds"], array_contains: referenceId } },
      })
      const paymentIds = Array.isArray((event?.payload as { paymentIds?: unknown })?.paymentIds)
        ? ((event!.payload as { paymentIds: string[] }).paymentIds)
        : [referenceId]
      const siblings =
        paymentIds.length > 1
          ? await db.payment.findMany({ where: { id: { in: paymentIds }, organizationId }, orderBy: { receiptNumber: "asc" } })
          : [payment]
      if (siblings.length <= 1) {
        return { label, summary: `${payment.receiptNumber} — ${payment.method} — ${Number(payment.amount).toFixed(2)}`, href: null }
      }
      const total = siblings.reduce((sum, p) => sum + Number(p.amount), 0)
      const tenderList = siblings.map((p) => `${p.receiptNumber} (${p.method} ${Number(p.amount).toFixed(2)})`).join(", ")
      return { label, summary: `${siblings.length} tenders, total ${total.toFixed(2)}: ${tenderList}`, href: null }
    }
    case "refund": {
      const refund = await db.refund.findFirst({ where: { id: referenceId, organizationId } })
      if (!refund) return { label, summary: "Refund not found (may have been deleted).", href: null }
      return { label, summary: `${refund.refundNumber ?? refund.id.slice(0, 8)} — ${refund.reason} — ${Number(refund.amount).toFixed(2)}`, href: null }
    }
    case "goods_receipt": {
      const receipt = await db.goodsReceipt.findFirst({ where: { id: referenceId, organizationId }, include: { supplier: true } })
      if (!receipt) return { label, summary: "Goods receipt not found (may have been deleted).", href: null }
      return { label, summary: `${receipt.receiptNumber} — ${receipt.supplier.companyName}`, href: `/purchasing/orders/${receipt.purchaseOrderId}` }
    }
    case "supplier_invoice": {
      const invoice = await db.supplierInvoice.findFirst({ where: { id: referenceId, organizationId }, include: { supplier: true } })
      if (!invoice) return { label, summary: "Supplier invoice not found (may have been deleted).", href: null }
      return { label, summary: `${invoice.invoiceNumber} — ${invoice.supplier.companyName} — ${Number(invoice.amount).toFixed(2)}`, href: null }
    }
    case "supplier_payment": {
      const payment = await db.supplierPayment.findFirst({ where: { id: referenceId, organizationId }, include: { supplierInvoice: { include: { supplier: true } } } })
      if (!payment) return { label, summary: "Supplier payment not found (may have been deleted).", href: null }
      return { label, summary: `${payment.supplierInvoice.supplier.companyName} — ${payment.method} — ${Number(payment.amount).toFixed(2)}`, href: null }
    }
    case "charge_cogs":
    case "charge_cogs_void": {
      const charge = await db.charge.findFirst({ where: { id: referenceId, organizationId } })
      if (!charge) return { label, summary: "Charge not found (may have been deleted).", href: null }
      return { label, summary: `${charge.description} — qty ${charge.quantity} — ${Number(charge.amount).toFixed(2)}`, href: null }
    }
    case "stock_ledger_entry": {
      const entry = await db.stockLedgerEntry.findFirst({ where: { id: referenceId, organizationId }, include: { product: true, batch: true } })
      if (!entry) return { label, summary: "Stock ledger entry not found (may have been deleted).", href: null }
      return {
        label,
        summary: `${entry.product.name}${entry.batch ? ` (batch ${entry.batch.batchNumber})` : ""} — ${entry.transactionType} — qty ${Number(entry.quantity)}${entry.reason ? ` — ${entry.reason}` : ""}`,
        href: null,
      }
    }
    case "patient_package_session": {
      const session = await db.patientPackageSession.findFirst({
        where: { id: referenceId, organizationId },
        include: { patientPackage: { include: { package: true, patient: true } } },
      })
      if (!session) return { label, summary: "Package session not found (may have been deleted).", href: null }
      return {
        label,
        summary: `${session.patientPackage.package.name} — ${session.patientPackage.patient.firstName} ${session.patientPackage.patient.lastName}`,
        href: null,
      }
    }
    case "expense": {
      const expense = await db.expense.findFirst({ where: { id: referenceId, organizationId } })
      if (!expense) return { label, summary: "Expense not found (may have been deleted).", href: null }
      return { label, summary: `${expense.description} — ${Number(expense.amount).toFixed(2)}`, href: null }
    }
    case "asset": {
      const asset = await db.asset.findFirst({ where: { id: referenceId, organizationId } })
      if (!asset) return { label, summary: "Asset not found (may have been deleted).", href: null }
      return { label, summary: `${asset.assetNumber} — ${asset.name}`, href: `/assets/${asset.id}` }
    }
    case "payroll_run":
    case "payroll_run_paid": {
      const run = await db.payrollRun.findFirst({ where: { id: referenceId, organizationId } })
      if (!run) return { label, summary: "Payroll run not found (may have been deleted).", href: null }
      return {
        label,
        summary: `${run.periodStart.toISOString().slice(0, 10)} – ${run.periodEnd.toISOString().slice(0, 10)} — ${run.status}`,
        href: `/payroll/${run.id}`,
      }
    }
    case "manual_reversal": {
      // referenceId here is the ORIGINAL journal's own id, not a business
      // record — see journals.ts's reverseJournal, which re-keys the
      // reversal to referenceType "manual_reversal"/referenceId: original.id.
      const original = await db.journal.findFirst({ where: { id: referenceId, organizationId } })
      if (!original) return { label, summary: "Original journal not found (may have been deleted).", href: null }
      return { label, summary: `Reverses journal ${original.journalNumber}`, href: null }
    }
    default:
      return { label, summary: `Reference id ${referenceId}`, href: null }
  }
}

export type RelatedJournal = {
  id: string
  journalNumber: string
  referenceType: string
  journalDate: Date
  relationship: "reverses" | "reversed by" | "related"
}

/**
 * The "reversal relationship" P2.md §6 asks for. Journal has no dedicated
 * `reversalOfId` column — the existing convention (posting-service.ts,
 * journals.ts's reverseJournal) is looser: a reversal/settlement journal
 * either shares its original's own `referenceId` under a related
 * `referenceType` (invoice/invoice_void, charge_cogs/charge_cogs_void,
 * payroll_run/payroll_run_paid), or — for a manual reversal specifically —
 * points its `referenceId` directly at the original *journal's* id
 * (referenceType "manual_reversal"). This reads both shapes without
 * requiring a schema change, exactly as P2.md's "do not duplicate the
 * ledger" instruction asks.
 */
export async function getRelatedJournals(organizationId: string, journal: { id: string; referenceType: string; referenceId: string | null }): Promise<RelatedJournal[]> {
  const related: RelatedJournal[] = []

  if (journal.referenceType === "manual_reversal" && journal.referenceId) {
    const original = await db.journal.findFirst({ where: { id: journal.referenceId, organizationId } })
    if (original) {
      related.push({ id: original.id, journalNumber: original.journalNumber, referenceType: original.referenceType, journalDate: original.journalDate, relationship: "reverses" })
    }
  } else {
    const reversal = await db.journal.findFirst({ where: { organizationId, referenceType: "manual_reversal", referenceId: journal.id } })
    if (reversal) {
      related.push({ id: reversal.id, journalNumber: reversal.journalNumber, referenceType: reversal.referenceType, journalDate: reversal.journalDate, relationship: "reversed by" })
    }
  }

  if (journal.referenceId) {
    const siblings = await db.journal.findMany({
      where: { organizationId, referenceId: journal.referenceId, id: { not: journal.id }, referenceType: { not: "manual_reversal" } },
    })
    for (const sibling of siblings) {
      related.push({ id: sibling.id, journalNumber: sibling.journalNumber, referenceType: sibling.referenceType, journalDate: sibling.journalDate, relationship: "related" })
    }
  }

  return related
}

/**
 * Business Transaction → Journal → Journal Lines → Source Reference, in one
 * call — the exact trace P2.md §6 asks the viewer to show, read-only.
 * Called lazily per-journal (the detail dialog, on open), not for a whole
 * list page at once.
 */
export async function getJournalTrace(session: SessionContext, journalId: string) {
  assertCan(session, "accounting.view")
  const journal = await db.journal.findFirstOrThrow({
    where: { id: journalId, organizationId: session.user.organizationId },
    include: { lines: { include: { account: true } }, branch: true, postedByUser: true },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), journal.branchId)

  const [source, related] = await Promise.all([
    resolveSourceReference(session.user.organizationId, journal.referenceType, journal.referenceId),
    getRelatedJournals(session.user.organizationId, journal),
  ])

  return { journal, source, related }
}
