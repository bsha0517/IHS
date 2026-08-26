import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { nextNumber } from "@/lib/platform/sequences"
import type { Prisma } from "@/generated/prisma/client"

type Db = Prisma.TransactionClient | typeof db

/**
 * The fixed set of things a posting can resolve an account for (spec.md §55:
 * "use configurable account mappings"). Never hardcode an account by name or
 * id anywhere outside this file — every posting method below resolves
 * through `resolveAccountId`.
 */
export type PostingIntent =
  | "cash"
  | "card"
  | "bank"
  | "online"
  | "insurance"
  | "credit"
  | "other"
  | "accounts_receivable"
  | "revenue"
  | "tax_payable"
  | "unearned_revenue"
  | "inventory_asset"
  | "accounts_payable"
  | "expense_default"
  | "salary_expense"
  | "payroll_payable"

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
  const totalDebit = input.lines.reduce((sum, l) => sum + (l.debit ?? 0), 0)
  const totalCredit = input.lines.reduce((sum, l) => sum + (l.credit ?? 0), 0)
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    throw new Error(`Journal for ${input.referenceType} would be unbalanced: debit ${totalDebit} vs credit ${totalCredit}.`)
  }

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
  })
}

/**
 * Cash Patient Payment (spec.md §55): Dr Cash (or the resolved account for
 * whichever tender method was used), Cr Accounts Receivable. A split payment
 * (spec.md §35) produces one debit line per tender against a single AR
 * credit for the total, generalizing the single-tender example.
 */
export async function postPaymentReceived(
  invoiceId: string,
  tenders: { method: string; amount: number }[]
) {
  const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
  const total = tenders.reduce((sum, t) => sum + t.amount, 0)

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
      referenceId: invoice.id,
      description: `Payment received for invoice ${invoice.invoiceNumber}`,
      postedBy: null,
      lines: [...tenderLines, { accountId: arAccount, credit: total }],
    })
  })
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
  })
}

/** Inventory Purchase (spec.md §55): Dr Inventory, Cr Accounts Payable. */
export async function postGoodsReceiptCompleted(goodsReceiptId: string) {
  const receipt = await db.goodsReceipt.findUniqueOrThrow({ where: { id: goodsReceiptId }, include: { lines: true } })
  const totalValue = receipt.lines.reduce((sum, l) => sum + l.quantityReceived * Number(l.unitCost), 0)
  if (totalValue <= 0) return

  await db.$transaction(async (tx) => {
    const [inventoryAccount, apAccount] = await Promise.all([
      resolveAccountId(tx, receipt.organizationId, receipt.branchId, "inventory_asset"),
      resolveAccountId(tx, receipt.organizationId, receipt.branchId, "accounts_payable"),
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
        { accountId: apAccount, credit: totalValue },
      ],
    })
  })
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
  })
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
  })
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
  })
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

    await postJournal(tx, {
      organizationId: run.organizationId,
      branchId: run.branchId,
      referenceType: "payroll_run",
      referenceId: run.id,
      description: `Payroll paid for ${run.periodStart.toISOString().slice(0, 10)} – ${run.periodEnd.toISOString().slice(0, 10)}`,
      postedBy: null,
      lines: [
        { accountId: payrollPayableAccount, debit: total },
        { accountId: tenderAccount, credit: total },
      ],
    })
  })
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
  return db.$transaction((tx) =>
    postJournal(tx, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      referenceType: "manual",
      referenceId: null,
      description: input.description,
      postedBy: input.postedBy,
      journalDate: input.journalDate,
      lines: input.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description ?? undefined })),
    })
  )
}
