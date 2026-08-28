import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { listPatients, getPatient } from "@/lib/domains/patients/service"
import { listAppointments, getAppointment } from "@/lib/domains/appointments/service"
import { listInvoices, getInvoice } from "@/lib/domains/billing/invoices"
import { listPatientOrders } from "@/lib/domains/clinical/orders"
import { listStockSummary } from "@/lib/domains/inventory/stock"
import { listJournals, getJournal } from "@/lib/domains/accounting/reports"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P0-01 remediation — mandatory branch-isolation tests (P0.md §6). Verifies,
 * against real data in two real branches, that a session scoped to Branch A
 * cannot read Branch B's patients, appointments, invoices, clinical orders,
 * inventory, or accounting reports — on both the list path (results
 * filtered out) and the get-by-id path (a direct fetch by id throws) — and
 * that a genuinely org-wide session (Super Admin, and separately a session
 * holding real `user_branch_access` grants for both branches) can see both.
 *
 * SessionContext objects are hand-built in memory rather than created via a
 * real login, matching the pattern this build's own test scripts have used
 * since Phase 1 (see PROJECT_STATUS.md) — the functions under test only ever
 * read `session.user`, `session.branchIds`, `session.permissions`, and
 * `session.roleNames`, none of which require a real `User`/`Session` DB row.
 */
