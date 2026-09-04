import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { createAdHocCharge } from "@/lib/domains/billing/charges"
import { generateInvoice } from "@/lib/domains/billing/invoices"
import { recordPayment } from "@/lib/domains/billing/payments"
import { requestRefund, authorizeRefund, completeRefund } from "@/lib/domains/billing/refunds"
import { getProviderStatement, reverseCommissionsForRefund } from "@/lib/domains/payroll/commissions"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §19: provider commission follows its configured basis (gross/net
 * invoice vs collected revenue), and a later refund adjusts commission
 * per policy rather than silently leaving it overpaid —
 * P1_FINANCIAL_INTEGRITY_FINDINGS.md's B11. See reverseCommissionsForRefund's
 * own doc comment (commissions.ts) for why gross/net-invoice basis is
 * deliberately left untouched (the "follow configured policy" branch) while
 * collected_revenue basis is reversed proportionally.
 *
 * Each test gets its own fresh Provider (never a shared one) — resolveCommissionRule
 * (commissions.ts) resolves the single best-matching *active* rule for a
 * (providerId, serviceId) pair without discriminating on basis, so two
 * simultaneously-active rules for the same provider (one gross, one
 * collected) would make resolution non-deterministic. One provider per test
 * keeps each test's rule the only one in scope for that provider, sidestepping
 * the ambiguity entirely rather than deactivating rules between tests.
 */
const TIMEOUT = 60000

