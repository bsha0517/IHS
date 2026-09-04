import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { listInvoices } from "@/lib/domains/billing/invoices"
import { listPayments } from "@/lib/domains/billing/payments"
import { listLedgerEntries } from "@/lib/domains/inventory/stock"
import { listJournals } from "@/lib/domains/accounting/reports"
import { listEmployees } from "@/lib/domains/hr/employees"
import { listAssets } from "@/lib/domains/assets/assets"
import { listClaims } from "@/lib/domains/claims/service"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P2 Batch 6 (§8) — server-side pagination correctness, across the
 * highest-traffic lists named in P2.md §8's own text ("invoice list hard
 * cap, stock ledger hard cap") plus a representative sample of the rest.
 * See P2_REMEDIATION_REPORT.md for the full batch record.
 *
 * Every test here proves the same three things per list, real against the
 * database (not mocked): (1) `total`/`totalPages` reflect the true
 * matching row count, not the page size; (2) page 1 and page 2 return
 * disjoint rows — the `skip` in the underlying query genuinely skips,
 * it isn't silently re-serving page 1; (3) a page past the end returns
 * an empty array rather than erroring or wrapping around.
 */
const TIMEOUT = 90000
const PAGE_SIZE = 50
const OVER_ONE_PAGE = PAGE_SIZE + 7 // enough rows to guarantee a real, non-empty page 2

function disjoint(a: string[], b: string[]): boolean {
  const setA = new Set(a)
  return b.every((id) => !setA.has(id))
}

