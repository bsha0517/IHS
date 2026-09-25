import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { Prisma } from "@/generated/prisma/client"
import { db } from "@/lib/db"
import { assertCan, can, ForbiddenError } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { generateSystemCharge } from "@/lib/domains/billing/charges"
import { writeOutboxEvent, dispatchPendingOutboxEvents } from "@/lib/platform/outbox"
import "@/lib/platform/event-handlers"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import { claimIdempotencyKey, recordIdempotentResult, resolveDuplicateRequest, isIdempotencyKeyConflict } from "@/lib/platform/idempotency"
import type { SessionContext } from "@/lib/auth/session"
import type { PackageInput, PurchasePackageInput, ConsumeSessionInput } from "@/lib/domains/packages/schemas"

const CONSUME_SESSION_IDEMPOTENCY_SCOPE = "package.consume_session"

export async function listPackages(session: SessionContext) {
  assertCan(session, "service.view")
  return db.package.findMany({
    where: { organizationId: session.user.organizationId },
    include: { services: { include: { service: true } } },
    orderBy: { name: "asc" },
  })
}

export async function createPackage(session: SessionContext, input: PackageInput) {
  assertCan(session, "package.manage")

  const created = await db.$transaction(async (tx) => {
    const pkg = await tx.package.create({
      data: {
        organizationId: session.user.organizationId,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        price: new Decimal(input.price),
        discountAmount: new Decimal(input.discountAmount),
        validityDays: input.validityDays ?? null,
      },
    })
    await tx.packageService.createMany({
      data: input.services.map((s) => ({ packageId: pkg.id, serviceId: s.serviceId, sessionsAllocated: s.sessionsAllocated })),
    })
    return pkg
  })

  await auditFromSession(session, "create", "package", created.id, { new: { code: created.code, name: created.name } })
  return created
}

/**
 * Sold through the same Charge -> Invoice -> Payment path as everything
 * else (spec.md §33: "Create Charge entity if appropriate") — a package
 * purchase is absolutely a billable event. The PatientPackage is created
 * `active` immediately (sessions usable) independent of payment status,
 * matching how a Prescription is issued regardless of billing state — the
 * whole point of separating Charge from Invoice/Payment (spec.md §33) is
 * that the service can be rendered before payment settles.
 */
export async function purchasePackage(session: SessionContext, input: PurchasePackageInput) {
  assertCan(session, "package.sell", { branchId: input.branchId })

  const pkg = await db.package.findFirstOrThrow({
    where: { id: input.packageId, organizationId: session.user.organizationId },
  })
  const purchasePrice = new Decimal(input.priceOverride ?? Number(pkg.price) - Number(pkg.discountAmount))

  const result = await db.$transaction(async (tx) => {
    const expiresAt = pkg.validityDays ? new Date(Date.now() + pkg.validityDays * 24 * 60 * 60 * 1000) : null
    const patientPackage = await tx.patientPackage.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId,
        patientId: input.patientId,
        packageId: pkg.id,
        purchasePrice,
        expiresAt,
        createdBy: session.user.id,
      },
    })

    const charge = await generateSystemCharge(tx, {
      organizationId: session.user.organizationId,
      branchId: input.branchId,
      patientId: input.patientId,
      sourceType: "package",
      sourceReferenceId: patientPackage.id,
      description: `Package: ${pkg.name}`,
      quantity: 1,
      unitPrice: Number(purchasePrice),
    })

    return { patientPackage, charge }
  })

  await auditFromSession(session, "purchase", "patient_package", result.patientPackage.id, {
    new: { packageId: pkg.id, purchasePrice: Number(purchasePrice) },
  })
  return result
}

export async function listPatientPackages(session: SessionContext, patientId: string) {
  // Doctor/Nurse hold package.consume but not service.view (system-roles.ts)
  // — they still need to see a patient's package balances to pick which one
  // to consume a session from (the only UI path to package.consume).
  if (!can(session, "service.view") && !can(session, "package.consume")) {
    throw new ForbiddenError("service.view")
  }
  const scope = getAuthorizedBranchScope(session)
  const patientPackages = await db.patientPackage.findMany({
    where: { organizationId: session.user.organizationId, patientId, branchId: narrowBranchFilter(scope) },
    include: {
      package: { include: { services: { include: { service: true } } } },
      sessions: { include: { packageService: { include: { service: true } } } },
    },
    orderBy: { purchasedAt: "desc" },
  })

  return patientPackages.map((pp) => ({
    ...pp,
    remaining: pp.package.services.map((ps) => ({
      packageServiceId: ps.id,
      serviceName: ps.service.name,
      allocated: ps.sessionsAllocated,
      used: pp.sessions.filter((s) => s.packageServiceId === ps.id).length,
    })),
  }))
}

