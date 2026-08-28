import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { retryOutboxEvent, processPendingOutboxEvents } from "@/lib/platform/outbox"
import type { SessionContext } from "@/lib/auth/session"

const PAGE_SIZE = 50

/**
 * P0-02 admin visibility (P0.md §10) — the user-facing, permission-gated
 * read/retry wrappers around outbox.ts's internal dispatch mechanism.
 * outbox.ts itself takes no SessionContext and has no permission check of
 * its own (it's only ever reached from the transactional-write side, never
 * a Server Action) — same "internal system reaction, not a new
 * user-initiated action" split this codebase already uses for
 * generateSystemCharge/consumeStock/etc.
 */
export async function listSystemEvents(session: SessionContext, filters: { status?: string; page?: number } = {}) {
  assertCan(session, "system_events.view")
  const page = Math.max(1, filters.page ?? 1)

  const where = {
    organizationId: session.user.organizationId,
    status: filters.status ? (filters.status as never) : undefined,
  }

  const [events, total] = await Promise.all([
    db.outboxEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.outboxEvent.count({ where }),
  ])

  return { events, total, page, pageSize: PAGE_SIZE, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) }
}

export async function retrySystemEventAsAdmin(session: SessionContext, eventId: string): Promise<void> {
  assertCan(session, "system_events.retry")
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { id: eventId, organizationId: session.user.organizationId },
  })
  await retryOutboxEvent(event.id)
  await auditFromSession(session, "retry", "outbox_event", event.id, {
    old: { status: event.status, attempts: event.attempts },
    new: { status: "pending", attempts: 0 },
  })
}

/**
 * P1 §4's "admin/manual action" trigger for `processPendingOutboxEvents()` —
 * the same organization-agnostic sweep a cron job would run (recovers stuck
 * `processing` events past the timeout, then dispatches due pending/failed
 * events), reachable from the System Events page for an admin who doesn't
 * want to wait for the next scheduled run. Same permission as retrying a
 * single event — this moves state the same way a retry does, just for many
 * events at once, not a read-only action.
 */
export async function sweepSystemEventsAsAdmin(session: SessionContext): Promise<{ recovered: number; processed: number }> {
  assertCan(session, "system_events.retry")
  const result = await processPendingOutboxEvents()
  await auditFromSession(session, "sweep", "outbox_event", "*", { new: result })
  return result
}