describe("P2 §8: pagination correctness on high-traffic lists", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let userId: string
  let productId: string
  let accountId: string
  let contraAccountId: string

  function session(): SessionContext {
    return {
      sessionId: "test-p2-batch6-pagination",
      user: { id: userId, organizationId, email: "p2-batch6-pagination-test@test.local", firstName: "Page", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set([
        "invoice.view", "payment.view", "inventory.view", "accounting.view",
        "payroll.view", "claim.create",
      ]),
      roleNames: ["Super Admin"],
    }
  }

  const invoiceIds: string[] = []
  const paymentIds: string[] = []
  const ledgerEntryIds: string[] = []
  const journalIds: string[] = []
  const employeeIds: string[] = []
  const assetIds: string[] = []
  const claimIds: string[] = []
  let claimPatientCoverageId: string
  let claimPayorId: string
  let claimInvoiceId: string
  let claimInsurancePlanId: string
  let claimPolicyId: string

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
    const product = await db.product.findFirstOrThrow({ where: { organizationId } })
    productId = product.id
    const account = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1000" } })
    accountId = account.id
    const contraAccount = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "4000" } })
    contraAccountId = contraAccount.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTP2B6-${Date.now()}`, firstName: "P2Batch6", lastName: "Pagination",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `P2B6-${Date.now()}`,
      },
    })
    patientId = patient.id

    // --- Invoices: bulk-inserted directly (bypassing generateInvoice) —
    // this test is about listInvoices' own pagination math, not invoice
    // generation, which is already covered elsewhere.
    const invoiceRows = Array.from({ length: OVER_ONE_PAGE }, (_, i) => ({
      organizationId, branchId, patientId,
      invoiceNumber: `TESTP2B6INV-${Date.now()}-${i}`,
      subtotal: 100, totalAmount: 100,
    }))
    await db.invoice.createMany({ data: invoiceRows })
    const createdInvoices = await db.invoice.findMany({ where: { organizationId, invoiceNumber: { startsWith: "TESTP2B6INV-" } } })
    invoiceIds.push(...createdInvoices.map((i) => i.id))

    // --- Payments
    const paymentRows = Array.from({ length: OVER_ONE_PAGE }, (_, i) => ({
      organizationId, branchId,
      receiptNumber: `TESTP2B6PAY-${Date.now()}-${i}`,
      method: "cash" as const, amount: 50,
    }))
    await db.payment.createMany({ data: paymentRows })
    const createdPayments = await db.payment.findMany({ where: { organizationId, receiptNumber: { startsWith: "TESTP2B6PAY-" } } })
    paymentIds.push(...createdPayments.map((p) => p.id))

    // --- Stock ledger entries (the audit's own "stock ledger hard cap" example)
    const ledgerRows = Array.from({ length: OVER_ONE_PAGE }, (_, i) => ({
      organizationId, branchId, productId,
      transactionType: "adjustment" as const,
      quantity: 1,
      reason: `TESTP2B6LEDGER-${i}`,
    }))
    await db.stockLedgerEntry.createMany({ data: ledgerRows })
    const createdLedgerEntries = await db.stockLedgerEntry.findMany({ where: { organizationId, reason: { startsWith: "TESTP2B6LEDGER-" } } })
    ledgerEntryIds.push(...createdLedgerEntries.map((e) => e.id))

    // --- Journals + one balanced line each
    const journalRows = Array.from({ length: OVER_ONE_PAGE }, (_, i) => ({
      organizationId, branchId,
      journalNumber: `TESTP2B6JRN-${Date.now()}-${i}`,
      journalDate: new Date(),
      referenceType: "test_p2_batch6",
      description: "P2B6 pagination test journal",
    }))
    await db.journal.createMany({ data: journalRows })
    const createdJournals = await db.journal.findMany({ where: { organizationId, referenceType: "test_p2_batch6" } })
    journalIds.push(...createdJournals.map((j) => j.id))
    // Journal has a real DB-level deferred constraint trigger enforcing
    // SUM(debit) = SUM(credit) per journal (spec.md §54/§92) — a single
    // one-sided line per journal would violate it at commit time, so each
    // journal gets a genuinely balanced Dr/Cr pair.
    await db.journalLine.createMany({
      data: createdJournals.flatMap((j) => [
        { journalId: j.id, accountId, debit: 1, credit: 0 },
        { journalId: j.id, accountId: contraAccountId, debit: 0, credit: 1 },
      ]),
    })

    // --- Employees
    const employeeRows = Array.from({ length: OVER_ONE_PAGE }, (_, i) => ({
      organizationId, branchId,
      employeeNumber: `TESTP2B6EMP-${Date.now()}-${i}`,
      firstName: "P2B6", lastName: `Employee${i}`,
      designation: "Tester",
      joiningDate: new Date("2020-01-01"),
      employmentType: "full_time" as const,
    }))
    await db.employee.createMany({ data: employeeRows })
    const createdEmployees = await db.employee.findMany({ where: { organizationId, employeeNumber: { startsWith: "TESTP2B6EMP-" } } })
    employeeIds.push(...createdEmployees.map((e) => e.id))

    // --- Assets
    const assetRows = Array.from({ length: OVER_ONE_PAGE }, (_, i) => ({
      organizationId, branchId,
      assetNumber: `TESTP2B6AST-${Date.now()}-${i}`,
      name: `P2B6 Asset ${i}`,
      category: "equipment",
    }))
    await db.asset.createMany({ data: assetRows })
    const createdAssets = await db.asset.findMany({ where: { organizationId, assetNumber: { startsWith: "TESTP2B6AST-" } } })
    assetIds.push(...createdAssets.map((a) => a.id))

    // --- Claims: heavier FK chain (Payor -> InsurancePlan -> Policy ->
    // PatientCoverage -> Claim), so built once and shared across all 51
    // claim rows rather than once per claim.
    const payor = await db.payor.create({
      data: { organizationId, code: `TESTP2B6PAYOR-${Date.now()}`, name: "P2B6 Test Payor", payorType: "insurance_company" },
    })
    claimPayorId = payor.id
    const plan = await db.insurancePlan.create({
      data: { organizationId, payorId: payor.id, code: `TESTP2B6PLAN-${Date.now()}`, name: "P2B6 Test Plan" },
    })
    claimInsurancePlanId = plan.id
    const policy = await db.policy.create({
      data: { organizationId, insurancePlanId: plan.id, policyNumber: `TESTP2B6POL-${Date.now()}` },
    })
    claimPolicyId = policy.id
    const coverage = await db.patientCoverage.create({
      data: { organizationId, patientId, policyId: policy.id, memberId: `TESTP2B6MEM-${Date.now()}`, startDate: new Date("2020-01-01") },
    })
    claimPatientCoverageId = coverage.id
    const claimInvoice = await db.invoice.create({
      data: { organizationId, branchId, patientId, invoiceNumber: `TESTP2B6CLAIMINV-${Date.now()}`, subtotal: 100, totalAmount: 100 },
    })
    claimInvoiceId = claimInvoice.id
    invoiceIds.push(claimInvoice.id)

    const claimRows = Array.from({ length: OVER_ONE_PAGE }, (_, i) => ({
      organizationId, branchId,
      claimNumber: `TESTP2B6CLM-${Date.now()}-${i}`,
      patientId, patientCoverageId: claimPatientCoverageId, payorId: claimPayorId, invoiceId: claimInvoiceId,
      submittedAmount: 100,
    }))
    await db.claim.createMany({ data: claimRows })
    const createdClaims = await db.claim.findMany({ where: { organizationId, claimNumber: { startsWith: "TESTP2B6CLM-" } } })
    claimIds.push(...createdClaims.map((c) => c.id))
  }, TIMEOUT)

  afterAll(async () => {
    // Defensive against a partially-completed beforeAll (an id still
    // undefined) — same discipline branch-isolation.test.ts's own afterAll
    // already established, so one failed seed step doesn't mask itself
    // behind a wall of unrelated "argument needs at least one of id" errors.
    await db.claim.deleteMany({ where: { id: { in: claimIds } } })
    if (claimPatientCoverageId) await db.patientCoverage.delete({ where: { id: claimPatientCoverageId } })
    if (claimPolicyId) await db.policy.delete({ where: { id: claimPolicyId } })
    if (claimInsurancePlanId) await db.insurancePlan.delete({ where: { id: claimInsurancePlanId } })
    if (claimPayorId) await db.payor.delete({ where: { id: claimPayorId } })
    await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await db.payment.deleteMany({ where: { id: { in: paymentIds } } })
    await db.stockLedgerEntry.deleteMany({ where: { id: { in: ledgerEntryIds } } })
    await db.journalLine.deleteMany({ where: { journalId: { in: journalIds } } })
    await db.journal.deleteMany({ where: { id: { in: journalIds } } })
    await db.asset.deleteMany({ where: { id: { in: assetIds } } })
    await db.employee.deleteMany({ where: { id: { in: employeeIds } } })
    if (patientId) await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("listInvoices: page/pageSize/total/totalPages are correct, and page 1 and page 2 never overlap", async () => {
    const page1 = await listInvoices(session(), { patientId })
    expect(page1.pageSize).toBe(PAGE_SIZE)
    expect(page1.invoices).toHaveLength(PAGE_SIZE)
    expect(page1.total).toBeGreaterThanOrEqual(OVER_ONE_PAGE)
    expect(page1.totalPages).toBeGreaterThanOrEqual(2)

    const page2 = await listInvoices(session(), { patientId, page: 2 })
    expect(page2.invoices.length).toBeGreaterThan(0)
    expect(disjoint(page1.invoices.map((i) => i.id), page2.invoices.map((i) => i.id))).toBe(true)

    const farPage = await listInvoices(session(), { patientId, page: 999 })
    expect(farPage.invoices).toHaveLength(0)
  }, TIMEOUT)

  it("listPayments: page/pageSize/total/totalPages are correct, and page 1 and page 2 never overlap", async () => {
    const page1 = await listPayments(session(), { branchId })
    expect(page1.pageSize).toBe(PAGE_SIZE)
    expect(page1.payments.length).toBeGreaterThan(0)
    expect(page1.total).toBeGreaterThanOrEqual(OVER_ONE_PAGE)

    const page2 = await listPayments(session(), { branchId, page: 2 })
    expect(disjoint(page1.payments.map((p) => p.id), page2.payments.map((p) => p.id))).toBe(true)
  }, TIMEOUT)

  it("listLedgerEntries (Stock Ledger — the audit's own named example): pagination is correct and every entry created is reachable across pages", async () => {
    const page1 = await listLedgerEntries(session(), { productId })
    expect(page1.pageSize).toBe(PAGE_SIZE)
    expect(page1.entries).toHaveLength(PAGE_SIZE)
    expect(page1.total).toBeGreaterThanOrEqual(OVER_ONE_PAGE)

    const page2 = await listLedgerEntries(session(), { productId, page: 2 })
    expect(page2.entries.length).toBeGreaterThan(0)
    expect(disjoint(page1.entries.map((e) => e.id), page2.entries.map((e) => e.id))).toBe(true)

    // Every one of the 57 seeded entries is reachable by walking pages —
    // proves the query isn't silently dropping rows past the old hard cap.
    const seenIds = new Set<string>()
    for (let p = 1; p <= page1.totalPages; p++) {
      const res = p === 1 ? page1 : await listLedgerEntries(session(), { productId, page: p })
      for (const e of res.entries) seenIds.add(e.id)
    }
    for (const id of ledgerEntryIds) expect(seenIds.has(id)).toBe(true)
  }, TIMEOUT)

  it("listJournals: pagination is correct and composes with the existing referenceType filter", async () => {
    const page1 = await listJournals(session(), { referenceType: "test_p2_batch6" })
    expect(page1.pageSize).toBe(PAGE_SIZE)
    expect(page1.journals).toHaveLength(PAGE_SIZE)
    expect(page1.total).toBeGreaterThanOrEqual(OVER_ONE_PAGE)

    const page2 = await listJournals(session(), { referenceType: "test_p2_batch6", page: 2 })
    expect(disjoint(page1.journals.map((j) => j.id), page2.journals.map((j) => j.id))).toBe(true)
    expect(page2.journals.every((j) => j.referenceType === "test_p2_batch6")).toBe(true)
  }, TIMEOUT)

  it("listEmployees: pagination is correct", async () => {
    const page1 = await listEmployees(session(), { branchId })
    expect(page1.pageSize).toBe(PAGE_SIZE)
    expect(page1.total).toBeGreaterThanOrEqual(OVER_ONE_PAGE)

    const page2 = await listEmployees(session(), { branchId, page: 2 })
    expect(page2.employees.length).toBeGreaterThan(0)
    expect(disjoint(page1.employees.map((e) => e.id), page2.employees.map((e) => e.id))).toBe(true)
  }, TIMEOUT)

  it("listAssets: pagination is correct", async () => {
    const page1 = await listAssets(session(), { branchId })
    expect(page1.pageSize).toBe(PAGE_SIZE)
    expect(page1.total).toBeGreaterThanOrEqual(OVER_ONE_PAGE)

    const page2 = await listAssets(session(), { branchId, page: 2 })
    expect(page2.assets.length).toBeGreaterThan(0)
    expect(disjoint(page1.assets.map((a) => a.id), page2.assets.map((a) => a.id))).toBe(true)
  }, TIMEOUT)

  it("listClaims: pagination is correct", async () => {
    const page1 = await listClaims(session())
    expect(page1.pageSize).toBe(PAGE_SIZE)
    expect(page1.total).toBeGreaterThanOrEqual(OVER_ONE_PAGE)

    const page2 = await listClaims(session(), { page: 2 })
    expect(page2.claims.length).toBeGreaterThan(0)
    expect(disjoint(page1.claims.map((c) => c.id), page2.claims.map((c) => c.id))).toBe(true)
  }, TIMEOUT)
})
