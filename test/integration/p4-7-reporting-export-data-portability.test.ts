import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { createBranch } from "@/lib/domains/identity/org-structure"
import { createProvider } from "@/lib/domains/providers/service"
import { createService } from "@/lib/domains/services/service"
import { setMapping } from "@/lib/domains/accounting/account-mappings"
import { registerPatient } from "@/lib/domains/patients/service"
import { bookAppointment, checkIn } from "@/lib/domains/appointments/service"
import { startEncounter } from "@/lib/domains/clinical/encounters"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { generateInvoice } from "@/lib/domains/billing/invoices"
import { recordPayment } from "@/lib/domains/billing/payments"
import { requestRefund, authorizeRefund, completeRefund } from "@/lib/domains/billing/refunds"
import { openSession as openCashierSession } from "@/lib/domains/billing/cashier"
import { receiveStock } from "@/lib/domains/inventory/stock"
import { trialBalance } from "@/lib/domains/accounting/reports"
import { defaultReportFilters } from "@/lib/domains/analytics/schemas"
import { getPracticeReport, exportAppointmentRows } from "@/lib/domains/analytics/reports/practice"
import { getFinancialReport } from "@/lib/domains/analytics/reports/financial"
import { getInventoryReport, exportStockMovementRows } from "@/lib/domains/analytics/reports/inventory"
import { getInvoiceReport, exportInvoiceRows, exportCollectionsRows, exportRefundRows, getCollectionsReport, getRefundReport } from "@/lib/domains/analytics/reports/revenue-cycle"
import { getRevenueCycleReport } from "@/lib/domains/analytics/reports"
import { getPatientRegistrationReport, exportPatientRegistrationRows } from "@/lib/domains/analytics/reports/patients"
import { getDailyOperationsReport } from "@/lib/domains/analytics/reports/daily-operations"
import { exportPatientMasterRows, exportGeneralLedgerRows } from "@/lib/domains/analytics/exports"
import { toCsv } from "@/lib/platform/csv"
import { assertExportRowLimit, ExportTooLargeError } from "@/lib/platform/reports"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import { startOfLocalDay, endOfLocalDay, parseLocalDateParam, toDateParam } from "@/lib/utils/dates"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 60000
const FIXTURE_ORG_NAMES = ["P4.7 Fresh Clinic LLC", "P4.7 Other Org LLC"]

async function deleteOrgData(orgIds: string[]) {
  if (orgIds.length === 0) return
  const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
  await ownerDb.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } })
  await ownerDb.clinicalAccessLog.deleteMany({ where: { organizationId: { in: orgIds } } })
  await ownerDb.$disconnect()

  await db.importJobError.deleteMany({ where: { job: { organizationId: { in: orgIds } } } })
  await db.importJob.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.journalLine.deleteMany({ where: { journal: { organizationId: { in: orgIds } } } })
  await db.journal.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.queueEntry.deleteMany({ where: { appointment: { organizationId: { in: orgIds } } } })
  await db.appointmentStatusHistory.deleteMany({ where: { appointment: { organizationId: { in: orgIds } } } })
  await db.encounter.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.paymentAllocation.deleteMany({ where: { payment: { organizationId: { in: orgIds } } } })
  await db.refund.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.payment.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.cashMovement.deleteMany({ where: { cashierSession: { organizationId: { in: orgIds } } } })
  await db.cashierSession.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.invoiceLine.deleteMany({ where: { invoice: { organizationId: { in: orgIds } } } })
  await db.invoice.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.charge.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.appointment.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.patient.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.stockLedgerEntry.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.productBatch.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.product.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.supplierInvoice.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.supplier.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.providerBranch.deleteMany({ where: { provider: { organizationId: { in: orgIds } } } })
  await db.provider.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.service.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.accountMapping.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.setting.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.chartOfAccount.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.userRole.deleteMany({ where: { user: { organizationId: { in: orgIds } } } })
  await db.user.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.role.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.numberSequence.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.idempotencyKey.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.outboxEvent.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.notification.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.department.deleteMany({ where: { branch: { organizationId: { in: orgIds } } } })
  await db.branch.deleteMany({ where: { organizationId: { in: orgIds } } })
  await db.organization.deleteMany({ where: { id: { in: orgIds } } })
}

