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
import type { SessionContext } from "@/lib/auth/session"
import type { GenerateInvoiceInput } from "@/lib/domains/billing/schemas"

type Db = Prisma.TransactionClient | typeof db

/**
 * P1 §29: the one and only place `invoice.paid_amount` is ever incremented
 * — by a patient payment (payments.ts) or an insurance remittance
 * (claims/service.ts), both of which write the same column and must
 * therefore share the same guard, not two independently-racing ones. A
 * plain "read paidAmount, check in application code, then write" (what
 * every caller did before P1) has a real gap: two concurrent calls both
 * read the same stale paidAmount, both pass validation, both write —
 * together overpaying an invoice with neither ever seeing the other's
 * write. Fixed with a single atomic UPDATE whose WHERE clause re-validates
 * the invariant (`paid_amount + amount <= total_amount`) against
 * whatever the row's value actually is *at the moment Postgres evaluates
 * this statement*, which is what makes it safe under concurrency — the
 * same "one atomic conditional statement, not check-then-update" pattern
 * `sequences.ts`'s `nextNumber()` already established for its own
 * concurrency guarantee. Two concurrent calls against the same invoice
 * serialize on the row (the second genuinely waits for the first's
 * transaction to commit or roll back before its own UPDATE evaluates),
 * so the second sees the first's already-applied increment and correctly
 * fails the WHERE clause if there's no room left — 0 rows updated, and
 * this throws rather than silently truncating or overpaying.
 */
export async function applyPaymentAtomically(tx: Db, invoiceId: string, amount: Decimal): Promise<{ status: string }> {
  const updated = await tx.$queryRaw<{ status: string }[]>(Prisma.sql`
    UPDATE "invoice"
    SET
      "paid_amount" = "paid_amount" + ${amount.toFixed(2)}::numeric,
      "status" = CASE
        WHEN "paid_amount" + ${amount.toFixed(2)}::numeric >= "total_amount" THEN 'paid'::"InvoiceStatus"
        ELSE 'partially_paid'::"InvoiceStatus"
      END
    WHERE "id" = ${invoiceId}
      AND "paid_amount" + ${amount.toFixed(2)}::numeric <= "total_amount"
    RETURNING "status"
  `)
  if (updated.length === 0) {
    throw new Error(
      `Payment of ${amount.toFixed(2)} exceeds the invoice's outstanding balance — another payment or remittance was recorded first. Refresh and try again.`
    )
  }
  return updated[0]
}

/**
 * The refund-side mirror of `applyPaymentAtomically` — same reasoning, same
 * pattern, guarding the opposite direction: `paid_amount - amount >= 0`
 * (a refund can never make the recorded paid amount negative, which is
 * exactly "cannot exceed the remaining refundable balance," since
 * `paid_amount` already reflects every prior completed refund's
 * decrement). This is P1 §7's literal scenario: Payment 1,000, an existing
 * completed refund of 600 (paid_amount already down to 400), two new
 * simultaneous requests to refund 300 each — the first to actually commit
 * its UPDATE succeeds (400 - 300 = 100 >= 0); the second, evaluated after
 * the first commits, sees paid_amount already at 100 and correctly fails
 * (100 - 300 < 0) rather than letting the combined 600 exceed the 400 that
 * was actually still refundable.
 */
export async function applyRefundAtomically(tx: Db, invoiceId: string, amount: Decimal): Promise<{ status: string }> {
  const updated = await tx.$queryRaw<{ status: string }[]>(Prisma.sql`
    UPDATE "invoice"
    SET
      "paid_amount" = "paid_amount" - ${amount.toFixed(2)}::numeric,
      "status" = CASE
        WHEN "paid_amount" - ${amount.toFixed(2)}::numeric <= 0 THEN 'issued'::"InvoiceStatus"
        WHEN "paid_amount" - ${amount.toFixed(2)}::numeric < "total_amount" THEN 'partially_paid'::"InvoiceStatus"
        ELSE 'paid'::"InvoiceStatus"
      END
    WHERE "id" = ${invoiceId}
      AND "paid_amount" - ${amount.toFixed(2)}::numeric >= 0
    RETURNING "status"
  `)
  if (updated.length === 0) {
    throw new Error(
      `Refund of ${amount.toFixed(2)} exceeds the invoice's remaining refundable balance — another refund was completed first. Refresh and try again.`
    )
  }
  return updated[0]
}

