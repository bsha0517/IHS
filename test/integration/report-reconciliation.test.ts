import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { createAdHocCharge } from "@/lib/domains/billing/charges"
import { generateInvoice } from "@/lib/domains/billing/invoices"
import { recordPayment } from "@/lib/domains/billing/payments"
import { requestRefund, authorizeRefund, completeRefund } from "@/lib/domains/billing/refunds"
import { createGoodsReceipt } from "@/lib/domains/procurement/goods-receipts"
import { createSupplierInvoice, recordSupplierPayment } from "@/lib/domains/procurement/supplier-invoices"
import { getInventoryReport } from "@/lib/domains/analytics/reports/inventory"
import { getFinancialReport } from "@/lib/domains/analytics/reports/financial"
import { trialBalance, incomeStatement, balanceSheet } from "@/lib/domains/accounting/reports"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §35: proves the REPORT FUNCTIONS themselves — not just the raw journal
 * postings pos-inventory-cogs.test.ts already verifies in isolation —
 * reconcile against each other and against a real, known chain of
 * transactions. This codebase has no report literally named "Sales
 * Report" (spec.md/P1.md's generic accounting vocabulary doesn't map 1:1
 * onto every named artifact here); the closest existing equivalent is
 * `getFinancialReport().revenue` (Invoice.totalAmount issued in the
 * period), used as its stand-in throughout.
 *
 * The scenario: PurchaseOrder → GoodsReceipt → SupplierInvoice → POS
 * product sale (COGS) → patient Invoice → Payment → Refund → Supplier
 * Payment — a single chain that touches Inventory, COGS, AR, AP, Revenue,
 * and Cash all at once, so every reconciliation P1 §35 names can be
 * checked against the SAME transactions, per its own instruction.
 *
 * Every GL-side figure below is measured as a BEFORE/AFTER *delta*, not an
 * absolute value — this is a shared dev database with other data already
 * in every account, so only the net movement this scenario itself caused
 * is a meaningful, deterministic assertion.
 */
const TIMEOUT = 60000

