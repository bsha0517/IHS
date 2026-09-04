import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { consumeStock } from "@/lib/domains/inventory/stock"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { claimIdempotencyKey, recordIdempotentResult, resolveDuplicateRequest, isIdempotencyKeyConflict } from "@/lib/platform/idempotency"
import type { Prisma } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"
import type { AdHocChargeInput } from "@/lib/domains/billing/schemas"

type Db = Prisma.TransactionClient | typeof db

const IDEMPOTENCY_SCOPE = "charge.create_adhoc"

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
    productId?: string | null
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
      productId: input.productId ?? null,
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

  // P1 §9/§10/§11: a direct retail product sale (sourceType "product" with
  // a real productId — see the schema's own doc comment on Charge.productId
  // for why presence, not sourceType, is the trigger) consumes real stock
  // via the same FEFO-safe, expired-batch-excluding consumeStock() every
  // other inventory movement in this system goes through — never a direct
  // decrement. Insufficient stock throws (allocateFefo), which aborts this
  // entire transaction, so a charge (and therefore any invoice built from
  // it) can never exist without the inventory movement that should
  // accompany it — the same guarantee already held for service-triggered
  // consumption above, extended to the one path that previously had none
  // at all. The resulting cost feeds a `ProductSold` event, posted
  // asynchronously (postProductSaleCogs, accounting/posting-service.ts) —
  // Dr COGS / Cr Inventory Asset — the moment stock actually left the
  // shelf, not deferred to whenever the charge is later invoiced.
  if (input.productId) {
    const { totalCost } = await consumeStock(tx, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      productId: input.productId,
      quantity: input.quantity,
      referenceType: "charge",
      referenceId: charge.id,
      performedBy: input.createdBy,
      transactionType: "sale",
    })

    if (totalCost.greaterThan(0)) {
      await writeOutboxEvent(tx, {
        organizationId: input.organizationId,
        eventType: "ProductSold",
        payload: { branchId: input.branchId, chargeId: charge.id, cost: Number(totalCost) },
      })
    }
  }

  return charge
}

/**
 * P1/P3.7 §45: previously had no duplicate-submission guard at all — unlike
 * `dispenseRecord`/`completeRefund`, there is no pre-existing row to
 * atomically claim here (every call creates a brand-new Charge), so a
 * realistic Cashier/POS double-submit (a double-click on "Add charge", or a
 * network retry after the first request actually succeeded but the client
 * never saw the response) would previously create two identical Charge rows
 * — real duplicate patient billing, silently. Fixed with the same
 * client-supplied `idempotencyKey` mechanism `recordPayment` already
 * established (see `platform/idempotency.ts`): the POS "Add charge" dialog
 * generates one key per dialog-open and resubmits it unchanged on any
 * retry, so a genuine duplicate submission replays the original Charge
 * instead of creating a second one.
 */
