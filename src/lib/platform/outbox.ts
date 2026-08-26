import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"

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

/**
 * Dispatches pending events to their registered handlers and marks them processed.
 * Called immediately after the writing transaction commits (see callers in
 * appointments.ts/patients.ts) rather than from a timer — this is a modular
 * monolith with a single app instance per BLUEPRINT.md §73 ("no unnecessary
 * distributed infrastructure"), so a real background poller/queue is deferred
 * until multiple instances actually need shared dispatch. A handler failing
 * does not roll back the state change that already committed — it just leaves
 * the event `pending` for the next dispatch call to retry (at-least-once).
 */
export async function dispatchPendingOutboxEvents(organizationId: string): Promise<void> {
  const pending = await db.outboxEvent.findMany({
    where: { organizationId, status: "pending" },
    orderBy: { createdAt: "asc" },
    take: 50,
  })

  for (const event of pending) {
    const eventHandlers = handlers.get(event.eventType) ?? []
    try {
      for (const handler of eventHandlers) {
        await handler(event.payload as Record<string, unknown>, event.organizationId)
      }
      await db.outboxEvent.update({ where: { id: event.id }, data: { status: "processed", processedAt: new Date() } })
    } catch (error) {
      console.error(`[outbox] handler failed for ${event.eventType} (${event.id}):`, error)
      await db.outboxEvent.update({ where: { id: event.id }, data: { status: "failed" } })
    }
  }
}
