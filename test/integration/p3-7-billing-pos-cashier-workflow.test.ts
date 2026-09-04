import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import { generateSystemCharge, createAdHocCharge, voidCharge } from "@/lib/domains/billing/charges"
import { generateInvoice, getInvoice } from "@/lib/domains/billing/invoices"
import { recordPayment, getPayment } from "@/lib/domains/billing/payments"
import { requestRefund, authorizeRefund, completeRefund } from "@/lib/domains/billing/refunds"
import { openSession as openCashierSession } from "@/lib/domains/billing/cashier"
import { listPatientInvoices } from "@/lib/domains/billing/invoices"
import { listPatientPayments } from "@/lib/domains/billing/payments"
import { getOrganizationIdentity } from "@/lib/domains/identity/org-structure"
import { closePeriod, reopenPeriod } from "@/lib/domains/accounting/periods"
import { getJournalTrace } from "@/lib/domains/accounting/traceability"
import { dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 60000

/**
 * P3.7 (Billing / POS / Cashier Workflow) — targeted tests for the actual
 * behavior changed this batch. Pre-existing files already thoroughly cover
 * ground this batch deliberately does not re-test: `pos-inventory-cogs.test.ts`
 * (POS stock/FEFO/COGS/void-reversal), `idempotency-and-transaction-review.test.ts`
 * (duplicate-Charge-invoicing protection, recordPayment idempotency key,
 * concurrent stock consumption), `accounting-period-control.test.ts` (closed-
 * period posting rejection). This file covers what P3.7 actually added: the
 * new Billing/POS write-side branch scoping, `createAdHocCharge`'s new
 * idempotency guard, duplicate-refund protection, multi-source Charge
 * combination into one Invoice, Patient 360 reflecting new financial
 * activity, printing without `settings.view`, and closed-period behavior at
 * the operational (not just posting-layer) level.
 */
describe("P3.7: billing / POS / cashier workflow", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let cashierUserAId: string
  let cashierUserBId: string
  let registerAId: string
  let registerBId: string
  let patientId: string
  const createdChargeProductIds: string[] = []
  const createdPatientIds: string[] = []
  const createdInvoiceIds: string[] = []
  const createdCashierSessionIds: string[] = []

  function cashierSession(userId: string, branchIds: string[]): SessionContext {
    return {
      sessionId: `test-p3-7-cashier-${userId}`,
      user: { id: userId, organizationId, email: `p3-7-cashier-${userId}@test.local`, firstName: "P3.7", lastName: "Cashier" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "patient.view", "service.view",
        "charge.create", "charge.void", "invoice.view", "invoice.create",
        "payment.view", "payment.create", "refund.request", "refund.authorize", "cashier.open", "cashier.view",
      ]),
      roleNames: ["Cashier"],
    }
  }

  async function newPatient() {
    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchAId,
        mrn: `TESTP37-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, firstName: "P3.7", lastName: "Billing",
        dob: new Date("1980-01-01"), gender: "unknown", mobile: `P37M${Date.now()}${Math.random().toString(36).slice(2, 4)}`,
      },
    })
    createdPatientIds.push(patient.id)
    return patient
  }

  async function newCharge(branchId: string, pid: string, sourceType: string, amount: number) {
    return db.$transaction((tx) =>
      generateSystemCharge(tx, {
        organizationId, branchId, patientId: pid,
        sourceType, description: `P3.7 test ${sourceType} charge`, quantity: 1, unitPrice: amount,
      })
    )
  }

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 2, orderBy: { createdAt: "asc" } })
    if (branches.length < 2) throw new Error("Test requires at least 2 seeded branches (see LOCAL_DATABASE_SETUP.md).")
    organizationId = branches[0].organizationId
    branchAId = branches[0].id
    branchBId = branches[1].id

    const userA = await db.user.create({
      data: { organizationId, email: `p3-7-cashierA-${Date.now()}@test.local`, passwordHash: "x", firstName: "P3.7", lastName: "CashierA" },
    })
    cashierUserAId = userA.id
    const userB = await db.user.create({
      data: { organizationId, email: `p3-7-cashierB-${Date.now()}@test.local`, passwordHash: "x", firstName: "P3.7", lastName: "CashierB" },
    })
    cashierUserBId = userB.id

    // One register per cashier, opened once and reused across every test in
    // this file (openSession itself enforces "one open session per user" —
    // real production behavior, not a test artifact to work around per-test).
    const registerA = await openCashierSession(cashierSession(cashierUserAId, [branchAId]), { branchId: branchAId, openingCash: 100 })
    registerAId = registerA.id
    createdCashierSessionIds.push(registerA.id)
    const registerB = await openCashierSession(cashierSession(cashierUserBId, [branchBId]), { branchId: branchBId, openingCash: 100 })
    registerBId = registerB.id
    createdCashierSessionIds.push(registerB.id)

    const patient = await newPatient()
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
    await ownerDb.clinicalAccessLog.deleteMany({ where: { patientId: { in: createdPatientIds } } }).catch(() => {})
    await ownerDb.$disconnect()

    await db.refund.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    await db.commissionAccrual.deleteMany({ where: { organizationId, invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    // Payments (and their COGS/commission postings) found before their own
    // allocations are deleted — deleting allocations first would leave these
    // Payment rows un-findable via this join, orphaning them and later
    // tripping payment_received_by_fkey when the test users are deleted.
    const payments = await db.payment.findMany({ where: { receivedBy: { in: [cashierUserAId, cashierUserBId] } }, select: { id: true } })
    await db.paymentAllocation.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } }).catch(() => {})
    await db.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } }).catch(() => {})
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } })
    await db.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } })
    await db.charge.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.cashMovement.deleteMany({ where: { cashierSessionId: { in: createdCashierSessionIds } } }).catch(() => {})
    await db.cashierSession.deleteMany({ where: { id: { in: createdCashierSessionIds } } })
    await db.patient.deleteMany({ where: { id: { in: createdPatientIds } } })
    // The §40 closed-period test reopens the period it closes (so it never
    // leaves accounting in a closed state), but the AccountingPeriod row
    // itself still references these test users via closedBy/reopenedBy.
    await db.accountingPeriod.deleteMany({ where: { organizationId, reason: { contains: "P3.7" } } }).catch(() => {})
    await db.user.deleteMany({ where: { id: { in: [cashierUserAId, cashierUserBId] } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("§6/§13: charges from two different clinical sources combine into one invoice, each traceable through its own InvoiceLine", async () => {
    const labCharge = await newCharge(branchAId, patientId, "lab", 50)
    const pharmacyCharge = await newCharge(branchAId, patientId, "pharmacy", 30)

    const invoice = await generateInvoice(cashierSession(cashierUserAId, [branchAId]), {
      patientId, branchId: branchAId, chargeIds: [labCharge.id, pharmacyCharge.id], discountAmount: 0,
    })
    createdInvoiceIds.push(invoice.id)
    expect(Number(invoice.totalAmount)).toBe(80)

    const full = await getInvoice(cashierSession(cashierUserAId, [branchAId]), invoice.id)
    expect(full.lines).toHaveLength(2)
    expect(full.lines.map((l) => l.chargeId).sort()).toEqual([labCharge.id, pharmacyCharge.id].sort())

    const reloadedLab = await db.charge.findUniqueOrThrow({ where: { id: labCharge.id } })
    expect(reloadedLab.status).toBe("invoiced")
  }, TIMEOUT)

  it("§12/§41: generateInvoice cannot merge a charge from a different branch into this invoice, even naming a branch the session is authorized for", async () => {
    const chargeAtA = await newCharge(branchAId, patientId, "consultation", 40)
    const chargeAtB = await newCharge(branchBId, patientId, "consultation", 40)
    // A session authorized at BOTH branches, requesting an invoice AT branch A
    // but naming a charge that actually lives at branch B.
    const bothBranches = cashierSession(cashierUserAId, [branchAId, branchBId])

    await expect(
      generateInvoice(bothBranches, { patientId, branchId: branchAId, chargeIds: [chargeAtA.id, chargeAtB.id], discountAmount: 0 })
    ).rejects.toThrow(/don't belong to this branch|no longer pending/)

    // Neither charge was claimed by the failed attempt.
    const reloadedA = await db.charge.findUniqueOrThrow({ where: { id: chargeAtA.id } })
    const reloadedB = await db.charge.findUniqueOrThrow({ where: { id: chargeAtB.id } })
    expect(reloadedA.status).toBe("pending")
    expect(reloadedB.status).toBe("pending")
  }, TIMEOUT)

  it("§41: a Cashier authorized only for Branch B cannot void a Branch A charge, invoice, pay it, or refund it", async () => {
    const charge = await newCharge(branchAId, patientId, "other", 60)
    const onlyB = cashierSession(cashierUserBId, [branchBId])
    await expect(voidCharge(onlyB, charge.id, "wrong branch")).rejects.toThrow(ForbiddenError)

    const invoice = await generateInvoice(cashierSession(cashierUserAId, [branchAId]), {
      patientId, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0,
    })
    createdInvoiceIds.push(invoice.id)

    await expect(
      recordPayment(onlyB, { invoiceId: invoice.id, cashierSessionId: registerBId, tenders: [{ method: "cash", amount: 60 }] })
    ).rejects.toThrow(ForbiddenError)
    await expect(requestRefund(onlyB, { invoiceId: invoice.id, method: "cash", amount: 10, reason: "wrong branch" })).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§17-19: partial payment then remaining payment — invoice stays partially_paid until fully settled, never overwriting the first payment", async () => {
    const charge = await newCharge(branchAId, patientId, "procedure", 100)
    const invoice = await generateInvoice(cashierSession(cashierUserAId, [branchAId]), {
      patientId, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0,
    })
    createdInvoiceIds.push(invoice.id)

    await recordPayment(cashierSession(cashierUserAId, [branchAId]), {
      invoiceId: invoice.id, cashierSessionId: registerAId, tenders: [{ method: "cash", amount: 40 }],
    })
    let reloaded = await getInvoice(cashierSession(cashierUserAId, [branchAId]), invoice.id)
    expect(reloaded.status).toBe("partially_paid")
    expect(Number(reloaded.paidAmount)).toBe(40)

    await recordPayment(cashierSession(cashierUserAId, [branchAId]), {
      invoiceId: invoice.id, cashierSessionId: registerAId, tenders: [{ method: "card", amount: 60, reference: "AUTH123" }],
    })
    reloaded = await getInvoice(cashierSession(cashierUserAId, [branchAId]), invoice.id)
    expect(reloaded.status).toBe("paid")
    expect(Number(reloaded.paidAmount)).toBe(100)
    expect(reloaded.paymentAllocations).toHaveLength(2) // both tenders preserved, never overwritten
  }, TIMEOUT)

  it("§23/§24: refund reduces the invoice balance and a second concurrent refund of the same amount cannot also succeed", async () => {
    const charge = await newCharge(branchAId, patientId, "product", 100)
    const invoice = await generateInvoice(cashierSession(cashierUserAId, [branchAId]), {
      patientId, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0,
    })
    createdInvoiceIds.push(invoice.id)
    await recordPayment(cashierSession(cashierUserAId, [branchAId]), {
      invoiceId: invoice.id, cashierSessionId: registerAId, tenders: [{ method: "cash", amount: 100 }],
    })

    const refund1 = await requestRefund(cashierSession(cashierUserAId, [branchAId]), { invoiceId: invoice.id, method: "cash", amount: 70, reason: "partial return" })
    await authorizeRefund(cashierSession(cashierUserAId, [branchAId]), refund1.id)
    const refund2 = await requestRefund(cashierSession(cashierUserAId, [branchAId]), { invoiceId: invoice.id, method: "cash", amount: 70, reason: "duplicate attempt" })
    await authorizeRefund(cashierSession(cashierUserAId, [branchAId]), refund2.id)

    // §24: two authorized refunds, each individually valid against the
    // original 100 paid, but only one can actually be completed — the
    // remaining balance after the first is 30, not enough for the second's 70.
    const results = await Promise.allSettled([
      completeRefund(cashierSession(cashierUserAId, [branchAId]), refund1.id, registerAId),
      completeRefund(cashierSession(cashierUserAId, [branchAId]), refund2.id, registerAId),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    expect(fulfilled).toHaveLength(1)

    const reloaded = await getInvoice(cashierSession(cashierUserAId, [branchAId]), invoice.id)
    expect(Number(reloaded.paidAmount)).toBe(30) // exactly one 70 refund applied, never both
  }, TIMEOUT)

  it("§45: createAdHocCharge with the same idempotency key twice — only one Charge row is ever created", async () => {
    const key = `p3-7-idem-${Date.now()}`
    const session = cashierSession(cashierUserAId, [branchAId])
    const input = {
      patientId, branchId: branchAId, sourceType: "other" as const, description: "Idempotency test charge",
      quantity: 1, unitPrice: 25, idempotencyKey: key,
    }
    const [first, second] = await Promise.all([createAdHocCharge(session, input), createAdHocCharge(session, input)])
    expect(first.id).toBe(second.id) // the second call replayed the first's own charge, not a new one

    const count = await db.charge.count({ where: { patientId, description: "Idempotency test charge" } })
    expect(count).toBe(1)
  }, TIMEOUT)

  it("§21/§22/§30: invoice and receipt printing succeed for a Cashier session without settings.view", async () => {
    const charge = await newCharge(branchAId, patientId, "consultation", 20)
    const invoice = await generateInvoice(cashierSession(cashierUserAId, [branchAId]), {
      patientId, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0,
    })
    createdInvoiceIds.push(invoice.id)
    const [payment] = await recordPayment(cashierSession(cashierUserAId, [branchAId]), {
      invoiceId: invoice.id, cashierSessionId: registerAId, tenders: [{ method: "cash", amount: 20 }],
    })

    const org = await getOrganizationIdentity(cashierSession(cashierUserAId, [branchAId]))
    expect(org.displayName).toBeTruthy()
    const printableInvoice = await getInvoice(cashierSession(cashierUserAId, [branchAId]), invoice.id)
    expect(printableInvoice.id).toBe(invoice.id)
    const printableReceipt = await getPayment(cashierSession(cashierUserAId, [branchAId]), payment.id)
    expect(printableReceipt.allocations[0]?.invoice.invoiceNumber).toBe(invoice.invoiceNumber)
  }, TIMEOUT)

  it("§33: Patient 360 (listPatientInvoices/listPatientPayments) reflects a newly created invoice and payment", async () => {
    const charge = await newCharge(branchAId, patientId, "consultation", 15)
    const invoice = await generateInvoice(cashierSession(cashierUserAId, [branchAId]), {
      patientId, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0,
    })
    createdInvoiceIds.push(invoice.id)

    await recordPayment(cashierSession(cashierUserAId, [branchAId]), {
      invoiceId: invoice.id, cashierSessionId: registerAId, tenders: [{ method: "cash", amount: 15 }],
    })

    const patient360Invoices = await listPatientInvoices(cashierSession(cashierUserAId, [branchAId]), patientId)
    expect(patient360Invoices.some((i) => i.id === invoice.id && i.status === "paid")).toBe(true)
    const patient360Payments = await listPatientPayments(cashierSession(cashierUserAId, [branchAId]), patientId)
    expect(patient360Payments.some((p) => p.allocations.some((a) => a.invoiceId === invoice.id))).toBe(true)
  }, TIMEOUT)

  it("§40: a closed accounting period does not block the operational invoice/payment action itself, but its accounting posting fails and retries rather than landing in the closed period", async () => {
    // periodBounds (accounting/periods.ts) builds period boundaries via
    // Date.UTC — must close the UTC-current month, not the host's local
    // month, or a host running ahead of UTC (this environment's own clock
    // included) closes the wrong period and the invoice's own UTC posting
    // timestamp never falls inside it, making this test flaky by timezone
    // rather than a real product bug.
    const now = new Date()
    const accountantSession: SessionContext = { ...cashierSession(cashierUserAId, [branchAId]), permissions: new Set(["accounting.period.manage"]) }
    const closed = await closePeriod(accountantSession, { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, reason: "P3.7 closed-period test" })
    try {
      const charge = await newCharge(branchAId, patientId, "other", 10)
      const invoice = await generateInvoice(cashierSession(cashierUserAId, [branchAId]), {
        patientId, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0,
      })
      createdInvoiceIds.push(invoice.id)
      // The operational write itself succeeded — it is not gated on the
      // accounting posting's own success (see event-handlers.ts's own
      // "a posting failure must never block the write" discipline, applied
      // consistently across this codebase).
      expect(invoice.status).toBe("issued")

      await dispatchPendingOutboxEvents(organizationId)
      const event = await db.outboxEvent.findFirstOrThrow({
        where: { organizationId, eventType: "InvoiceIssued", payload: { path: ["invoiceId"], equals: invoice.id } },
      })
      // The posting attempt genuinely failed (closed period), queued for
      // retry — never silently dropped, and never posted into the closed
      // period despite the invoice itself existing.
      expect(event.status === "failed" || event.status === "dead_letter").toBe(true)
      const journal = await db.journal.findFirst({ where: { organizationId, referenceType: "invoice", referenceId: invoice.id } })
      expect(journal).toBeNull()
    } finally {
      await reopenPeriod(accountantSession, closed.id, "P3.7 test cleanup")
    }
  }, TIMEOUT)

  it("§30: two POS sales competing for the last unit of stock — only one succeeds, stock never goes negative", async () => {
    const product = await db.product.create({
      data: {
        organizationId, name: `P3.7 Last Unit ${Date.now()}`, sku: `P37LAST-${Date.now()}`,
        category: "product", unit: "unit", reorderLevel: 0, purchaseCost: 5, sellingPrice: 10,
      },
    })
    createdChargeProductIds.push(product.id)
    const batch = await db.productBatch.create({
      data: { organizationId, productId: product.id, batchNumber: `P37B-${Date.now()}`, purchaseCost: 5, receivedQuantity: 1 },
    })
    await db.stockLedgerEntry.create({
      data: { organizationId, branchId: branchAId, productId: product.id, batchId: batch.id, transactionType: "purchase", quantity: 1, referenceType: "test" },
    })

    const session = cashierSession(cashierUserAId, [branchAId])
    const results = await Promise.allSettled([
      createAdHocCharge(session, { patientId, branchId: branchAId, productId: product.id, sourceType: "product", description: "Last unit A", quantity: 1, unitPrice: 10 }),
      createAdHocCharge(session, { patientId, branchId: branchAId, productId: product.id, sourceType: "product", description: "Last unit B", quantity: 1, unitPrice: 10 }),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    expect(fulfilled).toHaveLength(1)

    const balance = await db.stockLedgerEntry.aggregate({ where: { productId: product.id }, _sum: { quantity: true } })
    expect(Number(balance._sum.quantity)).toBe(0) // never negative
  }, TIMEOUT)

  /**
   * Targeted backlog closure, item 9 (P3.13's own known radar item):
   * `recordPayment` can create MULTIPLE `Payment` rows in one call (a real
   * split-tender payment — spec.md §35's own Cash+Card+Insurance example),
   * but `postPaymentReceived` keys the resulting Journal's `referenceId` on
   * only the first (`paymentIds[0]`) — by design, matching how `tenders`
   * already aggregates one call's tenders into one journal. Verifies the
   * journal's own debit lines are still fully correct (never in question),
   * AND that the traceability VIEW (`getJournalTrace`/
   * `resolveSourceReference`) now surfaces every sibling tender, not just
   * the first — the actual gap this item closes.
   */
  it("item 9: a multi-tender (split) payment's journal trace surfaces every tender, not just the first", async () => {
    const patient = await newPatient()
    const chargeAmount = 900
    const charge = await newCharge(branchAId, patient.id, "consultation", chargeAmount)
    const invoice = await generateInvoice(cashierSession(cashierUserAId, [branchAId]), { patientId: patient.id, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0 })

    // A dedicated cashier + register for this test — openSession correctly
    // rejects a second concurrent register for the same user, and this
    // must not interfere with registerAId's use elsewhere in this file.
    const tenderUser = await db.user.create({
      data: { organizationId, email: `p3-7-tender-cashier-${Date.now()}@test.local`, passwordHash: "x", firstName: "P3.7", lastName: "TenderCashier" },
    })
    const tenderSession = cashierSession(tenderUser.id, [branchAId])
    const register = await openCashierSession(tenderSession, { branchId: branchAId, openingCash: 0 })

    const payments = await recordPayment(tenderSession, {
      invoiceId: invoice.id,
      cashierSessionId: register.id,
      tenders: [
        { method: "cash", amount: 200 },
        { method: "card", amount: 500, reference: "AUTH-P9" },
        { method: "insurance", amount: 200 },
      ],
    })
    expect(payments).toHaveLength(3) // confirms one call really does create multiple Payment rows

    await dispatchPendingOutboxEvents(organizationId) // recordPayment already dispatches inline — idempotent no-op if already drained

    const journal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "payment", referenceId: payments[0].id } })
    // The journal's own figures were never in question — every tender gets
    // its own debit line, verified here as a baseline before checking the trace.
    const lines = await db.journalLine.findMany({ where: { journalId: journal.id } })
    const totalDebit = lines.reduce((sum, l) => sum + Number(l.debit), 0)
    const totalCredit = lines.reduce((sum, l) => sum + Number(l.credit), 0)
    expect(totalDebit).toBe(900)
    expect(totalCredit).toBe(900)
    expect(lines.length).toBeGreaterThanOrEqual(4) // 3 tender debit lines + 1 AR credit line

    // The actual gap this item closes: the trace view previously showed
    // only payments[0] ("Cash 200") — now it surfaces all three.
    const accountantSession: SessionContext = { ...cashierSession(cashierUserAId, [branchAId]), permissions: new Set(["accounting.view"]) }
    const trace = await getJournalTrace(accountantSession, journal.id)
    expect(trace.source?.summary).toContain("3 tenders")
    for (const p of payments) {
      expect(trace.source?.summary).toContain(p.receiptNumber)
    }
    expect(trace.source?.summary).toContain("200.00")
    expect(trace.source?.summary).toContain("500.00")

    // Full manual cleanup — this test's dedicated tenderUser/register/
    // invoice/payments are outside every shared array the file's own
    // afterAll sweeps (that afterAll only covers cashierUserAId/B), so
    // nothing here is safe to leave for it to catch.
    const paymentIds = payments.map((p) => p.id)
    await db.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } })
    await db.journalLine.deleteMany({ where: { journalId: journal.id } })
    await db.journal.deleteMany({ where: { id: journal.id } })
    await db.payment.deleteMany({ where: { id: { in: paymentIds } } })
    await db.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } })
    await db.invoice.deleteMany({ where: { id: invoice.id } })
    await db.charge.deleteMany({ where: { id: charge.id } })
    await db.cashMovement.deleteMany({ where: { cashierSessionId: register.id } })
    await db.cashierSession.deleteMany({ where: { id: register.id } })
    await db.patient.deleteMany({ where: { id: patient.id } })
    await db.userRole.deleteMany({ where: { userId: tenderUser.id } })
    await db.user.delete({ where: { id: tenderUser.id } })
  }, TIMEOUT)
})
