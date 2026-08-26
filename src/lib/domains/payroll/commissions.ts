import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
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

/** Most-specific-wins: (provider, service) > (provider, null) > (null, service) > (null, null) org default. */
async function resolveCommissionRule(tx: Db, organizationId: string, providerId: string, serviceId: string | null) {
  const rules = await tx.commissionRule.findMany({ where: { organizationId, providerId, isActive: true } })
  const orgRules = providerId ? await tx.commissionRule.findMany({ where: { organizationId, providerId: null, isActive: true } }) : []
  const candidates = [...rules, ...orgRules]

  return (
    candidates.find((r) => r.providerId === providerId && r.serviceId === serviceId) ??
    candidates.find((r) => r.providerId === providerId && r.serviceId === null) ??
    candidates.find((r) => r.providerId === null && r.serviceId === serviceId) ??
    candidates.find((r) => r.providerId === null && r.serviceId === null) ??
    null
  )
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

  for (const line of invoice.lines) {
    if (!line.charge.providerId) continue
    const rule = await resolveCommissionRule(tx, invoice.organizationId, line.charge.providerId, line.charge.serviceId)
    if (!rule || rule.basis === "collected_revenue") continue

    const existing = await tx.commissionAccrual.findFirst({ where: { chargeId: line.chargeId, paymentId: null } })
    if (existing) continue

    const basisAmount = rule.basis === "gross_invoice" ? Number(line.lineTotal) : Number(line.charge.amount)
    const amount = computeAmount(rule, basisAmount)
    if (amount <= 0) continue

    await tx.commissionAccrual.create({
      data: {
        organizationId: invoice.organizationId,
        branchId: invoice.branchId,
        providerId: line.charge.providerId,
        chargeId: line.chargeId,
        invoiceId: invoice.id,
        paymentId: null,
        commissionRuleId: rule.id,
        basisAmount: new Decimal(basisAmount),
        amount: new Decimal(amount),
      },
    })
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

  for (const payment of payments) {
    for (const line of invoice.lines) {
      if (!line.charge.providerId) continue
      const rule = await resolveCommissionRule(tx, invoice.organizationId, line.charge.providerId, line.charge.serviceId)
      if (!rule || rule.basis !== "collected_revenue") continue

      const existing = await tx.commissionAccrual.findFirst({ where: { chargeId: line.chargeId, paymentId: payment.id } })
      if (existing) continue

      const proportionalCollected = (Number(line.charge.amount) / subtotal) * Number(payment.amount)
      const amount = computeAmount(rule, proportionalCollected)
      if (amount <= 0) continue

      await tx.commissionAccrual.create({
        data: {
          organizationId: invoice.organizationId,
          branchId: invoice.branchId,
          providerId: line.charge.providerId,
          chargeId: line.chargeId,
          invoiceId: invoice.id,
          paymentId: payment.id,
          commissionRuleId: rule.id,
          basisAmount: new Decimal(proportionalCollected),
          amount: new Decimal(amount),
        },
      })
    }
  }
}

/** Provider commission statement (spec.md §53) — computed live from CommissionAccrual, never a stored running total. */
export async function getProviderStatement(session: SessionContext, providerId: string, filters: { from?: Date; to?: Date } = {}) {
  assertCan(session, "commission.view")
  const accruals = await db.commissionAccrual.findMany({
    where: {
      organizationId: session.user.organizationId,
      providerId,
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
  return db.commissionAccrual.findMany({
    where: { organizationId: session.user.organizationId, providerId, status: "pending" },
    orderBy: { accruedAt: "asc" },
  })
}
