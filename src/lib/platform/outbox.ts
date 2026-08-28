import "server-only"
import { db } from "@/lib/db"
import { Prisma, type OutboxStatus } from "@/generated/prisma/client"

/**
 * Transactional outbox (BLUEPRINT.md §27 / ARCHITECTURE.md §9). Call inside the same
 * transaction as the state change that other domains care about, so the event write
 * is durable and atomic with it even though dispatch happens after commit.
 */
export async function writeOutboxEvent(
  tx: Prisma.TransactionClient | typeof db,
  input: { organizationId: string; eventType: string; payload: Record<string, unknown> }
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      organizationId: input.organizationId,
      eventType: input.eventType,
      payload: input.payload as Prisma.InputJsonValue,
    },
  })
}

type OutboxHandler = (payload: Record<string, unknown>, organizationId: string) => Promise<void>

const handlers = new Map<string, OutboxHandler[]>()

/** Registered once per event type, typically at module load time by the domain that reacts to it. */
export function registerOutboxHandler(eventType: string, handler: OutboxHandler): void {
  const existing = handlers.get(eventType) ?? []
  existing.push(handler)
  handlers.set(eventType, existing)
}

// P0-02 (SYSTEM_AUDIT.md Critical #2): a bounded retry schedule with an
// explicit dead-letter end state, replacing the old "failed" dead end that
// dispatchPendingOutboxEvents never re-queried. Short delay, then two longer
// ones — deliberately not an aggressive/infinite loop (P0.md §8).
const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 20 * 60_000] // 1min, 5min, 20min

function nextRetryDelay(attemptNumber: number): number {
  return RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)]
}

// P1 §3: how long an event may sit in "processing" before it's presumed
// crashed (the process that claimed it died mid-handler, e.g. a killed
// serverless invocation) rather than genuinely still running. Every handler
// registered in event-handlers.ts is a handful of DB writes — seconds, not
// minutes, even under this project's real Supabase-pooler latency (see
// PROJECT_STATUS.md's repeated notes on that latency during Phase 14/P0
// testing). 5 minutes is generous enough to never misclassify real in-flight
// work while still recovering a genuine crash well within the same business
// day. Configurable via OUTBOX_PROCESSING_TIMEOUT_MS for environments that
// need a different value (e.g. a slower external delivery provider added
// later) without a code change.
const DEFAULT_PROCESSING_TIMEOUT_MS = 5 * 60_000

function processingTimeoutMs(): number {
  const raw = process.env.OUTBOX_PROCESSING_TIMEOUT_MS
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROCESSING_TIMEOUT_MS
}

type DueOutboxEvent = {
  id: string
  organizationId: string
  eventType: string
  payload: unknown
  status: OutboxStatus
  attempts: number
}

/**
 * Claims and runs one batch of already-selected events. Shared by both
 * `dispatchPendingOutboxEvents` (called inline, right after a write, scoped
 * to that write's own organization) and `processPendingOutboxEvents` (the
 * periodic sweep, P1 §4, scanning across every organization) so the claim
 * and retry/dead-letter logic exists in exactly one place.
 *
 * Every handler reachable from here MUST be idempotent — safe to run twice
 * for the same event — because retry means a handler that partially
 * succeeded (e.g. posted a Journal, then crashed before this function could
 * mark the event `completed`) WILL run again. The financial/commission
 * handlers achieve this via `postJournal`'s own existing-journal check
 * (posting-service.ts, keyed on referenceType+referenceId) and the
 * commission-accrual functions' existing-record checks (commissions.ts,
 * keyed on chargeId/paymentId) — both already in place, verified during
 * P0_REMEDIATION_PLAN.md's design of this fix, not newly added here. A
 * retry system without idempotent handlers is worse than no retry system
 * (P0.md §9); do not add a new handler here without the same discipline.
 */