describe("P1 §35: report consistency across Inventory Valuation, COGS, AR, AP, P&L, Trial Balance, Balance Sheet", () => {
  let organizationId: string
  let branchId: string
  let supplierId: string
  let patientId: string
  let userId: string
  let cashierSessionId: string
  let inventoryAccountId: string
  let apAccountId: string
  let arAccountId: string
  const productIds: string[] = []
  const purchaseOrderIds: string[] = []
  const goodsReceiptIds: string[] = []
  const supplierInvoiceIds: string[] = []
  const chargeIds: string[] = []
  const invoiceIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-report-reconciliation",
      user: { id: userId, organizationId, email: "report-reconciliation-test@test.local", firstName: "Reconcile", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set([
        "goods_receipt.create", "supplier_invoice.manage", "purchase_order.manage",
        "charge.create", "invoice.create", "payment.create", "refund.request", "refund.authorize",
        "cashier.open", "accounting.view", "inventory.view",
      ]),
      roleNames: ["Super Admin"],
    }
  }

  async function reportRange() {
    return { from: new Date(Date.UTC(2000, 0, 1)), to: new Date(Date.UTC(2100, 0, 1)) }
  }

  /** Delta helper: the GL account's own net balance (debit-credit for asset/expense, credit-debit for liability/revenue) via trialBalance, before vs after a step. */
  async function accountBalance(accountId: string): Promise<number> {
    const tb = await trialBalance(session())
    const line = tb.lines.find((l) => l.accountId === accountId)
    if (!line) return 0
    // trialBalance already normalizes into debit/credit columns per account
    // type — reduce back to one signed figure the same way netBalance does
    // internally, so a delta is a plain subtraction regardless of type.
    return line.debit - line.credit
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const [inventory, ap, ar] = await Promise.all([
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1200" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "2000" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1100" } }),
    ])
    inventoryAccountId = inventory.id
    apAccountId = ap.id
    arAccountId = ar.id

    const supplier = await db.supplier.create({
      data: { organizationId, companyName: `Reconciliation Test Supplier ${Date.now()}`, code: `TESTRECONSUP-${Date.now()}` },
    })
    supplierId = supplier.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTRECON-${Date.now()}`, firstName: "Reconciliation", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `RC${Date.now()}`,
      },
    })
    patientId = patient.id

    // Created directly rather than via openSession() — that function
    // refuses a second open session for the same user, and this shared dev
    // database's own admin user is reused as the actor across many test
    // files (same precedent as refund-payment-integrity.test.ts and others).
    const cashierSession = await db.cashierSession.create({
      data: { organizationId, branchId, cashierUserId: userId, openingCash: 0, status: "open" },
    })
    cashierSessionId = cashierSession.id
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
          { referenceType: "goods_receipt", referenceId: { in: goodsReceiptIds } },
          { referenceType: "supplier_invoice", referenceId: { in: supplierInvoiceIds } },
          { referenceType: { in: ["charge_cogs", "charge_cogs_void"] }, referenceId: { in: chargeIds } },
          { referenceType: "invoice", referenceId: { in: invoiceIds } },
          { referenceType: "payment", referenceId: { in: paymentIds } },
          { referenceType: "refund" },
          { referenceType: "supplier_payment" },
        ],
      },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })

    const refunds = await db.refund.findMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.refund.deleteMany({ where: { id: { in: refunds.map((r) => r.id) } } })
    const paymentAllocations = await db.paymentAllocation.findMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.paymentAllocation.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.payment.deleteMany({ where: { id: { in: paymentAllocations.map((a) => a.paymentId) } } })
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await db.charge.deleteMany({ where: { id: { in: chargeIds } } })
    await db.cashierSession.delete({ where: { id: cashierSessionId } }).catch(() => {})

    const supplierPayments = await db.supplierPayment.findMany({ where: { supplierInvoiceId: { in: supplierInvoiceIds } } })
    await db.supplierPayment.deleteMany({ where: { id: { in: supplierPayments.map((p) => p.id) } } })
    await db.supplierInvoice.deleteMany({ where: { id: { in: supplierInvoiceIds } } })
    const goodsReceiptLines = await db.goodsReceiptLine.findMany({ where: { goodsReceiptId: { in: goodsReceiptIds } } })
    await db.goodsReceiptLine.deleteMany({ where: { id: { in: goodsReceiptLines.map((l) => l.id) } } })
    await db.goodsReceipt.deleteMany({ where: { id: { in: goodsReceiptIds } } })
    const poLines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: { in: purchaseOrderIds } } })
    await db.purchaseOrderLine.deleteMany({ where: { id: { in: poLines.map((l) => l.id) } } })
    await db.purchaseOrder.deleteMany({ where: { id: { in: purchaseOrderIds } } })
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: productIds } } })
    await db.productBatch.deleteMany({ where: { productId: { in: productIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.supplier.delete({ where: { id: supplierId } })
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("one real transaction chain — receive 50 @ 10, sell 20, invoice, pay, refund, pay supplier — reconciles across every named report", async () => {
    // ---- Step 1: purchase 50 units @ 10 each (Dr Inventory 500 / Cr GR-not-invoiced) ----
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const product = await db.product.create({
      data: { organizationId, name: `Reconciliation Test Product ${suffix}`, sku: `TESTRECON-${suffix}`, category: "consumable", unit: "unit", reorderLevel: 0, purchaseCost: 10, sellingPrice: 25 },
    })
    productIds.push(product.id)

    const po = await db.purchaseOrder.create({
      data: { organizationId, branchId, supplierId, poNumber: `TESTRECONPO-${suffix}`, status: "issued", lines: { create: [{ productId: product.id, quantity: 50, unitCost: 10 }] } },
      include: { lines: true },
    })
    purchaseOrderIds.push(po.id)

    const inventoryBeforeReceipt = await accountBalance(inventoryAccountId)
    const valuationBeforeReceipt = (await getInventoryReport(session(), await reportRange())).valuation.find((v) => v.productId === product.id)?.value ?? 0

    const receipt = await createGoodsReceipt(session(), {
      purchaseOrderId: po.id,
      lines: [{ purchaseOrderLineId: po.lines[0].id, productId: product.id, batchNumber: `TESTRECONBATCH-${suffix}`, quantityReceived: 50, unitCost: 10 }],
      allowOverReceipt: false,
    })
    goodsReceiptIds.push(receipt.id)

    // Reconciliation #1: Inventory Valuation report moved by exactly the
    // same amount the Inventory Asset GL account moved — P1 §35's own
    // literal example, "stock [change] + COGS/posting must show a matching
    // inventory valuation [change]," checked here for a stock INCREASE.
    const inventoryAfterReceipt = await accountBalance(inventoryAccountId)
    const valuationAfterReceipt = (await getInventoryReport(session(), await reportRange())).valuation.find((v) => v.productId === product.id)?.value ?? 0
    expect(inventoryAfterReceipt - inventoryBeforeReceipt).toBe(500)
    expect(valuationAfterReceipt - valuationBeforeReceipt).toBe(500)

    // ---- Step 2: supplier invoice recognizes AP (Dr GR-not-invoiced / Cr AP 500) ----
    const apGlBeforeInvoice = await accountBalance(apAccountId) // negative (credit-normal) — see note below
    const apSubledgerBeforeInvoice = (await getFinancialReport(session(), await reportRange())).accountsPayable

    // purchaseOrderId links this invoice to the PO the goods receipt above
    // was already against — postSupplierInvoiceCreated clears the GR/IR
    // clearing account for a PO-linked invoice (Dr Goods Received Not
    // Invoiced), vs. debiting Inventory directly for a genuinely standalone
    // invoice with no linked receipt (a freight/adjustment-only invoice).
    // Omitting it here (an earlier version of this test did) makes the
    // invoice look standalone and double-recognizes Inventory — a real bug
    // in this TEST's own fixture, caught by reconciliation #3 below
    // failing, not a bug in the application.
    const supplierInvoice = await createSupplierInvoice(session(), {
      supplierId, branchId, purchaseOrderId: po.id, invoiceNumber: `TESTRECONSI-${suffix}`, amount: 500, taxAmount: 0,
    })
    supplierInvoiceIds.push(supplierInvoice.id)

    // Reconciliation #2: AP sub-ledger (SupplierInvoice-based,
    // getFinancialReport) and AP GL account (liability, trialBalance) move
    // by the identical 500 this one invoice created — proving the two
    // independently-computed figures aren't allowed to silently drift.
    const apGlAfterInvoice = await accountBalance(apAccountId)
    const apSubledgerAfterInvoice = (await getFinancialReport(session(), await reportRange())).accountsPayable
    // apAccountId is liability (credit-normal) — accountBalance() returns
    // debit-credit, so a liability INCREASE (more owed) is a NEGATIVE delta.
    expect(apGlBeforeInvoice - apGlAfterInvoice).toBe(500)
    expect(apSubledgerAfterInvoice - apSubledgerBeforeInvoice).toBe(500)

    // ---- Step 3: sell 20 units through POS (Dr COGS / Cr Inventory 200) ----
    const charge = await createAdHocCharge(session(), {
      patientId, branchId, sourceType: "product", productId: product.id,
      description: "Reconciliation test sale", quantity: 20, unitPrice: 25,
    })
    chargeIds.push(charge.id)

    // Reconciliation #3: selling reduces both Inventory Valuation and the
    // Inventory Asset GL account by the SAME COGS amount (20 x 10 = 200) —
    // the exact "stock decreases, COGS posted, valuation must decrease
    // consistently" example P1 §35 names.
    const inventoryAfterSale = await accountBalance(inventoryAccountId)
    const valuationAfterSale = (await getInventoryReport(session(), await reportRange())).valuation.find((v) => v.productId === product.id)?.value ?? 0
    expect(inventoryAfterReceipt - inventoryAfterSale).toBe(200)
    expect(valuationAfterReceipt - valuationAfterSale).toBe(200)
    // Balance also agrees: 50 received - 20 sold = 30 remaining @ 10 = 300 valuation.
    expect(valuationAfterSale).toBe(300)

    // ---- Step 4: invoice the charge (Dr AR / Cr Revenue 500) ----
    const arGlBeforeInvoice = await accountBalance(arAccountId)
    const arSubledgerBeforeInvoice = (await getFinancialReport(session(), await reportRange())).accountsReceivable
    const revenueBeforeInvoice = (await incomeStatement(session())).totalRevenue

    const invoice = await generateInvoice(session(), { patientId, branchId, chargeIds: [charge.id], discountAmount: 0 })
    invoiceIds.push(invoice.id)

    // Reconciliation #4: AR sub-ledger (Invoice.totalAmount - paidAmount)
    // and AR GL account (asset, trialBalance) both move by the identical
    // 500 this one invoice created — the same cross-check as AP above,
    // patient-billing side. Revenue (P&L, incomeStatement) also moves by
    // the identical amount — the "Sales Report" stand-in this file's own
    // header comment explains.
    const arGlAfterInvoice = await accountBalance(arAccountId)
    const arSubledgerAfterInvoice = (await getFinancialReport(session(), await reportRange())).accountsReceivable
    const revenueAfterInvoice = (await incomeStatement(session())).totalRevenue
    expect(arGlAfterInvoice - arGlBeforeInvoice).toBe(500)
    expect(arSubledgerAfterInvoice - arSubledgerBeforeInvoice).toBe(500)
    // Targeted backlog closure, item 10A (BACKLOG.md's documented flaky
    // test): `totalRevenue` is a Postgres `_sum` aggregate converted to a
    // JS `Number` once, then subtracted here — classic floating-point
    // cancellation between two large, nearly-equal doubles (observed once
    // as 499.9999999999991, not a real ledger imbalance; every underlying
    // DB value is still exact Decimal/NUMERIC). `toBeCloseTo(500, 6)` keeps
    // 6 decimal places of precision — far tighter than currency's real
    // 2-decimal display precision — so this still fails on any actual
    // financial discrepancy, just not on ~1e-13 float noise.
    expect(revenueAfterInvoice - revenueBeforeInvoice).toBeCloseTo(500, 6)

    // ---- Step 5: pay 300 (Dr Cash / Cr AR 300) ----
    await recordPayment(session(), { invoiceId: invoice.id, cashierSessionId, tenders: [{ method: "cash", amount: 300 }] })

    const arGlAfterPayment = await accountBalance(arAccountId)
    const arSubledgerAfterPayment = (await getFinancialReport(session(), await reportRange())).accountsReceivable
    // Reconciliation #5: paying down 300 of the 500 owed reduces both the
    // AR sub-ledger (org-wide aggregate — a delta, like everything else in
    // this file, since the shared dev database has other patients'
    // invoices already contributing to it) and the AR GL account by the
    // identical 300. This one invoice's own outstanding balance — a figure
    // scoped to just it, so an absolute check is meaningful here — sits at
    // exactly 200, the same number both org-wide deltas agree on.
    expect(arGlAfterInvoice - arGlAfterPayment).toBe(300)
    expect(arSubledgerAfterInvoice - arSubledgerAfterPayment).toBe(300)
    const invoiceAfterPayment = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    expect(Number(invoiceAfterPayment.totalAmount) - Number(invoiceAfterPayment.paidAmount)).toBe(200)

    // ---- Step 6: refund 100 (Dr Revenue / Cr Cash 100 — documented simplification, see below) ----
    const requested = await requestRefund(session(), { invoiceId: invoice.id, method: "cash", amount: 100, reason: "reconciliation test refund" })
    await authorizeRefund(session(), requested.id)
    await completeRefund(session(), requested.id, cashierSessionId)

    const arGlAfterRefund = await accountBalance(arAccountId)
    const arSubledgerAfterRefund = (await getFinancialReport(session(), await reportRange())).accountsReceivable
    const revenueAfterRefund = (await incomeStatement(session())).totalRevenue
    // Reconciliation #6 — the one KNOWN, already-documented divergence
    // (PROJECT_STATUS.md's "Refund posting is a documented simplification,
    // not a bug"): `postRefundCompleted` posts Dr Revenue / Cr Cash — it
    // never touches the AR account, which is the CORRECT entry for
    // refunding cash on an invoice that was already fully/partially paid
    // (a real AR reversal would only apply if the underlying charge itself
    // were also being voided). The AR *sub-ledger* figure here is derived
    // from `Invoice.paidAmount`, which `applyRefundAtomically` DOES
    // decrement — so the sub-ledger's "outstanding" rises back up by the
    // refunded amount while the GL AR account correctly does not move at
    // all. This test asserts that EXACT, already-understood shape rather
    // than silently treating a real design tradeoff as either a bug to
    // paper over or an invariant to blindly assert equal.
    expect(arGlAfterRefund).toBe(arGlAfterPayment) // GL AR: refund doesn't touch it — correct
    expect(arSubledgerAfterRefund - arSubledgerAfterPayment).toBe(100) // sub-ledger "outstanding": rises back up
    expect(revenueAfterInvoice - revenueAfterRefund).toBeCloseTo(100, 6) // P&L revenue: the refund's own real effect (Dr Revenue 100) — see item 10A's comment above on toBeCloseTo

    // ---- Step 7: pay the supplier invoice in full (Dr AP / Cr Cash 500) ----
    await recordSupplierPayment(session(), { supplierInvoiceId: supplierInvoice.id, method: "bank", amount: 500 })

    const apGlAfterPayment = await accountBalance(apAccountId)
    const apSubledgerAfterPayment = (await getFinancialReport(session(), await reportRange())).accountsPayable
    // Reconciliation #7: both AP figures return to exactly where they
    // started before step 2 — a full round trip, not just a directional check.
    expect(apGlAfterPayment).toBe(apGlBeforeInvoice)
    expect(apSubledgerAfterPayment).toBe(apSubledgerBeforeInvoice)

    // ---- Trial Balance and Balance Sheet stay internally consistent throughout ----
    const tb = await trialBalance(session())
    expect(tb.isBalanced).toBe(true)
    const bs = await balanceSheet(session())
    expect(bs.isBalanced).toBe(true)
    // P&L net income and the Balance Sheet's own "Retained Earnings
    // (current period)" line are the same figure, read two different ways —
    // not two independently-maintained numbers that could drift.
    const income = await incomeStatement(session())
    const retainedEarningsLine = bs.equityLines.find((l) => l.name === "Retained Earnings (current period)")
    expect(retainedEarningsLine?.amount).toBe(income.netIncome)
    // Widened from the shared TIMEOUT — this one test runs the full 7-step
    // chain (goods receipt, supplier invoice, POS sale, invoice, payment,
    // a 3-step refund, supplier payment) plus a trialBalance/
    // getFinancialReport/incomeStatement re-read after most of them, each
    // its own real round trip — genuinely more sequential work than 60s
    // reliably covers under this environment's real Supabase latency, the
    // same "one slow test gets its own larger number, not a raised shared
    // constant" precedent refund-payment-integrity.test.ts already set.
  }, 120000)
})
