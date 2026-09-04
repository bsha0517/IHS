import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { Decimal } from "@prisma/client/runtime/client"
import { generateInvoice, voidInvoice, applyPaymentAtomically } from "@/lib/domains/billing/invoices"
import { recordPayment } from "@/lib/domains/billing/payments"
import { requestRefund, authorizeRefund, completeRefund } from "@/lib/domains/billing/refunds"
import { getPatientStatement } from "@/lib/domains/billing/statement"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §36: the patient financial statement (`getPatientStatement`,
 * billing/statement.ts) shows invoices, payments (including an
 * insurance-tender one, labeled distinctly), payment allocations, refunds,
 * and a running balance that reconciles to the same AR figure
 * (`Invoice.totalAmount - paidAmount`, summed) as everywhere else in this
 * codebase computes it — proven against a real chain of transactions, not
 * asserted in the abstract.
 */
const TIMEOUT = 60000

describe("P1 §36: patient financial statement reconciles to AR", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let userId: string
  // Nullable and only ever set right after their own successful create —
  // afterAll checks each individually before touching it, so a
  // beforeAll failure partway through can never leave a later cleanup step
  // running with an unset id and silently falling back to an unscoped
  // (matches-everything) query. A real version of exactly that mistake — a
  // stale `payorId` making `insurancePlan.findMany({ where: { payorId:
  // undefined } })` return every plan org-wide — surfaced while writing
  // this file; caught before it reached a shared environment, but the
  // pattern below is the actual fix, not just a close call to remember.
  let cashierSessionId: string | null = null
  let payorId: string | null = null
  let insurancePlanId: string | null = null
  let policyId: string | null = null
  let patientCoverageId: string | null = null
  const chargeIds: string[] = []
  const invoiceIds: string[] = []
  const claimIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-patient-statement-reconciliation",
      user: { id: userId, organizationId, email: "patient-statement-test@test.local", firstName: "Statement", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set([
        "charge.create", "invoice.create", "invoice.view", "invoice.void", "payment.create", "payment.view",
        "refund.request", "refund.authorize", "cashier.open",
      ]),
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
        mrn: `TESTSTMT-${Date.now()}`, firstName: "Statement", lastName: "Reconciliation",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `ST${Date.now()}`,
      },
    })
    patientId = patient.id

    // Created directly rather than via openSession() — see
    // report-reconciliation.test.ts's identical comment for why.
    const cashierSession = await db.cashierSession.create({
      data: { organizationId, branchId, cashierUserId: userId, openingCash: 0, status: "open" },
    })
    cashierSessionId = cashierSession.id

    // Minimal insurance chain — just enough for one Payment.claimId to
    // point at a real Claim, to prove the statement labels that payment as
    // insurance rather than testing the full submit/adjudicate/remit
    // workflow (already covered elsewhere).
    const payor = await db.payor.create({ data: { organizationId, code: `TESTSTMTPAYOR-${Date.now()}`, name: "Statement Test Payor", payorType: "insurance_company" } })
    payorId = payor.id
    const plan = await db.insurancePlan.create({ data: { organizationId, payorId, code: `TESTSTMTPLAN-${Date.now()}`, name: "Statement Test Plan" } })
    insurancePlanId = plan.id
    const policy = await db.policy.create({ data: { organizationId, insurancePlanId: plan.id, policyNumber: `TESTSTMTPOL-${Date.now()}` } })
    policyId = policy.id
    const coverage = await db.patientCoverage.create({ data: { organizationId, patientId, policyId: policy.id, memberId: `TESTSTMTMEM-${Date.now()}`, startDate: new Date("2020-01-01") } })
    patientCoverageId = coverage.id
  }, TIMEOUT)

  afterAll(async () => {
    // P3.13: a "payment" journal's referenceId is the Payment's own id, not
    // the invoice's (posting-service.ts's postPaymentReceived, fixed this
    // batch) — resolve the real payment ids first so this cleanup still finds them.
    const paymentIds = (await db.payment.findMany({ where: { allocations: { some: { invoiceId: { in: invoiceIds } } } }, select: { id: true } })).map((p) => p.id)
    const journals = await db.journal.findMany({
      where: {
        organizationId,
        OR: [
          { referenceType: { in: ["invoice", "invoice_void", "refund"] }, referenceId: { in: invoiceIds } },
          { referenceType: "payment", referenceId: { in: paymentIds } },
        ],
      },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })

    await db.claim.deleteMany({ where: { id: { in: claimIds } } })
    const refunds = await db.refund.findMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.refund.deleteMany({ where: { id: { in: refunds.map((r) => r.id) } } })
    const paymentAllocations = await db.paymentAllocation.findMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.paymentAllocation.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.payment.deleteMany({ where: { id: { in: paymentAllocations.map((a) => a.paymentId) } } })
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await db.charge.deleteMany({ where: { id: { in: chargeIds } } })
    // Each step below only ever runs against an id THIS file's own beforeAll
    // actually assigned — never a query scoped by a possibly-unset variable.
    if (patientCoverageId) await db.patientCoverage.delete({ where: { id: patientCoverageId } }).catch(() => {})
    if (policyId) await db.policy.delete({ where: { id: policyId } }).catch(() => {})
    if (insurancePlanId) await db.insurancePlan.delete({ where: { id: insurancePlanId } }).catch(() => {})
    if (payorId) await db.payor.delete({ where: { id: payorId } }).catch(() => {})
    if (cashierSessionId) await db.cashierSession.delete({ where: { id: cashierSessionId } }).catch(() => {})
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("invoices, a cash payment, an insurance-tender payment, and a partial refund all reconcile to the same outstanding-balance figure", async () => {
    // Invoice A: 500, paid 400 cash, then 150 refunded — outstanding ends at 250.
    const chargeA = await db.charge.create({
      data: { organizationId, branchId, patientId, sourceType: "other", description: "Statement test charge A", quantity: 1, unitPrice: 500, amount: 500, status: "pending" },
    })
    chargeIds.push(chargeA.id)
    const invoiceA = await generateInvoice(session(), { patientId, branchId, chargeIds: [chargeA.id], discountAmount: 0 })
    invoiceIds.push(invoiceA.id)

    // Non-null: beforeAll assigns this before the it() block ever runs — if
    // it threw before assigning, vitest never runs this test at all.
    const cashierSessionIdForTest = cashierSessionId!
    const [paymentA] = await recordPayment(session(), { invoiceId: invoiceA.id, cashierSessionId: cashierSessionIdForTest, tenders: [{ method: "cash", amount: 400 }] })

    const requested = await requestRefund(session(), { invoiceId: invoiceA.id, paymentId: paymentA.id, method: "cash", amount: 150, reason: "statement reconciliation test" })
    await authorizeRefund(session(), requested.id)
    await completeRefund(session(), requested.id, cashierSessionIdForTest)

    // Invoice B: 300, paid in full via an insurance-tender payment — outstanding ends at 0.
    const chargeB = await db.charge.create({
      data: { organizationId, branchId, patientId, sourceType: "other", description: "Statement test charge B", quantity: 1, unitPrice: 300, amount: 300, status: "pending" },
    })
    chargeIds.push(chargeB.id)
    const invoiceB = await generateInvoice(session(), { patientId, branchId, chargeIds: [chargeB.id], discountAmount: 0 })
    invoiceIds.push(invoiceB.id)

    const claim = await db.claim.create({
      data: {
        organizationId, branchId, patientId, patientCoverageId: patientCoverageId!, payorId: payorId!, invoiceId: invoiceB.id,
        claimNumber: `TESTSTMTCLM-${Date.now()}`, status: "adjudicated", submittedAmount: 300, approvedAmount: 300,
      },
    })
    claimIds.push(claim.id)
    await db.$transaction(async (tx) => {
      await applyPaymentAtomically(tx, invoiceB.id, new Decimal(300))
      const insurancePayment = await tx.payment.create({
        data: { organizationId, branchId, receiptNumber: `TESTSTMTPAY-${Date.now()}`, method: "insurance", amount: 300, claimId: claim.id, receivedBy: userId },
      })
      await tx.paymentAllocation.create({ data: { paymentId: insurancePayment.id, invoiceId: invoiceB.id, amount: 300 } })
    })

    // Invoice C: created then immediately voided (no payment ever applied)
    // — must not appear in the statement at all, and must not affect the
    // reconciled balance, per voidInvoice's own "never voidable once paid" guarantee.
    const chargeC = await db.charge.create({
      data: { organizationId, branchId, patientId, sourceType: "other", description: "Statement test charge C (voided)", quantity: 1, unitPrice: 999, amount: 999, status: "pending" },
    })
    chargeIds.push(chargeC.id)
    const invoiceC = await generateInvoice(session(), { patientId, branchId, chargeIds: [chargeC.id], discountAmount: 0 })
    invoiceIds.push(invoiceC.id)
    await voidInvoice(session(), invoiceC.id, "statement reconciliation test — void")

    // ---- The actual reconciliation ----
    const statement = await getPatientStatement(session(), patientId)

    expect(statement.reconciled).toBe(true)

    // Independently recomputed from the raw Invoice rows — the same
    // definition the statement's own outstandingBalance uses, but derived
    // here separately so the test isn't just checking the function agrees
    // with itself.
    const expectedOutstanding = 500 - 250 + (300 - 300) // invoice A: paid 400, refunded 150 -> paidAmount 250; invoice B: fully paid
    expect(statement.outstandingBalance).toBe(expectedOutstanding)
    expect(statement.outstandingBalance).toBe(250)
    expect(statement.lines.at(-1)?.runningBalance).toBe(250)

    // The voided invoice (C) is genuinely absent — not shown as a zeroed
    // line, not counted in the balance.
    const voidedLine = statement.lines.find((l) => l.referenceId === invoiceC.id)
    expect(voidedLine).toBeUndefined()
    expect(statement.invoices.find((i) => i.id === invoiceC.id)?.status).toBe("void")

    // Every real event is present, in the order it actually happened —
    // invoice A, its payment, its refund, then invoice B and its payment.
    const types = statement.lines.map((l) => l.type)
    expect(types).toEqual(["invoice", "payment", "refund", "invoice", "payment"])

    const insurancePaymentLine = statement.lines.find((l) => l.type === "payment" && l.charge === 0 && l.credit === 300)
    expect(insurancePaymentLine?.description).toContain("insurance")

    const refundLine = statement.lines.find((l) => l.type === "refund")
    expect(refundLine?.charge).toBe(150)
    expect(refundLine?.credit).toBe(0)

    // Running balance progression: +500 (invoice A) = 500, -400 (payment A)
    // = 100, +150 (refund) = 250, +300 (invoice B) = 550, -300 (payment B) = 250.
    expect(statement.lines.map((l) => l.runningBalance)).toEqual([500, 100, 250, 550, 250])
    // Widened from the shared TIMEOUT — this one test runs three invoice
    // generations, a payment, a 3-step refund, a direct-transaction
    // insurance payment, and a void, each its own real round trip under
    // this environment's real Supabase latency; genuinely timed out at
    // 60000ms under full-suite load, the same class of fix
    // report-reconciliation.test.ts's own final batch already needed.
  }, 120000)
})