const INVOICE_INCLUDE = {
  patient: true,
  branch: true,
  provider: true,
  lines: { include: { charge: true } },
  paymentAllocations: { include: { payment: true } },
  refunds: true,
  payor: true,
  patientCoverage: { include: { policy: { include: { insurancePlan: true } } } },
  claims: { orderBy: { createdAt: "desc" } },
} as const

/**
 * Tax is a configurable rate attached per Service (or an org-wide default),
 * never a hardcoded percentage (spec.md §92, ARCHITECTURE.md §6). No
 * TaxRule at all — including no default — means 0% tax, which is a valid
 * configuration for a self-pay clinic in a no-VAT jurisdiction; this
 * function never invents a nonzero fallback.
 *
 * P2 §18: previously `getTaxRate`, called once per invoice line (SYSTEM_AUDIT
 * Medium #40) — one to two queries per charge, unbatched. Replaced with a
 * single prefetch of every TaxRule this invoice's charges could possibly
 * need (one query for the distinct service-specific rules, one for the
 * org-wide default — same two queries `getTaxRate` always made per call,
 * now made exactly once per invoice regardless of line count) plus an
 * in-memory resolver closure. Precedence is byte-for-byte identical to the
 * function it replaces: a specific active rule for the charge's own
 * serviceId wins if one exists; otherwise the org-wide default (isDefault
 * + isActive) if one exists; otherwise zero. (The one pre-existing,
 * unspecified edge case — multiple active rules configured for the same
 * service, which DATABASE.md already documents as enforced at the service
 * layer, not the database, and which `findFirst()`'s own undefined
 * ordering already made implementation-dependent before this change too —
 * is not a precedence question this function's contract ever defined, so
 * preserving it exactly isn't a "calculation behavior" this refactor could
 * regress.)
 */
async function prefetchTaxRateResolver(
  organizationId: string,
  serviceIds: (string | null)[]
): Promise<(serviceId: string | null) => Decimal> {
  const uniqueServiceIds = [...new Set(serviceIds.filter((id): id is string => id !== null))]
  const [specificRules, defaultRule] = await Promise.all([
    uniqueServiceIds.length > 0
      ? db.taxRule.findMany({ where: { organizationId, serviceId: { in: uniqueServiceIds }, isActive: true } })
      : Promise.resolve([]),
    db.taxRule.findFirst({ where: { organizationId, isDefault: true, isActive: true } }),
  ])
  const specificByService = new Map(specificRules.map((r) => [r.serviceId, new Decimal(r.rate)]))
  const defaultRate = defaultRule ? new Decimal(defaultRule.rate) : null

  return (serviceId: string | null): Decimal => {
    if (serviceId) {
      const specific = specificByService.get(serviceId)
      if (specific) return specific
    }
    return defaultRate ?? new Decimal(0)
  }
}

/**
 * The only place an Invoice is created (spec.md §33). Consumes a set of
 * pending Charges atomically: each becomes exactly one InvoiceLine (flipping
 * the Charge to `invoiced`), subtotal/tax/total are computed here from the
 * charges themselves — never accepted from the caller (spec.md §92 "never
 * trust frontend totals"). Tax is computed and rounded per line, then summed
 * (locked convention, ARCHITECTURE.md §6); the document-level discount
 * applies to the total, not to each line's tax base.
 */
