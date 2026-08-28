import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { db } from "@/lib/db"
import { registerOutboxHandler, dispatchPendingOutboxEvents, processPendingOutboxEvents } from "@/lib/platform/outbox"

/**
 * P1 §5: proves two "dispatcher instances" (simulated here as two
 * concurrent calls into the same process — the atomic conditional
 * `updateMany` claim this relies on is a real DB-level guarantee, so it
 * protects against genuinely separate processes exactly the same way) can
 * never both run a handler for the same outbox event. Each handler below
 * sleeps briefly before returning, deliberately widening the race window
 * that a naive "check status, then update" implementation would fall into
 * — a claim that isn't atomic would very likely double-fire under this,
 * not just theoretically could.
 */
const TIMEOUT = 20000
const EVENT_TYPE = "TestP1ConcurrencyScenario"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("P1 §5: outbox dispatcher concurrency", () => {
  let organizationId: string
  let executionLog: string[] = []
  const createdIds: string[] = []

  beforeAll(async () => {
    organizationId = (await db.branch.findFirstOrThrow()).organizationId
    registerOutboxHandler(EVENT_TYPE, async (payload) => {
      // Widen the race window: read, wait, then "do the work" — a
      // check-then-update claim (no atomic WHERE guard) would let a second
      // concurrent caller slip in during this sleep and also run the
      // handler for the same event.
      await sleep(150)
      executionLog.push(payload.marker as string)
    })
  }, TIMEOUT)

  beforeEach(() => {
    executionLog = []
  })

  afterAll(async () => {
    await db.outboxEvent.deleteMany({ where: { id: { in: createdIds } } })
    await db.notification.deleteMany({ where: { referenceType: "outbox_event", referenceId: { in: createdIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("two concurrent dispatch calls never both run the handler for the same pending event", async () => {
    const event = await db.outboxEvent.create({
      data: { organizationId, eventType: EVENT_TYPE, payload: { marker: "single-event" }, status: "pending" },
    })
    createdIds.push(event.id)

    // Two "instances" racing to dispatch the same organization's queue at
    // the same moment — the realistic trigger for this in production is two
    // concurrent requests each calling dispatchPendingOutboxEvents() right
    // after their own write, both seeing the same pending row.
    await Promise.all([dispatchPendingOutboxEvents(organizationId), dispatchPendingOutboxEvents(organizationId)])

    expect(executionLog).toEqual(["single-event"]) // exactly once, not twice
    const after = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.status).toBe("completed")
    expect(after.attempts).toBe(1)
  }, TIMEOUT)

  it("two concurrent periodic-sweep calls never both run the handler for the same batch of events", async () => {
    const events = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        db.outboxEvent.create({
          data: { organizationId, eventType: EVENT_TYPE, payload: { marker: `batch-${i}` }, status: "pending" },
        })
      )
    )
    createdIds.push(...events.map((e) => e.id))

    await Promise.all([processPendingOutboxEvents(), processPendingOutboxEvents()])

    expect(executionLog.length).toBe(5) // each of the 5 ran exactly once total across both concurrent sweeps
    expect(new Set(executionLog).size).toBe(5) // no duplicates

    const after = await db.outboxEvent.findMany({ where: { id: { in: events.map((e) => e.id) } } })
    expect(after.every((e) => e.status === "completed")).toBe(true)
    expect(after.every((e) => e.attempts === 1)).toBe(true)
  }, TIMEOUT)

  it("two concurrent sweeps recovering the same stuck event only ever run its handler once", async () => {
    process.env.OUTBOX_PROCESSING_TIMEOUT_MS = "100"
    try {
      const stuck = await db.outboxEvent.create({
        data: {
          organizationId,
          eventType: EVENT_TYPE,
          payload: { marker: "stuck-event" },
          status: "processing",
          attempts: 1,
          lastAttemptAt: new Date(Date.now() - 500), // older than the 100ms timeout
        },
      })
      createdIds.push(stuck.id)

      await Promise.all([processPendingOutboxEvents(), processPendingOutboxEvents()])

      expect(executionLog).toEqual(["stuck-event"]) // recovered and re-dispatched exactly once, not twice
      const after = await db.outboxEvent.findUniqueOrThrow({ where: { id: stuck.id } })
      expect(after.status).toBe("completed")
    } finally {
      delete process.env.OUTBOX_PROCESSING_TIMEOUT_MS
    }
  }, TIMEOUT)
})