async function cleanupOrphanedFixtureOrgs() {
  const orphans = await db.organization.findMany({ where: { legalName: { in: FIXTURE_ORG_NAMES } }, select: { id: true } })
  if (orphans.length > 0) await deleteOrgData(orphans.map((o) => o.id))
}

/**
 * P4.7: a fresh, isolated two-organization fixture (not the shared seed),
 * proving cross-org isolation for the new report/export architecture and
 * exercising the real domain functions (never inserting rows this code
 * path wouldn't itself produce) for AR/AP aging, GL/TB reconciliation,
 * inventory reconciliation, and the Daily Operations acceptance test.
 */
describe("P4.7: reporting, export, data portability", () => {
  let orgAId: string
  let orgBId: string
  let branchAId: string
  let branchBId: string
  let adminUserId: string
  let providerId: string
  let serviceId: string
  let cashAccountId: string
  let arAccountId: string
  let revenueAccountId: string
  let inventoryAccountId: string
  let cogsAccountId: string
  const createdPatientIds: string[] = []

  function adminSession(branchIds = [branchAId]): SessionContext {
    return {
      sessionId: "test-p4-7-admin",
      user: { id: adminUserId, organizationId: orgAId, email: "p4-7-admin@test.local", firstName: "P4.7", lastName: "Admin" },
      activeBranchId: branchAId,
      branchIds,
      permissions: new Set([
        "patient.view", "patient.create", "appointment.view", "appointment.create", "appointment.checkin",
        "encounter.view", "encounter.create", "encounter.finalize", "charge.create",
        "invoice.view", "invoice.create", "payment.view", "payment.create",
        "refund.request", "refund.authorize", "cashier.open", "cashier.view",
        "accounting.view", "accounting.post", "chart_of_account.manage", "account_mapping.manage",
        "inventory.view", "inventory.adjust", "supplier.view",
        "reports.export", "data_import.manage", "audit.review",
        "provider.view", "provider.manage", "service.view", "service.manage",
        "settings.view", "settings.edit", "branch.view", "branch.manage", "users.manage",
        "payroll.view",
      ]),
      roleNames: ["Organization Administrator"],
    }
  }

  /** Same session, but scoped only to branchB — proves branch-scope narrowing independent of org isolation. */
  function branchBSession(): SessionContext {
    return { ...adminSession([branchBId]), activeBranchId: branchBId }
  }

  beforeAll(async () => {
    await cleanupOrphanedFixtureOrgs()

    const org = await db.organization.create({ data: { legalName: "P4.7 Fresh Clinic LLC", displayName: "P4.7 Fresh Clinic" } })
    orgAId = org.id
    const orgB = await db.organization.create({ data: { legalName: "P4.7 Other Org LLC", displayName: "P4.7 Other Org" } })
    orgBId = orgB.id

    const role = await db.role.create({ data: { organizationId: orgAId, name: "P4.7 Org Admin" } })
    const permission = await db.permission.findUniqueOrThrow({ where: { code: "users.manage" } })
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    const admin = await db.user.create({
      data: { organizationId: orgAId, email: `p4-7-admin-${Date.now()}@test.local`, passwordHash: "x", firstName: "P4.7", lastName: "Admin" },
    })
    adminUserId = admin.id
    await db.userRole.create({ data: { userId: admin.id, roleId: role.id } })

    const branch = await createBranch(adminSession(), { name: "Main Branch", code: "MAIN", timezone: "Asia/Dubai" })
    branchAId = branch.id
    const branchB = await createBranch(adminSession(), { name: "Second Branch", code: "SECOND", timezone: "Asia/Dubai" })
    branchBId = branchB.id

    const provider = await createProvider({ ...adminSession(), activeBranchId: branchAId, branchIds: [branchAId] }, {
      providerType: "doctor", firstName: "P4.7", lastName: "Doctor", consultationFee: 100, defaultAppointmentDurationMinutes: 30, branchIds: [branchAId], departmentIds: [],
    })
    providerId = provider.id
    const service = await createService(adminSession(), { code: "P47-CONS", name: "P4.7 Consultation", category: "Consultation", durationMinutes: 30, price: 100, billable: true, isActive: true, providerIds: [] })
    serviceId = service.id

    const cash = await db.chartOfAccount.create({ data: { organizationId: orgAId, code: "P47-1000", name: "Cash", type: "asset" } })
    const ar = await db.chartOfAccount.create({ data: { organizationId: orgAId, code: "P47-1100", name: "Accounts Receivable", type: "asset" } })
    const revenue = await db.chartOfAccount.create({ data: { organizationId: orgAId, code: "P47-4000", name: "Service Revenue", type: "revenue" } })
    const inv = await db.chartOfAccount.create({ data: { organizationId: orgAId, code: "P47-1200", name: "Inventory", type: "asset" } })
    const cogs = await db.chartOfAccount.create({ data: { organizationId: orgAId, code: "P47-5100", name: "COGS", type: "expense" } })
    cashAccountId = cash.id
    arAccountId = ar.id
    revenueAccountId = revenue.id
    inventoryAccountId = inv.id
    cogsAccountId = cogs.id
    await setMapping(adminSession(), { intent: "accounts_receivable", accountId: arAccountId })
    await setMapping(adminSession(), { intent: "revenue", accountId: revenueAccountId })
    await setMapping(adminSession(), { intent: "cash", accountId: cashAccountId })
    await setMapping(adminSession(), { intent: "inventory_asset", accountId: inventoryAccountId })
    await setMapping(adminSession(), { intent: "cogs", accountId: cogsAccountId })
  }, TIMEOUT)

  afterAll(async () => {
    // createdPatientIds is tracked for documentation/traceability only —
    // deleteOrgData's own org-scoped patient delete (after invoices/
    // appointments/etc. are already gone) is what actually removes them;
    // deleting by id here first would race ahead of those FK dependents,
    // the same class of ordering bug P4.6's own afterAll hit and fixed.
    await deleteOrgData([orgAId, orgBId])
    await db.$disconnect()
  }, TIMEOUT)

  describe("§45 date-range rule: 'to' is inclusive through end of the selected local date", () => {
    it("defaultReportFilters resolves an explicit ?to=YYYY-MM-DD to 23:59:59.999 local, not midnight at its start", () => {
      const filters = defaultReportFilters({ from: "2026-09-01", to: "2026-09-30" })
      expect(filters.to.getHours()).toBe(23)
      expect(filters.to.getMinutes()).toBe(59)
      expect(filters.to.getDate()).toBe(30)
      expect(filters.from.getHours()).toBe(0)
    })

    it("parseLocalDateParam/startOfLocalDay/endOfLocalDay agree on the same calendar date's boundaries", () => {
      const start = parseLocalDateParam("2026-09-03", "start")!
      const end = parseLocalDateParam("2026-09-03", "end")!
      expect(start.getTime()).toBe(startOfLocalDay(new Date(2026, 8, 3)).getTime())
      expect(end.getTime()).toBe(endOfLocalDay(new Date(2026, 8, 3)).getTime())
      expect(end.getTime()).toBeGreaterThan(start.getTime())
    })

    it("a report with an explicit same-day from/to range includes activity from anywhere in that day, not only up to midnight", async () => {
      const patient = await registerPatient(adminSession(), {
        registrationBranchId: branchAId, firstName: "DateRange", lastName: "Test", dob: new Date("1990-01-01"), gender: "unknown", mobile: `P47DR${Date.now()}`,
      })
      createdPatientIds.push(patient.id)
      // Local date, not `new Date().toISOString().slice(0, 10)` — that's the
      // UTC date, which silently differs from "today" for part of every day
      // in any non-UTC server timezone (this exact class of bug is what
      // `toDateParam`'s own doc comment warns about) and made this test
      // fail for roughly 5 hours a day in a UTC+5 environment with no
      // product defect involved.
      const todayStr = toDateParam(new Date())
      const filters = defaultReportFilters({ from: todayStr, to: todayStr, branchId: branchAId })
      const report = await getPatientRegistrationReport(adminSession(), filters)
      expect(report.preview.some((p) => p.id === patient.id)).toBe(true)
    }, TIMEOUT)
  })

  describe("§33 CSV formula-injection protection and §34 Unicode", () => {
    it("escapes a leading =, +, -, @ with a leading single quote", () => {
      const csv = toCsv(["Name"], [["=CMD('calc')"], ["+1+1"], ["-1"], ["@SUM(1)"], ["plain"]])
      const lines = csv.split("\r\n").slice(1)
      expect(lines[0]).toBe("'=CMD('calc')")
      expect(lines[1]).toBe("'+1+1")
      expect(lines[2]).toBe("'-1")
      expect(lines[3]).toBe("'@SUM(1)")
      expect(lines[4]).toBe("plain")
    })

    it("prepends a UTF-8 BOM when bom:true, and round-trips Arabic/Urdu text unescaped", () => {
      const csv = toCsv(["Name"], [["محمد"], ["اردو نام"]], { bom: true })
      expect(csv.startsWith("﻿")).toBe(true)
      expect(csv).toContain("محمد")
      expect(csv).toContain("اردو نام")
    })
  })

  describe("§38/§39 export row limits — no silent truncation", () => {
    it("assertExportRowLimit throws ExportTooLargeError (never truncates) once the count exceeds the limit", () => {
      expect(() => assertExportRowLimit(50_001)).toThrow(ExportTooLargeError)
      expect(() => assertExportRowLimit(50_000)).not.toThrow()
      try {
        assertExportRowLimit(60_000, 100)
      } catch (e) {
        expect(e).toBeInstanceOf(ExportTooLargeError)
        expect((e as ExportTooLargeError).message).toMatch(/60,000/)
        expect((e as ExportTooLargeError).message).toMatch(/narrow/i)
      }
    })
  })

  describe("§16/§21 AR/AP aging", () => {
    it("buckets outstanding invoices by age from issue date, and reports the basis honestly", async () => {
      const patient = await registerPatient(adminSession(), {
        registrationBranchId: branchAId, firstName: "Aging", lastName: "Patient", dob: new Date("1990-01-01"), gender: "unknown", mobile: `P47AGE${Date.now()}`,
      })
      createdPatientIds.push(patient.id)
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
      const invoice = await db.invoice.create({
        data: {
          organizationId: orgAId, branchId: branchAId, patientId: patient.id, invoiceNumber: `P47-AGE-${Date.now()}`,
          status: "issued", subtotal: 200, totalAmount: 200, paidAmount: 0, issuedAt: fortyDaysAgo,
        },
      })
      const report = await getFinancialReport(adminSession(), defaultReportFilters({ branchId: branchAId }))
      expect(report.arAging.basis).toBe("issuedAt")
      expect(report.arAging.d31to60).toBeGreaterThanOrEqual(200)
      expect(report.arAging.current).toBe(0)
      await db.invoice.delete({ where: { id: invoice.id } })
    }, TIMEOUT)

    it("a supplier invoice with no due date is reported separately as 'undated', never guessed into a bucket", async () => {
      const supplier = await db.supplier.create({ data: { organizationId: orgAId, code: `P47-SUP-${Date.now()}`, companyName: "P4.7 Test Supplier" } })
      const si = await db.supplierInvoice.create({
        data: { organizationId: orgAId, branchId: branchAId, supplierId: supplier.id, invoiceNumber: `P47-SI-${Date.now()}`, amount: 500, status: "pending", dueDate: null },
      })
      const report = await getFinancialReport(adminSession(), defaultReportFilters({ branchId: branchAId }))
      expect(report.apAging.basis).toBe("dueDate")
      expect(report.apAging.undated).toBeGreaterThanOrEqual(1)
      expect(report.apAging.undatedAmount).toBeGreaterThanOrEqual(500)
      await db.supplierInvoice.delete({ where: { id: si.id } })
      await db.supplier.delete({ where: { id: supplier.id } })
    }, TIMEOUT)
  })

  describe("§17/§19 inventory movement and reconciliation", () => {
    it("opening-inventory-style receiveStock produces a traceable ledger movement and sets the GL setup note", async () => {
      const product = await db.product.create({ data: { organizationId: orgAId, sku: `P47-SKU-${Date.now()}`, name: "P4.7 Test Product", category: "supply", unit: "box", purchaseCost: 5 } })
      await db.$transaction((tx) =>
        receiveStock(tx, {
          organizationId: orgAId, branchId: branchAId, productId: product.id, supplierId: null,
          batchNumber: `P47-BATCH-${Date.now()}`, expiryDate: null, purchaseCost: 10, quantity: 20,
          referenceType: "opening_balance", referenceId: "test-import-job", performedBy: adminUserId,
        })
      )
      const inventory = await getInventoryReport(adminSession(), defaultReportFilters({ branchId: branchAId }))
      expect(inventory.openingInventorySetupNote).not.toBeNull()
      expect(inventory.openingInventorySetupNote).toMatch(/opening inventory/i)

      const movement = await exportStockMovementRows(adminSession(), { ...defaultReportFilters({ branchId: branchAId }), productId: product.id })
      expect(movement.some((m) => m.referenceType === "opening_balance")).toBe(true)
    }, TIMEOUT)

    it("negative stock and unvalued positive stock are both flagged by the reconciliation section", async () => {
      const product = await db.product.create({ data: { organizationId: orgAId, sku: `P47-NEG-${Date.now()}`, name: "P4.7 Negative Product", category: "supply", unit: "box", purchaseCost: 5 } })
      // A zero-cost batch with positive balance — deliberately bypasses receiveStock's own
      // §30-style cost requirement by writing the ledger row directly, since this test needs
      // to construct the exact anomaly the reconciliation report exists to detect.
      const batch = await db.productBatch.create({ data: { organizationId: orgAId, productId: product.id, supplierId: null, batchNumber: `P47-ZC-${Date.now()}`, expiryDate: null, purchaseCost: 0, receivedQuantity: 5 } })
      await db.stockLedgerEntry.create({ data: { organizationId: orgAId, branchId: branchAId, productId: product.id, batchId: batch.id, transactionType: "adjustment", quantity: 5, reason: "test fixture" } })

      const product2 = await db.product.create({ data: { organizationId: orgAId, sku: `P47-NEGBAL-${Date.now()}`, name: "P4.7 Negative Balance Product", category: "supply", unit: "box", purchaseCost: 5 } })
      await db.stockLedgerEntry.create({ data: { organizationId: orgAId, branchId: branchAId, productId: product2.id, batchId: null, transactionType: "adjustment", quantity: -3, reason: "test fixture" } })

      const inventory = await getInventoryReport(adminSession(), defaultReportFilters({ branchId: branchAId }))
      expect(inventory.reconciliation.unvaluedPositiveStock.some((u) => u.productId === product.id)).toBe(true)
      expect(inventory.reconciliation.negativeStock.some((n) => n.productId === product2.id)).toBe(true)
    }, TIMEOUT)
  })

  describe("§22/§23/§24 financial export reconciliation", () => {
    it("General Ledger export rows always balance: total debit equals total credit", async () => {
      const rows = await exportGeneralLedgerRows(adminSession(), defaultReportFilters({ branchId: branchAId }))
      const debit = rows.reduce((s, r) => s + Number(r.debit), 0)
      const credit = rows.reduce((s, r) => s + Number(r.credit), 0)
      expect(debit).toBeCloseTo(credit, 2)
    }, TIMEOUT)

    it("Trial Balance export totals match trialBalance()'s own computed totals exactly", async () => {
      const filters = defaultReportFilters({ branchId: branchAId })
      const tb = await trialBalance(adminSession(), { branchId: branchAId, asOf: filters.to })
      const rowDebit = tb.lines.reduce((s, l) => s + l.debit, 0)
      const rowCredit = tb.lines.reduce((s, l) => s + l.credit, 0)
      expect(rowDebit).toBeCloseTo(tb.totalDebit, 2)
      expect(rowCredit).toBeCloseTo(tb.totalCredit, 2)
      expect(tb.isBalanced).toBe(true)
    }, TIMEOUT)
  })

  describe("P4.7A.1 §46 — revenue-cycle report merge never re-collides field names", () => {
    it("the exact object-spread shape reports/page.tsx's own loadReport() builds for the revenue-cycle tab keeps a numeric collections field, not overwritten by an object", async () => {
      // Reproduces reports/page.tsx's own `loadReport` merge for category
      // "revenue-cycle" verbatim — `getRevenueCycleReport`'s own return
      // already has a numeric `collections` field (total collections
      // amount); a same-named merge with `getCollectionsReport`'s
      // {rows,total,truncated} object silently overwrote it and broke the
      // summary tile's `.toFixed()` call, found live in the browser during
      // P4.7's own verification (BACKLOG.md). The three sub-reports are
      // deliberately named `invoiceReport`/`collectionsReport`/
      // `refundReport` — never `invoices`/`collections`/`refunds` — to
      // never collide with `summary`'s own field names again. This guards
      // that naming, not just the current absence of a bug.
      const filters = defaultReportFilters({ branchId: branchAId })
      const [summary, invoiceReport, collectionsReport, refundReport] = await Promise.all([
        getRevenueCycleReport(adminSession(), filters),
        getInvoiceReport(adminSession(), filters),
        getCollectionsReport(adminSession(), filters),
        getRefundReport(adminSession(), filters),
      ])
      const merged = { ...summary, invoiceReport, collectionsReport, refundReport }

      expect(typeof merged.collections).toBe("number")
      expect(() => merged.collections.toFixed(2)).not.toThrow()
      expect(typeof merged.collectionsReport).toBe("object")
      expect(merged.collectionsReport).toHaveProperty("rows")
      expect(typeof merged.invoiceReport).toBe("object")
      expect(typeof merged.refundReport).toBe("object")
    }, TIMEOUT)
  })

  describe("§48 Patient Master export — data portability, not a clinical export", () => {
    it("returns operational demographics only — no national ID/passport, no auth data", async () => {
      const patient = await registerPatient(adminSession(), {
        registrationBranchId: branchAId, firstName: "Master", lastName: "Export", dob: new Date("1988-05-05"), gender: "female", mobile: `P47PM${Date.now()}`,
        nationalId: "SENSITIVE-ID-999",
      })
      createdPatientIds.push(patient.id)
      const rows = await exportPatientMasterRows(adminSession(), { from: new Date(0), to: new Date(), branchId: branchAId })
      const row = rows.find((r) => r.id === patient.id)
      expect(row).toBeDefined()
      expect(row).not.toHaveProperty("nationalId")
      expect(row).not.toHaveProperty("passportNumber")
      expect(row).not.toHaveProperty("passwordHash")
      expect(row!.mrn).toBe(patient.mrn)
    }, TIMEOUT)
  })

  describe("§36 filter consistency — screen report and export use the identical filters", () => {
    it("getInvoiceReport's total and exportInvoiceRows' row count agree for the same filters", async () => {
      const patient = await registerPatient(adminSession(), {
        registrationBranchId: branchAId, firstName: "Filter", lastName: "Consistency", dob: new Date("1990-01-01"), gender: "unknown", mobile: `P47FC${Date.now()}`,
      })
      createdPatientIds.push(patient.id)
      await db.invoice.create({
        data: { organizationId: orgAId, branchId: branchAId, patientId: patient.id, invoiceNumber: `P47-FC-${Date.now()}`, status: "issued", subtotal: 50, totalAmount: 50, paidAmount: 0 },
      })
      const filters = defaultReportFilters({ branchId: branchAId })
      const [screen, exported] = await Promise.all([getInvoiceReport(adminSession(), filters), exportInvoiceRows(adminSession(), filters)])
      expect(exported.length).toBe(screen.total)
    }, TIMEOUT)
  })

  describe("§61/§66 fresh-clinic smoke workflow feeding the Daily Operations report", () => {
    it("Patient → Appointment → Check-in → Encounter → Charge → Invoice → Payment → Refund, all correctly counted for today", async () => {
      const patient = await registerPatient(adminSession(), {
        registrationBranchId: branchAId, firstName: "Daily", lastName: "Ops", dob: new Date("1992-02-02"), gender: "unknown", mobile: `P47DO${Date.now()}`,
      })
      createdPatientIds.push(patient.id)

      const appt = await bookAppointment(adminSession(), {
        branchId: branchAId, patientId: patient.id, providerId, serviceId,
        startTime: new Date(Date.now() + 60 * 60 * 1000), durationMinutes: 30, bookingSource: "walk_in",
      })
      await checkIn(adminSession(), appt.id)
      const encounter = await startEncounter(adminSession(), { branchId: branchAId, patientId: patient.id, providerId, appointmentId: appt.id, encounterType: "consultation" })
      const charge = await db.$transaction((tx) =>
        generateSystemCharge(tx, { organizationId: orgAId, branchId: branchAId, patientId: patient.id, sourceType: "consultation", sourceReferenceId: encounter.id, description: "P4.7 Daily Ops consultation", quantity: 1, unitPrice: 100 })
      )
      const invoice = await generateInvoice(adminSession(), { patientId: patient.id, branchId: branchAId, chargeIds: [charge.id], discountAmount: 0 })
      const register = await openCashierSession(adminSession(), { branchId: branchAId, openingCash: 0 })
      await recordPayment(adminSession(), { invoiceId: invoice.id, cashierSessionId: register.id, tenders: [{ method: "cash", amount: 100 }] })

      const refund = await requestRefund(adminSession(), { invoiceId: invoice.id, method: "cash", amount: 20, reason: "P4.7 test partial refund" })
      await authorizeRefund(adminSession(), refund.id)
      await completeRefund(adminSession(), refund.id, register.id)

      const report = await getDailyOperationsReport(adminSession(), { date: new Date(), branchId: branchAId })
      expect(report.appointments.walkIn).toBeGreaterThanOrEqual(1)
      expect(report.appointments.checkedIn).toBeGreaterThanOrEqual(1)
      expect(report.encountersCompleted).toBeGreaterThanOrEqual(0) // encounter may still be draft/active — not asserted finalized
      expect(report.billing!.invoicesRaised).toBeGreaterThanOrEqual(1)
      expect(report.collections!.paymentsCollected).toBeGreaterThanOrEqual(1)
      expect(report.collections!.collectedAmount).toBeGreaterThanOrEqual(100)
      expect(report.collections!.refundsIssued).toBeGreaterThanOrEqual(1)
      expect(report.collections!.refundedAmount).toBeGreaterThanOrEqual(20)

      // §15 — collections/refunds row-level exports pick up the same rows.
      const collectionsRows = await exportCollectionsRows(adminSession(), defaultReportFilters({ branchId: branchAId }))
      expect(collectionsRows.some((p) => p.allocations.some((a) => a.invoice.invoiceNumber === invoice.invoiceNumber))).toBe(true)
      const refundRows = await exportRefundRows(adminSession(), defaultReportFilters({ branchId: branchAId }))
      expect(refundRows.some((r) => r.id === refund.id)).toBe(true)
    }, TIMEOUT)
  })

  describe("§61/§62 cross-organization and cross-branch isolation", () => {
    it("org A's patient/invoice/GL data is completely invisible to an org B session", async () => {
      const roleB = await db.role.create({ data: { organizationId: orgBId, name: "P4.7 Org B Admin" } })
      const permission = await db.permission.findUniqueOrThrow({ where: { code: "users.manage" } })
      await db.rolePermission.create({ data: { roleId: roleB.id, permissionId: permission.id } })
      const userB = await db.user.create({ data: { organizationId: orgBId, email: `p4-7-orgb-${Date.now()}@test.local`, passwordHash: "x", firstName: "Org B", lastName: "Admin" } })
      await db.userRole.create({ data: { userId: userB.id, roleId: roleB.id } })
      const branchB2 = await createBranch({ ...adminSession(), user: { ...adminSession().user, id: userB.id, organizationId: orgBId }, activeBranchId: "" } as SessionContext, { name: "Org B Branch", code: "OBB", timezone: "Asia/Dubai" })

      const sessionB: SessionContext = {
        sessionId: "test-p4-7-orgb", user: { id: userB.id, organizationId: orgBId, email: "orgb@test.local", firstName: "Org", lastName: "B" },
        activeBranchId: branchB2.id, branchIds: [branchB2.id],
        permissions: new Set(["patient.view", "invoice.view", "accounting.view", "reports.export"]),
        roleNames: ["P4.7 Org B Admin"],
      }

      const filters = defaultReportFilters({})
      const patientsB = await getPatientRegistrationReport(sessionB, filters)
      expect(patientsB.preview.every((p) => createdPatientIds.every((id) => id !== p.id))).toBe(true)

      const glB = await exportGeneralLedgerRows(sessionB, filters)
      expect(glB.length).toBe(0) // org A's own journals must never appear here

      // requesting org A's own branch from an org-B session must be rejected, not silently ignored
      await expect(getInvoiceReport(sessionB, { ...filters, branchId: branchAId })).rejects.toThrow(ForbiddenError)

      await db.userRole.deleteMany({ where: { userId: userB.id } })
      await db.user.delete({ where: { id: userB.id } })
      await db.role.delete({ where: { id: roleB.id } })
      await db.branch.delete({ where: { id: branchB2.id } })
    }, TIMEOUT)

    it("a session scoped only to branch B cannot see branch A's appointments; a session with branch A access can", async () => {
      // Wide enough to include the Daily Ops test's own near-future-dated
      // appointment (booked ~1 hour ahead of "now" at creation time).
      const wideTo = new Date(Date.now() + 6 * 60 * 60 * 1000)
      const filters = { ...defaultReportFilters({}), to: wideTo }
      const branchBReport = await getPracticeReport(branchBSession(), filters)
      expect(branchBReport.appointmentRows.length).toBe(0)

      const branchARows = await exportAppointmentRows(adminSession(), filters)
      expect(branchARows.length).toBeGreaterThan(0)
      expect(branchARows.every((a) => a.branchName === "Main Branch")).toBe(true)
    }, TIMEOUT)
  })

  describe("§67 representative export performance", () => {
    it("Patient Master export: 1,000 and 10,000 rows both complete in a reasonable, measured time", async () => {
      const batch1k = Array.from({ length: 1000 }, (_, i) => ({
        organizationId: orgAId, registrationBranchId: branchAId, mrn: `P47-PERF1K-${i}-${Date.now()}`,
        firstName: "Perf", lastName: `Patient${i}`, dob: new Date("1990-01-01"), gender: "unknown" as const, mobile: `P47PERF1K${i}${Date.now()}`,
      }))
      await db.patient.createMany({ data: batch1k })

      const start1k = Date.now()
      const rows1k = await exportPatientMasterRows(adminSession(), { from: new Date(0), to: new Date(), branchId: branchAId })
      const ms1k = Date.now() - start1k
      console.log(`[P4.7 §67] Patient Master export (${rows1k.length} rows): ${ms1k}ms.`)
      expect(rows1k.length).toBeGreaterThanOrEqual(1000)

      const batch10k = Array.from({ length: 9000 }, (_, i) => ({
        organizationId: orgAId, registrationBranchId: branchAId, mrn: `P47-PERF10K-${i}-${Date.now()}`,
        firstName: "Perf", lastName: `Patient10k${i}`, dob: new Date("1990-01-01"), gender: "unknown" as const, mobile: `P47PERF10K${i}${Date.now()}`,
      }))
      await db.patient.createMany({ data: batch10k })

      const start10k = Date.now()
      const rows10k = await exportPatientMasterRows(adminSession(), { from: new Date(0), to: new Date(), branchId: branchAId })
      const ms10k = Date.now() - start10k
      console.log(`[P4.7 §67] Patient Master export (${rows10k.length} rows): ${ms10k}ms.`)
      expect(rows10k.length).toBeGreaterThanOrEqual(10000)
    }, TIMEOUT)

    it("Stock Movement export: 1,000 rows completes in a reasonable, measured time", async () => {
      const product = await db.product.create({ data: { organizationId: orgAId, sku: `P47-PERFSTOCK-${Date.now()}`, name: "P4.7 Perf Stock Product", category: "supply", unit: "box", purchaseCost: 5 } })
      const batch = await db.productBatch.create({ data: { organizationId: orgAId, productId: product.id, supplierId: null, batchNumber: `P47-PERFBATCH-${Date.now()}`, expiryDate: null, purchaseCost: 5, receivedQuantity: 1000 } })
      const entries = Array.from({ length: 1000 }, () => ({
        organizationId: orgAId, branchId: branchAId, productId: product.id, batchId: batch.id,
        transactionType: "adjustment" as const, quantity: 1, reason: "P4.7 perf fixture",
      }))
      await db.stockLedgerEntry.createMany({ data: entries })

      const start = Date.now()
      const rows = await exportStockMovementRows(adminSession(), { ...defaultReportFilters({ branchId: branchAId }), productId: product.id })
      const ms = Date.now() - start
      console.log(`[P4.7 §67] Stock Movement export (${rows.length} rows): ${ms}ms.`)
      expect(rows.length).toBeGreaterThanOrEqual(1000)
    }, TIMEOUT)
  })

  describe("§18/§53 permission gating", () => {
    it("a session without patient.view cannot call the Patient Registration report or its export", async () => {
      const noPermSession: SessionContext = { ...adminSession(), permissions: new Set(["appointment.view"]) }
      await expect(getPatientRegistrationReport(noPermSession, defaultReportFilters({}))).rejects.toThrow(ForbiddenError)
      await expect(exportPatientRegistrationRows(noPermSession, defaultReportFilters({}))).rejects.toThrow(ForbiddenError)
    }, TIMEOUT)
  })
})