export async function generateInvoice(session: SessionContext, input: GenerateInvoiceInput) {
  assertCan(session, "invoice.create", { branchId: input.branchId })

  // P1 §32/§33 (finding A5): fast, pre-transaction read for the common
  // (non-racing) case only — NOT the safety mechanism, same "friendly error
  // without opening a transaction" discipline as recordPayment's own
  // preliminary check. Two overlapping "Generate Invoice" submissions (a
  // double-click, or two staff members both invoicing from the same
  // pending-charges list) could both pass this read; the atomic claim
  // inside the transaction below is what actually prevents both from
  // succeeding and double-billing the same charge on two invoices.
  const charges = await db.charge.findMany({
    where: {
      id: { in: input.chargeIds },
      organizationId: session.user.organizationId,
      patientId: input.patientId,
      // P3.7 §12/§13/§41: previously absent — `assertCan(...,{branchId:
      // input.branchId})` above only verifies the *session* is authorized
      // for the invoice's own branch; it says nothing about whether the
      // *charges themselves* actually belong to that branch. Without this,
      // a request naming a branch the session legitimately operates at
      // could still merge in chargeIds that were actually incurred at a
      // completely different branch, producing an invoice whose own
      // branchId disagrees with the branch its line items were really
      // billed at — real cross-branch financial data corruption, not just
      // an authorization gap.
      branchId: input.branchId,
      status: "pending",
    },
  })
  if (charges.length !== input.chargeIds.length) {
    throw new Error("One or more selected charges are no longer pending, or don't belong to this branch — refresh and try again.")
  }
  if (input.discountAmount > 0) {
    assertCan(session, "invoice.discount", { branchId: input.branchId })
  }

  // P2 §18: one prefetch for the whole invoice instead of a getTaxRate()
  // round-trip per charge — see prefetchTaxRateResolver's own doc comment.
  const resolveTaxRate = await prefetchTaxRateResolver(session.user.organizationId, charges.map((c) => c.serviceId))
  const lineComputations = charges.map((charge) => {
    const rate = resolveTaxRate(charge.serviceId)
    const amount = new Decimal(charge.amount)
    const tax = amount.mul(rate).toDecimalPlaces(2)
    return { charge, tax, lineTotal: amount.add(tax) }
  })

  const subtotal = lineComputations.reduce((sum, l) => sum.add(l.charge.amount), new Decimal(0))
  const taxAmount = lineComputations.reduce((sum, l) => sum.add(l.tax), new Decimal(0))
  const discountAmount = new Decimal(input.discountAmount)
  const totalAmount = subtotal.sub(discountAmount).add(taxAmount)
  if (totalAmount.isNegative()) {
    throw new Error("Discount cannot exceed the invoice subtotal plus tax.")
  }

  // Insurance path (spec.md §38, Phase 11) — estimated at issue time from
  // the linked PatientCoverage's copay, never a live payor eligibility call
  // (spec.md §92 "never fake API integrations"). Deliberately copay-only:
  // deductibleAmount is stored on PatientCoverage for reference but doesn't
  // feed this estimate — an accurate estimate would require summing every
  // prior claim against the same policy year's deductible, a real feature
  // deferred until a concrete need names it (see PROJECT_STATUS.md's Phase
  // 11 Known Issues), the same "architecture, not full automation" scope
  // spec.md §38 itself asks for ("deductible architecture").
  let payorId: string | null = null
  let estimatedPatientResponsibility: Decimal | null = null
  let estimatedPayorResponsibility: Decimal | null = null
  if (input.patientCoverageId) {
    const coverage = await db.patientCoverage.findFirstOrThrow({
      where: { id: input.patientCoverageId, organizationId: session.user.organizationId, patientId: input.patientId },
      include: { policy: { include: { insurancePlan: true } } },
    })
    payorId = coverage.policy.insurancePlan.payorId
    const copay = coverage.copayAmount != null
      ? new Decimal(coverage.copayAmount)
      : coverage.copayPercent != null
        ? totalAmount.mul(coverage.copayPercent).div(100).toDecimalPlaces(2)
        : new Decimal(0)
    estimatedPatientResponsibility = Decimal.min(copay, totalAmount)
    estimatedPayorResponsibility = totalAmount.sub(estimatedPatientResponsibility)
  }

  const invoice = await db.$transaction(async (tx) => {
    // P1 §32/§33 (finding A5) — the actual guard: atomically claim every
    // charge (pending -> invoiced) *before* creating the invoice, with a
    // `status: "pending"` precondition in the WHERE clause itself, not a
    // plain `where: { id }` update. Two concurrent generateInvoice calls
    // selecting the same charge(s) both pass the pre-transaction read above,
    // but only the first to reach this claim actually flips them — the
    // second's `claimed.count` comes up short and the whole transaction
    // (including the invoice/lines it hadn't created yet) rolls back, the
    // same "claim before acting" discipline dispenseRecord/completeRefund
    // already established.
    const claimed = await tx.charge.updateMany({
      where: {
        id: { in: input.chargeIds },
        organizationId: session.user.organizationId,
        patientId: input.patientId,
        branchId: input.branchId,
        status: "pending",
      },
      data: { status: "invoiced" },
    })
    if (claimed.count !== input.chargeIds.length) {
      throw new Error("One or more selected charges were already invoiced by another request — refresh and try again.")
    }

    const invoiceNumber = await nextNumber({
      organizationId: session.user.organizationId,
      sequenceType: "INV",
      prefix: "INV",
    })

    const created = await tx.invoice.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        invoiceNumber,
        patientId: input.patientId,
        providerId: input.providerId ?? null,
        subtotal,
        discountAmount,
        taxAmount,
        totalAmount,
        payorId,
        patientCoverageId: input.patientCoverageId ?? null,
        estimatedPatientResponsibility,
        estimatedPayorResponsibility,
        createdBy: session.user.id,
      },
    })

    for (const { charge, tax, lineTotal } of lineComputations) {
      await tx.invoiceLine.create({
        data: {
          invoiceId: created.id,
          chargeId: charge.id,
          description: charge.description,
          quantity: charge.quantity,
          unitPrice: charge.unitPrice,
          taxAmount: tax,
          lineTotal,
        },
      })
    }

    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "InvoiceIssued",
      payload: { invoiceId: created.id, patientId: created.patientId, totalAmount: Number(totalAmount) },
    })

    return created
  }, { timeout: 20_000, maxWait: 10_000 }) // widened for the same reason posting-service.ts's POSTING_TRANSACTION_OPTIONS is — nextNumber()'s own nested transaction plus one invoiceLine create and one charge update PER LINE add up under this environment's real Supabase pooler latency, and a real P1 Batch 6 full-suite run caught this exact transaction genuinely exceeding Prisma's 5000ms default

  await auditFromSession(session, "create", "invoice", invoice.id, {
    new: { invoiceNumber: invoice.invoiceNumber, totalAmount: Number(totalAmount) },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)

  return invoice
}

