import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"

/**
 * P0-05 remediation tests (P0.md §21) — real DB-level proof that a parent
 * record carrying clinical or financial history cannot be deleted while
 * that history exists, now that the relevant FKs are RESTRICT rather than
 * CASCADE. Each fixture is created fresh and cleaned up in reverse
 * dependency order — the whole point of this test is that this cleanup
 * order is mandatory (child before parent), not optional.
 */
// Real-DB round trips against this environment's Supabase pooler
// occasionally exceed vitest's default 5s test timeout.
const TIMEOUT = 20000

describe("P0-05: cascade delete protection (DB-level RESTRICT)", () => {
  let organizationId: string
  let branchId: string
  let patientId: string
  let providerId: string
  let serviceId: string
  let encounterId: string
  let diagnosisId: string
  let invoiceId: string
  let chargeId: string
  let invoiceLineId: string
  let paymentId: string
  let cashierSessionId: string
  let journalId: string
  let journalLineIds: string[] = []
  let cashAccountId: string
  let arAccountId: string
  let userId: string

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    providerId = (await db.provider.findFirstOrThrow({ where: { organizationId } })).id
    serviceId = (await db.service.findFirstOrThrow({ where: { organizationId } })).id
    userId = (await db.user.findFirstOrThrow({ where: { organizationId } })).id
    const cash = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1000" } })
    cashAccountId = cash.id
    const ar = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: { not: "1000" } } })
    arAccountId = ar.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTCDP-${Date.now()}`, firstName: "CascadeProtection", lastName: "Test",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `CDP${Date.now()}`,
      },
    })
    patientId = patient.id

    const encounter = await db.encounter.create({
      data: {
        organizationId, branchId, patientId, providerId,
        encounterNumber: `TESTCDP-${Date.now()}`, encounterType: "consultation", status: "finalized", startAt: new Date(),
      },
    })
    encounterId = encounter.id

    const diagnosisCode = await db.diagnosisCode.findFirst()
    const diagnosis = await db.diagnosis.create({
      data: {
        organizationId, patientId, encounterId,
        description: "test diagnosis for cascade-delete protection", status: "active",
        ...(diagnosisCode ? { diagnosisCode: diagnosisCode.code } : {}),
      },
    })
    diagnosisId = diagnosis.id

    const charge = await db.charge.create({
      data: { organizationId, branchId, patientId, providerId, serviceId, sourceType: "consultation", description: "test", unitPrice: 100, amount: 100, status: "invoiced" },
    })
    chargeId = charge.id

    const invoice = await db.invoice.create({
      data: {
        organizationId, branchId, patientId, invoiceNumber: `TESTCDP-${Date.now()}`,
        subtotal: 100, discountAmount: 0, taxAmount: 0, totalAmount: 100, paidAmount: 100, status: "paid", issuedAt: new Date(),
        lines: { create: [{ chargeId, description: "test", quantity: 1, unitPrice: 100, taxAmount: 0, lineTotal: 100 }] },
      },
      include: { lines: true },
    })
    invoiceId = invoice.id
    invoiceLineId = invoice.lines[0].id

    const cashierSession = await db.cashierSession.create({
      data: { organizationId, branchId, cashierUserId: userId, openingCash: 0, status: "open" },
    })
    cashierSessionId = cashierSession.id

    const payment = await db.payment.create({
      data: {
        organizationId, branchId, receiptNumber: `TESTCDP-${Date.now()}`, method: "cash", amount: 100,
        status: "completed", cashierSessionId,
        allocations: { create: [{ invoiceId, amount: 100 }] },
      },
    })
    paymentId = payment.id

    const journal = await db.journal.create({
      data: {
        organizationId, branchId, journalNumber: `TESTCDP-${Date.now()}`, journalDate: new Date(),
        referenceType: "test", description: "cascade-delete protection test fixture",
        lines: { create: [{ accountId: cashAccountId, debit: 100, credit: 0 }, { accountId: arAccountId, debit: 0, credit: 100 }] },
      },
      include: { lines: true },
    })
    journalId = journal.id
    journalLineIds = journal.lines.map((l) => l.id)
  }, 30000)

  afterAll(async () => {
    // Correct order: children before parents — this is the only order that
    // now works, which is the point of this whole test file.
    await db.journalLine.deleteMany({ where: { id: { in: journalLineIds } } })
    await db.journal.delete({ where: { id: journalId } })
    await db.paymentAllocation.deleteMany({ where: { paymentId } })
    await db.payment.delete({ where: { id: paymentId } })
    await db.cashierSession.delete({ where: { id: cashierSessionId } })
    await db.invoiceLine.delete({ where: { id: invoiceLineId } })
    await db.invoice.delete({ where: { id: invoiceId } })
    await db.charge.delete({ where: { id: chargeId } })
    await db.diagnosis.delete({ where: { id: diagnosisId } })
    await db.encounter.delete({ where: { id: encounterId } })
    await db.patient.delete({ where: { id: patientId } })
    await db.$disconnect()
  }, 30000)

  it("rejects deleting a Patient that has clinical history (a Diagnosis)", async () => {
    await expect(db.patient.delete({ where: { id: patientId } })).rejects.toThrow()
    // Confirm it's still there (the delete genuinely didn't happen, not a fluke).
    const stillExists = await db.patient.findUnique({ where: { id: patientId } })
    expect(stillExists).not.toBeNull()
  }, TIMEOUT)

  it("rejects deleting an Encounter with finalized documentation (a Diagnosis)", async () => {
    await expect(db.encounter.delete({ where: { id: encounterId } })).rejects.toThrow()
    const stillExists = await db.encounter.findUnique({ where: { id: encounterId } })
    expect(stillExists).not.toBeNull()
  }, TIMEOUT)

  it("rejects deleting an Invoice that has payments (via InvoiceLine)", async () => {
    await expect(db.invoice.delete({ where: { id: invoiceId } })).rejects.toThrow()
    const stillExists = await db.invoice.findUnique({ where: { id: invoiceId } })
    expect(stillExists).not.toBeNull()
  }, TIMEOUT)

  it("rejects deleting a Journal that has lines", async () => {
    await expect(db.journal.delete({ where: { id: journalId } })).rejects.toThrow()
    const stillExists = await db.journal.findUnique({ where: { id: journalId } })
    expect(stillExists).not.toBeNull()
  }, TIMEOUT)

  it("rejects deleting a Payment that has allocations", async () => {
    await expect(db.payment.delete({ where: { id: paymentId } })).rejects.toThrow()
    const stillExists = await db.payment.findUnique({ where: { id: paymentId } })
    expect(stillExists).not.toBeNull()
  }, TIMEOUT)
})
