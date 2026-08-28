import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { startEncounter, completeEncounter, cancelEncounter, markEncounterEnteredInError } from "@/lib/domains/clinical/encounters"
import { updatePatientStatus } from "@/lib/domains/patients/service"
import { voidInvoice } from "@/lib/domains/billing/invoices"
import { createManualJournal, reverseJournal } from "@/lib/domains/accounting/journals"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §23 (finalized clinical records can't be casually changed) and §24
 * (explicit cancellation/void alternatives now that P0 made deletes
 * RESTRICT) — real DB integration tests against Encounter cancellation,
 * Patient status transitions, Invoice void's reversing journal, and manual
 * Journal reversal.
 */
const TIMEOUT = 60000

describe("P1 §23/§24: explicit cancellation/void and casual-edit protection", () => {
  let organizationId: string
  let branchId: string
  let providerId: string
  let userId: string
  let cashAccountId: string
  let arAccountId: string
  let revenueAccountId: string
  const patientIds: string[] = []
  const encounterIds: string[] = []
  const invoiceIds: string[] = []
  const journalIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-clinical-cancellation",
      user: { id: userId, organizationId, email: "clinical-cancel-test@test.local", firstName: "Cancel", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["encounter.create", "encounter.finalize", "patient.edit", "invoice.void", "invoice.view", "accounting.post"]),
      roleNames: ["Super Admin"],
    }
  }

  async function newPatient() {
    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTCANCEL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, firstName: "Cancel", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `CX${Date.now()}${Math.random().toString(36).slice(2, 4)}`,
      },
    })
    patientIds.push(patient.id)
    return patient
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id
    const provider = await db.provider.findFirstOrThrow({ where: { organizationId } })
    providerId = provider.id

    const [cash, ar, revenue] = await Promise.all([
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1000" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1100" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "4000" } }),
    ])
    cashAccountId = cash.id
    arAccountId = ar.id
    revenueAccountId = revenue.id
  }, TIMEOUT)

  afterAll(async () => {
    const journals = await db.journal.findMany({
      where: {
        organizationId,
        OR: [
          { referenceType: "invoice", referenceId: { in: invoiceIds } },
          { referenceType: "invoice_void", referenceId: { in: invoiceIds } },
          { id: { in: journalIds } },
          { referenceType: "manual_reversal" },
        ],
      },
    })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } })
    const charges = await db.charge.findMany({ where: { patientId: { in: patientIds } } })
    await db.charge.deleteMany({ where: { id: { in: charges.map((c) => c.id) } } })
    await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
    await db.encounter.deleteMany({ where: { id: { in: encounterIds } } })
    await db.patient.deleteMany({ where: { id: { in: patientIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  describe("§24: Encounter — CANCELLED / ENTERED_IN_ERROR", () => {
    it("cancelEncounter works from active, captures the reason, and is blocked once completed", async () => {
      const patient = await newPatient()
      const encounter = await startEncounter(session(), { branchId, patientId: patient.id, providerId, encounterType: "consultation" })
      encounterIds.push(encounter.id)

      const cancelled = await cancelEncounter(session(), encounter.id, "wrong patient called")
      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.cancelReason).toBe("wrong patient called")

      const patient2 = await newPatient()
      const encounter2 = await startEncounter(session(), { branchId, patientId: patient2.id, providerId, encounterType: "consultation" })
      encounterIds.push(encounter2.id)
      await completeEncounter(session(), encounter2.id)
      await expect(cancelEncounter(session(), encounter2.id, "too late")).rejects.toThrow(/use "entered in error" instead/)
    }, TIMEOUT)

    it("markEncounterEnteredInError works even after completion, and is terminal", async () => {
      const patient = await newPatient()
      const encounter = await startEncounter(session(), { branchId, patientId: patient.id, providerId, encounterType: "consultation" })
      encounterIds.push(encounter.id)
      await completeEncounter(session(), encounter.id)

      const marked = await markEncounterEnteredInError(session(), encounter.id, "wrong patient entirely")
      expect(marked.status).toBe("entered_in_error")
      expect(marked.cancelReason).toBe("wrong patient entirely")

      await expect(markEncounterEnteredInError(session(), encounter.id, "again")).rejects.toThrow(/already "entered_in_error"/)
    }, TIMEOUT)

    it("a completed encounter can never be silently re-completed or re-finalized past its own guard — casual edits stay blocked", async () => {
      const patient = await newPatient()
      const encounter = await startEncounter(session(), { branchId, patientId: patient.id, providerId, encounterType: "consultation" })
      encounterIds.push(encounter.id)
      await completeEncounter(session(), encounter.id)

      await expect(completeEncounter(session(), encounter.id)).rejects.toThrow(/Cannot complete an encounter with status "completed"/)
    }, TIMEOUT)
  })

  describe("§24: Patient — ACTIVE/INACTIVE/DECEASED, never deleted", () => {
    it("moves active -> inactive -> active freely, both directions captured with a reason", async () => {
      const patient = await newPatient()
      const inactive = await updatePatientStatus(session(), patient.id, { status: "inactive", reason: "stopped attending" })
      expect(inactive.status).toBe("inactive")
      const active = await updatePatientStatus(session(), patient.id, { status: "active", reason: "returned" })
      expect(active.status).toBe("active")
    }, TIMEOUT)

    it("deceased is terminal — no further status change is allowed through this function", async () => {
      const patient = await newPatient()
      await updatePatientStatus(session(), patient.id, { status: "deceased", reason: "confirmed deceased" })
      await expect(updatePatientStatus(session(), patient.id, { status: "active", reason: "undo attempt" })).rejects.toThrow(/Cannot move a patient from "deceased" to "active"/)
    }, TIMEOUT)

    it("the patient record itself is never deleted by any status change", async () => {
      const patient = await newPatient()
      await updatePatientStatus(session(), patient.id, { status: "deceased", reason: "confirmed" })
      const stillExists = await db.patient.findUniqueOrThrow({ where: { id: patient.id } })
      expect(stillExists.id).toBe(patient.id)
    }, TIMEOUT)
  })

  describe("§24: Invoice VOID reverses its own posted journal", () => {
    it("voiding an unpaid invoice posts an exact mirror of the original Dr AR / Cr Revenue journal", async () => {
      const patient = await newPatient()
      const charge = await db.charge.create({
        data: {
          organizationId, branchId, patientId: patient.id, sourceType: "other",
          description: "Void-reversal test charge", quantity: 1, unitPrice: 300, amount: 300, status: "invoiced",
        },
      })
      const invoice = await db.invoice.create({
        data: {
          organizationId, branchId, patientId: patient.id,
          invoiceNumber: `TESTVOID-${Date.now()}`,
          subtotal: 300, discountAmount: 0, taxAmount: 0, totalAmount: 300, paidAmount: 0,
          status: "issued", issuedAt: new Date(),
          lines: { create: [{ chargeId: charge.id, description: charge.description, quantity: 1, unitPrice: 300, taxAmount: 0, lineTotal: 300 }] },
        },
      })
      invoiceIds.push(invoice.id)

      // Post the original issuance journal directly (bypassing generateInvoice's own flow, which this fixture sidesteps for setup simplicity).
      const originalJournal = await db.journal.create({
        data: {
          organizationId, branchId, journalNumber: `TESTJRN-${Date.now()}`, referenceType: "invoice", referenceId: invoice.id,
          journalDate: new Date(),
          description: `Invoice ${invoice.invoiceNumber} issued`,
          lines: { create: [{ accountId: arAccountId, debit: 300, credit: 0 }, { accountId: revenueAccountId, debit: 0, credit: 300 }] },
        },
      })

      await voidInvoice(session(), invoice.id, "billed in error")

      const updated = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
      expect(updated.status).toBe("void")
      expect(updated.voidReason).toBe("billed in error")

      const reversalJournal = await db.journal.findFirstOrThrow({
        where: { organizationId, referenceType: "invoice_void", referenceId: invoice.id },
        include: { lines: true },
      })
      const arLine = reversalJournal.lines.find((l) => l.accountId === arAccountId)
      const revenueLine = reversalJournal.lines.find((l) => l.accountId === revenueAccountId)
      expect(Number(arLine?.credit)).toBe(300) // exact mirror of the original's debit
      expect(Number(revenueLine?.debit)).toBe(300) // exact mirror of the original's credit

      // The original journal is untouched — never edited or deleted.
      const stillOriginal = await db.journal.findUniqueOrThrow({ where: { id: originalJournal.id } })
      expect(stillOriginal.id).toBe(originalJournal.id)
    }, TIMEOUT)

    it("cannot void an invoice that already has a payment applied", async () => {
      const patient = await newPatient()
      const charge = await db.charge.create({
        data: {
          organizationId, branchId, patientId: patient.id, sourceType: "other",
          description: "Paid invoice void-block test", quantity: 1, unitPrice: 150, amount: 150, status: "invoiced",
        },
      })
      const invoice = await db.invoice.create({
        data: {
          organizationId, branchId, patientId: patient.id,
          invoiceNumber: `TESTVOIDBLOCK-${Date.now()}`,
          subtotal: 150, discountAmount: 0, taxAmount: 0, totalAmount: 150, paidAmount: 150,
          status: "paid", issuedAt: new Date(),
          lines: { create: [{ chargeId: charge.id, description: charge.description, quantity: 1, unitPrice: 150, taxAmount: 0, lineTotal: 150 }] },
        },
      })
      invoiceIds.push(invoice.id)

      await expect(voidInvoice(session(), invoice.id, "attempted void of a paid invoice")).rejects.toThrow(/issue a refund instead/)
    }, TIMEOUT)
  })

  describe("§24: Journal — REVERSAL, never physical delete", () => {
    it("reverses a manual journal with an exact mirror, and blocks a second reversal of the same journal", async () => {
      const manual = await createManualJournal(session(), {
        branchId,
        journalDate: new Date(),
        description: "Test manual correction",
        lines: [
          { accountId: cashAccountId, debit: 50, credit: 0 },
          { accountId: revenueAccountId, debit: 0, credit: 50 },
        ],
      })
      journalIds.push(manual.id)

      const reversal = await reverseJournal(session(), manual.id, "posted to the wrong account")
      journalIds.push(reversal.id)
      const lines = await db.journalLine.findMany({ where: { journalId: reversal.id } })
      const cashLine = lines.find((l) => l.accountId === cashAccountId)
      const revenueLine = lines.find((l) => l.accountId === revenueAccountId)
      expect(Number(cashLine?.credit)).toBe(50)
      expect(Number(revenueLine?.debit)).toBe(50)

      await expect(reverseJournal(session(), manual.id, "trying again")).rejects.toThrow(/already been reversed/)

      // The original manual journal is untouched.
      const stillOriginal = await db.journal.findUniqueOrThrow({ where: { id: manual.id } })
      expect(stillOriginal.id).toBe(manual.id)
    }, TIMEOUT)

    it("refuses to reverse a domain-tied (non-manual) journal directly", async () => {
      const domainJournal = await db.journal.create({
        data: {
          organizationId, branchId, journalNumber: `TESTDOMJRN-${Date.now()}`, referenceType: "payment", referenceId: null,
          journalDate: new Date(),
          description: "Simulated domain-tied journal",
          lines: { create: [{ accountId: cashAccountId, debit: 20, credit: 0 }, { accountId: revenueAccountId, debit: 0, credit: 20 }] },
        },
      })
      journalIds.push(domainJournal.id)

      await expect(reverseJournal(session(), domainJournal.id, "attempted direct reversal")).rejects.toThrow(/reverse the underlying record instead/)
    }, TIMEOUT)
  })
})