export async function getInvoice(session: SessionContext, id: string) {
  assertCan(session, "invoice.view")
  const invoice = await db.invoice.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: INVOICE_INCLUDE,
  })
  assertBranchAccess(getAuthorizedBranchScope(session), invoice.branchId)
  return invoice
}

const INVOICE_LIST_PAGE_SIZE = 50

/** P2 §8: was `take: 100` with no page param — the original audit's own "invoice list hard cap" finding. Real server-side pagination now, not a bigger cap. */
export async function listInvoices(
  session: SessionContext,
  filters: { patientId?: string; status?: string; branchId?: string; page?: number } = {}
) {
  assertCan(session, "invoice.view")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where: Prisma.InvoiceWhereInput = {
    organizationId: session.user.organizationId,
    patientId: filters.patientId,
    status: filters.status as never,
    branchId: narrowBranchFilter(scope, filters.branchId),
  }
  const [invoices, total] = await Promise.all([
    db.invoice.findMany({
      where,
      include: { patient: true, branch: true },
      orderBy: { createdAt: "desc" },
      ...paginationSkipTake(page, INVOICE_LIST_PAGE_SIZE),
    }),
    db.invoice.count({ where }),
  ])
  return { invoices, total, page, pageSize: INVOICE_LIST_PAGE_SIZE, totalPages: totalPages(total, INVOICE_LIST_PAGE_SIZE) }
}

/**
 * Backs the Receivables page (spec.md §56) — every invoice still owed
 * money, oldest first.
 *
 * P2 §8: was fully unbounded (no `take` at all) — the status filter alone
 * doesn't bound this in a clinic with enough history, so this needed the
 * same real pagination as `listInvoices`, not a post-filter over an
 * already-capped general list (see `listOutstandingSupplierInvoices`,
 * `procurement/supplier-invoices.ts`, for why the Payables page's
 * equivalent needed its own DB-level status filter rather than
 * paginating-then-filtering).
 */
export async function listOutstandingInvoices(session: SessionContext, filters: { branchId?: string; page?: number } = {}) {
  assertCan(session, "invoice.view")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const where: Prisma.InvoiceWhereInput = {
    organizationId: session.user.organizationId,
    branchId: narrowBranchFilter(scope, filters.branchId),
    status: { in: ["issued", "partially_paid"] },
  }
  // The page header's "total owed" figure must reflect every outstanding
  // invoice, not just the current page — a real DB-level SUM (two, since
  // "outstanding" is totalAmount - paidAmount, not a raw stored column),
  // never derived from whatever rows happen to be on this page.
  const [invoices, total, sums] = await Promise.all([
    db.invoice.findMany({
      where,
      include: { patient: true, branch: true },
      orderBy: { issuedAt: "asc" },
      ...paginationSkipTake(page, INVOICE_LIST_PAGE_SIZE),
    }),
    db.invoice.count({ where }),
    db.invoice.aggregate({ where, _sum: { totalAmount: true, paidAmount: true } }),
  ])
  const totalOutstanding = Number(sums._sum.totalAmount ?? 0) - Number(sums._sum.paidAmount ?? 0)
  return { invoices, total, totalOutstanding, page, pageSize: INVOICE_LIST_PAGE_SIZE, totalPages: totalPages(total, INVOICE_LIST_PAGE_SIZE) }
}

