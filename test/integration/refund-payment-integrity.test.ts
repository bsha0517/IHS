import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { recordPayment } from "@/lib/domains/billing/payments"
import { requestRefund, authorizeRefund, completeRefund } from "@/lib/domains/billing/refunds"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §7 (refund concurrency), §8 (refund accounting), §29 (payment
 * allocation concurrency) — real DB integration tests against the atomic
 * guards added this batch (applyPaymentAtomically/applyRefundAtomically,
 * src/lib/domains/billing/invoices.ts). Session is a Super Admin (bypasses
 * permission/branch checks entirely — this file is testing transactional
 * correctness, not authorization, the same "hand-built SessionContext,
 * Super Admin where authorization isn't the thing under test" precedent
 * branch-isolation.test.ts established for the opposite case).
 */
// Several of these tests chain multiple real recordPayment/refund cycles
// sequentially, each of which now allows its own $transaction up to 15000ms
// under real load (see posting-service.ts's POSTING_TRANSACTION_OPTIONS) —
// generous headroom needed on top of that for the whole test, not just one call.
const TIMEOUT = 60000

describe("P1 §7/§8/§29: refund and payment allocation integrity", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let cashierSessionId: string
  let cashAccountId: string
  let cashierUserId: string
  const invoiceIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-refund-payment-integrity",
      user: { id: cashierUserId, organizationId, email: "refund-test@test.local", firstName: "Refund", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["payment.create", "refund.request", "refund.authorize", "invoice.view"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createInvoice(totalAmount: number) {
    const invoice = await db.invoice.create({
      data: {
        organizationId, branchId, patientId,
        invoiceNumber: `TESTRPI-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        subtotal: totalAmount, discountAmount: 0, taxAmount: 0, totalAmount, paidAmount: 0,
        status: "issued", issuedAt: new Date(),
      },
    })
    invoiceIds.push(invoice.id)
    return invoice
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const cash = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1000" } })
    cashAccountId = cash.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    cashierUserId = user.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTRPI-${Date.now()}`, firstName: "RefundPayment", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `RPI${Date.now()}`,
      },
    })
    patientId = patient.id

    const cashierSession = await db.cashierSession.create({
      data: { organizationId, branchId, cashierUserId: user.id, openingCash: 0, status: "open" },
    })
    cashierSessionId = cashierSession.id
  }, TIMEOUT)

  afterAll(async () => {
    const refunds = await db.refund.findMany({ where: { invoiceId: { in: invoiceIds } } })
    const refundIds = refunds.map((r) => r.id)

    const journals = await db.journal.findMany({
      where: {
        organizationId,
        OR: [
          { referenceType: "invoice", referenceId: { in: invoiceIds } },
          { referenceType: "payment", referenceId: { in: invoiceIds } },
          { referenceType: "refund", referenceId: { in: refundIds } },
        ],
      },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })

    await db.paymentAllocation.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.refund.deleteMany({ where: { id: { in: refundIds } } })
    const payments = await db.payment.findMany({ where: { cashierSessionId } })
    await db.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } })
    await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await db.cashierSession.delete({ where: { id: cashierSessionId } })
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  describe("§29: payment allocation concurrency", () => {
    it("invoice outstanding 500, two simultaneous 400 payments — only one combination is allowed to succeed, never both", async () => {
      const invoice = await createInvoice(500)

      const results = await Promise.allSettled([
        recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: 400 }] }),
        recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: 400 }] }),
      ])

      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter((r) => r.status === "rejected")
      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/exceeds the invoice's outstanding balance/)

      const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(after.paidAmount)).toBe(400) // exactly one 400 payment applied, not 800 and not 0
      expect(after.status).toBe("partially_paid")

      const payments = await db.payment.findMany({ where: { allocations: { some: { invoiceId: invoice.id } } } })
      expect(payments.length).toBe(1) // only the winning payment actually persisted
    }, TIMEOUT)

    it("a single payment that exactly fills the outstanding balance still succeeds normally (the guard doesn't over-reject)", async () => {
      const invoice = await createInvoice(200)
      await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: 200 }] })
      const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(after.paidAmount)).toBe(200)
      expect(after.status).toBe("paid")
    }, TIMEOUT)
  })

  describe("§7: refund concurrency — the exact scenario from P1.md", () => {
    it("payment 1000, existing refund 600 already completed, two simultaneous 300 refund requests — only one succeeds", async () => {
      // Directly seeded to the exact starting point P1.md's scenario names
      // (Payment 1,000, Existing Refund 600 -> paidAmount 400) rather than
      // re-exercising a full prior refund cycle through requestRefund ->
      // authorizeRefund -> completeRefund — that full-cycle correctness is
      // already proven by the §8 tests below, real round trips apart from
      // this one. This test's job is proving the concurrency guard on the
      // TWO NEW simultaneous requests, not re-proving the happy path a
      // third time. applyRefundAtomically only ever reads/writes
      // invoice.paid_amount/total_amount, so this is exactly equivalent
      // for what's under test here.
      const invoice = await createInvoice(1000)
      await db.invoice.update({ where: { id: invoice.id }, data: { paidAmount: 400, status: "partially_paid" } })

      // Two NEW simultaneous 300 requests — combined 600 would exceed the 400 actually remaining refundable.
      const refundA = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 300, reason: "race A" })
      const refundB = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 300, reason: "race B" })
      await authorizeRefund(session(), refundA.id)
      await authorizeRefund(session(), refundB.id)

      const results = await Promise.allSettled([
        completeRefund(session(), refundA.id, cashierSessionId),
        completeRefund(session(), refundB.id, cashierSessionId),
      ])

      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter((r) => r.status === "rejected")
      expect(fulfilled.length).toBe(1) // only one of the two 300s was allowed through
      expect(rejected.length).toBe(1)
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/exceeds the invoice's remaining refundable balance/)

      const final = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(final.paidAmount)).toBe(100) // 400 - 300, never 400 - 600 = -200
      expect(final.status).toBe("partially_paid")
    }, TIMEOUT)

    it("completing the same refund twice concurrently (double-click) never double-decrements the balance", async () => {
      const invoice = await createInvoice(1000)
      await db.invoice.update({ where: { id: invoice.id }, data: { paidAmount: 1000, status: "paid" } })
      const refund = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 300, reason: "double-click test" })
      await authorizeRefund(session(), refund.id)

      const results = await Promise.allSettled([
        completeRefund(session(), refund.id, cashierSessionId),
        completeRefund(session(), refund.id, cashierSessionId),
      ])

      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1)
      expect(results.filter((r) => r.status === "rejected").length).toBe(1)

      const final = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(final.paidAmount)).toBe(700) // 1000 - 300 exactly once, not 1000 - 600
    }, TIMEOUT)
  })

  describe("§8: refund accounting", () => {
    it("full refund — reverses the correct journal amount, keeps the original payment/invoice/journal, patient balance ends at zero", async () => {
      const invoice = await createInvoice(250)
      await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: 250 }] })
      const paymentJournal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "payment", referenceId: invoice.id } })
      const originalPayment = await db.payment.findFirstOrThrow({ where: { allocations: { some: { invoiceId: invoice.id } } } })

      const refund = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 250, reason: "full refund" })
      await authorizeRefund(session(), refund.id)
      await completeRefund(session(), refund.id, cashierSessionId)

      // Original records untouched — never deleted, never mutated to hide the refund happened.
      const stillOriginalPayment = await db.payment.findUniqueOrThrow({ where: { id: originalPayment.id } })
      expect(Number(stillOriginalPayment.amount)).toBe(250)
      const stillOriginalInvoice = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(stillOriginalInvoice.totalAmount)).toBe(250) // never rewritten
      const stillPaymentJournal = await db.journal.findUniqueOrThrow({ where: { id: paymentJournal.id } })
      expect(stillPaymentJournal.id).toBe(paymentJournal.id) // the original posting is still there, not deleted

      // A real, separate reversing journal exists for the refund.
      const refundJournal = await db.journal.findFirstOrThrow({
        where: { organizationId, referenceType: "refund", referenceId: refund.id },
        include: { lines: true },
      })
      const totalDebit = refundJournal.lines.reduce((s, l) => s + Number(l.debit), 0)
      const totalCredit = refundJournal.lines.reduce((s, l) => s + Number(l.credit), 0)
      expect(totalDebit).toBe(250) // Dr Revenue
      expect(totalCredit).toBe(250) // Cr Cash — journal stays balanced
      const cashLine = refundJournal.lines.find((l) => l.accountId === cashAccountId)
      expect(cashLine).toBeDefined()
      expect(Number(cashLine!.credit)).toBe(250)

      // Patient balance: invoice fully refunded, nothing outstanding, nothing overpaid.
      const final = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(final.paidAmount)).toBe(0)
      expect(final.status).toBe("issued")
    }, TIMEOUT)

    it("partial refund — journal reflects only the partial amount, invoice stays partially_paid", async () => {
      const invoice = await createInvoice(400)
      await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: 400 }] })

      const refund = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 150, reason: "partial refund" })
      await authorizeRefund(session(), refund.id)
      await completeRefund(session(), refund.id, cashierSessionId)

      const refundJournal = await db.journal.findFirstOrThrow({
        where: { organizationId, referenceType: "refund", referenceId: refund.id },
        include: { lines: true },
      })
      const totalDebit = refundJournal.lines.reduce((s, l) => s + Number(l.debit), 0)
      expect(totalDebit).toBe(150)

      const final = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(final.paidAmount)).toBe(250) // 400 - 150
      expect(final.status).toBe("partially_paid")
    }, TIMEOUT)

    it("multiple partial refunds — each posts its own journal, balances accumulate correctly, never overlap", async () => {
      const invoice = await createInvoice(600)
      await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: 600 }] })

      const refund1 = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 100, reason: "partial 1" })
      await authorizeRefund(session(), refund1.id)
      await completeRefund(session(), refund1.id, cashierSessionId)

      const refund2 = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 150, reason: "partial 2" })
      await authorizeRefund(session(), refund2.id)
      await completeRefund(session(), refund2.id, cashierSessionId)

      const refund3 = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 50, reason: "partial 3" })
      await authorizeRefund(session(), refund3.id)
      await completeRefund(session(), refund3.id, cashierSessionId)

      const journals = await db.journal.findMany({
        where: { organizationId, referenceType: "refund", referenceId: { in: [refund1.id, refund2.id, refund3.id] } },
        include: { lines: true },
      })
      expect(journals.length).toBe(3) // one distinct journal per refund, none merged or skipped
      const amounts = journals.map((j) => j.lines.reduce((s, l) => s + Number(l.debit), 0)).sort((a, b) => a - b)
      expect(amounts).toEqual([50, 100, 150])

      const final = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(final.paidAmount)).toBe(300) // 600 - 100 - 150 - 50
      expect(final.status).toBe("partially_paid")

      const allRefunds = await db.refund.findMany({ where: { invoiceId: invoice.id } })
      expect(allRefunds.every((r) => r.status === "completed")).toBe(true)
      // 3x the sequential DB round trips of this file's other tests (three
      // full request->authorize->complete->dispatch cycles, each cycle's
      // own completeRefund transaction and its dispatched postRefundCompleted
      // posting each individually allowed up to 20s under real Supabase
      // latency) — a real P1 §7 test caught genuinely exceeding the shared
      // 60s TIMEOUT under that latency, not a broken assertion. Widened for
      // this one test specifically rather than raising TIMEOUT file-wide.
    }, 120000)

    it("split-payment refund — refunding against an invoice paid via two tenders leaves both original Payment rows intact", async () => {
      const invoice = await createInvoice(500)
      await recordPayment(session(), {
        invoiceId: invoice.id,
        cashierSessionId,
        tenders: [
          { method: "cash", amount: 300 },
          { method: "card", amount: 200 },
        ],
      })

      const paymentsBefore = await db.payment.findMany({ where: { allocations: { some: { invoiceId: invoice.id } } } })
      expect(paymentsBefore.length).toBe(2) // one row per tender, never blended

      const refund = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 120, reason: "split-payment refund" })
      await authorizeRefund(session(), refund.id)
      await completeRefund(session(), refund.id, cashierSessionId)

      // Both original tender rows are still there, unmodified — a refund never
      // touches the Payment rows it's reversing, only the Invoice balance and
      // a new Refund/Journal record (spec.md §92).
      const paymentsAfter = await db.payment.findMany({ where: { allocations: { some: { invoiceId: invoice.id } } } })
      expect(paymentsAfter.length).toBe(2)
      expect(paymentsAfter.map((p) => Number(p.amount)).sort((a, b) => a - b)).toEqual([200, 300])

      const refundJournal = await db.journal.findFirstOrThrow({
        where: { organizationId, referenceType: "refund", referenceId: refund.id },
        include: { lines: true },
      })
      const cashLine = refundJournal.lines.find((l) => l.accountId === cashAccountId)
      expect(Number(cashLine!.credit)).toBe(120) // refunded via the "cash" method specifically, not blended across tenders

      const final = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(Number(final.paidAmount)).toBe(380) // 500 - 120
    }, TIMEOUT)
  })
})
