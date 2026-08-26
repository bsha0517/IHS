import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

const PRESCRIPTION_INCLUDE = {
  patient: true,
  provider: true,
  items: { include: { dispensingRecords: true } },
} as const

/**
 * The Pharmacy Queue (spec.md §29) — every active Prescription with at
 * least one item not yet fully dispensed. "Fully dispensed" is always
 * derived live by summing non-cancelled DispensingRecord.quantityDispensed
 * per item against PrescriptionItem.quantity, never a stored counter — the
 * same discipline as every other queue/balance computation in this
 * codebase since Phase 5's stock ledger.
 */
export async function listPharmacyQueue(session: SessionContext) {
  assertCan(session, "prescription.dispense")

  const prescriptions = await db.prescription.findMany({
    where: { organizationId: session.user.organizationId, status: "active" },
    include: PRESCRIPTION_INCLUDE,
    orderBy: { issuedAt: "asc" },
  })

  return prescriptions
    .map((rx) => ({
      ...rx,
      items: rx.items.map((item) => {
        const dispensed = item.dispensingRecords
          .filter((d) => d.status !== "cancelled")
          .reduce((sum, d) => sum + d.quantityDispensed, 0)
        const remaining = item.quantity != null ? Math.max(0, item.quantity - dispensed) : null
        return { ...item, dispensedQuantity: dispensed, remainingQuantity: remaining }
      }),
    }))
    .filter((rx) => rx.items.some((item) => item.remainingQuantity == null || item.remainingQuantity > 0))
}

export async function getPrescriptionForDispensing(session: SessionContext, prescriptionId: string) {
  assertCan(session, "prescription.dispense")

  const prescription = await db.prescription.findFirstOrThrow({
    where: { id: prescriptionId, organizationId: session.user.organizationId },
    include: {
      ...PRESCRIPTION_INCLUDE,
      items: { include: { dispensingRecords: { include: { medication: { include: { product: true } }, returns: true } } } },
    },
  })

  const items = prescription.items.map((item) => {
    const dispensed = item.dispensingRecords
      .filter((d) => d.status !== "cancelled")
      .reduce((sum, d) => sum + d.quantityDispensed, 0)
    const remaining = item.quantity != null ? Math.max(0, item.quantity - dispensed) : null
    return { ...item, dispensedQuantity: dispensed, remainingQuantity: remaining }
  })

  return { ...prescription, items }
}
