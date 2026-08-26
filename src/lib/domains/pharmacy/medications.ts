import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { MedicationInput } from "@/lib/domains/pharmacy/schemas"

const MEDICATION_INCLUDE = { product: true } as const

export async function listMedications(session: SessionContext) {
  assertCan(session, "inventory.view")
  return db.medication.findMany({
    where: { organizationId: session.user.organizationId, product: { isActive: true } },
    include: MEDICATION_INCLUDE,
    orderBy: { product: { name: "asc" } },
  })
}

/**
 * "Medication Master" (spec.md §29) creates a Product + Medication pair
 * together in one action — a medication is an inventory item first (stock,
 * batches, cost all live on Product per Phase 5), with pharmacy-specific
 * fields layered on top, not a parallel item master duplicating Product.
 */
export async function createMedication(session: SessionContext, input: MedicationInput) {
  assertCan(session, "product.manage")

  const created = await db.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        organizationId: session.user.organizationId,
        sku: input.sku,
        barcode: input.barcode ?? null,
        name: input.name,
        category: input.category,
        brand: input.brand ?? null,
        unit: input.unit,
        purchaseCost: new Decimal(input.purchaseCost),
        sellingPrice: input.sellingPrice != null ? new Decimal(input.sellingPrice) : null,
        reorderLevel: input.reorderLevel,
        minimumStock: input.minimumStock,
        maximumStock: input.maximumStock ?? null,
      },
    })
    const medication = await tx.medication.create({
      data: {
        organizationId: session.user.organizationId,
        productId: product.id,
        genericName: input.genericName ?? null,
        strength: input.strength ?? null,
        dosageForm: input.dosageForm,
        route: input.route ?? null,
        controlledSubstance: input.controlledSubstance,
        requiresPrescription: input.requiresPrescription,
      },
    })
    return { ...medication, product }
  })

  await auditFromSession(session, "create", "medication", created.id, { new: { sku: created.product.sku, name: created.product.name } })
  return created
}

export async function updateMedication(session: SessionContext, id: string, input: MedicationInput) {
  assertCan(session, "product.manage")

  const existing = await db.medication.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: MEDICATION_INCLUDE,
  })

  const updated = await db.$transaction(async (tx) => {
    const product = await tx.product.update({
      where: { id: existing.productId },
      data: {
        sku: input.sku,
        barcode: input.barcode ?? null,
        name: input.name,
        category: input.category,
        brand: input.brand ?? null,
        unit: input.unit,
        purchaseCost: new Decimal(input.purchaseCost),
        sellingPrice: input.sellingPrice != null ? new Decimal(input.sellingPrice) : null,
        reorderLevel: input.reorderLevel,
        minimumStock: input.minimumStock,
        maximumStock: input.maximumStock ?? null,
      },
    })
    const medication = await tx.medication.update({
      where: { id },
      data: {
        genericName: input.genericName ?? null,
        strength: input.strength ?? null,
        dosageForm: input.dosageForm,
        route: input.route ?? null,
        controlledSubstance: input.controlledSubstance,
        requiresPrescription: input.requiresPrescription,
      },
    })
    return { ...medication, product }
  })

  await auditFromSession(session, "update", "medication", id, { old: existing, new: input })
  return updated
}
