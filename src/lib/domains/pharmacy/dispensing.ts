import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { isPharmacyEnabled } from "@/lib/platform/settings"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { consumeStock } from "@/lib/domains/inventory/stock"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, patientVisibilityWhere } from "@/lib/platform/branch-scope"
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
 *
 * P1 §14: atomically claims the record (`verified` -> `dispensed`) *before*
 * touching stock or billing — the same "claim before acting" discipline as
 * Batch 2's `completeRefund` fix. Without this, a double-click/retry could
 * pass the (unlocked) status check twice and run consumeStock +
 * generateSystemCharge twice for one physical dispensing: double stock
 * deduction, the patient billed twice. The claim happens first specifically
 * so the loser never reaches either side effect.
 *
 * P1 §14 (Accounting leg): consumeStock's returned actual cost feeds the
 * same `ProductSold` outbox event insertCharge (billing/charges.ts) fires
 * for a POS sale, so a dispensed medication posts Dr COGS / Cr Inventory
 * Asset (postProductSaleCogs, accounting/posting-service.ts) exactly like a
 * retail product sale — before this fix, the stock was consumed and the
 * charge/invoice recognized revenue, but no matching cost was ever posted,
 * silently overstating gross margin for every dispensed medication. The
 * charge itself still doesn't carry `productId` (generateSystemCharge is
 * called without one) — dispensing already consumed stock itself above, so
 * insertCharge must not also consume it a second time.
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
    const claimed = await tx.dispensingRecord.updateMany({
      where: { id, status: "verified" },
      data: { status: "dispensed", dispensedBy: session.user.id, dispensedAt: new Date() },
    })
    if (claimed.count === 0) {
      throw new Error("This dispensing record was already dispensed (or its status changed) — refresh and try again.")
    }

    const { totalCost } = await consumeStock(tx, {
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

    if (totalCost.greaterThan(0)) {
      await writeOutboxEvent(tx, {
        organizationId: session.user.organizationId,
        eventType: "ProductSold",
        payload: { branchId: record.branchId, chargeId: charge.id, cost: Number(totalCost) },
      })
    }

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

    return tx.dispensingRecord.update({ where: { id }, data: { chargeId: charge.id } })
  }, { timeout: 20_000, maxWait: 10_000 })

  await auditFromSession(session, "update", "dispensing_record", id, { new: { status: "dispensed" } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}

/**
 * "Returns" (spec.md §29) — a correcting record, never an edit to the
 * original dispensing. Adds stock back; does not reverse the Charge — and,
 * consistently, does not reverse the COGS dispenseRecord posted either
 * (unlike voidCharge's POS-side postProductSaleVoided). Revenue and cost
 * stay a matched, permanent pair alongside the original invoice; a return
 * is a physical stock correction, not a financial undo.
 *
 * P1 §14/§33: the over-return guard (`alreadyReturned + this <=
 * quantityDispensed`) is re-validated *inside* the transaction against a
 * row genuinely locked with `SELECT ... FOR UPDATE` on the parent
 * DispensingRecord — not the plain, unlocked read this replaced. Two
 * concurrent return requests against the same record would otherwise both
 * read the same stale `alreadyReturned` sum, both pass validation, and
 * together over-return more than was ever dispensed. Because
 * `quantityReturned` is a derived aggregate over child rows (never a
 * mutable counter, by design — see DispensingReturn), there is no single
 * column to atomically increment the way `applyPaymentAtomically` does;
 * locking the parent row is the correct tool for gating an aggregate
 * check + insert instead.
 */
export async function returnDispensingRecord(session: SessionContext, id: string, input: ReturnDispensingInput) {
  assertCan(session, "prescription.dispense")
  await assertPharmacyEnabled(session.user.organizationId)

  const record = await db.dispensingRecord.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { medication: true },
  })
  if (record.status !== "dispensed") throw new Error("Only a dispensed record can be returned.")

  const created = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "dispensing_record" WHERE id = ${id} FOR UPDATE`

    const returns = await tx.dispensingReturn.findMany({ where: { dispensingRecordId: id } })
    const alreadyReturned = returns.reduce((sum, r) => sum + r.quantityReturned, 0)
    if (alreadyReturned + input.quantityReturned > record.quantityDispensed) {
      throw new Error(`Cannot return more than was dispensed (${record.quantityDispensed}, already returned ${alreadyReturned}).`)
    }

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
  }, { timeout: 20_000, maxWait: 10_000 })

  await auditFromSession(session, "create", "dispensing_return", created.id, { new: { dispensingRecordId: id, quantity: input.quantityReturned } })
  return created
}

export async function listPatientMedicationHistory(session: SessionContext, patientId: string) {
  assertCan(session, "patient.view")
  // Was missing organization isolation entirely (P0-01 remediation) — a
  // cross-tenant leak, not just a cross-branch one: PatientMedicationHistory
  // has no organizationId of its own, and the original query didn't even
  // traverse to the patient's — any org's session could read any other
  // org's patient's medication history by id. Fixed via the same `patient:`
  // relation filter used for branch visibility, since organizationId only
  // exists on Patient here.
  const visibility = patientVisibilityWhere(getAuthorizedBranchScope(session))
  return db.patientMedicationHistory.findMany({
    where: { patientId, patient: { organizationId: session.user.organizationId, ...(visibility ?? {}) } },
    orderBy: { notedAt: "desc" },
  })
}
