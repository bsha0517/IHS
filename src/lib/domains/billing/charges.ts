import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { consumeStock } from "@/lib/domains/inventory/stock"
import type { Prisma } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"
import type { AdHocChargeInput } from "@/lib/domains/billing/schemas"

type Db = Prisma.TransactionClient | typeof db

/**
 * The billing engine's only entry point for creating a Charge (spec.md §33 —
 * "do not build billing logic directly inside the POS UI"). Every billable
 * event, whether system-triggered (consultation completion) or staff-entered
 * at POS (ad-hoc procedure/product/other), goes through this one function so
 * `amount` is always computed here, never trusted from a caller.
 *
 * Also the automatic-clinical-consumption hook (spec.md §44): if the charge
 * is tied to a Service with a consumption template, this deducts the
 * template's products from stock in the same transaction as the charge
 * itself — Charge is the one place that already captures "this service was
 * delivered" with the correct service/branch context, whether the charge
 * came from an automatic trigger or a POS-entered ad-hoc line, so hooking in
 * here covers both without touching CPOE. Insufficient stock throws, which
 * aborts the whole charge — you cannot bill for consuming stock that isn't
 * there.
 */
async function insertCharge(
  tx: Db,
  input: {
    organizationId: string
    branchId: string
    patientId: string
    encounterId?: string | null
    serviceId?: string | null
    providerId?: string | null
    sourceType: string
    sourceReferenceId?: string | null
    description: string
    quantity: number
    unitPrice: number
    createdBy: string | null
  }
) {
  const unitPrice = new Decimal(input.unitPrice)
  const amount = unitPrice.mul(input.quantity)
  const charge = await tx.charge.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      patientId: input.patientId,
      encounterId: input.encounterId ?? null,
      serviceId: input.serviceId ?? null,
      providerId: input.providerId ?? null,
      sourceType: input.sourceType as never,
      sourceReferenceId: input.sourceReferenceId ?? null,
      description: input.description,
      quantity: input.quantity,
      unitPrice,
      amount,
      createdBy: input.createdBy,
    },
  })

  if (input.serviceId) {
    const templateLines = await tx.serviceProductConsumption.findMany({ where: { serviceId: input.serviceId } })
    for (const line of templateLines) {
      await consumeStock(tx, {
        organizationId: input.organizationId,
        branchId: input.branchId,
        productId: line.productId,
        quantity: Number(line.quantityPerUnit) * input.quantity,
        referenceType: "charge",
        referenceId: charge.id,
        performedBy: input.createdBy,
      })
    }
  }

  return charge
}

export async function createAdHocCharge(session: SessionContext, input: AdHocChargeInput) {
  assertCan(session, "charge.create", { branchId: input.branchId })

  let unitPrice = input.unitPrice
  let description = input.description
  if (input.serviceId) {
    const service = await db.service.findFirstOrThrow({
      where: { id: input.serviceId, organizationId: session.user.organizationId },
    })
    if (!unitPrice) unitPrice = Number(service.price)
    if (!description) description = service.name
  }

  const charge = await db.$transaction((tx) =>
    insertCharge(tx, {
      organizationId: session.user.organizationId,
      branchId: input.branchId,
      patientId: input.patientId,
      encounterId: input.encounterId,
      serviceId: input.serviceId,
      providerId: input.providerId,
      sourceType: input.sourceType,
      description,
      quantity: input.quantity,
      unitPrice,
      createdBy: session.user.id,
    })
  )

  await auditFromSession(session, "create", "charge", charge.id, {
    new: { sourceType: charge.sourceType, description: charge.description, amount: Number(charge.amount) },
  })

  return charge
}

export async function voidCharge(session: SessionContext, chargeId: string, reason: string) {
  assertCan(session, "charge.void")

  const charge = await db.charge.findFirstOrThrow({
    where: { id: chargeId, organizationId: session.user.organizationId },
  })
  if (charge.status !== "pending") {
    throw new Error(`Only a pending charge can be voided (this one is "${charge.status}").`)
  }

  const updated = await db.charge.update({
    where: { id: chargeId },
    data: { status: "void", voidReason: reason },
  })

  await auditFromSession(session, "void", "charge", chargeId, { old: charge, new: { status: "void", reason } })
  return updated
}

export async function listPendingCharges(session: SessionContext, patientId: string) {
  assertCan(session, "charge.create")
  return db.charge.findMany({
    where: { organizationId: session.user.organizationId, patientId, status: "pending" },
    include: { service: true, encounter: true, provider: true },
    orderBy: { createdAt: "asc" },
  })
}

export async function listPatientCharges(session: SessionContext, patientId: string) {
  assertCan(session, "invoice.view")
  return db.charge.findMany({
    where: { organizationId: session.user.organizationId, patientId },
    include: { service: true },
    orderBy: { createdAt: "desc" },
  })
}

/**
 * Internal helper for other domains to generate a Charge without going
 * through the ad-hoc POS permission check — used by the EncounterCompleted
 * handler (system-triggered, not a new user-initiated action) and by
 * packages.ts (package sale). Never exported to a Server Action.
 */
export async function generateSystemCharge(
  tx: Db,
  input: {
    organizationId: string
    branchId: string
    patientId: string
    encounterId?: string | null
    serviceId?: string | null
    providerId?: string | null
    sourceType: string
    sourceReferenceId?: string | null
    description: string
    quantity: number
    unitPrice: number
  }
) {
  return insertCharge(tx, { ...input, createdBy: null })
}
