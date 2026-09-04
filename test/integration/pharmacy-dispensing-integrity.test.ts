import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { createDispensingRecord, verifyDispensingRecord, dispenseRecord, returnDispensingRecord } from "@/lib/domains/pharmacy/dispensing"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P1 §14: the full pharmacy chain (Prescription -> Dispensing -> Inventory
 * Movement -> Charge -> Billing -> Accounting) and its idempotency guards —
 * real DB integration tests against
 * `src/lib/domains/pharmacy/dispensing.ts`'s "claim before acting" fix
 * (dispenseRecord/returnDispensingRecord) and its new COGS posting.
 */
const TIMEOUT = 60000

describe("P1 §14: pharmacy dispensing chain integrity", () => {
  let organizationId: string
  let branchId: string
  let providerId: string
  let userId: string
  let cogsAccountId: string
  let inventoryAccountId: string
  const productIds: string[] = []
  const medicationIds: string[] = []
  const encounterIds: string[] = []
  const prescriptionIds: string[] = []
  const chargeIds: string[] = []
  const patientIds: string[] = []

  function session(): SessionContext {
    return {
      sessionId: "test-pharmacy-dispensing",
      user: { id: userId, organizationId, email: "pharmacy-dispensing-test@test.local", firstName: "Pharm", lastName: "Test" },
      activeBranchId: branchId,
      branchIds: [branchId],
      permissions: new Set(["prescription.dispense", "prescription.verify", "prescription.create", "patient.view", "charge.create", "invoice.view"]),
      roleNames: ["Super Admin"],
    }
  }

  async function createProduct(purchaseCost: number) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const product = await db.product.create({
      data: {
        organizationId,
        name: `Dispensing Test Med ${suffix}`,
        sku: `TESTDISP-${suffix}`,
        category: "medication",
        unit: "tablet",
        reorderLevel: 0,
        purchaseCost,
        sellingPrice: purchaseCost * 3,
      },
    })
    productIds.push(product.id)
    const medication = await db.medication.create({
      data: { organizationId, productId: product.id, dosageForm: "tablet", requiresPrescription: true },
    })
    medicationIds.push(medication.id)
    return { product, medication }
  }

  async function createBatch(productId: string, opts: { purchaseCost: number; quantity: number; expiryDate?: Date | null }) {
    const batch = await db.productBatch.create({
      data: {
        organizationId,
        productId,
        batchNumber: `DB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        expiryDate: opts.expiryDate ?? null,
        purchaseCost: opts.purchaseCost,
        receivedQuantity: opts.quantity,
      },
    })
    await db.stockLedgerEntry.create({
      data: { organizationId, branchId, productId, batchId: batch.id, transactionType: "purchase", quantity: opts.quantity, referenceType: "test" },
    })
    return batch
  }

  async function newPatient() {
    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchId,
        mrn: `TESTDISP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, firstName: "Dispensing", lastName: "Integrity",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `DP${Date.now()}${Math.random().toString(36).slice(2, 4)}`,
      },
    })
    patientIds.push(patient.id)
    return patient
  }

  async function newPrescription(pid: string, medicationName: string, quantity = 30) {
    const encounter = await db.encounter.create({
      data: {
        organizationId, branchId, patientId: pid, providerId,
        encounterNumber: `TESTDISP-ENC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        encounterType: "consultation", status: "active",
      },
    })
    encounterIds.push(encounter.id)
    const prescription = await db.prescription.create({
      data: {
        organizationId, patientId: pid, encounterId: encounter.id, providerId,
        prescriptionNumber: `TESTDISP-RX-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        status: "active",
        items: {
          create: [{ medicationName, dose: "1 tab", frequency: "BID", route: "oral", quantity }],
        },
      },
      include: { items: true },
    })
    prescriptionIds.push(prescription.id)
    return prescription
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    const provider = await db.provider.findFirstOrThrow({ where: { organizationId } })
    providerId = provider.id
    // P2 §14: previously a hardcoded, never-created id
    // ("00000000-0000-0000-0000-0000000000f4") — worked only because
    // nothing enforced it referenced a real row. dispenseRecord() writes
    // this straight into PatientMedicationHistory.notedBy, which now has a
    // real FK to `user` (§14, Category A) — found and fixed as a direct
    // consequence of that migration, not a pre-existing bug this batch went
    // looking for. A real seeded user, matching every other test file's own
    // convention, needs no its own cleanup.
    const user = await db.user.findFirstOrThrow({ where: { organizationId } })
    userId = user.id

    const [cogs, inventory] = await Promise.all([
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "5100" } }),
      db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1200" } }),
    ])
    cogsAccountId = cogs.id
    inventoryAccountId = inventory.id
  }, TIMEOUT)

  afterAll(async () => {
    const journals = await db.journal.findMany({ where: { organizationId, referenceType: { in: ["charge_cogs", "charge_cogs_void"] }, referenceId: { in: chargeIds } } })
    await db.journalLine.deleteMany({ where: { journalId: { in: journals.map((j) => j.id) } } })
    await db.journal.deleteMany({ where: { id: { in: journals.map((j) => j.id) } } })
    await db.notification.deleteMany({ where: { organizationId, referenceType: "outbox_event" } }).catch(() => {})
    await db.dispensingReturn.deleteMany({ where: { organizationId } }).catch(() => {})
    await db.dispensingRecord.deleteMany({ where: { organizationId, prescriptionId: { in: prescriptionIds } } })
    await db.patientMedicationHistory.deleteMany({ where: { patientId: { in: patientIds } } })
    await db.invoiceLine.deleteMany({ where: { chargeId: { in: chargeIds } } })
    await db.charge.deleteMany({ where: { id: { in: chargeIds } } })
    await db.prescriptionItem.deleteMany({ where: { prescriptionId: { in: prescriptionIds } } })
    await db.prescription.deleteMany({ where: { id: { in: prescriptionIds } } })
    await db.encounter.deleteMany({ where: { id: { in: encounterIds } } })
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: productIds } } })
    await db.productBatch.deleteMany({ where: { productId: { in: productIds } } })
    await db.medication.deleteMany({ where: { id: { in: medicationIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.patient.deleteMany({ where: { id: { in: patientIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("complete dispensing: consumes stock, generates a charge, updates medication history, and posts Dr COGS / Cr Inventory Asset at actual batch cost", async () => {
    const { product, medication } = await createProduct(4)
    const batch = await createBatch(product.id, { purchaseCost: 4, quantity: 50 })
    const patient = await newPatient()
    const rx = await newPrescription(patient.id, product.name, 10)
    const item = rx.items[0]

    const record = await createDispensingRecord(session(), { prescriptionItemId: item.id, medicationId: medication.id, quantityDispensed: 10 })
    await verifyDispensingRecord(session(), record.id)
    const dispensed = await dispenseRecord(session(), record.id)

    expect(dispensed.status).toBe("dispensed")
    expect(dispensed.chargeId).toBeTruthy()
    chargeIds.push(dispensed.chargeId!)

    const stockEntry = await db.stockLedgerEntry.findFirstOrThrow({ where: { referenceType: "dispensing_record", referenceId: record.id } })
    expect(stockEntry.transactionType).toBe("dispensing")
    expect(Number(stockEntry.quantity)).toBe(-10)
    expect(stockEntry.batchId).toBe(batch.id)

    const charge = await db.charge.findUniqueOrThrow({ where: { id: dispensed.chargeId! } })
    expect(charge.sourceType).toBe("pharmacy")
    expect(charge.patientId).toBe(patient.id)

    const history = await db.patientMedicationHistory.findFirstOrThrow({ where: { patientId: patient.id, medicationName: product.name } })
    expect(history.status).toBe("current")

    const journal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "charge_cogs", referenceId: dispensed.chargeId! }, include: { lines: true } })
    const cogsLine = journal.lines.find((l) => l.accountId === cogsAccountId)
    const inventoryLine = journal.lines.find((l) => l.accountId === inventoryAccountId)
    expect(Number(cogsLine?.debit)).toBe(40) // 10 units x 4 actual batch cost
    expect(Number(inventoryLine?.credit)).toBe(40)
  }, TIMEOUT)

  it("partial dispensing: only the requested (lesser) quantity is consumed and billed, not the full prescribed quantity", async () => {
    const { product, medication } = await createProduct(6)
    await createBatch(product.id, { purchaseCost: 6, quantity: 50 })
    const patient = await newPatient()
    const rx = await newPrescription(patient.id, product.name, 20)
    const item = rx.items[0]

    // Dispense only 5 of the 20 prescribed.
    const record = await createDispensingRecord(session(), { prescriptionItemId: item.id, medicationId: medication.id, quantityDispensed: 5 })
    await verifyDispensingRecord(session(), record.id)
    const dispensed = await dispenseRecord(session(), record.id)
    chargeIds.push(dispensed.chargeId!)

    const stockEntry = await db.stockLedgerEntry.findFirstOrThrow({ where: { referenceType: "dispensing_record", referenceId: record.id } })
    expect(Number(stockEntry.quantity)).toBe(-5)
    const charge = await db.charge.findUniqueOrThrow({ where: { id: dispensed.chargeId! } })
    expect(Number(charge.quantity)).toBe(5)
  }, TIMEOUT)

  it("expired-batch rejection: dispensing a medication with only expired stock throws and leaves no charge or stock movement", async () => {
    const { product, medication } = await createProduct(3)
    await createBatch(product.id, { purchaseCost: 3, quantity: 50, expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    const patient = await newPatient()
    const rx = await newPrescription(patient.id, product.name, 5)
    const item = rx.items[0]

    const record = await createDispensingRecord(session(), { prescriptionItemId: item.id, medicationId: medication.id, quantityDispensed: 5 })
    await verifyDispensingRecord(session(), record.id)

    await expect(dispenseRecord(session(), record.id)).rejects.toThrow(/Insufficient stock/)

    const stillVerified = await db.dispensingRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(stillVerified.status).toBe("verified") // never flipped to dispensed
    expect(stillVerified.chargeId).toBeNull()
    const entries = await db.stockLedgerEntry.findMany({ where: { referenceType: "dispensing_record", referenceId: record.id } })
    expect(entries.length).toBe(0)
  }, TIMEOUT)

  it("insufficient stock: dispensing more than is on hand throws and leaves the record claimable again", async () => {
    const { product, medication } = await createProduct(5)
    await createBatch(product.id, { purchaseCost: 5, quantity: 3 })
    const patient = await newPatient()
    const rx = await newPrescription(patient.id, product.name, 50)
    const item = rx.items[0]

    const record = await createDispensingRecord(session(), { prescriptionItemId: item.id, medicationId: medication.id, quantityDispensed: 50 })
    await verifyDispensingRecord(session(), record.id)

    await expect(dispenseRecord(session(), record.id)).rejects.toThrow(/Insufficient stock/)

    const stillVerified = await db.dispensingRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(stillVerified.status).toBe("verified")
  }, TIMEOUT)

  it("return: adds stock back without reversing the original charge or its COGS, and rejects returning more than was dispensed", async () => {
    const { product, medication } = await createProduct(2)
    await createBatch(product.id, { purchaseCost: 2, quantity: 50 })
    const patient = await newPatient()
    const rx = await newPrescription(patient.id, product.name, 10)
    const item = rx.items[0]

    const record = await createDispensingRecord(session(), { prescriptionItemId: item.id, medicationId: medication.id, quantityDispensed: 10 })
    await verifyDispensingRecord(session(), record.id)
    const dispensed = await dispenseRecord(session(), record.id)
    chargeIds.push(dispensed.chargeId!)

    const ret = await returnDispensingRecord(session(), record.id, { quantityReturned: 4, reason: "patient returned unused tablets" })
    expect(ret.quantityReturned).toBe(4)

    const returnEntry = await db.stockLedgerEntry.findFirstOrThrow({ where: { referenceType: "dispensing_return", referenceId: ret.id } })
    expect(returnEntry.transactionType).toBe("return")
    expect(Number(returnEntry.quantity)).toBe(4)

    const balance = await db.stockLedgerEntry.aggregate({ where: { productId: product.id }, _sum: { quantity: true } })
    expect(Number(balance._sum.quantity)).toBe(50 - 10 + 4) // 44

    // The charge and its COGS journal are untouched by the return.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: dispensed.chargeId! } })
    expect(charge.status).not.toBe("void")
    const cogsJournal = await db.journal.findFirstOrThrow({ where: { organizationId, referenceType: "charge_cogs", referenceId: dispensed.chargeId! }, include: { lines: true } })
    expect(Number(cogsJournal.lines.find((l) => l.accountId === cogsAccountId)?.debit)).toBe(20) // still 10 x 2, never reversed

    // Returning the remaining 6 succeeds (10 total); a 7th unit over that fails.
    await returnDispensingRecord(session(), record.id, { quantityReturned: 5, reason: "more returned" })
    await expect(returnDispensingRecord(session(), record.id, { quantityReturned: 2, reason: "over-return attempt" })).rejects.toThrow(/Cannot return more than was dispensed/)
  }, TIMEOUT)

  it("idempotency: two concurrent dispense attempts on the same verified record result in exactly one charge and one stock consumption", async () => {
    const { product, medication } = await createProduct(8)
    await createBatch(product.id, { purchaseCost: 8, quantity: 50 })
    const patient = await newPatient()
    const rx = await newPrescription(patient.id, product.name, 10)
    const item = rx.items[0]

    const record = await createDispensingRecord(session(), { prescriptionItemId: item.id, medicationId: medication.id, quantityDispensed: 10 })
    await verifyDispensingRecord(session(), record.id)

    const results = await Promise.allSettled([dispenseRecord(session(), record.id), dispenseRecord(session(), record.id)])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    if (rejected[0].status === "rejected") {
      expect(String(rejected[0].reason)).toMatch(/already dispensed/)
    }

    const final = fulfilled[0].status === "fulfilled" ? fulfilled[0].value : null
    if (final?.chargeId) chargeIds.push(final.chargeId)

    const entries = await db.stockLedgerEntry.findMany({ where: { referenceType: "dispensing_record", referenceId: record.id } })
    expect(entries.length).toBe(1) // consumed exactly once, not twice
    const charges = await db.charge.findMany({ where: { organizationId, patientId: patient.id, sourceType: "pharmacy" } })
    expect(charges.length).toBe(1) // billed exactly once
  }, TIMEOUT)

  it("idempotency: two concurrent returns on the same dispensing record never together exceed the dispensed quantity", async () => {
    const { product, medication } = await createProduct(3)
    await createBatch(product.id, { purchaseCost: 3, quantity: 50 })
    const patient = await newPatient()
    const rx = await newPrescription(patient.id, product.name, 10)
    const item = rx.items[0]

    const record = await createDispensingRecord(session(), { prescriptionItemId: item.id, medicationId: medication.id, quantityDispensed: 10 })
    await verifyDispensingRecord(session(), record.id)
    const dispensed = await dispenseRecord(session(), record.id)
    chargeIds.push(dispensed.chargeId!)

    // Two concurrent returns of 6 each against a 10-unit dispensing — only one may fully succeed.
    const results = await Promise.allSettled([
      returnDispensingRecord(session(), record.id, { quantityReturned: 6, reason: "concurrent return A" }),
      returnDispensingRecord(session(), record.id, { quantityReturned: 6, reason: "concurrent return B" }),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    expect(fulfilled.length).toBe(1) // the second must be rejected by the over-return guard

    const returns = await db.dispensingReturn.findMany({ where: { dispensingRecordId: record.id } })
    const totalReturned = returns.reduce((sum, r) => sum + r.quantityReturned, 0)
    expect(totalReturned).toBeLessThanOrEqual(10)
  }, TIMEOUT)
})