async function dispatchBatch(due: DueOutboxEvent[]): Promise<void> {
  for (const event of due) {
    // Claim it (pending/failed -> processing) before running handlers, so a
    // second concurrent dispatcher instance can't double-process the same
    // event (P1 §5). Guarded by the WHERE on the current status, not just
    // the id, so a lost race is a silent no-op rather than a double-claim —
    // the same atomic conditional-updateMany pattern used everywhere in this
    // file a status transition needs to be safe under concurrency.
    const claimed = await db.outboxEvent.updateMany({
      where: { id: event.id, status: event.status },
      data: { status: "processing", lastAttemptAt: new Date(), attempts: { increment: 1 } },
    })
    if (claimed.count === 0) continue

    const eventHandlers = handlers.get(event.eventType) ?? []
    try {
      for (const handler of eventHandlers) {
        await handler(event.payload as Record<string, unknown>, event.organizationId)
      }
      await db.outboxEvent.update({ where: { id: event.id }, data: { status: "completed", completedAt: new Date() } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[outbox] handler failed for ${event.eventType} (${event.id}), attempt ${event.attempts + 1}:`, error)

      const attemptsSoFar = event.attempts + 1
      if (attemptsSoFar >= MAX_ATTEMPTS) {
        await db.outboxEvent.update({
          where: { id: event.id },
          data: { status: "dead_letter", lastError: message },
        })
        await notifyDeadLetter(event.organizationId, event.eventType, event.id, message)
      } else {
        await db.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: "failed",
            lastError: message,
            nextRetryAt: new Date(Date.now() + nextRetryDelay(attemptsSoFar)),
          },
        })
      }
    }
  }
}

/** Fires right after a write, scoped to that write's own organization — the fast, primary delivery path. */
export async function dispatchPendingOutboxEvents(organizationId: string): Promise<void> {
  const now = new Date()
  const due = await db.outboxEvent.findMany({
    where: {
      organizationId,
      OR: [
        { status: "pending" },
        { status: "failed", nextRetryAt: { lte: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  })
  await dispatchBatch(due)
}

/**
 * P1 §3 (stuck-event recovery): an event stuck in `processing` past
 * PROCESSING_TIMEOUT_MS is presumed to belong to a crashed/killed process
 * (e.g. a serverless invocation that died mid-handler) rather than genuinely
 * still-running work — see the timeout constant's own doc comment for why
 * that threshold is safe. Recovered events go to `failed` with
 * `nextRetryAt` set to now (picked up by the very next dispatch pass, no
 * extra grace period needed beyond the timeout itself) unless they'd
 * already exhausted MAX_ATTEMPTS, in which case they go straight to
 * `dead_letter` — mirroring `dispatchBatch`'s own retry-vs-dead-letter
 * logic exactly, since a stuck attempt is still an attempt (its `attempts`
 * counter was already incremented at claim time, before it got stuck).
 *
 * The reclaim below is itself an atomic conditional updateMany (status
 * must still be "processing"), the same pattern as `dispatchBatch`'s claim
 * — this is what makes it safe for two concurrent sweep calls to both
 * consider the same stuck event: only one of them can actually flip it
 * (P1 §5), and if the "stuck" handler was in fact still running and
 * completes normally in between, its own final `update` already moved the
 * status off `processing`, making this reclaim a correct no-op instead of
 * a race.
 */
async function recoverStaleProcessingEvents(): Promise<number> {
  const staleThreshold = new Date(Date.now() - processingTimeoutMs())
  const stale = await db.outboxEvent.findMany({
    where: { status: "processing", lastAttemptAt: { lt: staleThreshold } },
    orderBy: { lastAttemptAt: "asc" },
    take: 100,
  })

  let recovered = 0
  for (const event of stale) {
    const exhausted = event.attempts >= MAX_ATTEMPTS
    const message = `Stuck in "processing" past the ${processingTimeoutMs()}ms timeout — presumed crashed${exhausted ? " after exhausting retries" : ", returned to the retry queue"}.`

    const claim = await db.outboxEvent.updateMany({
      where: { id: event.id, status: "processing", lastAttemptAt: event.lastAttemptAt },
      data: exhausted
        ? { status: "dead_letter", lastError: message }
        : { status: "failed", lastError: message, nextRetryAt: new Date() },
    })
    if (claim.count === 0) continue
    recovered++

    if (exhausted) {
      await notifyDeadLetter(event.organizationId, event.eventType, event.id, message)
    }
  }
  return recovered
}

/**
 * P1 §4 (periodic sweep): the reusable, organization-agnostic entry point a
 * production deployment schedules independently of any single request —
 * the inline `dispatchPendingOutboxEvents` calls above only ever fire for
 * the organization that just performed a write, so nothing re-checks a
 * failed event whose `nextRetryAt` has since arrived, or a stuck
 * `processing` event, unless something else calls this. Safe to call from:
 *
 *   - a cron job (see src/app/api/cron/outbox-sweep/route.ts + vercel.json)
 *   - any other scheduled server job/task runner
 *   - an authorized admin action (see system-events.ts's
 *     `sweepSystemEventsAsAdmin`, wired to a button on /admin/system-events)
 *
 * Deliberately a plain function with no queue/broker dependency — this
 * project's modular-monolith architecture (ARCHITECTURE.md §1/§15) doesn't
 * need Kafka/RabbitMQ/a dedicated worker process for a bounded, idempotent
 * batch sweep; see DEPLOYMENT.md's "Outbox Sweep Scheduling" for the
 * concrete production scheduling requirement.
 */
export async function processPendingOutboxEvents(): Promise<{ recovered: number; processed: number }> {
  const recovered = await recoverStaleProcessingEvents()

  const now = new Date()
  const due = await db.outboxEvent.findMany({
    where: {
      OR: [
        { status: "pending" },
        { status: "failed", nextRetryAt: { lte: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  })
  await dispatchBatch(due)

  return { recovered, processed: due.length }
}

/**
 * P0.md §11: a financial/operational event that exhausted its retries must
 * not fail silently. Notifies every Org Admin/Super Admin in the
 * organization via the existing Notification model — no new delivery
 * mechanism, same as every other in-app notification this build sends.
 */
async function notifyDeadLetter(organizationId: string, eventType: string, eventId: string, error: string): Promise<void> {
  const admins = await db.user.findMany({
    where: {
      organizationId,
      status: "active",
      roles: { some: { role: { name: { in: ["Super Admin", "Organization Administrator"] } } } },
    },
    select: { id: true },
  })
  if (admins.length === 0) return

  await db.notification.createMany({
    data: admins.map((admin) => ({
      organizationId,
      recipientUserId: admin.id,
      type: "system_event_dead_letter",
      title: `Background task failed: ${eventType}`,
      body: `An automatic ${eventType} action failed after ${MAX_ATTEMPTS} attempts and needs manual review. Last error: ${error.slice(0, 300)}`,
      referenceType: "outbox_event",
      referenceId: eventId,
    })),
  })
}

/** Admin-only manual retry (system_events.retry) — resets attempts and re-queues immediately. */
export async function retryOutboxEvent(eventId: string): Promise<void> {
  await db.outboxEvent.update({
    where: { id: eventId },
    data: { status: "pending", attempts: 0, nextRetryAt: null, lastError: null },
  })
}