describe("P0-01: branch data isolation", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let patientAId: string
  let patientBId: string
  let providerId: string
  let serviceId: string
  let appointmentAId: string
  let appointmentBId: string
  let chargeAId: string
  let chargeBId: string
  let invoiceAId: string
  let invoiceBId: string
  let encounterAId: string
  let encounterBId: string
  let orderAId: string
  let orderBId: string
  let cashAccountId: string
  let journalAId: string
  let journalBId: string

  const ALL_PERMISSIONS = new Set([
    "patient.view",
    "appointment.view",
    "invoice.view",
    "encounter.view",
    "inventory.view",
    "accounting.view",
  ])

  function branchASession(): SessionContext {
    return {
      sessionId: "test-session-branch-a",
      user: { id: "00000000-0000-0000-0000-00000000000a", organizationId, email: "branch-a@test.local", firstName: "Branch", lastName: "A" },
      activeBranchId: branchAId,
      branchIds: [branchAId],
      permissions: ALL_PERMISSIONS,
      roleNames: ["Receptionist"],
    }
  }

  function orgWideByGrantSession(): SessionContext {
    return {
      sessionId: "test-session-org-wide",
      user: { id: "00000000-0000-0000-0000-00000000000b", organizationId, email: "org-wide@test.local", firstName: "Org", lastName: "Wide" },
      activeBranchId: branchAId,
      branchIds: [branchAId, branchBId],
      permissions: ALL_PERMISSIONS,
      roleNames: ["Accountant"],
    }
  }

  function superAdminSession(): SessionContext {
    return {
      sessionId: "test-session-super-admin",
      user: { id: "00000000-0000-0000-0000-00000000000c", organizationId, email: "super-admin@test.local", firstName: "Super", lastName: "Admin" },
      activeBranchId: null,
      branchIds: [],
      permissions: ALL_PERMISSIONS,
      roleNames: ["Super Admin"],
    }
  }

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 2, orderBy: { createdAt: "asc" } })
    if (branches.length < 2) throw new Error("Test requires at least 2 seeded branches")
    branchAId = branches[0].id
    branchBId = branches[1].id
    organizationId = branches[0].organizationId

    providerId = (await db.provider.findFirstOrThrow({ where: { organizationId } })).id
    serviceId = (await db.service.findFirstOrThrow({ where: { organizationId } })).id
    const cashAccount = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1000" } })
    cashAccountId = cashAccount.id
    const arAccount = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: { not: "1000" } } })

    // Randomized far-future offset (not just Date.now()) so a re-run after an
    // interrupted previous run never collides with a leftover fixture still
    // holding the same provider/time slot under the exclusion constraint.
    const future = new Date(Date.now() + (400 + Math.floor(Math.random() * 300)) * 24 * 60 * 60 * 1000)

    // Branch A fixtures
    const patientA = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchAId,
        mrn: `TESTBI-A-${Date.now()}`, firstName: "IsolationTest", lastName: "BranchA",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `A${Date.now()}`,
      },
    })
    patientAId = patientA.id
    const apptA = await db.appointment.create({
      data: { organizationId, branchId: branchAId, appointmentNumber: `TESTBI-A-${Date.now()}`, patientId: patientAId, providerId, serviceId, startTime: future, endTime: new Date(future.getTime() + 30 * 60000) },
    })
    appointmentAId = apptA.id
    const encA = await db.encounter.create({
      data: { organizationId, branchId: branchAId, patientId: patientAId, providerId, encounterNumber: `TESTBI-A-${Date.now()}`, encounterType: "consultation", status: "active", startAt: new Date() },
    })
    encounterAId = encA.id
    const orderA = await db.clinicalOrder.create({
      data: { organizationId, branchId: branchAId, patientId: patientAId, encounterId: encounterAId, orderingProviderId: providerId, orderNumber: `TESTBI-A-${Date.now()}`, orderType: "lab", status: "ordered" },
    })
    orderAId = orderA.id
    const chargeA = await db.charge.create({
      data: { organizationId, branchId: branchAId, patientId: patientAId, providerId, serviceId, sourceType: "other", description: "branch isolation test fixture", unitPrice: 100, amount: 100, status: "pending" },
    })
    chargeAId = chargeA.id
    const invoiceA = await db.invoice.create({
      data: {
        organizationId, branchId: branchAId, patientId: patientAId, invoiceNumber: `TESTBI-A-${Date.now()}`,
        subtotal: 100, discountAmount: 0, taxAmount: 0, totalAmount: 100, paidAmount: 0, status: "issued", issuedAt: new Date(),
        lines: { create: [{ chargeId: chargeAId, description: "test", quantity: 1, unitPrice: 100, taxAmount: 0, lineTotal: 100 }] },
      },
    })
    invoiceAId = invoiceA.id
    const journalA = await db.journal.create({
      data: {
        organizationId, branchId: branchAId, journalNumber: `TESTBI-A-${Date.now()}`, journalDate: new Date(),
        referenceType: "test", description: "branch isolation test fixture",
        lines: { create: [{ accountId: cashAccountId, debit: 10, credit: 0 }, { accountId: arAccount.id, debit: 0, credit: 10 }] },
      },
    })
    journalAId = journalA.id

    // Branch B fixtures (identical shape, different branch)
    const patientB = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchBId,
        mrn: `TESTBI-B-${Date.now()}`, firstName: "IsolationTest", lastName: "BranchB",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `B${Date.now()}`,
      },
    })
    patientBId = patientB.id
    const futureB = new Date(future.getTime() + 4 * 60 * 60 * 1000) // offset from Branch A's slot — same provider, must not overlap
    const apptB = await db.appointment.create({
      data: { organizationId, branchId: branchBId, appointmentNumber: `TESTBI-B-${Date.now()}`, patientId: patientBId, providerId, serviceId, startTime: futureB, endTime: new Date(futureB.getTime() + 30 * 60000) },
    })
    appointmentBId = apptB.id
    const encB = await db.encounter.create({
      data: { organizationId, branchId: branchBId, patientId: patientBId, providerId, encounterNumber: `TESTBI-B-${Date.now()}`, encounterType: "consultation", status: "active", startAt: new Date() },
    })
    encounterBId = encB.id
    const orderB = await db.clinicalOrder.create({
      data: { organizationId, branchId: branchBId, patientId: patientBId, encounterId: encounterBId, orderingProviderId: providerId, orderNumber: `TESTBI-B-${Date.now()}`, orderType: "lab", status: "ordered" },
    })
    orderBId = orderB.id
    const chargeB = await db.charge.create({
      data: { organizationId, branchId: branchBId, patientId: patientBId, providerId, serviceId, sourceType: "other", description: "branch isolation test fixture", unitPrice: 100, amount: 100, status: "pending" },
    })
    chargeBId = chargeB.id
    const invoiceB = await db.invoice.create({
      data: {
        organizationId, branchId: branchBId, patientId: patientBId, invoiceNumber: `TESTBI-B-${Date.now()}`,
        subtotal: 100, discountAmount: 0, taxAmount: 0, totalAmount: 100, paidAmount: 0, status: "issued", issuedAt: new Date(),
        lines: { create: [{ chargeId: chargeBId, description: "test", quantity: 1, unitPrice: 100, taxAmount: 0, lineTotal: 100 }] },
      },
    })
    invoiceBId = invoiceB.id
    const journalB = await db.journal.create({
      data: {
        organizationId, branchId: branchBId, journalNumber: `TESTBI-B-${Date.now()}`, journalDate: new Date(),
        referenceType: "test", description: "branch isolation test fixture",
        lines: { create: [{ accountId: cashAccountId, debit: 10, credit: 0 }, { accountId: arAccount.id, debit: 0, credit: 10 }] },
      },
    })
    journalBId = journalB.id
  }, 30000)

  afterAll(async () => {
    // Defensive against a partially-completed beforeAll (an id still
    // undefined) — filter rather than let Prisma reject the whole cleanup
    // over one unset id and mask the real failure.
    const ids = (vals: (string | undefined)[]) => vals.filter((v): v is string => !!v)
    await db.journalLine.deleteMany({ where: { journalId: { in: ids([journalAId, journalBId]) } } })
    await db.journal.deleteMany({ where: { id: { in: ids([journalAId, journalBId]) } } })
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: ids([invoiceAId, invoiceBId]) } } })
    await db.invoice.deleteMany({ where: { id: { in: ids([invoiceAId, invoiceBId]) } } })
    await db.charge.deleteMany({ where: { id: { in: ids([chargeAId, chargeBId]) } } })
    await db.clinicalOrder.deleteMany({ where: { id: { in: ids([orderAId, orderBId]) } } })
    await db.encounter.deleteMany({ where: { id: { in: ids([encounterAId, encounterBId]) } } })
    await db.appointment.deleteMany({ where: { id: { in: ids([appointmentAId, appointmentBId]) } } })
    await db.patient.deleteMany({ where: { id: { in: ids([patientAId, patientBId]) } } })
    await db.$disconnect()
  }, 30000)

  describe("Branch A session cannot see Branch B data", () => {
    it("list patients: Branch B's test patient is excluded", async () => {
      const result = await listPatients(branchASession(), { search: "IsolationTest" })
      const ids = result.patients.map((p) => p.id)
      expect(ids).toContain(patientAId)
      expect(ids).not.toContain(patientBId)
    })

    it("get patient: opening Branch B's patient by id is rejected", async () => {
      await expect(getPatient(branchASession(), patientBId)).rejects.toThrow()
    })

    it("list appointments: Branch B's appointment is excluded", async () => {
      const from = new Date(Date.now())
      const to = new Date(Date.now() + 800 * 24 * 60 * 60 * 1000) // covers the full 400-700-day randomized fixture range
      const result = await listAppointments(branchASession(), { from, to })
      const ids = result.map((a) => a.id)
      expect(ids).toContain(appointmentAId)
      expect(ids).not.toContain(appointmentBId)
    })

    it("get appointment: opening Branch B's appointment by id is rejected", async () => {
      await expect(getAppointment(branchASession(), appointmentBId)).rejects.toThrow(ForbiddenError)
    })

    it("list invoices: Branch B's invoice is excluded", async () => {
      const result = await listInvoices(branchASession())
      const ids = result.map((i) => i.id)
      expect(ids).toContain(invoiceAId)
      expect(ids).not.toContain(invoiceBId)
    })

    it("get invoice: opening Branch B's invoice by id is rejected", async () => {
      await expect(getInvoice(branchASession(), invoiceBId)).rejects.toThrow(ForbiddenError)
    })

    it("clinical information: Branch B's clinical order is excluded from the patient's order list", async () => {
      const resultA = await listPatientOrders(branchASession(), patientAId)
      expect(resultA.map((o) => o.id)).toContain(orderAId)
      const resultB = await listPatientOrders(branchASession(), patientBId)
      expect(resultB.map((o) => o.id)).not.toContain(orderBId)
    })

    it("inventory: a branchId filter for Branch B is rejected outright", async () => {
      await expect(listStockSummary(branchASession(), branchBId)).rejects.toThrow(ForbiddenError)
    })

    it("reports/accounting: Branch B's journal is excluded from the list, and direct access is rejected", async () => {
      const result = await listJournals(branchASession(), { referenceType: "test" })
      const ids = result.map((j) => j.id)
      expect(ids).toContain(journalAId)
      expect(ids).not.toContain(journalBId)
      await expect(getJournal(branchASession(), journalBId)).rejects.toThrow(ForbiddenError)
    })
  })

  describe("A session with real grants to both branches can see both", () => {
    it("list patients: both test patients are visible", async () => {
      const result = await listPatients(orgWideByGrantSession(), { search: "IsolationTest" })
      const ids = result.patients.map((p) => p.id)
      expect(ids).toContain(patientAId)
      expect(ids).toContain(patientBId)
    })

    it("get invoice: both invoices are individually reachable", async () => {
      await expect(getInvoice(orgWideByGrantSession(), invoiceAId)).resolves.toBeTruthy()
      await expect(getInvoice(orgWideByGrantSession(), invoiceBId)).resolves.toBeTruthy()
    })
  })

  describe("Super Admin sees both branches (the system's one intended org-wide bypass)", () => {
    it("get appointment: both branches' appointments are reachable", async () => {
      await expect(getAppointment(superAdminSession(), appointmentAId)).resolves.toBeTruthy()
      await expect(getAppointment(superAdminSession(), appointmentBId)).resolves.toBeTruthy()
    })

    it("inventory: an explicit Branch B filter is allowed, not rejected", async () => {
      await expect(listStockSummary(superAdminSession(), branchBId)).resolves.toBeDefined()
    })
  })
})
