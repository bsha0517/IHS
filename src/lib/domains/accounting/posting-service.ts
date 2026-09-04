import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { nextNumber } from "@/lib/platform/sequences"
import { log } from "@/lib/platform/logger"
import { assertPeriodOpen } from "@/lib/domains/accounting/periods"
import type { Prisma, $Enums } from "@/generated/prisma/client"

type Db = Prisma.TransactionClient | typeof db

// Prisma's interactive-transaction defaults (2000ms to acquire a connection
// and start the transaction, 5000ms for the transaction to run once
// started) have repeatedly proven too tight for this pattern under this
// environment's real Supabase pooler latency combined with `pg.Pool`'s
// deliberately small max:3 (src/lib/db.ts, capped for serverless
// connection-count safety) — each posting function below does several
// sequential round trips (resolveAccountId x2-4, postJournal's own
// idempotency lookup, nextNumber()'s own NESTED transaction for the journal
// number, the journal + line inserts) before committing, and under load
// (several postings dispatched in sequence, each briefly needing 2
// simultaneous connections for its outer + nextNumber's inner transaction)
// the pool can genuinely have nothing free for a moment. This isn't a
// test-only artifact: the same sequential cost and pool pressure apply in
// production, and P1 §29's atomic payment/refund guard (billing/invoices.ts)
// added one more round trip to the callers that write invoice.paid_amount,
// pushing what was already marginal further into failure territory — both
// "Transaction already expired" (timeout) and "Unable to start a
// transaction in the given time" (maxWait) were observed in this batch's
// own test runs. Both widened deliberately, not left implicit, so a slow
// account-mapping lookup or a momentarily-busy pool fails with a real error
// instead of one that looks like a different bug.
const POSTING_TRANSACTION_OPTIONS = { timeout: 20_000, maxWait: 10_000 }

/**
 * The fixed set of things a posting can resolve an account for (spec.md §55:
 * "use configurable account mappings"). Never hardcode an account by name or
 * id anywhere outside this file — every posting method below resolves
 * through `resolveAccountId`.
 *
 * P2 §10: re-exported from the generated Prisma enum (`AccountMapping.intent`
 * is now a real `PostingIntent` DB enum, not a bare string — see
 * prisma/schema.prisma) rather than maintained as a second, hand-written
 * union that could silently drift from the actual column type, which is
 * exactly the mismatch the original audit flagged. One source of truth now:
 * add a new intent to the Prisma enum, this type updates itself.
 */
export type PostingIntent = $Enums.PostingIntent

/** Branch-level mapping wins if present; otherwise the org-wide default (branchId null). Throws if neither exists. */
async function resolveAccountId(tx: Db, organizationId: string, branchId: string | null, intent: PostingIntent): Promise<string> {
  if (branchId) {
    const branchMapping = await tx.accountMapping.findFirst({ where: { organizationId, branchId, intent } })
    if (branchMapping) return branchMapping.accountId
  }
  const orgMapping = await tx.accountMapping.findFirst({ where: { organizationId, branchId: null, intent } })
  if (!orgMapping) {
    throw new Error(`No account mapping configured for "${intent}" — configure it under Accounting > Account Mappings.`)
  }
  return orgMapping.accountId
}

type PostingLine = { accountId: string; debit?: number; credit?: number; description?: string }

/**
 * The only writer of Journal/JournalLine (spec.md §55: "operational modules
 * should NOT independently invent journal logic"). Every caller in this file
 * goes through here. The DB's deferred constraint trigger (see this phase's
 * migration) is the actual balance enforcement; the explicit sum check here
 * is a fast, readable failure before that trigger ever runs.
 *
 * P0-02: idempotent on (organizationId, referenceType, referenceId) when a
 * referenceId is given — outbox retries (see outbox.ts) mean this can now
 * genuinely be called twice for the same business event, and creating a
 * second journal for an already-posted invoice/payment/etc. would silently
 * double the books. Manual journals (referenceId: null) are exempt: each is
 * intentionally a one-off correction, and a null-keyed check would wrongly
 * treat every manual journal after the first as a duplicate of it.
 */
