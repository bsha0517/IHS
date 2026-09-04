import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { db } from "@/lib/db"
import { createAdHocCharge } from "@/lib/domains/billing/charges"
import { generateInvoice } from "@/lib/domains/billing/invoices"
import { accrueInvoiceBasisCommissions, accruePaymentBasisCommissions } from "@/lib/domains/payroll/commissions"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P2 Batch 3 (§4, §18) — targeted performance fixes, no semantic changes.
 * See P2_REMEDIATION_REPORT.md for the full record.
 *
 * Both sections below prove two things separately, on purpose: (1) the
 * *result* is identical to what the original per-line/per-payment
 * implementation would have computed (a direct assertion against
 * hand-computed expected values, not "trust the refactor"), and (2) the
 * *query count* is now a small constant instead of growing with the
 * number of lines/payments — measured with `vi.spyOn` wrapping the real
 * model methods on the real `db` client (passthrough spies — every call
 * still hits the real database, this only counts how many round trips
 * happen), not asserted from reading the code.
 */
const TIMEOUT = 90000

describe("P2 §4: commission accrual batching — identical results, O(1) queries", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let userId: string
  const invoiceIds: string[] = []
  const chargeIds: string[] = []
  const providerIds: string[] = []
  const ruleIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-p2-batch3-commission",
      user: { id: userId, organizationId, email: "p2-batch3-commission-test@test.local", firstName: "Perf", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["charge.create", "invoice.create"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createProvider() {
    const provider = await db.provider.create({
      data: { organizationId, providerType: "doctor", firstName: "P2B3", lastName: `Provider-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    })
    providerIds.push(provider.id)
    return provider.id
  }

  async function createRule(providerId: string | null, serviceId: string | null, basis: "gross_invoice" | "collected_revenue", rate: number) {
    const rule = await db.commissionRule.create({
      data: { organizationId, providerId, serviceId, type: "percentage", basis, percentageRate: rate },
    })
    ruleIds.push(rule.id)
    return rule
  }

  /**
   * Builds an Invoice + InvoiceLines directly via `db`, deliberately NOT
   * through `generateInvoice` — generateInvoice writes an `InvoiceIssued`
   * outbox event and, still inside itself, awaits
   * `dispatchPendingOutboxEvents`, whose registered handler
   * (event-handlers.ts) calls `accrueInvoiceBasisCommissions` automatically.
   * These tests need to invoke `accrueInvoiceBasisCommissions`/
   * `accruePaymentBasisCommissions` exactly once, deterministically, to get
   * a clean query count and a single set of resulting rows to assert
   * against — going through the outbox would both double-run the accrual
   * (contaminating the "identical results" assertion with an
   * already-accrued idempotency skip) and let the dispatcher's "process
   * every pending event for this org" behavior sweep in whatever backlog
   * already exists in this shared dev database, inflating the query count
   * with unrelated work. This helper reconstructs exactly the shape
   * `accrueInvoiceBasisCommissions`/`accruePaymentBasisCommissions` read
   * (`invoice.lines[].charge`), nothing more.
   */
  async function createInvoiceDirect(charges: { id: string; amount: number; description: string; quantity: number; unitPrice: number }[]) {
    const subtotal = charges.reduce((sum, c) => sum + c.amount, 0)
    const invoice = await db.invoice.create({
      data: {
        organizationId, branchId, patientId,
        invoiceNumber: `TESTP2B3INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        subtotal, discountAmount: 0, taxAmount: 0, totalAmount: subtotal,
        createdBy: userId,
      },
    })
    for (const c of charges) {
      await db.invoiceLine.create({
        data: { invoiceId: invoice.id, chargeId: c.id, description: c.description, quantity: c.quantity, unitPrice: c.unitPrice, taxAmount: 0, lineTotal: c.amount },
      })
    }
    return invoice
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
        mrn: `TESTP2B3-${Date.now()}`, firstName: "P2Batch3", lastName: "Performance",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P2B3-${Date.now()}`,
      },
    })
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    const accruals = await db.commissionAccrual.findMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.commissionAccrual.deleteMany({ where: { id: { in: accruals.map((a) => a.id) } } })
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await db.charge.deleteMany({ where: { id: { in: chargeIds } } })
    await db.commissionRule.deleteMany({ where: { id: { in: ruleIds } } })
    await db.provider.deleteMany({ where: { id: { in: providerIds } } })
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  it(
    "resolves most-specific-wins precedence correctly across multiple providers/services on one invoice, matching hand-computed amounts, using O(1) queries regardless of line count",
    async () => {
      const providerA = await createProvider()
      const providerB = await createProvider()
      // Provider A: a provider+service-specific rule (most specific).
      await createRule(providerA, null, "gross_invoice", 0.10)
      // Provider B has no rule of its own — must fall through to the
      // org-wide default below (least specific, providerId+serviceId both null).
      await createRule(null, null, "gross_invoice", 0.05)

      const chargeA1 = await createAdHocCharge(session(), { patientId, branchId, providerId: providerA, sourceType: "procedure", description: "P2B3 A1", quantity: 1, unitPrice: 200 })
      const chargeA2 = await createAdHocCharge(session(), { patientId, branchId, providerId: providerA, sourceType: "procedure", description: "P2B3 A2", quantity: 1, unitPrice: 100 })
      const chargeB1 = await createAdHocCharge(session(), { patientId, branchId, providerId: providerB, sourceType: "procedure", description: "P2B3 B1", quantity: 1, unitPrice: 300 })
      chargeIds.push(chargeA1.id, chargeA2.id, chargeB1.id)

      const invoice = await createInvoiceDirect([
        { id: chargeA1.id, amount: 200, description: "P2B3 A1", quantity: 1, unitPrice: 200 },
        { id: chargeA2.id, amount: 100, description: "P2B3 A2", quantity: 1, unitPrice: 100 },
        { id: chargeB1.id, amount: 300, description: "P2B3 B1", quantity: 1, unitPrice: 300 },
      ])
      invoiceIds.push(invoice.id)

      const commissionRuleFindMany = vi.spyOn(db.commissionRule, "findMany")
      const commissionAccrualFindMany = vi.spyOn(db.commissionAccrual, "findMany")
      const commissionAccrualCreateMany = vi.spyOn(db.commissionAccrual, "createMany")
      const invoiceFindUniqueOrThrow = vi.spyOn(db.invoice, "findUniqueOrThrow")

      await accrueInvoiceBasisCommissions(db, invoice.id)

      const totalQueries =
        commissionRuleFindMany.mock.calls.length +
        commissionAccrualFindMany.mock.calls.length +
        commissionAccrualCreateMany.mock.calls.length +
        invoiceFindUniqueOrThrow.mock.calls.length
      // 3 lines on this invoice — the pre-refactor implementation issued up
      // to 3 queries PER LINE (2 for rule resolution + 1 existing-accrual
      // check) on top of the 1 invoice read, i.e. up to 10 for 3 lines and
      // growing linearly. The batched version is a fixed 4 regardless of
      // line count: 1 invoice read, 1 rule prefetch, 1 existing-accrual
      // prefetch, 1 bulk insert.
      expect(totalQueries).toBe(4)
      commissionRuleFindMany.mockRestore()
      commissionAccrualFindMany.mockRestore()
      commissionAccrualCreateMany.mockRestore()
      invoiceFindUniqueOrThrow.mockRestore()

      const accruals = await db.commissionAccrual.findMany({ where: { invoiceId: invoice.id }, orderBy: { basisAmount: "desc" } })
      expect(accruals).toHaveLength(3)
      // Provider A's own rule (10%) wins for both of A's charges — most
      // specific beats the org-wide default even though the org-wide rule
      // is also active.
      const aAccruals = accruals.filter((a) => a.providerId === providerA)
      expect(aAccruals.map((a) => Number(a.amount)).sort((x, y) => y - x)).toEqual([20, 10]) // 200*0.10, 100*0.10
      // Provider B has no rule of its own — falls through to the org-wide
      // 5% default.
      const bAccrual = accruals.find((a) => a.providerId === providerB)
      expect(Number(bAccrual!.amount)).toBe(15) // 300*0.05
    },
    TIMEOUT
  )

  it("is idempotent — calling accrueInvoiceBasisCommissions twice creates no duplicate rows (proves the batched existing-accrual check works, not just the per-line one it replaced)", async () => {
    const provider = await createProvider()
    await createRule(provider, null, "gross_invoice", 0.08)
    const charge = await createAdHocCharge(session(), { patientId, branchId, providerId: provider, sourceType: "procedure", description: "P2B3 idempotency", quantity: 1, unitPrice: 500 })
    chargeIds.push(charge.id)
    const invoice = await createInvoiceDirect([{ id: charge.id, amount: 500, description: "P2B3 idempotency", quantity: 1, unitPrice: 500 }])
    invoiceIds.push(invoice.id)

    await accrueInvoiceBasisCommissions(db, invoice.id)
    await accrueInvoiceBasisCommissions(db, invoice.id) // second call — must be a no-op

    const accruals = await db.commissionAccrual.findMany({ where: { invoiceId: invoice.id } })
    expect(accruals).toHaveLength(1)
    expect(Number(accruals[0].amount)).toBe(40) // 500*0.08
  })

  it("accruePaymentBasisCommissions: proportional collected-revenue accrual across multiple payments/lines matches hand-computed amounts, using O(1) queries regardless of payment/line count", async () => {
    const provider = await createProvider()
    await createRule(provider, null, "collected_revenue", 0.10)

    const charge1 = await createAdHocCharge(session(), { patientId, branchId, providerId: provider, sourceType: "procedure", description: "P2B3 collected 1", quantity: 1, unitPrice: 600 })
    const charge2 = await createAdHocCharge(session(), { patientId, branchId, providerId: provider, sourceType: "procedure", description: "P2B3 collected 2", quantity: 1, unitPrice: 400 })
    chargeIds.push(charge1.id, charge2.id)
    const invoice = await createInvoiceDirect([
      { id: charge1.id, amount: 600, description: "P2B3 collected 1", quantity: 1, unitPrice: 600 },
      { id: charge2.id, amount: 400, description: "P2B3 collected 2", quantity: 1, unitPrice: 400 },
    ])
    invoiceIds.push(invoice.id)
    // subtotal = 1000 (600 + 400): charge1 is 60% of it, charge2 is 40%.

    const payment1 = await db.payment.create({
      data: { organizationId, branchId, receiptNumber: `TESTP2B3PAY1-${Date.now()}`, method: "cash", amount: 300, receivedBy: userId },
    })
    const payment2 = await db.payment.create({
      data: { organizationId, branchId, receiptNumber: `TESTP2B3PAY2-${Date.now()}`, method: "cash", amount: 200, receivedBy: userId },
    })

    const commissionRuleFindMany = vi.spyOn(db.commissionRule, "findMany")
    const commissionAccrualFindMany = vi.spyOn(db.commissionAccrual, "findMany")
    const commissionAccrualCreateMany = vi.spyOn(db.commissionAccrual, "createMany")
    const paymentFindMany = vi.spyOn(db.payment, "findMany")
    const invoiceFindUniqueOrThrow = vi.spyOn(db.invoice, "findUniqueOrThrow")

    await accruePaymentBasisCommissions(db, invoice.id, [payment1.id, payment2.id])

    const totalQueries =
      commissionRuleFindMany.mock.calls.length +
      commissionAccrualFindMany.mock.calls.length +
      commissionAccrualCreateMany.mock.calls.length +
      paymentFindMany.mock.calls.length +
      invoiceFindUniqueOrThrow.mock.calls.length
    // 2 payments x 2 lines = 4 (payment, line) pairs — the original audit's
    // own literal example: up to 3 queries PER PAIR (2 for rule resolution
    // + 1 existing-accrual check), on top of 2 queries already batched
    // (invoice read, payment read) = up to 14 for this scenario, growing
    // as payments x lines. The batched version is a fixed 5 regardless:
    // 1 invoice read, 1 payment read, 1 rule prefetch, 1 existing-accrual
    // prefetch, 1 bulk insert.
    expect(totalQueries).toBe(5)
    commissionRuleFindMany.mockRestore()
    commissionAccrualFindMany.mockRestore()
    commissionAccrualCreateMany.mockRestore()
    paymentFindMany.mockRestore()
    invoiceFindUniqueOrThrow.mockRestore()

    const accruals = await db.commissionAccrual.findMany({ where: { invoiceId: invoice.id } })
    expect(accruals).toHaveLength(4) // 2 payments x 2 lines
    const byPaymentAndCharge = new Map(accruals.map((a) => [`${a.paymentId}:${a.chargeId}`, Number(a.amount)]))
    // payment1 (300): charge1 gets 60% of it (180) x 10% rate = 18; charge2 gets 40% (120) x 10% = 12.
    expect(byPaymentAndCharge.get(`${payment1.id}:${charge1.id}`)).toBeCloseTo(18, 5)
    expect(byPaymentAndCharge.get(`${payment1.id}:${charge2.id}`)).toBeCloseTo(12, 5)
    // payment2 (200): charge1 gets 60% (120) x 10% = 12; charge2 gets 40% (80) x 10% = 8.
    expect(byPaymentAndCharge.get(`${payment2.id}:${charge1.id}`)).toBeCloseTo(12, 5)
    expect(byPaymentAndCharge.get(`${payment2.id}:${charge2.id}`)).toBeCloseTo(8, 5)

    await db.payment.deleteMany({ where: { id: { in: [payment1.id, payment2.id] } } })
  }, TIMEOUT)
})

describe("P2 §18: invoice tax-rate prefetch — identical totals, O(1) queries", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let userId: string
  const invoiceIds: string[] = []
  const chargeIds: string[] = []
  const taxRuleIds: string[] = []
  const serviceIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-p2-batch3-tax",
      user: { id: userId, organizationId, email: "p2-batch3-tax-test@test.local", firstName: "Perf", lastName: "Tax" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["charge.create", "invoice.create"]),
      roleNames: ["Super Admin"],
    }
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
        mrn: `TESTP2B3TAX-${Date.now()}`, firstName: "P2Batch3", lastName: "Tax",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P2B3TAX-${Date.now()}`,
      },
    })
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await db.charge.deleteMany({ where: { id: { in: chargeIds } } })
    await db.taxRule.deleteMany({ where: { id: { in: taxRuleIds } } })
    await db.service.deleteMany({ where: { id: { in: serviceIds } } })
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("resolves specific-rule -> org-default -> zero precedence correctly across mixed-service lines, matching hand-computed totals, using O(1) queries regardless of line count", async () => {
    // Service A: its own specific 10% rule. Service B: no rule of its own
    // -> falls through to the org default. A third line has no serviceId
    // at all (an ad-hoc, service-less charge) -> also falls through to the
    // org default (getTaxRate's own documented behavior, unchanged).
    const serviceA = await db.service.create({ data: { organizationId, code: `TESTP2B3SVCA-${Date.now()}`, name: "P2B3 Service A", category: "test", durationMinutes: 30, price: 0 } })
    const serviceB = await db.service.create({ data: { organizationId, code: `TESTP2B3SVCB-${Date.now()}`, name: "P2B3 Service B", category: "test", durationMinutes: 30, price: 0 } })
    serviceIds.push(serviceA.id, serviceB.id)

    const ruleA = await db.taxRule.create({ data: { organizationId, name: "P2B3 specific A", rate: 0.10, serviceId: serviceA.id, isActive: true } })
    const orgDefault = await db.taxRule.create({ data: { organizationId, name: "P2B3 org default", rate: 0.05, isDefault: true, isActive: true } })
    taxRuleIds.push(ruleA.id, orgDefault.id)

    const chargeA = await createAdHocCharge(session(), { patientId, branchId, serviceId: serviceA.id, sourceType: "procedure", description: "P2B3 tax A", quantity: 1, unitPrice: 200 })
    const chargeB = await createAdHocCharge(session(), { patientId, branchId, serviceId: serviceB.id, sourceType: "procedure", description: "P2B3 tax B", quantity: 1, unitPrice: 100 })
    const chargeNoService = await createAdHocCharge(session(), { patientId, branchId, sourceType: "other", description: "P2B3 tax no-service", quantity: 1, unitPrice: 50 })
    chargeIds.push(chargeA.id, chargeB.id, chargeNoService.id)

    const taxRuleFindMany = vi.spyOn(db.taxRule, "findMany")
    const taxRuleFindFirst = vi.spyOn(db.taxRule, "findFirst")

    const invoice = await generateInvoice(session(), { patientId, branchId, chargeIds: [chargeA.id, chargeB.id, chargeNoService.id], discountAmount: 0 })
    invoiceIds.push(invoice.id)

    const totalTaxQueries = taxRuleFindMany.mock.calls.length + taxRuleFindFirst.mock.calls.length
    // 3 lines — the pre-refactor getTaxRate() issued up to 2 queries PER
    // LINE (a specific-rule check, then an org-default check), i.e. up to
    // 6 for this invoice and growing linearly with line count. The batched
    // prefetch is a fixed 2 regardless: 1 for every distinct service's
    // specific rules, 1 for the org-wide default.
    expect(totalTaxQueries).toBe(2)
    taxRuleFindMany.mockRestore()
    taxRuleFindFirst.mockRestore()

    // A: 200 * 10% = 20 (specific rule). B: 100 * 5% = 5 (org default,
    // since B has no rule of its own). No-service: 50 * 5% = 2.5 (org
    // default, same as getTaxRate's original null-serviceId path).
    expect(Number(invoice.taxAmount)).toBeCloseTo(27.5, 5)
    expect(Number(invoice.totalAmount)).toBeCloseTo(200 + 100 + 50 + 27.5, 5)

    const lines = await db.invoiceLine.findMany({ where: { invoiceId: invoice.id }, include: { charge: true } })
    const lineA = lines.find((l) => l.charge.id === chargeA.id)!
    const lineB = lines.find((l) => l.charge.id === chargeB.id)!
    const lineNoService = lines.find((l) => l.charge.id === chargeNoService.id)!
    expect(Number(lineA.taxAmount)).toBeCloseTo(20, 5)
    expect(Number(lineB.taxAmount)).toBeCloseTo(5, 5)
    expect(Number(lineNoService.taxAmount)).toBeCloseTo(2.5, 5)
  }, TIMEOUT)

  it("no TaxRule configured at all (including no default) still correctly means 0% tax, not a fabricated fallback", async () => {
    // A dedicated org-free-of-tax-rules scenario would require a second
    // organization fixture; instead, exercise the "no default, only a
    // service-specific rule for a DIFFERENT service" case, which exercises
    // the identical "no applicable rule found -> zero" code path
    // `getTaxRate` always used for a service with nothing configured.
    const serviceC = await db.service.create({ data: { organizationId, code: `TESTP2B3SVCC-${Date.now()}`, name: "P2B3 Service C", category: "test", durationMinutes: 30, price: 0 } })
    serviceIds.push(serviceC.id)
    const chargeC = await createAdHocCharge(session(), { patientId, branchId, serviceId: serviceC.id, sourceType: "procedure", description: "P2B3 tax C (no matching rule)", quantity: 1, unitPrice: 80 })
    chargeIds.push(chargeC.id)

    // Deactivate the org default from the previous test so this scenario
    // genuinely has zero applicable rules, matching "no TaxRule at all".
    await db.taxRule.updateMany({ where: { id: { in: taxRuleIds }, isDefault: true }, data: { isActive: false } })

    const invoice = await generateInvoice(session(), { patientId, branchId, chargeIds: [chargeC.id], discountAmount: 0 })
    invoiceIds.push(invoice.id)
    expect(Number(invoice.taxAmount)).toBe(0)
    expect(Number(invoice.totalAmount)).toBe(80)

    // restore for anything else sharing this dev org's tax rules
    await db.taxRule.updateMany({ where: { id: { in: taxRuleIds }, isDefault: true }, data: { isActive: true } })
  }, TIMEOUT)
})
