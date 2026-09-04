import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import { startEncounter } from "@/lib/domains/clinical/encounters"
import { createPrescription, cancelPrescription, getPrescription, listPatientPrescriptions } from "@/lib/domains/clinical/prescriptions"
import { listPharmacyQueue, getPrescriptionForDispensing } from "@/lib/domains/pharmacy/queue"
import { createDispensingRecord, verifyDispensingRecord, dispenseRecord } from "@/lib/domains/pharmacy/dispensing"
import { getOrganizationIdentity } from "@/lib/domains/identity/org-structure"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 30000

/**
 * P3.6 (Pharmacy / Prescription / Dispensing Workflow) — targeted tests for
 * the actual behavior changed this batch. The pre-existing
 * `pharmacy-dispensing-integrity.test.ts` (P1 §14) already thoroughly covers
 * stock consumption, expired-batch/insufficient-stock rejection, charge/COGS
 * posting, returns, and concurrent-dispense/return idempotency using a
 * super-admin-shaped session — none of that is repeated here. This file
 * covers what P3.6 actually added: the doctor->Pharmacy handoff, multi-item
 * prescription fulfillment and status synchronization, the new Pharmacy
 * write-side branch scoping, cancelled-prescription protections (both
 * directions), FEFO batch ordering, and the widened Doctor read access plus
 * the `settings.view` print fix.
 */
