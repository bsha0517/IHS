import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import type { SessionContext } from "@/lib/auth/session"
import type { GenerateInvoiceInput } from "@/lib/domains/billing/schemas"

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
 */
async function getTaxRate(organizationId: string, serviceId: string | null): Promise<Decimal> {
  if (serviceId) {
    const specific = await db.taxRule.findFirst({
      where: { organizationId, serviceId, isActive: true },
    })
    if (specific) return new Decimal(specific.rate)
  }
  const defaultRule = await db.taxRule.findFirst({
    where: { organizationId, isDefault: true, isActive: true },
  })
  return defaultRule ? new Decimal(defaultRule.rate) : new Decimal(0)
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

  const charges = await db.charge.findMany({
    where: {
      id: { in: input.chargeIds },
      organizationId: session.user.organizationId,
      patientId: input.patientId,
      status: "pending",
    },
  })
  if (charges.length !== input.chargeIds.length) {
    throw new Error("One or more selected charges are no longer pending — refresh and try again.")
  }
  if (input.discountAmount > 0) {
    assertCan(session, "invoice.discount", { branchId: input.branchId })
  }

  const lineComputations = await Promise.all(
    charges.map(async (charge) => {
      const rate = await getTaxRate(session.user.organizationId, charge.serviceId)
      const amount = new Decimal(charge.amount)
      const tax = amount.mul(rate).toDecimalPlaces(2)
      return { charge, tax, lineTotal: amount.add(tax) }
    })
  )

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
      await tx.charge.update({ where: { id: charge.id }, data: { status: "invoiced" } })
    }

    await writeOutboxEvent(tx, {
      organizationId: session.user.organizationId,
      eventType: "InvoiceIssued",
      payload: { invoiceId: created.id, patientId: created.patientId, totalAmount: Number(totalAmount) },
    })

    return created
  })

  await auditFromSession(session, "create", "invoice", invoice.id, {
    new: { invoiceNumber: invoice.invoiceNumber, totalAmount: Number(totalAmount) },
  })
  await dispatchPendingOutboxEvents(session.user.organizationId)

  return invoice
}

export async function getInvoice(session: SessionContext, id: string) {
  assertCan(session, "invoice.view")
  return db.invoice.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: INVOICE_INCLUDE,
  })
}

export async function listInvoices(
  session: SessionContext,
  filters: { patientId?: string; status?: string; branchId?: string } = {}
) {
  assertCan(session, "invoice.view")
  return db.invoice.findMany({
    where: {
      organizationId: session.user.organizationId,
      patientId: filters.patientId,
      status: filters.status as never,
      branchId: filters.branchId,
    },
    include: { patient: true, branch: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
}

/** Backs the Receivables page (spec.md §56) — every invoice still owed money, oldest first. */
export async function listOutstandingInvoices(session: SessionContext, filters: { branchId?: string } = {}) {
  assertCan(session, "invoice.view")
  return db.invoice.findMany({
    where: {
      organizationId: session.user.organizationId,
      branchId: filters.branchId,
      status: { in: ["issued", "partially_paid"] },
    },
    include: { patient: true, branch: true },
    orderBy: { issuedAt: "asc" },
  })
}

export async function listPatientInvoices(session: SessionContext, patientId: string) {
  assertCan(session, "invoice.view")
  return db.invoice.findMany({
    where: { organizationId: session.user.organizationId, patientId },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  })
}

/** Never deletes — voiding is a status flag, and every consumed Charge reverts to pending so it can be re-invoiced. */
export async function voidInvoice(session: SessionContext, id: string, reason: string) {
  assertCan(session, "invoice.void")

  const invoice = await db.invoice.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { lines: true },
  })
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
    return tx.invoice.update({ where: { id }, data: { status: "void", voidReason: reason } })
  })

  await auditFromSession(session, "void", "invoice", id, { old: invoice, new: { status: "void", reason } })
  return updated
}
