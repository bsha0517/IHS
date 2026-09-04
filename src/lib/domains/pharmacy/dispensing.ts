import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { writeClinicalAccessLog } from "@/lib/platform/access-log"
import { nextNumber } from "@/lib/platform/sequences"
import { isPharmacyEnabled } from "@/lib/platform/settings"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { consumeStock } from "@/lib/domains/inventory/stock"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, assertBranchAccess, patientVisibilityWhere } from "@/lib/platform/branch-scope"
import { looksLikeSameMedication } from "@/lib/utils/medication-match"
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
  // P3.6 §36: every Pharmacy write function checked organization membership
  // but never branch — the same class of gap P3.3/P3.5 already closed in
  // their own domains, confirmed here by direct code reading rather than
  // assumed safe. A pharmacist authorized only for Branch B could otherwise
  // create/verify/dispense/return against a Branch A prescription.
  assertBranchAccess(getAuthorizedBranchScope(session), item.prescription.encounter.branchId)
  if (item.prescription.status !== "active") throw new Error(`This prescription is "${item.prescription.status}", not active.`)

  // Targeted backlog closure, item 8: server-side mirror of the client
  // dialog's own warning check — the requirement can't be bypassed by a
  // client that skips showing it. Never auto-substitutes, never blocks a
  // legitimate substitution — only requires the pharmacist to have
  // explicitly ticked the confirmation the dialog shows when the names
  // don't obviously correspond. See looksLikeSameMedication's own doc
  // comment for why this is a deliberately simple, non-clinical trigger.
  const medication = await db.medication.findFirst({
    where: { id: input.medicationId, organizationId: session.user.organizationId },
    include: { product: { select: { name: true } } },
  })
  if (!medication) throw new Error("This medication no longer exists or is not accessible.")
  const substitution = !looksLikeSameMedication(item.medicationName, medication.product.name)
  if (substitution && !input.substitutionConfirmed) {
    throw new Error(
      `"${medication.product.name}" doesn't obviously match the prescribed "${item.medicationName}" — confirm the substitution before dispensing.`
    )
  }

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
      substitutionConfirmed: substitution && !!input.substitutionConfirmed,
    },
  })

  await auditFromSession(session, "create", "dispensing_record", created.id, {
    new: { prescriptionItemId: item.id, medicationId: input.medicationId, quantity: input.quantityDispensed, substitutionConfirmed: created.substitutionConfirmed },
  })
  return created
}

/** Pharmacist review before dispensing (spec.md §29's "Verification" step, segregation of duties from the dispense action itself). */
export async function verifyDispensingRecord(session: SessionContext, id: string) {
  assertCan(session, "prescription.verify")
  await assertPharmacyEnabled(session.user.organizationId)

  const record = await db.dispensingRecord.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  // P3.6 §36: see `createDispensingRecord`'s comment for the full reasoning
  // — `DispensingRecord` carries its own `branchId` directly (no join
  // needed, unlike Prescription itself).
  assertBranchAccess(getAuthorizedBranchScope(session), record.branchId)
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
  // P3.6 §36: see `createDispensingRecord`'s comment for the full reasoning.
  assertBranchAccess(getAuthorizedBranchScope(session), record.branchId)
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

    const dispensed = await tx.dispensingRecord.update({ where: { id }, data: { chargeId: charge.id } })

    // P3.6 §27: `Prescription.status` never transitioned to `completed`
    // anywhere in the codebase before this fix — a fully-dispensed
    // prescription stayed "active" forever, the exact "never leave a fully
    // fulfilled prescription looking pending" gap this section warns
    // against. Uses the identical "still open" predicate `listPharmacyQueue`
    // already computes for the queue itself (remainingQuantity null or >0
    // on any item), so this can never disagree with what the queue shows —
    // one definition of "done," not two competing ones. An item with no
    // `quantity` set can never be counted done by this predicate (there is
    // no total to compare against), so a prescription with any such item
    // simply never auto-completes — conservative by construction, never a
    // false "fully dispensed."
    const siblings = await tx.prescriptionItem.findMany({
      where: { prescriptionId: record.prescriptionId },
      include: { dispensingRecords: { select: { status: true, quantityDispensed: true } } },
    })
    const stillOpen = siblings.some((item) => {
      if (item.quantity == null) return true
      const dispensedQty = item.dispensingRecords.filter((d) => d.status !== "cancelled").reduce((sum, d) => sum + d.quantityDispensed, 0)
      return dispensedQty < item.quantity
    })
    if (!stillOpen) {
      // `updateMany` (not `update`) so this is a clean no-op rather than an
      // error if the prescription was already completed by a concurrent
      // dispense of a sibling item, and so it never clobbers `cancelled`.
      await tx.prescription.updateMany({ where: { id: record.prescriptionId, status: "active" }, data: { status: "completed" } })
    }

    return dispensed
  }, { timeout: 20_000, maxWait: 10_000 })

  await auditFromSession(session, "update", "dispensing_record", id, { new: { status: "dispensed" } })
  await dispatchPendingOutboxEvents(session.user.organizationId)
  return updated
}