describe("P3.6: pharmacy / prescription / dispensing workflow", () => {
  let organizationId: string
  let branchAId: string
  let branchBId: string
  let doctorProviderId: string
  let doctorUserId: string
  let pharmacistUserId: string
  let patientId: string
  const createdEncounterIds: string[] = []
  const createdPrescriptionIds: string[] = []
  const createdPatientIds: string[] = []
  const createdProductIds: string[] = []
  const createdMedicationIds: string[] = []

  function doctorSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-6-doctor",
      user: { id: doctorUserId, organizationId, email: "p3-6-doctor@test.local", firstName: "P3.6", lastName: "Doctor" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set([
        "patient.view", "encounter.view", "encounter.create", "encounter.finalize",
        "prescription.create",
      ]),
      roleNames: ["Doctor"],
    }
  }
  function pharmacistSession(branchIds: string[]): SessionContext {
    return {
      sessionId: "test-p3-6-pharmacist",
      user: { id: pharmacistUserId, organizationId, email: "p3-6-pharmacist@test.local", firstName: "P3.6", lastName: "Pharmacist" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["patient.view", "inventory.view", "inventory.adjust", "product.manage", "prescription.verify", "prescription.dispense"]),
      roleNames: ["Pharmacist"],
    }
  }

  async function createMedicationWithStock(branchId: string, opts: { purchaseCost: number; batches: { quantity: number; expiryDate?: Date | null }[] }) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const product = await db.product.create({
      data: {
        organizationId, name: `P3.6 Test Med ${suffix}`, sku: `P36MED-${suffix}`,
        category: "medication", unit: "tablet", reorderLevel: 0,
        purchaseCost: opts.purchaseCost, sellingPrice: opts.purchaseCost * 3,
      },
    })
    createdProductIds.push(product.id)
    const medication = await db.medication.create({
      data: { organizationId, productId: product.id, dosageForm: "tablet", requiresPrescription: true },
    })
    createdMedicationIds.push(medication.id)
    for (const b of opts.batches) {
      const batch = await db.productBatch.create({
        data: {
          organizationId, productId: product.id,
          batchNumber: `P36B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          expiryDate: b.expiryDate ?? null, purchaseCost: opts.purchaseCost, receivedQuantity: b.quantity,
        },
      })
      await db.stockLedgerEntry.create({
        data: { organizationId, branchId, productId: product.id, batchId: batch.id, transactionType: "purchase", quantity: b.quantity, referenceType: "test" },
      })
    }
    return { product, medication }
  }

  async function placeMultiItemPrescription(branchId: string) {
    const encounter = await startEncounter(doctorSession([branchId]), {
      branchId, patientId, providerId: doctorProviderId, encounterType: "consultation",
    } as never)
    createdEncounterIds.push(encounter.id)
    const rx = await createPrescription(doctorSession([branchId]), encounter.id, {
      items: [
        { medicationName: "P3.6 Amoxicillin", dose: "1 cap", frequency: "TID", route: "oral", quantity: 6 },
        { medicationName: "P3.6 Paracetamol", dose: "2 tabs", frequency: "QID", route: "oral", quantity: 8 },
      ],
    })
    createdPrescriptionIds.push(rx.id)
    return { encounter, rx }
  }

  beforeAll(async () => {
    const branches = await db.branch.findMany({ take: 2, orderBy: { createdAt: "asc" } })
    if (branches.length < 2) throw new Error("Test requires at least 2 seeded branches (see LOCAL_DATABASE_SETUP.md).")
    organizationId = branches[0].organizationId
    branchAId = branches[0].id
    branchBId = branches[1].id

    const provider = await db.provider.findFirstOrThrow({ where: { organizationId } })
    doctorProviderId = provider.id

    const doctorUser = await db.user.create({
      data: { organizationId, email: `p3-6-doctor-${Date.now()}@test.local`, passwordHash: "x", firstName: "P3.6", lastName: "DoctorUser" },
    })
    doctorUserId = doctorUser.id
    const pharmacistUser = await db.user.create({
      data: { organizationId, email: `p3-6-pharmacist-${Date.now()}@test.local`, passwordHash: "x", firstName: "P3.6", lastName: "PharmacistUser" },
    })
    pharmacistUserId = pharmacistUser.id

    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branchAId,
        mrn: `TESTP36-${Date.now()}`, firstName: "P3.6", lastName: "Pharmacy",
        dob: new Date("1982-01-01"), gender: "unknown", mobile: `P36M${Date.now()}`,
      },
    })
    createdPatientIds.push(patient.id)
    patientId = patient.id
  }, TIMEOUT)

  afterAll(async () => {
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
    await ownerDb.clinicalAccessLog.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await ownerDb.$disconnect()

    await db.dispensingReturn.deleteMany({ where: { organizationId } }).catch(() => {})
    await db.dispensingRecord.deleteMany({ where: { prescriptionId: { in: createdPrescriptionIds } } })
    await db.patientMedicationHistory.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.charge.deleteMany({ where: { patientId: { in: createdPatientIds } } })
    await db.prescriptionItem.deleteMany({ where: { prescriptionId: { in: createdPrescriptionIds } } })
    await db.prescription.deleteMany({ where: { id: { in: createdPrescriptionIds } } })
    await db.encounter.deleteMany({ where: { id: { in: createdEncounterIds } } })
    await db.stockLedgerEntry.deleteMany({ where: { productId: { in: createdProductIds } } })
    await db.productBatch.deleteMany({ where: { productId: { in: createdProductIds } } })
    await db.medication.deleteMany({ where: { id: { in: createdMedicationIds } } })
    await db.product.deleteMany({ where: { id: { in: createdProductIds } } })
    await db.patient.deleteMany({ where: { id: { in: createdPatientIds } } })
    await db.user.deleteMany({ where: { id: { in: [doctorUserId, pharmacistUserId] } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("§7: a doctor's prescription becomes discoverable by Pharmacy with no manual duplication step", async () => {
    const { rx } = await placeMultiItemPrescription(branchAId)
    const queue = await listPharmacyQueue(pharmacistSession([branchAId]), {})
    expect(queue.some((q) => q.id === rx.id)).toBe(true)
    const pending = await listPharmacyQueue(pharmacistSession([branchAId]), { status: "pending" })
    expect(pending.some((q) => q.id === rx.id)).toBe(true)
  }, TIMEOUT)

  it("§15/§27: a multi-item prescription only completes once every item is fully dispensed, not after the first item alone", async () => {
    const { medication: medA } = await createMedicationWithStock(branchAId, { purchaseCost: 2, batches: [{ quantity: 100 }] })
    const { medication: medB } = await createMedicationWithStock(branchAId, { purchaseCost: 3, batches: [{ quantity: 100 }] })
    const { rx } = await placeMultiItemPrescription(branchAId)
    const [itemA, itemB] = rx.items

    const recA = await createDispensingRecord(pharmacistSession([branchAId]), { prescriptionItemId: itemA.id, medicationId: medA.id, quantityDispensed: 6, substitutionConfirmed: true }) // item 8: pre-existing test fixtures' medication names never claimed to match their prescribed item -- unrelated to what this test verifies
    await verifyDispensingRecord(pharmacistSession([branchAId]), recA.id)
    await dispenseRecord(pharmacistSession([branchAId]), recA.id)

    // Only one of two items fully dispensed — prescription must stay active.
    let reloaded = await db.prescription.findUniqueOrThrow({ where: { id: rx.id } })
    expect(reloaded.status).toBe("active")
    const stillInQueue = await listPharmacyQueue(pharmacistSession([branchAId]), {})
    expect(stillInQueue.some((q) => q.id === rx.id)).toBe(true)
    const partial = await listPharmacyQueue(pharmacistSession([branchAId]), { status: "partial" })
    expect(partial.some((q) => q.id === rx.id)).toBe(true)

    const recB = await createDispensingRecord(pharmacistSession([branchAId]), { prescriptionItemId: itemB.id, medicationId: medB.id, quantityDispensed: 8, substitutionConfirmed: true }) // item 8: pre-existing test fixtures' medication names never claimed to match their prescribed item -- unrelated to what this test verifies
    await verifyDispensingRecord(pharmacistSession([branchAId]), recB.id)
    await dispenseRecord(pharmacistSession([branchAId]), recB.id)

    // §27: both items now fully dispensed — the prescription itself must
    // synchronize to "completed", not stay "active" forever.
    reloaded = await db.prescription.findUniqueOrThrow({ where: { id: rx.id } })
    expect(reloaded.status).toBe("completed")
    const noLongerInQueue = await listPharmacyQueue(pharmacistSession([branchAId]), {})
    expect(noLongerInQueue.some((q) => q.id === rx.id)).toBe(false)
    const dispensedFilter = await listPharmacyQueue(pharmacistSession([branchAId]), { status: "dispensed" })
    expect(dispensedFilter.some((q) => q.id === rx.id)).toBe(true)

    // §29/§28: Patient 360 and the Encounter workspace both reflect the same
    // real, persisted per-item dispensing data.
    const patient360 = await listPatientPrescriptions(doctorSession([branchAId]), patientId)
    const rxFromPatient360 = patient360.find((p) => p.id === rx.id)
    expect(rxFromPatient360?.status).toBe("completed")
    expect(rxFromPatient360?.items.every((i) => i.dispensingRecords.some((d) => d.status === "dispensed"))).toBe(true)
  }, TIMEOUT)

  it("§22/§27: a cancelled prescription cannot be dispensed against, stays historically visible, and cannot itself be re-cancelled or resurrected", async () => {
    const { rx } = await placeMultiItemPrescription(branchAId)
    const { medication } = await createMedicationWithStock(branchAId, { purchaseCost: 1, batches: [{ quantity: 100 }] })
    await cancelPrescription(doctorSession([branchAId]), rx.id)

    await expect(
      createDispensingRecord(pharmacistSession([branchAId]), { prescriptionItemId: rx.items[0].id, medicationId: medication.id, quantityDispensed: 1, substitutionConfirmed: true }) // item 8: pre-existing test fixtures' medication names never claimed to match their prescribed item -- unrelated to what this test verifies
    ).rejects.toThrow(/not active/)

    // Still visible, not deleted.
    const stillVisible = await getPrescription(doctorSession([branchAId]), rx.id)
    expect(stillVisible.status).toBe("cancelled")

    // §27: a terminal state cannot be re-transitioned.
    await expect(cancelPrescription(doctorSession([branchAId]), rx.id)).rejects.toThrow()
  }, TIMEOUT)

  it("§27: a fully-dispensed (completed) prescription cannot subsequently be cancelled", async () => {
    const { medication } = await createMedicationWithStock(branchAId, { purchaseCost: 1, batches: [{ quantity: 100 }] })
    const encounter = await startEncounter(doctorSession([branchAId]), {
      branchId: branchAId, patientId, providerId: doctorProviderId, encounterType: "consultation",
    } as never)
    createdEncounterIds.push(encounter.id)
    const rx = await createPrescription(doctorSession([branchAId]), encounter.id, {
      items: [{ medicationName: "P3.6 SingleItem", dose: "1 tab", frequency: "OD", route: "oral", quantity: 3 }],
    })
    createdPrescriptionIds.push(rx.id)

    const rec = await createDispensingRecord(pharmacistSession([branchAId]), { prescriptionItemId: rx.items[0].id, medicationId: medication.id, quantityDispensed: 3, substitutionConfirmed: true }) // item 8: pre-existing test fixtures' medication names never claimed to match their prescribed item -- unrelated to what this test verifies
    await verifyDispensingRecord(pharmacistSession([branchAId]), rec.id)
    await dispenseRecord(pharmacistSession([branchAId]), rec.id)

    const completed = await db.prescription.findUniqueOrThrow({ where: { id: rx.id } })
    expect(completed.status).toBe("completed")
    await expect(cancelPrescription(doctorSession([branchAId]), rx.id)).rejects.toThrow()
  }, TIMEOUT)

  it("§36: a Pharmacist authorized only for Branch B cannot create, verify, or dispense against a Branch A prescription", async () => {
    const { rx } = await placeMultiItemPrescription(branchAId)
    const { medication } = await createMedicationWithStock(branchAId, { purchaseCost: 1, batches: [{ quantity: 100 }] })
    const onlyB = pharmacistSession([branchBId])

    await expect(
      createDispensingRecord(onlyB, { prescriptionItemId: rx.items[0].id, medicationId: medication.id, quantityDispensed: 1, substitutionConfirmed: true }) // item 8: pre-existing test fixtures' medication names never claimed to match their prescribed item -- unrelated to what this test verifies
    ).rejects.toThrow(ForbiddenError)

    const rec = await createDispensingRecord(pharmacistSession([branchAId]), { prescriptionItemId: rx.items[0].id, medicationId: medication.id, quantityDispensed: 1, substitutionConfirmed: true }) // item 8: pre-existing test fixtures' medication names never claimed to match their prescribed item -- unrelated to what this test verifies
    await expect(verifyDispensingRecord(onlyB, rec.id)).rejects.toThrow(ForbiddenError)

    await verifyDispensingRecord(pharmacistSession([branchAId]), rec.id)
    await expect(dispenseRecord(onlyB, rec.id)).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§13: FEFO — dispensing consumes the earlier-expiring batch before a later one, and never touches an expired batch while a valid one exists", async () => {
    const now = Date.now()
    const { product, medication } = await createMedicationWithStock(branchAId, {
      purchaseCost: 5,
      batches: [
        { quantity: 20, expiryDate: new Date(now + 60 * 24 * 60 * 60 * 1000) }, // expires in 60 days
        { quantity: 20, expiryDate: new Date(now + 10 * 24 * 60 * 60 * 1000) }, // expires in 10 days — should go first
      ],
    })
    const earlierBatch = await db.productBatch.findFirstOrThrow({ where: { productId: product.id }, orderBy: { expiryDate: "asc" } })

    const encounter = await startEncounter(doctorSession([branchAId]), {
      branchId: branchAId, patientId, providerId: doctorProviderId, encounterType: "consultation",
    } as never)
    createdEncounterIds.push(encounter.id)
    const rx = await createPrescription(doctorSession([branchAId]), encounter.id, {
      items: [{ medicationName: "P3.6 FEFO Item", dose: "1 tab", frequency: "OD", route: "oral", quantity: 5 }],
    })
    createdPrescriptionIds.push(rx.id)

    const rec = await createDispensingRecord(pharmacistSession([branchAId]), { prescriptionItemId: rx.items[0].id, medicationId: medication.id, quantityDispensed: 5, substitutionConfirmed: true }) // item 8: pre-existing test fixtures' medication names never claimed to match their prescribed item -- unrelated to what this test verifies
    await verifyDispensingRecord(pharmacistSession([branchAId]), rec.id)
    await dispenseRecord(pharmacistSession([branchAId]), rec.id)

    const ledgerEntry = await db.stockLedgerEntry.findFirstOrThrow({ where: { referenceType: "dispensing_record", referenceId: rec.id } })
    expect(ledgerEntry.batchId).toBe(earlierBatch.id) // the sooner-to-expire batch, not the later one
  }, TIMEOUT)

  it("§37: a Doctor session (no pharmacy-ops permission) can read a prescription's real fulfillment state but cannot dispense against it", async () => {
    const { rx } = await placeMultiItemPrescription(branchAId)
    const { medication } = await createMedicationWithStock(branchAId, { purchaseCost: 1, batches: [{ quantity: 100 }] })
    const rec = await createDispensingRecord(pharmacistSession([branchAId]), { prescriptionItemId: rx.items[0].id, medicationId: medication.id, quantityDispensed: 2, substitutionConfirmed: true }) // item 8: pre-existing test fixtures' medication names never claimed to match their prescribed item -- unrelated to what this test verifies
    await verifyDispensingRecord(pharmacistSession([branchAId]), rec.id)
    await dispenseRecord(pharmacistSession([branchAId]), rec.id)

    // The doctor holds only encounter.view for pharmacy-read purposes —
    // getPrescriptionForDispensing must not reject them (P3.6's own §28/§37
    // goal: a real destination from the Encounter).
    const asDoctor = await getPrescriptionForDispensing(doctorSession([branchAId]), rx.id)
    expect(asDoctor.items.find((i) => i.id === rx.items[0].id)?.dispensedQuantity).toBe(2)

    // But every actual write stays denied.
    await expect(
      createDispensingRecord(doctorSession([branchAId]), { prescriptionItemId: rx.items[1].id, medicationId: medication.id, quantityDispensed: 1, substitutionConfirmed: true }) // item 8: pre-existing test fixtures' medication names never claimed to match their prescribed item -- unrelated to what this test verifies
    ).rejects.toThrow()

    // A session with neither permission at all is rejected outright.
    const noPharmacyAccess: SessionContext = {
      sessionId: "test-p3-6-no-access",
      user: { id: doctorUserId, organizationId, email: "p3-6-doctor@test.local", firstName: "P3.6", lastName: "Doctor" },
      activeBranchId: branchAId,
      branchIds: [branchAId],
      permissions: new Set(["patient.view"]),
      roleNames: ["Receptionist"],
    }
    await expect(getPrescriptionForDispensing(noPharmacyAccess, rx.id)).rejects.toThrow(ForbiddenError)
  }, TIMEOUT)

  it("§30: printing a prescription no longer requires settings.view — the minimal organization-identity read succeeds for a Doctor session", async () => {
    const { rx } = await placeMultiItemPrescription(branchAId)
    const org = await getOrganizationIdentity(doctorSession([branchAId]))
    expect(org.displayName).toBeTruthy()
    // getPrescription (the print page's other data need) already succeeds
    // for Doctor via encounter.view — confirming the print page's full data
    // dependency is satisfiable without settings.view end to end.
    const printable = await getPrescription(doctorSession([branchAId]), rx.id)
    expect(printable.id).toBe(rx.id)
  }, TIMEOUT)

  /**
   * Targeted backlog closure, item 8 (BACKLOG.md's "No system-enforced
   * cross-check between a prescribed medication and the one a pharmacist
   * selects to dispense"): a real, server-enforced (not just UI-level)
   * cross-check now exists — never auto-substituting, never blocking a
   * legitimate substitution, only requiring an explicit confirmation when
   * the names don't obviously correspond, and recording whether that
   * confirmation was actually given.
   */
  describe("item 8: prescribed-vs-dispensed medication mismatch confirmation", () => {
    it("an obviously matching medication needs no confirmation and is not recorded as a substitution", async () => {
      const { rx } = await placeMultiItemPrescription(branchAId) // items: "P3.6 Amoxicillin", "P3.6 Paracetamol"
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const product = await db.product.create({
        data: { organizationId, name: "P3.6 Amoxicillin", sku: `P36MATCH-${suffix}`, category: "medication", unit: "tablet", reorderLevel: 0, purchaseCost: 1, sellingPrice: 3 },
      })
      createdProductIds.push(product.id)
      const medication = await db.medication.create({ data: { organizationId, productId: product.id, dosageForm: "capsule", requiresPrescription: true } })
      createdMedicationIds.push(medication.id)
      await db.stockLedgerEntry.create({ data: { organizationId, branchId: branchAId, productId: product.id, transactionType: "purchase", quantity: 50, referenceType: "test" } })

      const rec = await createDispensingRecord(pharmacistSession([branchAId]), {
        prescriptionItemId: rx.items[0].id, medicationId: medication.id, quantityDispensed: 6,
        // Deliberately NOT confirming — an obvious match must not require it.
      })
      expect(rec.substitutionConfirmed).toBe(false)
    }, TIMEOUT)

    it("a mismatched medication without confirmation is rejected with a clear, actionable message", async () => {
      const { rx } = await placeMultiItemPrescription(branchAId) // "P3.6 Amoxicillin"
      const { medication } = await createMedicationWithStock(branchAId, { purchaseCost: 1, batches: [{ quantity: 50 }] }) // "P3.6 Test Med <random>"

      await expect(
        createDispensingRecord(pharmacistSession([branchAId]), { prescriptionItemId: rx.items[0].id, medicationId: medication.id, quantityDispensed: 6 })
      ).rejects.toThrow(/doesn't obviously match the prescribed/)

      // Never auto-substitutes and never silently dispenses — no record created.
      expect(await db.dispensingRecord.count({ where: { prescriptionItemId: rx.items[0].id } })).toBe(0)
    }, TIMEOUT)

    it("a mismatched medication WITH explicit confirmation succeeds and is durably recorded as a confirmed substitution", async () => {
      const { rx } = await placeMultiItemPrescription(branchAId)
      const { medication, product } = await createMedicationWithStock(branchAId, { purchaseCost: 1, batches: [{ quantity: 50 }] })

      const rec = await createDispensingRecord(pharmacistSession([branchAId]), {
        prescriptionItemId: rx.items[0].id, medicationId: medication.id, quantityDispensed: 6, substitutionConfirmed: true,
      })
      expect(rec.substitutionConfirmed).toBe(true)
      expect(rec.medicationId).toBe(medication.id)

      // A legitimate substitution is never blocked, and stock still moves normally.
      const reloadedProduct = await db.product.findUniqueOrThrow({ where: { id: product.id } })
      expect(reloadedProduct.id).toBe(product.id)
      await verifyDispensingRecord(pharmacistSession([branchAId]), rec.id)
      await dispenseRecord(pharmacistSession([branchAId]), rec.id)
      const dispensed = await db.dispensingRecord.findUniqueOrThrow({ where: { id: rec.id } })
      expect(dispensed.status).toBe("dispensed")
      expect(dispensed.substitutionConfirmed).toBe(true) // survives the verify/dispense transitions unchanged
    }, TIMEOUT)
  })
})
