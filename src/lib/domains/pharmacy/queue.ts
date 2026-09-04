import "server-only"
import { db } from "@/lib/db"
import { assertCan, can, ForbiddenError } from "@/lib/platform/permissions-core"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"

const PRESCRIPTION_INCLUDE = {
  patient: true,
  provider: true,
  // Prescription has no branchId/branch relation of its own (Phase 3) —
  // derived from its Encounter, the same pattern dispensing.ts's own
  // branch-check comment describes.
  encounter: { select: { branch: { select: { name: true } } } },
  items: { include: { dispensingRecords: true } },
} as const

function deriveItems<T extends { quantity: number | null; dispensingRecords: { status: string; quantityDispensed: number }[] }>(
  items: T[]
) {
  return items.map((item) => {
    const dispensed = item.dispensingRecords
      .filter((d) => d.status !== "cancelled")
      .reduce((sum, d) => sum + d.quantityDispensed, 0)
    const remaining = item.quantity != null ? Math.max(0, item.quantity - dispensed) : null
    return { ...item, dispensedQuantity: dispensed, remainingQuantity: remaining }
  })
}

/**
 * The Pharmacy Queue (spec.md §29). "Fully dispensed" is always derived live
 * by summing non-cancelled DispensingRecord.quantityDispensed per item
 * against PrescriptionItem.quantity, never a stored counter — the same
 * discipline as every other queue/balance computation in this codebase
 * since Phase 5's stock ledger.
 *
 * P3.6 §6/§33: `filters.status` added — previously always hardcoded to the
 * "still open" active prescriptions only, with no way to see dispensed/
 * cancelled history from this page. `branch` (§6's own named field) added
 * to the include — `Prescription` has no `branchId` of its own, but
 * `encounter.branch` isn't traversed from a filter, so this joins through
 * the relation directly rather than duplicating narrowBranchFilter's own
 * `encounter: {branchId:...}` shape for display.
 */
export async function listPharmacyQueue(session: SessionContext, filters: { status?: "pending" | "partial" | "dispensed" | "cancelled" } = {}) {
  assertCan(session, "prescription.dispense")
  const scope = getAuthorizedBranchScope(session)

  const statusWhere = filters.status === "cancelled" ? { status: "cancelled" as const } : filters.status === "dispensed" ? { status: "completed" as const } : { status: "active" as const }

  const prescriptions = await db.prescription.findMany({
    where: {
      organizationId: session.user.organizationId,
      ...statusWhere,
      encounter: { branchId: narrowBranchFilter(scope) },
    },
    include: PRESCRIPTION_INCLUDE,
    orderBy: { issuedAt: "asc" },
  })

  const derived = prescriptions.map((rx) => ({ ...rx, items: deriveItems(rx.items) }))
  if (filters.status === "cancelled" || filters.status === "dispensed") return derived

  const stillOpen = derived.filter((rx) => rx.items.some((item) => item.remainingQuantity == null || item.remainingQuantity > 0))
  if (filters.status === "pending") return stillOpen.filter((rx) => rx.items.every((item) => item.dispensedQuantity === 0))
  if (filters.status === "partial") return stillOpen.filter((rx) => rx.items.some((item) => item.dispensedQuantity > 0))
  return stillOpen
}

/**
 * P3.6 §37: widened from `prescription.dispense` alone so a Doctor session
 * (which only holds `encounter.view`, the same permission `getPrescription`/
 * `listPatientPrescriptions` already trust for prescription reads) has a
 * real destination to see fulfillment from the Encounter — the P3.5
 * Lab/Radiology precedent, reused conceptually, not verbatim. Every
 * operational action on the page still requires `prescription.dispense`/
 * `prescription.verify` independently.
 */
export async function getPrescriptionForDispensing(session: SessionContext, prescriptionId: string) {
  if (!can(session, "prescription.dispense") && !can(session, "encounter.view")) throw new ForbiddenError("prescription.dispense")

  const prescription = await db.prescription.findFirstOrThrow({
    where: { id: prescriptionId, organizationId: session.user.organizationId },
    include: {
      ...PRESCRIPTION_INCLUDE,
      encounter: { select: { branchId: true, branch: { select: { name: true } } } },
      items: { include: { dispensingRecords: { include: { medication: { include: { product: true } }, returns: true } } } },
    },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), prescription.encounter.branchId)

  return { ...prescription, items: deriveItems(prescription.items) }
}
