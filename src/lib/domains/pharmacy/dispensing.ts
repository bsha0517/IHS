import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { isPharmacyEnabled } from "@/lib/platform/settings"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { consumeStock } from "@/lib/domains/inventory/stock"
import type { SessionContext } from "@/lib/auth/session"
import type { CreateDispensingRecordInput, ReturnDispensingInput } from "@/lib/domains/pharmacy/schemas"

async function assertPharmacyEnabled(organizationId: string) {
  if (!(await isPharmacyEnabled(organizationId))) {
    throw new Error("Pharmacy is disabled for this organization. Ask an administrator to enable it under Settings.")
  }
}

/**
 * Translates the doctor's free-text prescription line (Phase 3's
 * PrescriptionItem.medicationName) into a specific catalog Medication and
 * quantity — the same doctor-intent-vs-structured-execution split Phase 8
 * used for lab orders. Created `pending`; no stock/billing effect yet.
 */
export async function createDispensingRecord(session: SessionContext, input: CreateDispensingRecordInput) {
  assertCan(session, "prescription.dispense")
  await assertPharmacyEnabled(session.user.organizationId)

  const item = await db.prescriptionItem.findFirstOrThrow({
    where: { id: input.prescriptionItemId, prescription: { organizationId: session.user.organizationId } },
    include: { prescription: { include: { encounter: true } } },
  })
  if (item.prescription.status !== "active") throw new Error(`This prescription is "${item.prescription.status}", not active.`)

  const dispensingNumber = await nextNumber({ organizationId: session.user.organizationId, sequenceType: "DISP", prefix: "DISP" })
  const created = await db.dispensingRecord.create({
    data: {
      organizationId: session.user.organizationId,
      // Prescription has no branchId of its own (Phase 3) — derived from its Encounter.
      branchId: item.prescription.encounter.branchId,
      dispensingNumber,
      prescriptionId: item.prescriptionId,
      prescriptionItemId: item.id,
      medicationId: input.medicationId,
      patientId: item.prescription.patientId,
      quantityDispensed: input.quantityDispensed,
    },
  })

  await auditFromSession(session, "create", "dispensing_record", created.id, {
    new: { prescriptionItemId: item.id, medicationId: input.medicationId, quantity: input.quantityDispensed },
  })
  return created
}

/** Pharmacist review before dispensing (spec.md §29's "Verification" step, segregation of duties from the dispense action itself). */
export async function verifyDispensingRecord(session: SessionContext, id: string) {
  assertCan(session, "prescription.verify")
  await assertPharmacyEnabled(session.user.organizationId)

  const record = await db.dispensingRecord.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  if (record.status !== "pending") throw new Error(`Only a pending dispensing can be verified (this one is "${record.status}").`)

  const updated = await db.dispensingRecord.update({
    where: { id },
    data: { status: "verified", verifiedBy: session.user.id, verifiedAt: new Date() },
  })
  await auditFromSession(session, "update", "dispensing_record", id, { new: { status: "verified" } })
  return updated
}

/**
 * "Dispensing → Inventory Reduction → Billing → Patient Medication History"
 * (spec.md §29's exact ordering). Consumes stock FEFO (transactionType
 * "dispensing", distinguishing it from clinical treatment_consumption in
 * the ledger), generates one Charge (sourceType "pharmacy", the first real
 * use of that source type since it was defined in Phase 4), and upserts a
 * `current` PatientMedicationHistory row — all in one transaction, so a
 * stock shortfall aborts the whole dispensing rather than half-completing it.
 */
export async function dispenseRecord(session: SessionContext, id: string) {
  assertCan(session, "prescription.dispense")
  await assertPharmacyEnabled(session.user.organizationId)

  const record = await db.dispensingRecord.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { medication: { include: { product: true } }, prescriptionItem: true, prescription: true },
  })
  if (record.status !== "verified") throw new Error(`Only a verified dispensing can be dispensed (this one is "${record.status}").`)

  const unitPrice = Number(record.medication.product.sellingPrice ?? record.medication.product.purchaseCost)

  const updated = await db.$transaction(async (tx) => {
    await consumeStock(tx, {
      organizationId: session.user.organizationId,
      branchId: record.branchId,
      productId: record.medication.productId,
      quantity: record.quantityDispensed,
      referenceType: "dispensing_record",
      referenceId: record.id,
      performedBy: session.user.id,
      transactionType: "dispensing",
    })

    const charge = await generateSystemCharge(tx, {
      organizationId: session.user.organizationId,
      branchId: record.branchId,
      patientId: record.patientId,
      encounterId: record.prescription.encounterId,
      providerId: record.prescription.providerId,
      sourceType: "pharmacy",
      sourceReferenceId: record.id,
      description: `${record.medication.product.name} x${record.quantityDispensed}`,
      quantity: record.quantityDispensed,
      unitPrice,
    })

    const existingHistory = await tx.patientMedicationHistory.findFirst({
      where: { patientId: record.patientId, medicationName: record.medication.product.name },
    })
    if (existingHistory) {
      await tx.patientMedicationHistory.update({
        where: { id: existingHistory.id },
        data: { status: "current", startDate: new Date(), notedBy: session.user.id },
      })
    } else {
      await tx.patientMedicationHistory.create({
        data: {
          patientId: record.patientId,
          medicationName: record.medication.product.name,
          dose: record.prescriptionItem.dose,
          status: "current",
          startDate: new Date(),
          notedBy: session.user.id,
        },
      })
    }

    return tx.dispensingRecord.update({
      where: { id },
      data: { status: "dispensed", dispensedBy: session.user.id, dispensedAt: new Date(), chargeId: charge.id },
    })
  })

  await auditFromSession(session, "update", "dispensing_record", id, { new: { status: "dispensed" } })
  return updated
}

/** "Returns" (spec.md §29) — a correcting record, never an edit to the original dispensing. Adds stock back; does not reverse the Charge. */
export async function returnDispensingRecord(session: SessionContext, id: string, input: ReturnDispensingInput) {
  assertCan(session, "prescription.dispense")
  await assertPharmacyEnabled(session.user.organizationId)

  const record = await db.dispensingRecord.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { returns: true, medication: true },
  })
  if (record.status !== "dispensed") throw new Error("Only a dispensed record can be returned.")

  const alreadyReturned = record.returns.reduce((sum, r) => sum + r.quantityReturned, 0)
  if (alreadyReturned + input.quantityReturned > record.quantityDispensed) {
    throw new Error(`Cannot return more than was dispensed (${record.quantityDispensed}, already returned ${alreadyReturned}).`)
  }

  const created = await db.$transaction(async (tx) => {
    const returnRecord = await tx.dispensingReturn.create({
      data: {
        organizationId: session.user.organizationId,
        dispensingRecordId: id,
        quantityReturned: input.quantityReturned,
        reason: input.reason,
        returnedBy: session.user.id,
      },
    })

    await tx.stockLedgerEntry.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: record.branchId,
        productId: record.medication.productId,
        transactionType: "return",
        quantity: input.quantityReturned,
        referenceType: "dispensing_return",
        referenceId: returnRecord.id,
        performedBy: session.user.id,
      },
    })

    return returnRecord
  })

  await auditFromSession(session, "create", "dispensing_return", created.id, { new: { dispensingRecordId: id, quantity: input.quantityReturned } })
  return created
}

export async function listPatientMedicationHistory(session: SessionContext, patientId: string) {
  assertCan(session, "patient.view")
  return db.patientMedicationHistory.findMany({
    where: { patientId },
    orderBy: { notedAt: "desc" },
  })
}