async function postJournal(
  tx: Db,
  input: {
    organizationId: string
    branchId: string
    referenceType: string
    referenceId: string | null
    description: string
    postedBy: string | null
    journalDate?: Date
    lines: PostingLine[]
  }
) {
  if (input.referenceId) {
    const existing = await tx.journal.findFirst({
      where: { organizationId: input.organizationId, referenceType: input.referenceType, referenceId: input.referenceId },
    })
    if (existing) return existing
  }

  const totalDebit = input.lines.reduce((sum, l) => sum + (l.debit ?? 0), 0)
  const totalCredit = input.lines.reduce((sum, l) => sum + (l.credit ?? 0), 0)
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    // P2 §16: "accounting posting failures" — named explicitly in P2.md
    // §16's own "use it for" list. This chokepoint is the one place that
    // can log every posting failure once, regardless of which of the ~15
    // domain functions in this file called it, or whether the call came
    // synchronously (e.g. postExpense) or via an outbox handler (most of
    // the rest) — an outbox-routed failure is ALSO caught and logged by
    // outbox.ts's own dispatchBatch, so this is deliberately the one place
    // that also covers the synchronous callers that never pass through
    // there.
    log({
      level: "error", event: "accounting.posting_unbalanced", domain: "accounting", operation: "postJournal",
      organizationId: input.organizationId, branchId: input.branchId, reference: input.referenceType, entityId: input.referenceId ?? undefined,
    })
    throw new Error(`Journal for ${input.referenceType} would be unbalanced: debit ${totalDebit} vs credit ${totalCredit}.`)
  }

  try {
    // P1 §31: the single chokepoint every posting function funnels through —
    // one guard here protects all of them, not each individually. See
    // accounting/periods.ts's own doc comment for scope.
    await assertPeriodOpen(tx, input.organizationId, input.journalDate ?? new Date())

    const journalNumber = await nextNumber({ organizationId: input.organizationId, sequenceType: "JRN", prefix: "JRN" })
    const journal = await tx.journal.create({
      data: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        journalNumber,
        journalDate: input.journalDate ?? new Date(),
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        description: input.description,
        postedBy: input.postedBy,
      },
    })

    for (const line of input.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0)) {
      await tx.journalLine.create({
        data: {
          journalId: journal.id,
          accountId: line.accountId,
          debit: new Decimal(line.debit ?? 0),
          credit: new Decimal(line.credit ?? 0),
          description: line.description ?? null,
        },
      })
    }

    return journal
  } catch (error) {
    // Logged, then re-thrown unchanged — this function's error-propagation
    // behavior to its own callers (a closed-period rejection, a DB error,
    // ...) is completely unaffected; this is an observability side effect,
    // not a change to what the caller sees or how the enclosing transaction
    // reacts.
    log({
      level: "error", event: "accounting.posting_failed", domain: "accounting", operation: "postJournal",
      organizationId: input.organizationId, branchId: input.branchId, reference: input.referenceType, entityId: input.referenceId ?? undefined, error,
    })
    throw error
  }
}

function tenderIntent(method: string): PostingIntent {
  return (["cash", "card", "bank", "online", "insurance", "credit", "other"] as const).includes(method as never)
    ? (method as PostingIntent)
    : "other"
}

/**
 * Pure proportional-discount split, extracted from postInvoiceIssued for unit
 * testing (Phase 14) — the document-level discount is allocated across the
 * package/non-package subtotals in proportion to their share of the
 * pre-discount subtotal, so revenueAmount + unearnedAmount + discount ===
 * subtotal exactly, the same invariant PROJECT_STATUS.md's Phase 6
 * Architecture Decisions names.
 */
export function computeInvoicePostingSplit(invoice: {
  subtotal: number
  discountAmount: number
  taxAmount: number
  lines: { quantity: number; unitPrice: number; sourceType: string }[]
}) {
  const packageSubtotal = invoice.lines
    .filter((l) => l.sourceType === "package")
    .reduce((sum, l) => sum + l.quantity * l.unitPrice, 0)
  const subtotal = invoice.subtotal
  const discount = invoice.discountAmount
  const otherSubtotal = subtotal - packageSubtotal
  const packageShare = subtotal > 0 ? packageSubtotal / subtotal : 0
  const packageDiscount = discount * packageShare
  const otherDiscount = discount - packageDiscount
  const revenueAmount = Math.max(0, otherSubtotal - otherDiscount)
  const unearnedAmount = Math.max(0, packageSubtotal - packageDiscount)
  return { revenueAmount, unearnedAmount, taxAmount: invoice.taxAmount }
}

