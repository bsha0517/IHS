import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { OpenCashierSessionInput, CashMovementInput, CloseCashierSessionInput } from "@/lib/domains/billing/schemas"

/**
 * Branches a user can open a register at. Deliberately not gated on
 * `branch.view` (the org-wide branch admin permission) — `user_branch_access`
 * is itself the authorization for which branches this user operates in, so a
 * Cashier who can't see the full branch admin list can still see their own.
 */
export async function listAccessibleBranches(session: SessionContext) {
  return db.branch.findMany({
    where: { id: { in: session.branchIds }, organizationId: session.user.organizationId },
    orderBy: { name: "asc" },
  })
}

/** Open Register -> Transactions -> Cash Movements -> Close Register (spec.md §37). */
export async function openSession(session: SessionContext, input: OpenCashierSessionInput) {
  assertCan(session, "cashier.open", { branchId: input.branchId })

  const existing = await db.cashierSession.findFirst({
    where: { cashierUserId: session.user.id, status: "open" },
  })
  if (existing) {
    throw new Error("You already have an open cashier session — close it before opening a new one.")
  }

  const created = await db.cashierSession.create({
    data: {
      organizationId: session.user.organizationId,
      branchId: input.branchId,
      cashierUserId: session.user.id,
      openingCash: new Decimal(input.openingCash),
    },
  })
  await auditFromSession(session, "open", "cashier_session", created.id, { new: { openingCash: input.openingCash } })
  return created
}

export async function getMyOpenSession(session: SessionContext) {
  return db.cashierSession.findFirst({
    where: { organizationId: session.user.organizationId, cashierUserId: session.user.id, status: "open" },
  })
}

export async function recordCashMovement(session: SessionContext, cashierSessionId: string, input: CashMovementInput) {
  const cashierSession = await db.cashierSession.findFirstOrThrow({
    where: { id: cashierSessionId, organizationId: session.user.organizationId },
  })
  assertCan(session, "cashier.open", { branchId: cashierSession.branchId, resourceOwnerId: cashierSession.cashierUserId })
  if (cashierSession.status !== "open") {
    throw new Error("This cashier session is closed.")
  }

  const movement = await db.cashMovement.create({
    data: {
      organizationId: session.user.organizationId,
      cashierSessionId,
      direction: input.direction,
      amount: new Decimal(input.amount),
      reason: input.reason,
      recordedBy: session.user.id,
    },
  })
  await auditFromSession(session, "create", "cash_movement", movement.id, { new: input })
  return movement
}

/** expectedCash is always derived at close time — never a running mutable balance. */
export async function closeSession(session: SessionContext, cashierSessionId: string, input: CloseCashierSessionInput) {
  const cashierSession = await db.cashierSession.findFirstOrThrow({
    where: { id: cashierSessionId, organizationId: session.user.organizationId },
  })
  assertCan(session, "cashier.open", { branchId: cashierSession.branchId, resourceOwnerId: cashierSession.cashierUserId })
  if (cashierSession.status !== "open") {
    throw new Error("This cashier session is already closed.")
  }

  const [cashPayments, cashRefunds, movements] = await Promise.all([
    db.payment.findMany({ where: { cashierSessionId, method: "cash", status: "completed" } }),
    db.refund.findMany({ where: { cashierSessionId, method: "cash", status: "completed" } }),
    db.cashMovement.findMany({ where: { cashierSessionId } }),
  ])

  let expected = new Decimal(cashierSession.openingCash)
  for (const p of cashPayments) expected = expected.add(p.amount)
  for (const r of cashRefunds) expected = expected.sub(r.amount)
  for (const m of movements) expected = m.direction === "in" ? expected.add(m.amount) : expected.sub(m.amount)

  const actualCash = new Decimal(input.actualCash)
  const variance = actualCash.sub(expected)

  const updated = await db.cashierSession.update({
    where: { id: cashierSessionId },
    data: { status: "closed", closedAt: new Date(), expectedCash: expected, actualCash, variance, notes: input.notes },
  })

  await auditFromSession(session, "close", "cashier_session", cashierSessionId, {
    new: { expectedCash: Number(expected), actualCash: input.actualCash, variance: Number(variance) },
  })
  return updated
}

export async function listCashierSessions(session: SessionContext, filters: { branchId?: string; status?: string } = {}) {
  assertCan(session, "cashier.view")
  return db.cashierSession.findMany({
    where: {
      organizationId: session.user.organizationId,
      branchId: filters.branchId,
      status: filters.status as never,
    },
    orderBy: { openedAt: "desc" },
    take: 100,
  })
}

export async function getCashierSession(session: SessionContext, id: string) {
  const cashierSession = await db.cashierSession.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { cashMovements: { orderBy: { recordedAt: "desc" } }, payments: true, refunds: true },
  })
  if (cashierSession.cashierUserId !== session.user.id) {
    assertCan(session, "cashier.view")
  }
  return cashierSession
}