export async function createAdHocCharge(session: SessionContext, input: AdHocChargeInput & { idempotencyKey?: string }) {
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
  if (input.productId) {
    const product = await db.product.findFirstOrThrow({
      where: { id: input.productId, organizationId: session.user.organizationId },
    })
    if (!unitPrice) unitPrice = Number(product.sellingPrice ?? product.purchaseCost)
    if (!description) description = product.name
  }

  let charge
  try {
    charge = await db.$transaction(
      async (tx) => {
        if (input.idempotencyKey) {
          await claimIdempotencyKey(tx, { organizationId: session.user.organizationId, scope: IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
        }
        const created = await insertCharge(tx, {
          organizationId: session.user.organizationId,
          branchId: input.branchId,
          patientId: input.patientId,
          encounterId: input.encounterId,
          serviceId: input.serviceId,
          productId: input.productId,
          providerId: input.providerId,
          sourceType: input.sourceType,
          description,
          quantity: input.quantity,
          unitPrice,
          createdBy: session.user.id,
        })
        if (input.idempotencyKey) {
          await recordIdempotentResult(tx, { organizationId: session.user.organizationId, scope: IDEMPOTENCY_SCOPE, key: input.idempotencyKey, resultId: created.id })
        }
        return created
      },
      { timeout: 20_000, maxWait: 10_000 }
    )
  } catch (error) {
    if (input.idempotencyKey && isIdempotencyKeyConflict(error)) {
      const resultId = await resolveDuplicateRequest({ organizationId: session.user.organizationId, scope: IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
      return db.charge.findUniqueOrThrow({ where: { id: resultId } }) // idempotent replay — the original request's own charge, not a new one
    }
    throw error
  }

  await auditFromSession(session, "create", "charge", charge.id, {
    new: { sourceType: charge.sourceType, description: charge.description, amount: Number(charge.amount) },
  })
  if (input.productId) {
    await dispatchPendingOutboxEvents(session.user.organizationId)
  }

  return charge
}

export async function voidCharge(session: SessionContext, chargeId: string, reason: string) {
  assertCan(session, "charge.void")

  const charge = await db.charge.findFirstOrThrow({
    where: { id: chargeId, organizationId: session.user.organizationId },
  })
  // P3.7 §41: every Billing/POS write function checked organization
  // membership but never branch — the same class of gap P3.3/P3.5/P3.6
  // already closed in their own domains, confirmed here by direct code
  // reading rather than assumed. A cashier authorized only for Branch B
  // could otherwise void a Branch A charge.
  assertBranchAccess(getAuthorizedBranchScope(session), charge.branchId)
  if (charge.status !== "pending") {
    throw new Error(`Only a pending charge can be voided (this one is "${charge.status}").`)
  }

  const updated = await db.$transaction(async (tx) => {
    const result = await tx.charge.update({
      where: { id: chargeId },
      data: { status: "void", voidReason: reason },
    })

    // P1 §9: voiding a product-sale charge (only reachable while still
    // "pending" — never after it's been invoiced) must not leave the stock
    // it consumed permanently gone. Reverses each batch-level consumption
    // entry with a positive return — never edits or deletes the original
    // sale entries (spec.md §92) — then triggers the matching COGS reversal
    // asynchronously (postProductSaleVoided), the same outbox-driven
    // pattern every other accounting-relevant event in this system uses.
    if (charge.productId) {
      const consumedEntries = await tx.stockLedgerEntry.findMany({
        where: { organizationId: session.user.organizationId, referenceType: "charge", referenceId: chargeId, transactionType: "sale" },
      })
      for (const entry of consumedEntries) {
        await tx.stockLedgerEntry.create({
          data: {
            organizationId: session.user.organizationId,
            branchId: entry.branchId,
            productId: entry.productId,
            batchId: entry.batchId,
            transactionType: "return",
            quantity: entry.quantity.negated(),
            referenceType: "charge_void",
            referenceId: chargeId,
            performedBy: session.user.id,
          },
        })
      }
      if (consumedEntries.length > 0) {
        await writeOutboxEvent(tx, {
          organizationId: session.user.organizationId,
          eventType: "ProductSaleVoided",
          payload: { branchId: charge.branchId, chargeId },
        })
      }
    }

    return result
  }, { timeout: 20_000, maxWait: 10_000 })

  await auditFromSession(session, "void", "charge", chargeId, { old: charge, new: { status: "void", reason } })
  if (charge.productId) {
    await dispatchPendingOutboxEvents(session.user.organizationId)
  }
  return updated
}

export async function listPendingCharges(session: SessionContext, patientId: string) {
  assertCan(session, "charge.create")
  const scope = getAuthorizedBranchScope(session)
  return db.charge.findMany({
    where: { organizationId: session.user.organizationId, patientId, status: "pending", branchId: narrowBranchFilter(scope) },
    include: { service: true, encounter: true, provider: true },
    orderBy: { createdAt: "asc" },
  })
}

export async function listPatientCharges(session: SessionContext, patientId: string) {
  assertCan(session, "invoice.view")
  const scope = getAuthorizedBranchScope(session)
  return db.charge.findMany({
    where: { organizationId: session.user.organizationId, patientId, branchId: narrowBranchFilter(scope) },
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