/**
 * Credit Sale (spec.md §55): Dr Accounts Receivable, Cr Revenue, Cr Tax
 * Payable. Package-sourced lines credit Unearned Revenue instead of Revenue
 * (BLUEPRINT.md's Correction #3 — a package sale isn't recognized revenue
 * until sessions are used), with the invoice's document-level discount
 * allocated proportionally across the two buckets so the split stays exact.
 */
export async function postInvoiceIssued(invoiceId: string) {
  const invoice = await db.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { lines: { include: { charge: true } } },
  })

  const { revenueAmount, unearnedAmount, taxAmount } = computeInvoicePostingSplit({
    subtotal: Number(invoice.subtotal),
    discountAmount: Number(invoice.discountAmount),
    taxAmount: Number(invoice.taxAmount),
    lines: invoice.lines.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), sourceType: l.charge.sourceType })),
  })

  await db.$transaction(async (tx) => {
    const [arAccount, revenueAccount, unearnedAccount, taxAccount] = await Promise.all([
      resolveAccountId(tx, invoice.organizationId, invoice.branchId, "accounts_receivable"),
      resolveAccountId(tx, invoice.organizationId, invoice.branchId, "revenue"),
      unearnedAmount > 0 ? resolveAccountId(tx, invoice.organizationId, invoice.branchId, "unearned_revenue") : Promise.resolve(null),
      taxAmount > 0 ? resolveAccountId(tx, invoice.organizationId, invoice.branchId, "tax_payable") : Promise.resolve(null),
    ])

    await postJournal(tx, {
      organizationId: invoice.organizationId,
      branchId: invoice.branchId,
      referenceType: "invoice",
      referenceId: invoice.id,
      description: `Invoice ${invoice.invoiceNumber} issued`,
      postedBy: null,
      lines: [
        { accountId: arAccount, debit: Number(invoice.totalAmount) },
        ...(revenueAmount > 0 ? [{ accountId: revenueAccount, credit: revenueAmount }] : []),
        ...(unearnedAmount > 0 && unearnedAccount ? [{ accountId: unearnedAccount, credit: unearnedAmount }] : []),
        ...(taxAmount > 0 && taxAccount ? [{ accountId: taxAccount, credit: taxAmount }] : []),
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/**
 * P1 §24: "Invoice: Use VOID only according to accounting rules" — voiding
 * an issued invoice (voidInvoice, billing/invoices.ts, only reachable while
 * `paidAmount` is exactly 0) must also reverse the `Dr AR / Cr Revenue
 * [+Unearned][+Tax]` postInvoiceIssued already posted for it, or Revenue/AR
 * both stay permanently overstated by a sale that no longer exists — worse,
 * if the same underlying Charges are later re-invoiced (voidInvoice reverts
 * them to `pending` specifically so they CAN be), the new invoice's own
 * postInvoiceIssued would double-count that revenue on top of the
 * never-reversed original. Mirrors what was actually posted (reads back the
 * original journal and swaps debit/credit) rather than recomputing the
 * split via computeInvoicePostingSplit — the same "exact mirror, never a
 * fresh recomputation" discipline postProductSaleVoided already established,
 * so this can never drift from what genuinely posted even if that function's
 * logic changes later.
 */
export async function postInvoiceVoided(invoiceId: string) {
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
  const originalJournal = await db.journal.findFirst({
    where: { organizationId: invoice.organizationId, referenceType: "invoice", referenceId: invoiceId },
    include: { lines: true },
  })
  if (!originalJournal) return // never posted in the first place (e.g. a draft invoice voided before InvoiceIssued ever fired) — nothing to reverse

  await db.$transaction(async (tx) => {
    await postJournal(tx, {
      organizationId: invoice.organizationId,
      branchId: invoice.branchId,
      referenceType: "invoice_void",
      referenceId: invoiceId,
      description: `Invoice ${invoice.invoiceNumber} voided`,
      postedBy: null,
      lines: originalJournal.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.credit), credit: Number(l.debit) })),
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/**
 * Cash Patient Payment (spec.md §55): Dr Cash (or the resolved account for
 * whichever tender method was used), Cr Accounts Receivable. A split payment
 * (spec.md §35) produces one debit line per tender against a single AR
 * credit for the total, generalizing the single-tender example.
 *
 * P3.13: `referenceId` was previously `invoice.id` — meaning a SECOND
 * payment against the same invoice (a normal, explicitly-supported
 * workflow: partial payment now, remainder later — see P3.7's own
 * "§17-19: partial payment then remaining payment" test) collided with
 * `postJournal`'s own check-before-insert idempotency guard (keyed on
 * `(organizationId, referenceType, referenceId)`), which found the FIRST
 * payment's journal already sitting at that same key and silently returned
 * it instead of posting the second payment at all — the second payment's
 * cash/revenue never reached the general ledger, even though the
 * operational Invoice/Payment rows correctly showed it as paid. Found live
 * during P3.13's own cross-role workflow (a partial-then-final Cashier
 * payment, verified downstream by Accounting) — a real accounting
 * corruption, not a hypothetical one. `traceability.ts`'s own "payment"
 * case already expected `referenceId` to be a real `Payment.id`
 * (`db.payment.findFirst({ where: { id: referenceId } })`), confirming this
 * was a genuine pre-existing bug rather than an intentional shared key —
 * every payment's traceability drill-down was already silently returning
 * "Payment not found" before this fix, for the exact same reason. Fixed by
 * keying each posting on the payment(s) this specific call actually
 * created (`paymentIds[0]` — one journal per `recordPayment` call, exactly
 * as `tenders` here already aggregates a single call's tenders into one
 * journal), so a second, later call gets its own distinct journal.
 */
export async function postPaymentReceived(
  invoiceId: string,
  tenders: { method: string; amount: number }[],
  paymentIds: string[]
) {
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
  const total = tenders.reduce((sum, t) => sum + t.amount, 0)
  const referenceId = paymentIds[0] ?? invoice.id

  await db.$transaction(async (tx) => {
    const arAccount = await resolveAccountId(tx, invoice.organizationId, invoice.branchId, "accounts_receivable")
    const tenderLines = await Promise.all(
      tenders.map(async (t) => ({
        accountId: await resolveAccountId(tx, invoice.organizationId, invoice.branchId, tenderIntent(t.method)),
        debit: t.amount,
      }))
    )

    await postJournal(tx, {
      organizationId: invoice.organizationId,
      branchId: invoice.branchId,
      referenceType: "payment",
      referenceId,
      description: `Payment received for invoice ${invoice.invoiceNumber}`,
      postedBy: null,
      lines: [...tenderLines, { accountId: arAccount, credit: total }],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/**
 * Reverses recognized revenue rather than reinstating the receivable — a
 * completed Refund means money actually went back to the patient, not that
 * they owe again. Booked against Revenue generically rather than
 * re-deriving the package/non-package split from the original invoice
 * lines — a documented simplification (see PROJECT_STATUS.md) since a
 * refund doesn't reference specific invoice lines, only an aggregate amount.
 */
export async function postRefundCompleted(refundId: string) {
  const refund = await db.refund.findUniqueOrThrow({ where: { id: refundId }, include: { invoice: true } })

  await db.$transaction(async (tx) => {
    const [revenueAccount, tenderAccount] = await Promise.all([
      resolveAccountId(tx, refund.organizationId, refund.branchId, "revenue"),
      resolveAccountId(tx, refund.organizationId, refund.branchId, tenderIntent(refund.method)),
    ])

    await postJournal(tx, {
      organizationId: refund.organizationId,
      branchId: refund.branchId,
      referenceType: "refund",
      referenceId: refund.id,
      description: `Refund against invoice ${refund.invoice.invoiceNumber}`,
      postedBy: null,
      lines: [
        { accountId: revenueAccount, debit: Number(refund.amount) },
        { accountId: tenderAccount, credit: Number(refund.amount) },
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/**
 * Inventory Purchase — physical receipt (P1 §15): Dr Inventory, Cr Goods
 * Received Not Invoiced. NOT Accounts Payable directly — the physical
 * receipt and the legal AP obligation are two different events, often
 * separated by days or weeks (the supplier's invoice arrives later, and
 * may not even match this exact amount). Crediting real AP here, before an
 * invoice exists, would overstate payables; deferring this posting
 * entirely until the invoice arrives would instead understate inventory
 * (stock is already sellable — FEFO allocates it immediately — so a resale
 * before the invoice arrives could credit Inventory below zero). The
 * standard fix is this GR/IR clearing account: provisionally recognized
 * here, cleared to real AP by postSupplierInvoiceCreated below. See
 * GoodsReceipt's doc comment (schema.prisma) and INVENTORY.md.
 */
export async function postGoodsReceiptCompleted(goodsReceiptId: string) {
  const receipt = await db.goodsReceipt.findUniqueOrThrow({ where: { id: goodsReceiptId }, include: { lines: true } })
  const totalValue = receipt.lines.reduce((sum, l) => sum + l.quantityReceived * Number(l.unitCost), 0)
  if (totalValue <= 0) return

  await db.$transaction(async (tx) => {
    const [inventoryAccount, grirAccount] = await Promise.all([
      resolveAccountId(tx, receipt.organizationId, receipt.branchId, "inventory_asset"),
      resolveAccountId(tx, receipt.organizationId, receipt.branchId, "goods_received_not_invoiced"),
    ])

    await postJournal(tx, {
      organizationId: receipt.organizationId,
      branchId: receipt.branchId,
      referenceType: "goods_receipt",
      referenceId: receipt.id,
      description: `Goods receipt ${receipt.receiptNumber}`,
      postedBy: null,
      lines: [
        { accountId: inventoryAccount, debit: totalValue },
        { accountId: grirAccount, credit: totalValue },
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/**
 * Supplier Invoice — the actual AP obligation (P1 §15): the invoice is what
 * finally recognizes real Accounts Payable, clearing whatever
 * postGoodsReceiptCompleted provisionally recognized in GR/IR for a
 * PO-linked invoice (Dr Goods Received Not Invoiced), or debiting Inventory
 * directly for a standalone invoice with no linked purchase order (nothing
 * was ever provisionally recognized to clear — spec.md §46/P1 §15's
 * "supplier invoices can exist independently of patient billing" extends
 * the same way to existing independently of any goods receipt). Optional
 * `taxAmount` (recoverable purchase tax, entered manually — see
 * SupplierInvoice's own doc comment) debits Recoverable Tax; the credit is
 * always the invoice's full `amount + taxAmount`, matching
 * recordSupplierPayment's outstanding-balance computation
 * (supplier-invoices.ts).
 */
export async function postSupplierInvoiceCreated(supplierInvoiceId: string) {
  const invoice = await db.supplierInvoice.findUniqueOrThrow({ where: { id: supplierInvoiceId } })
  const amount = Number(invoice.amount)
  const taxAmount = Number(invoice.taxAmount)
  const total = amount + taxAmount
  if (total <= 0) return

  await db.$transaction(async (tx) => {
    const [debitAccount, apAccount, taxAccount] = await Promise.all([
      resolveAccountId(tx, invoice.organizationId, invoice.branchId, invoice.purchaseOrderId ? "goods_received_not_invoiced" : "inventory_asset"),
      resolveAccountId(tx, invoice.organizationId, invoice.branchId, "accounts_payable"),
      taxAmount > 0 ? resolveAccountId(tx, invoice.organizationId, invoice.branchId, "recoverable_tax") : Promise.resolve(null),
    ])

    await postJournal(tx, {
      organizationId: invoice.organizationId,
      branchId: invoice.branchId,
      referenceType: "supplier_invoice",
      referenceId: invoice.id,
      description: `Supplier invoice ${invoice.invoiceNumber}`,
      postedBy: null,
      lines: [
        ...(amount > 0 ? [{ accountId: debitAccount, debit: amount }] : []),
        ...(taxAmount > 0 && taxAccount ? [{ accountId: taxAccount, debit: taxAmount }] : []),
        { accountId: apAccount, credit: total },
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/**
 * Cost of Goods Sold (P1 §11): Dr Cost of Goods Sold, Cr Inventory Asset —
 * the cost-side counterpart to the revenue `postInvoiceIssued` posts for
 * the same sale. Fired from `insertCharge` (billing/charges.ts) the moment
 * a POS product-sale charge actually consumes real stock, valued at the
 * FEFO-consumed batches' own actual purchase cost (specific identification
 * — see INVENTORY.md's "Valuation Method" for why this, not an average, is
 * this system's cost basis). `cost` is computed once, in `consumeStock`
 * itself, from the exact batches FEFO allocated to that consumption — never
 * recomputed here from a product-level average, so this always matches
 * what was actually in the batch(es) that physically left the shelf.
 */
export async function postProductSaleCogs(input: { organizationId: string; branchId: string; chargeId: string; cost: number }) {
  if (input.cost <= 0) return

  await db.$transaction(async (tx) => {
    const [cogsAccount, inventoryAccount] = await Promise.all([
      resolveAccountId(tx, input.organizationId, input.branchId, "cogs"),
      resolveAccountId(tx, input.organizationId, input.branchId, "inventory_asset"),
    ])

    await postJournal(tx, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      referenceType: "charge_cogs",
      referenceId: input.chargeId,
      description: "Cost of goods sold — product sale",
      postedBy: null,
      lines: [
        { accountId: cogsAccount, debit: input.cost },
        { accountId: inventoryAccount, credit: input.cost },
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/**
 * The exact reversal of `postProductSaleCogs`, for a charge voided before
 * it was ever invoiced (charges.ts's `voidCharge` — only reachable while
 * `status: "pending"`, so there is never an issued invoice to reconcile).
 * Never edits or deletes the original COGS journal (spec.md §92) — looks
 * up what it actually posted and mirrors it with a new, opposite-direction
 * entry, so both the original sale and its reversal remain a permanent,
 * auditable pair.
 */
export async function postProductSaleVoided(input: { organizationId: string; branchId: string; chargeId: string }) {
  const originalJournal = await db.journal.findFirst({
    where: { organizationId: input.organizationId, referenceType: "charge_cogs", referenceId: input.chargeId },
    include: { lines: true },
  })
  if (!originalJournal) return // nothing was ever posted (e.g. a zero-cost line) — nothing to reverse
  const cost = originalJournal.lines.reduce((sum, l) => sum + Number(l.debit), 0)
  if (cost <= 0) return

  await db.$transaction(async (tx) => {
    const [cogsAccount, inventoryAccount] = await Promise.all([
      resolveAccountId(tx, input.organizationId, input.branchId, "cogs"),
      resolveAccountId(tx, input.organizationId, input.branchId, "inventory_asset"),
    ])

    await postJournal(tx, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      referenceType: "charge_cogs_void",
      referenceId: input.chargeId,
      description: "Cost of goods sold reversed — voided product sale",
      postedBy: null,
      lines: [
        { accountId: inventoryAccount, debit: cost },
        { accountId: cogsAccount, credit: cost },
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/**
 * Inventory write-off / gain (P1 §13): a manual stock adjustment
 * (`recordAdjustment`, inventory/stock.ts) with real financial impact.
 * `direction: "out"` (damage, expiry, or a negative count-correction) is a
 * real loss: Dr Inventory Write-off Expense, Cr Inventory Asset.
 * `direction: "in"` (a positive count-correction — physically more on hand
 * than the ledger recorded) is a real, non-operating gain: Dr Inventory
 * Asset, Cr Inventory Adjustment Gain. A manual "return"-type adjustment is
 * deliberately NOT posted here — see recordAdjustment's own doc comment for
 * why that category's accounting treatment is out of this batch's scope.
 */
export async function postInventoryAdjustment(input: {
  organizationId: string
  branchId: string
  stockLedgerEntryId: string
  direction: "in" | "out"
  amount: number
  description: string
}) {
  if (input.amount <= 0) return

  await db.$transaction(async (tx) => {
    const [inventoryAccount, otherAccount] = await Promise.all([
      resolveAccountId(tx, input.organizationId, input.branchId, "inventory_asset"),
      resolveAccountId(tx, input.organizationId, input.branchId, input.direction === "out" ? "inventory_write_off" : "inventory_adjustment_gain"),
    ])

    await postJournal(tx, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      referenceType: "stock_ledger_entry",
      referenceId: input.stockLedgerEntryId,
      description: input.description,
      postedBy: null,
      lines:
        input.direction === "out"
          ? [
              { accountId: otherAccount, debit: input.amount },
              { accountId: inventoryAccount, credit: input.amount },
            ]
          : [
              { accountId: inventoryAccount, debit: input.amount },
              { accountId: otherAccount, credit: input.amount },
            ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/** Mirror of postPaymentReceived on the payables side: Dr Accounts Payable, Cr Cash/Bank. */
export async function postSupplierPaymentRecorded(supplierPaymentId: string) {
  const payment = await db.supplierPayment.findUniqueOrThrow({
    where: { id: supplierPaymentId },
    include: { supplierInvoice: true },
  })

  await db.$transaction(async (tx) => {
    const [apAccount, tenderAccount] = await Promise.all([
      resolveAccountId(tx, payment.organizationId, payment.branchId, "accounts_payable"),
      resolveAccountId(tx, payment.organizationId, payment.branchId, tenderIntent(payment.method)),
    ])

    await postJournal(tx, {
      organizationId: payment.organizationId,
      branchId: payment.branchId,
      referenceType: "supplier_payment",
      referenceId: payment.id,
      description: `Supplier payment against invoice ${payment.supplierInvoice.invoiceNumber}`,
      postedBy: null,
      lines: [
        { accountId: apAccount, debit: Number(payment.amount) },
        { accountId: tenderAccount, credit: Number(payment.amount) },
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/**
 * Package revenue recognition (BLUEPRINT.md Correction #3): each session
 * usage moves its pro-rata share from Unearned Revenue to Revenue. Pro-rata
 * = purchase price / total sessions across every service the package
 * bundles, so a multi-service package recognizes evenly per session
 * regardless of which service the session was against.
 */
export async function postPackageSessionConsumed(patientPackageSessionId: string) {
  const session = await db.patientPackageSession.findUniqueOrThrow({
    where: { id: patientPackageSessionId },
    include: { patientPackage: { include: { package: { include: { services: true } } } } },
  })
  const totalSessions = session.patientPackage.package.services.reduce((sum, s) => sum + s.sessionsAllocated, 0)
  if (totalSessions <= 0) return
  const proRataAmount = Number(session.patientPackage.purchasePrice) / totalSessions
  if (proRataAmount <= 0) return

  await db.$transaction(async (tx) => {
    const [unearnedAccount, revenueAccount] = await Promise.all([
      resolveAccountId(tx, session.organizationId, session.patientPackage.branchId, "unearned_revenue"),
      resolveAccountId(tx, session.organizationId, session.patientPackage.branchId, "revenue"),
    ])

    await postJournal(tx, {
      organizationId: session.organizationId,
      branchId: session.patientPackage.branchId,
      referenceType: "patient_package_session",
      referenceId: session.id,
      description: `Package session recognized — ${session.patientPackage.package.name}`,
      postedBy: null,
      lines: [
        { accountId: unearnedAccount, debit: proRataAmount },
        { accountId: revenueAccount, credit: proRataAmount },
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/** Dr [expenseAccountId], Cr [account resolved from paidVia] — called synchronously from the same transaction as Expense creation. */
export async function postExpense(
  tx: Db,
  input: { organizationId: string; branchId: string; expenseId: string; expenseAccountId: string; amount: number; paidVia: string; description: string; postedBy: string }
) {
  const tenderAccount = await resolveAccountId(tx, input.organizationId, input.branchId, tenderIntent(input.paidVia))

  return postJournal(tx, {
    organizationId: input.organizationId,
    branchId: input.branchId,
    referenceType: "expense",
    referenceId: input.expenseId,
    description: input.description,
    postedBy: input.postedBy,
    lines: [
      { accountId: input.expenseAccountId, debit: input.amount },
      { accountId: tenderAccount, credit: input.amount },
    ],
  })
}

/**
 * Fixed Asset acquisition (P1 §17): Dr Fixed Asset, Cr [tender account
 * resolved from `paidVia`] — or Cr Accounts Payable when `paidVia` is null
 * (acquired on credit, no immediate cash/bank outflow). Mirrors postExpense
 * exactly: called synchronously from the same transaction as Asset
 * creation (createAsset, assets.ts), not via the outbox, since the user is
 * sitting at the asset form expecting immediate confirmation — the same
 * reasoning postExpense's own doc comment gives. Deliberately posts ONLY
 * capitalized cost, never depreciation — see Asset's depreciation-readiness
 * fields (schema.prisma) for what's intentionally not built yet.
 */
export async function postAssetAcquired(
  tx: Db,
  input: { organizationId: string; branchId: string; assetId: string; amount: number; paidVia: string | null; description: string; postedBy: string }
) {
  if (input.amount <= 0) return

  const [fixedAssetAccount, creditAccount] = await Promise.all([
    resolveAccountId(tx, input.organizationId, input.branchId, "fixed_asset"),
    resolveAccountId(tx, input.organizationId, input.branchId, input.paidVia ? tenderIntent(input.paidVia) : "accounts_payable"),
  ])

  return postJournal(tx, {
    organizationId: input.organizationId,
    branchId: input.branchId,
    referenceType: "asset",
    referenceId: input.assetId,
    description: input.description,
    postedBy: input.postedBy,
    lines: [
      { accountId: fixedAssetAccount, debit: input.amount },
      { accountId: creditAccount, credit: input.amount },
    ],
  })
}

/**
 * Payroll (spec.md §55's own named example): Dr Salary Expense, Cr Payroll
 * Payable, posted once when a run moves to `approved`. Both sides use the
 * SUM of every line's `netSalary`, not gross pay — a deliberate
 * simplification (see PROJECT_STATUS.md) that keeps the journal exactly two
 * lines matching spec's example and keeps Payroll Payable clean (it nets to
 * exactly zero once `postPayrollPaid` reverses it), rather than half-modeling
 * a "deductions payable" destination spec never named.
 */
export async function postPayrollApproved(payrollRunId: string) {
  const run = await db.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId }, include: { lines: true } })
  const total = run.lines.reduce((sum, l) => sum + Number(l.netSalary), 0)
  if (total <= 0) return

  await db.$transaction(async (tx) => {
    const [salaryExpenseAccount, payrollPayableAccount] = await Promise.all([
      resolveAccountId(tx, run.organizationId, run.branchId, "salary_expense"),
      resolveAccountId(tx, run.organizationId, run.branchId, "payroll_payable"),
    ])

    await postJournal(tx, {
      organizationId: run.organizationId,
      branchId: run.branchId,
      referenceType: "payroll_run",
      referenceId: run.id,
      description: `Payroll approved for ${run.periodStart.toISOString().slice(0, 10)} – ${run.periodEnd.toISOString().slice(0, 10)}`,
      postedBy: null,
      lines: [
        { accountId: salaryExpenseAccount, debit: total },
        { accountId: payrollPayableAccount, credit: total },
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/** Settlement: Dr Payroll Payable, Cr [account resolved from the run's paidVia] — posted once when a run moves to `paid`. */
export async function postPayrollPaid(payrollRunId: string) {
  const run = await db.payrollRun.findUniqueOrThrow({ where: { id: payrollRunId }, include: { lines: true } })
  const total = run.lines.reduce((sum, l) => sum + Number(l.netSalary), 0)
  if (total <= 0 || !run.paidVia) return

  await db.$transaction(async (tx) => {
    const [payrollPayableAccount, tenderAccount] = await Promise.all([
      resolveAccountId(tx, run.organizationId, run.branchId, "payroll_payable"),
      resolveAccountId(tx, run.organizationId, run.branchId, tenderIntent(run.paidVia!)),
    ])

    // P0-02: distinct referenceType from postPayrollApproved above — both
    // posted against the same run.id, and postJournal's new idempotency
    // check is keyed on (referenceType, referenceId). Sharing "payroll_run"
    // here would have made this posting silently no-op after Approved
    // already ran, a real latent bug found while designing that check, not
    // a pre-existing one this comment is merely describing.
    await postJournal(tx, {
      organizationId: run.organizationId,
      branchId: run.branchId,
      referenceType: "payroll_run_paid",
      referenceId: run.id,
      description: `Payroll paid for ${run.periodStart.toISOString().slice(0, 10)} – ${run.periodEnd.toISOString().slice(0, 10)}`,
      postedBy: null,
      lines: [
        { accountId: payrollPayableAccount, debit: total },
        { accountId: tenderAccount, credit: total },
      ],
    })
  }, POSTING_TRANSACTION_OPTIONS)
}

/** Accountant-entered correction — the one path where arbitrary lines are accepted directly rather than derived by a posting method. */
export async function postManualJournal(input: {
  organizationId: string
  branchId: string
  journalDate: Date
  description: string
  postedBy: string
  lines: { accountId: string; debit: number; credit: number; description?: string | null }[]
}) {
  // P2 Batch 5: the one posting function in this file that had been left on
  // Prisma's 5000ms default instead of POSTING_TRANSACTION_OPTIONS — found
  // via a real "transaction expired" failure under this environment's own
  // documented Supabase-pooler latency (see that constant's own doc comment
  // for why every other posting function here already needed this same
  // widening). No functional change, just closing the one gap.
  return db.$transaction(
    (tx) =>
      postJournal(tx, {
        organizationId: input.organizationId,
        branchId: input.branchId,
        referenceType: "manual",
        referenceId: null,
        description: input.description,
        postedBy: input.postedBy,
        journalDate: input.journalDate,
        lines: input.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description ?? undefined })),
      }),
    POSTING_TRANSACTION_OPTIONS
  )
}