/**
 * "Returns" (spec.md §29) — a correcting record, never an edit to the
 * original dispensing. Always restores stock. Its financial effect depends
 * on whether the original Charge has been invoiced yet (P3.9 §36-39):
 *
 *   - `charge.status === "pending"` (never invoiced — no InvoiceLine, no
 *     revenue ever recognized, no payment possible): the DispensingRecord ->
 *     Charge FK (unique, always set once dispensed) makes this state
 *     unambiguous, so the financial side closes completely here — the
 *     charge is voided and its COGS posting reversed via the same
 *     ProductSaleVoided event/postProductSaleVoided path voidCharge uses
 *     for a POS sale (charge-id-keyed, so it works correctly even though a
 *     pharmacy Charge never carries `productId` — see voidCharge's own
 *     stock-reversal branch, which pharmacy charges never trigger since
 *     dispenseRecord already moved that stock itself, above). Stock,
 *     revenue, and cost are all correctly closed for this state — not a
 *     partial fix, since revenue/AR were never touched in the first place.
 *   - `charge.status === "invoiced"`: NOT reversed here. P3.9 §36 traced
 *     whether a returned dispensing can be reliably mapped through
 *     DispensingRecord -> Charge -> InvoiceLine -> Invoice -> Payment/
 *     refund state — it can, one-to-one, via InvoiceLine's own unique
 *     `chargeId` (and InvoiceLine already carries this exact line's own
 *     lineTotal/taxAmount/discountAmount). What it can NOT reliably
 *     determine is whether — and how much of — THIS SPECIFIC line was ever
 *     actually paid: `PaymentAllocation` (payment/invoices.ts) is
 *     invoice-level only, with no line-level granularity, so on a
 *     multi-line, partially-paid invoice there is no safe way to know
 *     whether the returned line's own portion was paid, still owed, or
 *     covered by a payment that was really intended for a sibling line.
 *     Reversing revenue/AR/issuing a refund here without that guarantee
 *     risks crediting money that was never collected for this specific
 *     item, or leaving a genuinely-paid item's revenue overstated — exactly
 *     the "solve only one leg and call it fixed" outcome P3.9 §37
 *     prohibits. See BACKLOG.md for the CreditNote/line-level-reversal
 *     design this needs. The caller (returnDispensingRecordAction) surfaces
 *     `financialReversal: "manual_review_required"` so the UI can say so
 *     plainly rather than implying money was refunded.
 *   - `charge.status === "void"`: nothing to reverse (never billed, or
 *     already reversed by some other path) — `financialReversal:
 *     "not_applicable"`.
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
    include: { medication: true, charge: true },
  })
  // P3.6 §36: see `createDispensingRecord`'s comment for the full reasoning.
  assertBranchAccess(getAuthorizedBranchScope(session), record.branchId)
  if (record.status !== "dispensed") throw new Error("Only a dispensed record can be returned.")

  type FinancialReversal = "reversed" | "manual_review_required" | "not_applicable"

  const { returnRecord: created, financialReversal } = await db.$transaction(async (tx) => {
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

    // P3.9 §36-39: only a full return (every unit dispensed, across all
    // returns) can safely close the Charge — a partial return leaves real
    // units still legitimately sold, so the Charge/COGS must stay exactly
    // as posted for those. A charge is never voided/reversed twice
    // (guarded by its own status check, not this function's own state).
    const fullyReturned = alreadyReturned + input.quantityReturned >= record.quantityDispensed
    let financialReversal: FinancialReversal = "not_applicable"
    if (record.charge?.status === "pending") {
      if (fullyReturned) {
        await tx.charge.update({
          where: { id: record.charge.id },
          data: { status: "void", voidReason: `Dispensing returned: ${input.reason}` },
        })
        await writeOutboxEvent(tx, {
          organizationId: session.user.organizationId,
          eventType: "ProductSaleVoided",
          payload: { branchId: record.charge.branchId, chargeId: record.charge.id },
        })
        financialReversal = "reversed"
      } else {
        // A partial return leaves the charge covering more units than were
        // actually kept — Charge has no supported way to reduce its own
        // quantity/amount in place, so this needs the same manual review a
        // returned-and-already-invoiced charge does, not a silent no-op.
        financialReversal = "manual_review_required"
      }
    } else if (record.charge?.status === "invoiced") {
      financialReversal = "manual_review_required"
    }

    return { returnRecord, financialReversal }
  }, { timeout: 20_000, maxWait: 10_000 })

  if (financialReversal === "reversed") {
    await dispatchPendingOutboxEvents(session.user.organizationId)
  }

  await auditFromSession(session, "create", "dispensing_return", created.id, {
    new: { dispensingRecordId: id, quantity: input.quantityReturned, financialReversal },
  })
  return { ...created, financialReversal }
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
  const history = await db.patientMedicationHistory.findMany({
    where: { patientId, patient: { organizationId: session.user.organizationId, ...(visibility ?? {}) } },
    orderBy: { notedAt: "desc" },
  })
  // P2 §7: medication history is real chart content, previously unlogged.
  await writeClinicalAccessLog({ session, patientId, resourceType: "medication_history", action: "view" })
  return history
}