describe("P1 §19: provider commission basis and refund reversal", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let cashierSessionId: string
  let userId: string
  const invoiceIds: string[] = []
  const commissionRuleIds: string[] = []
  const providerIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-commission-refund",
      user: { id: userId, organizationId, email: "commission-refund-test@test.local", firstName: "Commission", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["charge.create", "invoice.create", "payment.create", "refund.request", "refund.authorize", "commission.view"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createProvider() {
    const provider = await db.provider.create({
      data: { organizationId, providerType: "doctor", firstName: "Commission", lastName: `TestProvider-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    })
    providerIds.push(provider.id)
    return provider.id
  }

  async function createRule(providerId: string, basis: "gross_invoice" | "net_invoice" | "collected_revenue", rate: number) {
    const rule = await db.commissionRule.create({
      data: { organizationId, providerId, type: "percentage", basis, percentageRate: rate },
    })
    commissionRuleIds.push(rule.id)
    return rule
  }

  async function chargeInvoiceAndPay(providerId: string, amount: number, paidAmount: number) {
    const charge = await createAdHocCharge(session(), {
      patientId, branchId, providerId, sourceType: "procedure", description: "Commission test charge", quantity: 1, unitPrice: amount,
    })
    const invoice = await generateInvoice(session(), { patientId, branchId, providerId, chargeIds: [charge.id], discountAmount: 0 })
    invoiceIds.push(invoice.id)
    let payment
    if (paidAmount > 0) {
      const payments = await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: paidAmount }] })
      payment = payments[0]
    }
    return { charge, invoice, payment }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTCOMM-${Date.now()}`, firstName: "Commission", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `CI${Date.now()}`,
      },
    })
    patientId = patient.id

    const cashierSession = await db.cashierSession.create({
      data: { organizationId, branchId, cashierUserId: userId, openingCash: 0, status: "open" },
    })
    cashierSessionId = cashierSession.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.commissionAccrual.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    // P3.13: a "payment" journal's referenceId is the Payment's own id, not
    // the invoice's (posting-service.ts's postPaymentReceived, fixed this
    // batch) — resolve the real payment ids first so this cleanup still
    // finds them.
    const paymentIds = (await db.payment.findMany({ where: { allocations: { some: { invoiceId: { in: invoiceIds } } } }, select: { id: true } })).map((p) => p.id)
    const journals = await db.journal.findMany({
      where: {
        organizationId,
        OR: [{ referenceType: "invoice", referenceId: { in: invoiceIds } }, { referenceType: "payment", referenceId: { in: paymentIds } }, { referenceType: "refund" }],
      },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.refund.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.paymentAllocation.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    const payments = await db.payment.findMany({ where: { cashierSessionId } })
    await db.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } })
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    // By patientId, not by (now-deleted) invoiceLine relation — this test
    // file's patient is exclusive to it, so this is a safe, simple way to
    // catch every charge regardless of invoicing status.
    await db.charge.deleteMany({ where: { patientId } })
    await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await db.commissionRule.deleteMany({ where: { id: { in: commissionRuleIds } } })
    await db.cashierSession.delete({ where: { id: cashierSessionId } })
    await db.patient.delete({ where: { id: patientId } })
    await db.provider.deleteMany({ where: { id: { in: providerIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("gross_invoice basis accrues at invoice-issue time, at the full billed amount, independent of collection", async () => {
    const providerId = await createProvider()
    await createRule(providerId, "gross_invoice", 0.2)
    const { invoice } = await chargeInvoiceAndPay(providerId, 1000, 0) // billed but never paid

    const accrual = await db.commissionAccrual.findFirstOrThrow({ where: { invoiceId: invoice.id, providerId } })
    expect(Number(accrual.amount)).toBe(200) // 20% of 1000, even though nothing was collected yet
    expect(accrual.paymentId).toBeNull()
  }, TIMEOUT)

  it("collected_revenue basis accrues only what a specific payment actually collected, proportional to the invoice", async () => {
    const providerId = await createProvider()
    await createRule(providerId, "collected_revenue", 0.2)
    const { invoice, payment } = await chargeInvoiceAndPay(providerId, 1000, 500) // patient pays half

    const accrual = await db.commissionAccrual.findFirstOrThrow({ where: { invoiceId: invoice.id, providerId, paymentId: payment!.id } })
    expect(Number(accrual.basisAmount)).toBe(500) // proportional collected amount
    expect(Number(accrual.amount)).toBe(100) // 20% of the 500 actually collected — not 20% of 1000
  }, TIMEOUT)

  it("a full refund of a collected_revenue payment fully reverses its commission — net commission ends at zero, not silently overpaid", async () => {
    const providerId = await createProvider()
    await createRule(providerId, "collected_revenue", 0.2)
    const { invoice, payment } = await chargeInvoiceAndPay(providerId, 800, 800)

    const original = await db.commissionAccrual.findFirstOrThrow({ where: { invoiceId: invoice.id, providerId, paymentId: payment!.id } })
    expect(Number(original.amount)).toBe(160) // 20% of 800

    const refund = await requestRefund(session(), { invoiceId: invoice.id, paymentId: payment!.id, method: "cash", amount: 800, reason: "full refund test" })
    await authorizeRefund(session(), refund.id)
    await completeRefund(session(), refund.id, cashierSessionId)

    const reversal = await db.commissionAccrual.findFirstOrThrow({ where: { refundId: refund.id, chargeId: original.chargeId } })
    expect(Number(reversal.amount)).toBe(-160) // exact mirror — never edits/deletes the original
    expect(reversal.paymentId).toBeNull()

    const stillOriginal = await db.commissionAccrual.findUniqueOrThrow({ where: { id: original.id } })
    expect(Number(stillOriginal.amount)).toBe(160) // untouched

    const statement = await getProviderStatement(session(), providerId, { from: new Date("2000-01-01"), to: new Date("2100-01-01") })
    const netForThisInvoice = statement.accruals.filter((a) => a.invoiceId === invoice.id).reduce((sum, a) => sum + Number(a.amount), 0)
    expect(netForThisInvoice).toBe(0) // 160 earned, 160 clawed back — never left overpaid
  }, TIMEOUT)

  it("a partial refund reverses commission proportionally, not the full amount", async () => {
    const providerId = await createProvider()
    await createRule(providerId, "collected_revenue", 0.1)
    const { invoice, payment } = await chargeInvoiceAndPay(providerId, 1000, 1000)

    const original = await db.commissionAccrual.findFirstOrThrow({ where: { invoiceId: invoice.id, providerId, paymentId: payment!.id } })
    expect(Number(original.amount)).toBe(100) // 10% of 1000

    const refund = await requestRefund(session(), { invoiceId: invoice.id, paymentId: payment!.id, method: "cash", amount: 250, reason: "partial refund test" })
    await authorizeRefund(session(), refund.id)
    await completeRefund(session(), refund.id, cashierSessionId)

    const reversal = await db.commissionAccrual.findFirstOrThrow({ where: { refundId: refund.id, chargeId: original.chargeId } })
    expect(Number(reversal.amount)).toBe(-25) // 250/1000 = 25% of the 100 commission reversed
  }, TIMEOUT)

  it("gross_invoice basis commission is NOT reversed by a refund — deliberate configured-policy behavior, not an oversight", async () => {
    const providerId = await createProvider()
    await createRule(providerId, "gross_invoice", 0.15)
    const { invoice, payment } = await chargeInvoiceAndPay(providerId, 600, 600)

    const original = await db.commissionAccrual.findFirstOrThrow({ where: { invoiceId: invoice.id, providerId, paymentId: null } })
    expect(Number(original.amount)).toBe(90) // 15% of 600

    const refund = await requestRefund(session(), { invoiceId: invoice.id, paymentId: payment!.id, method: "cash", amount: 600, reason: "full refund, gross-basis" })
    await authorizeRefund(session(), refund.id)
    await completeRefund(session(), refund.id, cashierSessionId)

    const reversal = await db.commissionAccrual.findFirst({ where: { invoiceId: invoice.id, providerId, refundId: { not: null } } })
    expect(reversal).toBeNull() // no reversal row — gross_invoice basis is untouched by a refund

    const stillOriginal = await db.commissionAccrual.findUniqueOrThrow({ where: { id: original.id } })
    expect(Number(stillOriginal.amount)).toBe(90) // unchanged
  }, TIMEOUT)

  it("idempotency: replaying the reversal for the same refund never double-reverses", async () => {
    const providerId = await createProvider()
    await createRule(providerId, "collected_revenue", 0.2)
    const { invoice, payment } = await chargeInvoiceAndPay(providerId, 500, 500)
    const original = await db.commissionAccrual.findFirstOrThrow({ where: { invoiceId: invoice.id, providerId, paymentId: payment!.id } })

    const refund = await requestRefund(session(), { invoiceId: invoice.id, paymentId: payment!.id, method: "cash", amount: 500, reason: "idempotency test" })
    await authorizeRefund(session(), refund.id)
    await completeRefund(session(), refund.id, cashierSessionId) // fires reverseCommissionsForRefund once via the outbox

    // Simulated redelivery of the same RefundCompleted event.
    await db.$transaction((tx) => reverseCommissionsForRefund(tx, refund.id))
    await db.$transaction((tx) => reverseCommissionsForRefund(tx, refund.id))

    const reversals = await db.commissionAccrual.findMany({ where: { refundId: refund.id, chargeId: original.chargeId } })
    expect(reversals.length).toBe(1) // exactly one reversal row despite three total invocations
    expect(Number(reversals[0].amount)).toBe(-100) // 20% of 500, reversed exactly once
  }, TIMEOUT)

  it("a refund not tied to a specific payment spreads proportionally across the invoice's payments", async () => {
    const providerId = await createProvider()
    await createRule(providerId, "collected_revenue", 0.1)
    const charge = await createAdHocCharge(session(), {
      patientId, branchId, providerId, sourceType: "procedure", description: "Multi-payment commission test", quantity: 1, unitPrice: 1000,
    })
    const invoice = await generateInvoice(session(), { patientId, branchId, providerId, chargeIds: [charge.id], discountAmount: 0 })
    invoiceIds.push(invoice.id)
    // Two separate payments: 600 then 400.
    await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: 600 }] })
    await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: 400 }] })

    const originals = await db.commissionAccrual.findMany({ where: { invoiceId: invoice.id, providerId, paymentId: { not: null } } })
    expect(originals.length).toBe(2)
    const totalOriginal = originals.reduce((sum, a) => sum + Number(a.amount), 0)
    expect(totalOriginal).toBe(100) // 10% of 1000 collected across both payments

    // Refund 500 with no specific paymentId — spread proportionally (60%/40%) across both payments.
    const refund = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 500, reason: "invoice-level refund, no specific payment" })
    await authorizeRefund(session(), refund.id)
    await completeRefund(session(), refund.id, cashierSessionId)

    const reversals = await db.commissionAccrual.findMany({ where: { refundId: refund.id, invoiceId: invoice.id } })
    const totalReversed = reversals.reduce((sum, a) => sum + Number(a.amount), 0)
    expect(totalReversed).toBeCloseTo(-50, 5) // 500/1000 = 50% of the 100 total commission reversed, split across both payments' shares
    // Two sequential recordPayment calls plus a full refund cycle — the most
    // sequential DB round trips of any test in this file. A real P1 Batch 6
    // full-suite run caught this one genuinely exceeding the shared 60s
    // TIMEOUT under real Supabase latency, the same "widen this one test,
    // not the file-wide default" precedent refund-payment-integrity.test.ts's
    // own multi-refund test already established.
  }, 120000)
})
