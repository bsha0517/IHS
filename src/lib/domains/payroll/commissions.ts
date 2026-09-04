import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { Prisma } from "@/generated/prisma/client"
import type { CommissionRuleInput } from "@/lib/domains/payroll/schemas"

type Db = Prisma.TransactionClient | typeof db
type Tier = { minAmount: number; maxAmount: number | null; rate: number }

export async function listCommissionRules(session: SessionContext) {
  assertCan(session, "commission.manage")
  return db.commissionRule.findMany({
    where: { organizationId: session.user.organizationId },
    include: { provider: true, service: true, product: true },
    orderBy: { createdAt: "desc" },
  })
}

export async function createCommissionRule(session: SessionContext, input: CommissionRuleInput) {
  assertCan(session, "commission.manage")
  const created = await db.commissionRule.create({
    data: {
      organizationId: session.user.organizationId,
      providerId: input.providerId ?? null,
      serviceId: input.serviceId ?? null,
      productId: input.productId ?? null,
      type: input.type,
      basis: input.basis,
      fixedAmount: input.fixedAmount != null ? new Decimal(input.fixedAmount) : null,
      percentageRate: input.percentageRate != null ? new Decimal(input.percentageRate) : null,
      tiers: input.tiers ?? undefined,
    },
  })
  await auditFromSession(session, "create", "commission_rule", created.id, {
    new: { providerId: input.providerId, serviceId: input.serviceId, type: input.type, basis: input.basis },
  })
  return created
}

export async function deactivateCommissionRule(session: SessionContext, id: string) {
  assertCan(session, "commission.manage")
  const updated = await db.commissionRule.update({ where: { id }, data: { isActive: false } })
  await auditFromSession(session, "update", "commission_rule", id, { new: { isActive: false } })
  return updated
}

type ResolvedCommissionRule = Prisma.CommissionRuleGetPayload<Record<string, never>>

/**
 * P2 §4: the original audit's ~90-sequential-query finding — this used to
 * be `resolveCommissionRule`, called fresh once PER (line) in
 * `accrueInvoiceBasisCommissions` and once per (payment × line) in
 * `accruePaymentBasisCommissions`, each call issuing its own 2 queries
 * (provider-specific rules + org-wide rules) even though the same
 * (providerId, serviceId) combination — and often the exact same provider
 * across every line on an invoice — repeats constantly within one
 * accrual pass. Replaced with a single prefetch covering every provider
 * that could possibly need resolving on this invoice (one query, an `OR`
 * across every distinct providerId plus the org-wide-provider rows,
 * instead of 2 queries × N callers) plus an in-memory resolver + cache.
 *
 * Most-specific-wins precedence is byte-for-byte identical to the
 * function this replaces: (provider, service) > (provider, null) >
 * (null, service) > (null, null) org default. The candidate list and its
 * find-order are reconstructed exactly — `[...this provider's own rules,
 * ...org-wide rules]`, filtered from the single prefetch rather than two
 * separate queries — so a caller can never observe a different resolved
 * rule than the original two-query-per-call version would have returned.
 */