/**
 * P3.9 §26: "if [AR aging] does NOT exist, do not build a complex aging
 * engine unless trivial using existing query infrastructure — basic
 * buckets may be useful later." A single SUM-with-CASE aggregate over the
 * same outstanding-invoice population `listOutstandingInvoices` already
 * scopes and totals (not a second, parallel definition of "outstanding") —
 * bucketed by days since `issuedAt`, the closest this model has to a due
 * date reference for every invoice regardless of whether `dueDate` is set.
 */
export async function getReceivablesAging(session: SessionContext, filters: { branchId?: string } = {}) {
  assertCan(session, "invoice.view")
  const scope = getAuthorizedBranchScope(session)
  if (filters.branchId) assertBranchAccess(scope, filters.branchId)
  const branchFilter = filters.branchId
    ? Prisma.sql`AND branch_id = ${filters.branchId}`
    : scope.isOrgWide
      ? Prisma.sql``
      : scope.branchIds.length === 0
        ? Prisma.sql`AND FALSE`
        : Prisma.sql`AND branch_id IN (${Prisma.join(scope.branchIds)})`

  const rows = await db.$queryRaw<{ bucket: string; total: number }[]>(Prisma.sql`
    SELECT
      CASE
        WHEN issued_at > NOW() - INTERVAL '30 days' THEN 'current'
        WHEN issued_at > NOW() - INTERVAL '60 days' THEN '31_60'
        WHEN issued_at > NOW() - INTERVAL '90 days' THEN '61_90'
        ELSE 'over_90'
      END AS bucket,
      COALESCE(SUM(total_amount - paid_amount), 0)::float AS total
    FROM "invoice"
    WHERE organization_id = ${session.user.organizationId}
      AND status IN ('issued', 'partially_paid')
      ${branchFilter}
    GROUP BY bucket
  `)
  const byBucket = new Map(rows.map((r) => [r.bucket, r.total]))
  return {
    current: byBucket.get("current") ?? 0,
    days31to60: byBucket.get("31_60") ?? 0,
    days61to90: byBucket.get("61_90") ?? 0,
    over90: byBucket.get("over_90") ?? 0,
  }
}

export async function listPatientInvoices(session: SessionContext, patientId: string) {
  assertCan(session, "invoice.view")
  const scope = getAuthorizedBranchScope(session)
  return db.invoice.findMany({
    where: { organizationId: session.user.organizationId, patientId, branchId: narrowBranchFilter(scope) },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  })
}

/**
 * Never deletes — voiding is a status flag, and every consumed Charge
 * reverts to pending so it can be re-invoiced.
 *
 * P1 §24: also reverses the `Dr AR / Cr Revenue` postInvoiceIssued posted
 * for this invoice (postInvoiceVoided, posting-service.ts) — fired via the
 * outbox, the same async-notification-of-a-cross-cutting-concern pattern
 * every other accounting trigger in this codebase uses, so a posting
 * failure never blocks the void itself from completing. See
 * postInvoiceVoided's own doc comment for why this was a real gap, not a
 * defensive addition: without it, re-invoicing the same reverted-to-pending
 * charges would double-count revenue.
 */
export async function voidInvoice(session: SessionContext, id: string, reason: string) {
  assertCan(session, "invoice.void")

  const invoice = await db.invoice.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { lines: true },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), invoice.branchId)
  if (Number(invoice.paidAmount) > 0) {
    throw new Error("Cannot void an invoice that has payments applied — issue a refund instead.")
  }
  if (invoice.status === "void") {
    throw new Error("This invoice is already void.")
  }

  const updated = await db.$transaction(async (tx) => {
    await tx.charge.updateMany({
      where: { id: { in: invoice.lines.map((l) => l.chargeId) } },
      data: { status: "pending" },
    })
    const result = await tx.invoice.update({ where: { id }, data: { status: "void", voidReason: reason } })
    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "InvoiceVoided",
      payload: { invoiceId: id },
    })
    return result
  }, { timeout: 20_000, maxWait: 10_000 }) // same headroom as generateInvoice above — this batch added the writeOutboxEvent call on top of what was already close to Prisma's 5000ms default

  await auditFromSession(session, "void", "invoice", id, { old: invoice, new: { status: "void", reason } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}