/**
 * "Every session consumption requires history" (spec.md §32) — this is that
 * history, never a mutable counter.
 *
 * P1 §28: the pre-transaction reads below are a fast, friendly-error path
 * for the common (non-racing) case only — NOT the safety mechanism, same
 * discipline as recordPayment's own preliminary check. The actual guard is
 * the `SELECT ... FOR UPDATE` inside the transaction: it locks this specific
 * PatientPackage row before re-fetching the package/sessions and
 * re-validating status/expiry/remaining-count against that locked read, so
 * two simultaneous completion requests against a package with exactly one
 * session remaining serialize — the second one re-checks under the lock
 * after the first has already committed its insert, and correctly sees zero
 * remaining rather than the stale "one remaining" both would see under an
 * unlocked read.
 *
 * P1 §33: the lock above stops a double-click from OVERSELLING past the
 * total, but not from double-CONSUMING when there's headroom — a package
 * with 5 sessions remaining and a double-clicked "complete" would let both
 * requests succeed, burning 2 sessions for what was really one visit.
 * `idempotencyKey`, when supplied, closes that — see platform/idempotency.ts.
 */
export async function consumeSession(session: SessionContext, input: ConsumeSessionInput & { idempotencyKey?: string }) {
  assertCan(session, "package.consume")

  const patientPackage = await db.patientPackage.findFirstOrThrow({
    where: { id: input.patientPackageId, organizationId: session.user.organizationId },
    include: { package: { include: { services: true } } },
  })
  if (patientPackage.status !== "active") {
    throw new Error(`This package is "${patientPackage.status}" and cannot be used.`)
  }
  if (patientPackage.expiresAt && patientPackage.expiresAt < new Date()) {
    throw new Error("This package has expired.")
  }
  const packageService = patientPackage.package.services.find((ps) => ps.id === input.packageServiceId)
  if (!packageService) throw new Error("That service is not part of this package.")

  try {
    const consumption = await db.$transaction(async (tx) => {
      if (input.idempotencyKey) {
        await claimIdempotencyKey(tx, { organizationId: session.user.organizationId, scope: CONSUME_SESSION_IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
      }

      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "patient_package" WHERE "id" = ${patientPackage.id} FOR UPDATE`)

      const locked = await tx.patientPackage.findUniqueOrThrow({
        where: { id: patientPackage.id },
        include: { package: { include: { services: true } }, sessions: true },
      })
      if (locked.status !== "active") {
        throw new Error(`This package is "${locked.status}" and cannot be used.`)
      }
      if (locked.expiresAt && locked.expiresAt < new Date()) {
        throw new Error("This package has expired.")
      }
      const lockedService = locked.package.services.find((ps) => ps.id === input.packageServiceId)
      if (!lockedService) throw new Error("That service is not part of this package.")

      const usedForService = locked.sessions.filter((s) => s.packageServiceId === input.packageServiceId).length
      if (usedForService >= lockedService.sessionsAllocated) {
        throw new Error("No remaining sessions for this service in the package.")
      }

      const record = await tx.patientPackageSession.create({
        data: {
          organizationId: session.user.organizationId,
          patientPackageId: patientPackage.id,
          packageServiceId: input.packageServiceId,
          encounterId: input.encounterId ?? null,
          notes: input.notes ?? null,
          consumedBy: session.user.id,
        },
      })

      const allExhausted = locked.package.services.every((ps) => {
        const used = locked.sessions.filter((s) => s.packageServiceId === ps.id).length + (ps.id === input.packageServiceId ? 1 : 0)
        return used >= ps.sessionsAllocated
      })
      if (allExhausted) {
        await tx.patientPackage.update({ where: { id: patientPackage.id }, data: { status: "exhausted" } })
      }

      await writeOutboxEvent(tx, {
        organizationId: session.user.organizationId,
        eventType: "PackageSessionConsumed",
        payload: { patientPackageSessionId: record.id },
      })

      if (input.idempotencyKey) {
        await recordIdempotentResult(tx, { organizationId: session.user.organizationId, scope: CONSUME_SESSION_IDEMPOTENCY_SCOPE, key: input.idempotencyKey, resultId: record.id })
      }

      return record
    }, { timeout: 20_000, maxWait: 10_000 })

    await auditFromSession(session, "consume", "patient_package_session", consumption.id, {
      new: { patientPackageId: patientPackage.id, packageServiceId: input.packageServiceId },
    })
    await dispatchPendingOutboxEvents(session.user.organizationId)
    return consumption
  } catch (error) {
    if (input.idempotencyKey && isIdempotencyKeyConflict(error)) {
      const resultId = await resolveDuplicateRequest({ organizationId: session.user.organizationId, scope: CONSUME_SESSION_IDEMPOTENCY_SCOPE, key: input.idempotencyKey })
      return db.patientPackageSession.findUniqueOrThrow({ where: { id: resultId } }) // idempotent replay
    }
    throw error
  }
}