async function buildCommissionRuleResolver(
  tx: Db,
  organizationId: string,
  providerIds: string[]
): Promise<(providerId: string, serviceId: string | null) => ResolvedCommissionRule | null> {
  const uniqueProviderIds = [...new Set(providerIds)]
  const allRules = await tx.commissionRule.findMany({
    where: { organizationId, isActive: true, OR: [{ providerId: { in: uniqueProviderIds } }, { providerId: null }] },
  })
  const orgWideRules = allRules.filter((r) => r.providerId === null)
  const rulesByProvider = new Map<string, typeof allRules>()
  for (const pid of uniqueProviderIds) {
    rulesByProvider.set(pid, allRules.filter((r) => r.providerId === pid))
  }

  const cache = new Map<string, ResolvedCommissionRule | null>()
  return (providerId: string, serviceId: string | null): ResolvedCommissionRule | null => {
    const cacheKey = `${providerId}:${serviceId ?? ""}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached

    const candidates = [...(rulesByProvider.get(providerId) ?? []), ...orgWideRules]
    const resolved =
      candidates.find((r) => r.providerId === providerId && r.serviceId === serviceId) ??
      candidates.find((r) => r.providerId === providerId && r.serviceId === null) ??
      candidates.find((r) => r.providerId === null && r.serviceId === serviceId) ??
      candidates.find((r) => r.providerId === null && r.serviceId === null) ??
      null
    cache.set(cacheKey, resolved)
    return resolved
  }
}

export function computeAmount(rule: { type: string; fixedAmount: Prisma.Decimal | null; percentageRate: Prisma.Decimal | null; tiers: unknown }, basisAmount: number): number {
  if (rule.type === "fixed") return Number(rule.fixedAmount ?? 0)
  if (rule.type === "percentage") return basisAmount * Number(rule.percentageRate ?? 0)
  if (rule.type === "tiered") {
    const tiers = (rule.tiers as Tier[] | null) ?? []
    const bracket = tiers.find((t) => basisAmount >= t.minAmount && (t.maxAmount === null || basisAmount <= t.maxAmount))
    return bracket ? basisAmount * bracket.rate : 0
  }
  return 0
}

/**
 * gross_invoice/net_invoice-basis accrual: once per charge, at InvoiceIssued
 * time. Idempotency is a check-before-insert on chargeId with paymentId null
 * — the same accepted tradeoff already made for TaxRule/AccountMapping (NULL
 * is distinct in a unique index, and this is a comparatively low-volume
 * table), not a DB constraint.
 */
export async function accrueInvoiceBasisCommissions(tx: Db, invoiceId: string) {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { lines: { include: { charge: true } } },
  })
  const linesWithProvider = invoice.lines.filter((line) => line.charge.providerId)
  if (linesWithProvider.length === 0) return

  // P2 §4: was up to 3 queries PER LINE (2 for rule resolution + 1
  // existing-accrual check) — batched to at most 2 queries total for the
  // whole invoice, regardless of line count. See buildCommissionRuleResolver's
  // own doc comment for why the resolved rule is identical either way.
  const resolveRule = await buildCommissionRuleResolver(
    tx,
    invoice.organizationId,
    linesWithProvider.map((line) => line.charge.providerId as string)
  )
  const existingAccruals = await tx.commissionAccrual.findMany({
    where: { chargeId: { in: linesWithProvider.map((line) => line.chargeId) }, paymentId: null },
    select: { chargeId: true },
  })
  const alreadyAccrued = new Set(existingAccruals.map((a) => a.chargeId))

  const rowsToInsert: Prisma.CommissionAccrualCreateManyInput[] = []
  for (const line of linesWithProvider) {
    if (alreadyAccrued.has(line.chargeId)) continue
    const rule = resolveRule(line.charge.providerId as string, line.charge.serviceId)
    if (!rule || rule.basis === "collected_revenue") continue

    const basisAmount = rule.basis === "gross_invoice" ? Number(line.lineTotal) : Number(line.charge.amount)
    const amount = computeAmount(rule, basisAmount)
    if (amount <= 0) continue

    rowsToInsert.push({
      organizationId: invoice.organizationId,
      branchId: invoice.branchId,
      providerId: line.charge.providerId as string,
      chargeId: line.chargeId,
      invoiceId: invoice.id,
      paymentId: null,
      commissionRuleId: rule.id,
      basisAmount: new Decimal(basisAmount),
      amount: new Decimal(amount),
    })
  }
  // P2 §4: bulk insert — every row above was already proven safe to create
  // (no existing row for its chargeId, computed independently of every
  // other row in this batch) so a single createMany is exactly equivalent
  // to N individual creates, just one round trip instead of N.
  if (rowsToInsert.length > 0) {
    await tx.commissionAccrual.createMany({ data: rowsToInsert })
  }
}

/**
 * collected_revenue-basis accrual: per payment, proportional to what that
 * specific payment collected against each charge on the invoice. paymentId
 * is always set for these rows, so @@unique([chargeId, paymentId]) genuinely
 * prevents double-accrual on outbox at-least-once redelivery.
 */
export async function accruePaymentBasisCommissions(tx: Db, invoiceId: string, paymentIds: string[]) {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { lines: { include: { charge: true } } },
  })
  const subtotal = Number(invoice.subtotal)
  if (subtotal <= 0) return

  const payments = await tx.payment.findMany({ where: { id: { in: paymentIds } } })
  const linesWithProvider = invoice.lines.filter((line) => line.charge.providerId)
  if (linesWithProvider.length === 0 || payments.length === 0) return

  // P2 §4: this was the original audit's own literal ~90-query example —
  // up to 3 queries PER (payment × line) pair (2 for rule resolution + 1
  // existing-accrual check), so a 3-payment, 6-line invoice alone could
  // hit 3 x 3 x 6 = 54 queries, before counting the invoice/payment reads.
  // Batched to at most 3 queries total for the whole invoice/payment
  // batch, regardless of how many payments or lines are involved — one
  // rule prefetch (shared with accrueInvoiceBasisCommissions's identical
  // helper), one existing-accrual prefetch across every (charge, payment)
  // pair at once, one bulk insert.
  const resolveRule = await buildCommissionRuleResolver(
    tx,
    invoice.organizationId,
    linesWithProvider.map((line) => line.charge.providerId as string)
  )
  const existingAccruals = await tx.commissionAccrual.findMany({
    where: { chargeId: { in: linesWithProvider.map((line) => line.chargeId) }, paymentId: { in: payments.map((p) => p.id) } },
    select: { chargeId: true, paymentId: true },
  })
  const alreadyAccrued = new Set(existingAccruals.map((a) => `${a.chargeId}:${a.paymentId}`))

  const rowsToInsert: Prisma.CommissionAccrualCreateManyInput[] = []
  for (const payment of payments) {
    for (const line of linesWithProvider) {
      if (alreadyAccrued.has(`${line.chargeId}:${payment.id}`)) continue
      const rule = resolveRule(line.charge.providerId as string, line.charge.serviceId)
      if (!rule || rule.basis !== "collected_revenue") continue

      const proportionalCollected = (Number(line.charge.amount) / subtotal) * Number(payment.amount)
      const amount = computeAmount(rule, proportionalCollected)
      if (amount <= 0) continue

      rowsToInsert.push({
        organizationId: invoice.organizationId,
        branchId: invoice.branchId,
        providerId: line.charge.providerId as string,
        chargeId: line.chargeId,
        invoiceId: invoice.id,
        paymentId: payment.id,
        commissionRuleId: rule.id,
        basisAmount: new Decimal(proportionalCollected),
        amount: new Decimal(amount),
      })
    }
  }
  // P2 §4: bulk insert — every (chargeId, paymentId) pair here is unique
  // within this batch by construction (one row per distinct line x payment
  // combination, already filtered against what exists in the database), so
  // a single createMany is exactly equivalent to N individual creates.
  if (rowsToInsert.length > 0) {
    await tx.commissionAccrual.createMany({ data: rowsToInsert })
  }
}

/**
 * P1 §19: claws back commission when the revenue it was earned on is later
 * refunded — closing P1_FINANCIAL_INTEGRITY_FINDINGS.md's B11 ("provider
 * commission is never reversed, adjusted, or flagged when a refund
 * occurs"). Only `collected_revenue`-basis accruals are ever touched here.
 *
 * `gross_invoice`/`net_invoice`-basis accruals are deliberately left
 * untouched — this is the "follow configured policy" branch P1 §19 itself
 * names as an acceptable outcome, not an oversight. Those two bases exist
 * specifically to pay commission on what was BILLED, independent of
 * collection outcome (a real, common sales-comp policy: "you get credit
 * for the sale, the business absorbs collection risk"); a refund reduces
 * `Invoice.paidAmount`, never `Invoice.totalAmount` or the original
 * charge/invoice-line, so the billed event those two bases are keyed to
 * never actually changed. `collected_revenue`-basis is different in kind:
 * it was earned *because* specific cash came in (accrued per Payment,
 * proportional to what that payment actually collected — see
 * accruePaymentBasisCommissions above), so a refund of that same cash
 * makes the original accrual genuinely wrong unless reversed — this is
 * the "reverse proportionately" branch.
 *
 * Never edits or deletes the original accrual (spec.md §92) — inserts a
 * new, negative-amount `CommissionAccrual` row instead, `status: pending`
 * by default so it flows through the exact same `createPayrollRun` pickup
 * (payroll.ts) as any other pending accrual regardless of whether the
 * original was already `pending`, `included_in_payroll`, or fully `paid`
 * — netting against future payroll runs rather than requiring the
 * original's status to still be reversible in place.
 *
 * Reversal is proportional to how much of the specific underlying payment
 * is being given back: `refund.paymentId` set narrows to exactly that
 * payment's own accruals; left null (a refund not attributed to one
 * specific tender), the refund is spread across every payment on the
 * invoice in proportion to each payment's own share of everything ever
 * collected on it — the same "amount, not specific tender" simplification
 * `postRefundCompleted`'s own doc comment already accepts for the
 * accounting side of a document-level refund.
 */
export async function reverseCommissionsForRefund(tx: Db, refundId: string) {
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } })
  const refundAmount = Number(refund.amount)
  if (refundAmount <= 0) return

  // Only ORIGINAL collected_revenue-basis rows — paymentId set, refundId
  // null (excludes reversal rows themselves, so a second refund against the
  // same invoice never treats an earlier reversal as something to reverse
  // again).
  const originalAccruals = await tx.commissionAccrual.findMany({
    where: { organizationId: refund.organizationId, invoiceId: refund.invoiceId, paymentId: { not: null }, refundId: null },
  })
  if (originalAccruals.length === 0) return // no collected_revenue rule ever applied to this invoice — nothing to reverse

  const paymentIds = refund.paymentId ? [refund.paymentId] : [...new Set(originalAccruals.map((a) => a.paymentId as string))]
  const payments = await tx.payment.findMany({ where: { id: { in: paymentIds } } })
  const paymentAmountById = new Map(payments.map((p) => [p.id, Number(p.amount)]))
  const totalAcrossPayments = payments.reduce((sum, p) => sum + Number(p.amount), 0)
  if (totalAcrossPayments <= 0) return

  for (const paymentId of paymentIds) {
    const paymentAmount = paymentAmountById.get(paymentId) ?? 0
    if (paymentAmount <= 0) continue

    // How much of THIS payment is being refunded: the whole refund if it
    // was tied to this exact payment, otherwise this payment's own
    // proportional share of the (possibly multi-payment) refund.
    const refundedAgainstThisPayment = refund.paymentId
      ? Math.min(refundAmount, paymentAmount)
      : refundAmount * (paymentAmount / totalAcrossPayments)
    const fractionOfPaymentRefunded = Math.min(1, refundedAgainstThisPayment / paymentAmount)
    if (fractionOfPaymentRefunded <= 0) continue

    for (const accrual of originalAccruals.filter((a) => a.paymentId === paymentId)) {
      // Idempotency: a reversal row for this exact (refund, ORIGINAL
      // ACCRUAL) pair already exists — outbox at-least-once redelivery of
      // RefundCompleted. Keyed on `reversalOfId`, not just `chargeId` —
      // one charge can have several originating payments (several
      // collected_revenue accruals to reverse for the same refund), and
      // checking only (refundId, chargeId) would wrongly treat the second
      // payment's reversal as "already done" the moment the first
      // payment's reversal existed, silently under-reversing. Enforced for
      // real by @@unique([refundId, reversalOfId]) — this pre-check is a
      // fast, friendly skip, not the sole guard.
      const existingReversal = await tx.commissionAccrual.findFirst({
        where: { refundId, reversalOfId: accrual.id },
      })
      if (existingReversal) continue

      const reversedBasis = Number(accrual.basisAmount) * fractionOfPaymentRefunded
      const reversedAmount = Number(accrual.amount) * fractionOfPaymentRefunded
      if (reversedAmount <= 0) continue

      await tx.commissionAccrual.create({
        data: {
          organizationId: accrual.organizationId,
          branchId: accrual.branchId,
          providerId: accrual.providerId,
          chargeId: accrual.chargeId,
          invoiceId: accrual.invoiceId,
          paymentId: null,
          commissionRuleId: accrual.commissionRuleId,
          basisAmount: new Decimal(reversedBasis),
          amount: new Decimal(-reversedAmount),
          refundId,
          reversalOfId: accrual.id,
        },
      })
    }
  }
}

/** Provider commission statement (spec.md §53) — computed live from CommissionAccrual, never a stored running total. */
export async function getProviderStatement(session: SessionContext, providerId: string, filters: { from?: Date; to?: Date } = {}) {
  assertCan(session, "commission.view")
  const scope = getAuthorizedBranchScope(session)
  const accruals = await db.commissionAccrual.findMany({
    where: {
      organizationId: session.user.organizationId,
      providerId,
      branchId: narrowBranchFilter(scope),
      accruedAt: { gte: filters.from, lte: filters.to },
    },
    include: { charge: true, invoice: true, commissionRule: true },
    orderBy: { accruedAt: "desc" },
  })
  const total = accruals.reduce((sum, a) => sum + Number(a.amount), 0)
  return { accruals, total }
}

export async function listPendingCommissionAccruals(session: SessionContext, providerId: string) {
  assertCan(session, "commission.view")
  const scope = getAuthorizedBranchScope(session)
  return db.commissionAccrual.findMany({
    where: { organizationId: session.user.organizationId, providerId, status: "pending", branchId: narrowBranchFilter(scope) },
    orderBy: { accruedAt: "asc" },
  })
}
