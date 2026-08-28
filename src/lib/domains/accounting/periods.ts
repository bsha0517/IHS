import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"

type Db = Prisma.TransactionClient | typeof db

/**
 * P1 §31: basic financial period control. A row here exists ONLY for a
 * calendar month that has actually been closed — see AccountingPeriod's own
 * schema doc comment for why nothing needs to be pre-created for future
 * months. `assertPeriodOpen` is called from `postJournal`
 * (posting-service.ts) — the single chokepoint every one of the ~17 named
 * posting functions in this codebase funnels through — so this one guard
 * protects every one of them at once, not each individually.
 *
 * Scope deliberately kept to what P1 §31 literally asks: block ordinary
 * posting into (or, since nothing in this codebase ever edits a posted
 * journal directly — see reverseJournal's own doc comment — effectively
 * "modifying") a closed period. A full close-the-books workflow (closing
 * entries zeroing income/expense to retained earnings, a
 * multi-step reconciliation checklist, period-end report snapshots) is real
 * accounting-department functionality this deliberately does NOT build —
 * P1 §31's own instruction is to document that as P2 rather than rush a
 * partial version, and unlike the lock mechanism itself (cheap, one
 * chokepoint), that ceremony is a genuinely large, separate feature. See
 * PROJECT_STATUS.md's Next Actions.
 */
function periodBounds(year: number, month: number): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(Date.UTC(year, month - 1, 1))
  const periodEnd = new Date(Date.UTC(year, month, 1))
  return { periodStart, periodEnd }
}

function periodLabel(periodStart: Date): string {
  return periodStart.toISOString().slice(0, 7) // "YYYY-MM"
}

/**
 * Called from inside `postJournal`'s own transaction, before it writes
 * anything — throws if `journalDate` falls within a closed period. No
 * override exists: closed means closed for every actor, including
 * accountants — the correction path is `reopenPeriod` (audited), fix, then
 * `closePeriod` again, not a permission that silently bypasses the lock.
 */
export async function assertPeriodOpen(tx: Db, organizationId: string, journalDate: Date): Promise<void> {
  const closed = await tx.accountingPeriod.findFirst({
    where: { organizationId, status: "closed", periodStart: { lte: journalDate }, periodEnd: { gt: journalDate } },
  })
  if (closed) {
    throw new Error(
      `${periodLabel(closed.periodStart)} is closed to posting. Reopen it first (Accounting > Periods) if this entry genuinely needs to land there.`
    )
  }
}

export async function listAccountingPeriods(session: SessionContext) {
  assertCan(session, "accounting.period.manage")
  return db.accountingPeriod.findMany({
    where: { organizationId: session.user.organizationId },
    orderBy: { periodStart: "desc" },
  })
}

export async function closePeriod(session: SessionContext, input: { year: number; month: number; reason: string }) {
  assertCan(session, "accounting.period.manage")
  const { periodStart, periodEnd } = periodBounds(input.year, input.month)

  const existing = await db.accountingPeriod.findUnique({
    where: { organizationId_periodStart: { organizationId: session.user.organizationId, periodStart } },
  })
  if (existing?.status === "closed") {
    throw new Error(`${periodLabel(periodStart)} is already closed.`)
  }

  const period = existing
    ? await db.accountingPeriod.update({
        where: { id: existing.id },
        data: { status: "closed", closedBy: session.user.id, closedAt: new Date(), reason: input.reason },
      })
    : await db.accountingPeriod.create({
        data: {
          organizationId: session.user.organizationId,
          periodStart,
          periodEnd,
          status: "closed",
          closedBy: session.user.id,
          reason: input.reason,
        },
      })

  await auditFromSession(session, existing ? "reclose" : "close", "accounting_period", period.id, {
    new: { period: periodLabel(periodStart), reason: input.reason },
  })
  return period
}

/** Reopening never deletes the row — the row's own presence plus this audit entry IS the "was closed, got reopened" history (same convention as Patient.status/Encounter.status). */
export async function reopenPeriod(session: SessionContext, id: string, reason: string) {
  assertCan(session, "accounting.period.manage")
  const period = await db.accountingPeriod.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  if (period.status !== "closed") throw new Error("This period is not closed.")

  const updated = await db.accountingPeriod.update({
    where: { id },
    data: { status: "open", reason },
  })
  await auditFromSession(session, "reopen", "accounting_period", id, {
    old: { status: "closed" },
    new: { status: "open", period: periodLabel(period.periodStart), reason },
  })
  return updated
}
