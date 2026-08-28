import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import { db } from "@/lib/db"
import { registerOutboxHandler, processPendingOutboxEvents } from "@/lib/platform/outbox"

/**
 * P1 §3 (stuck-event recovery) and §4 (periodic sweep) tests. A "stuck"
 * event is simulated directly — a row created straight in the DB with
 * status `processing` and a `lastAttemptAt` older than the configured
 * timeout — rather than actually crashing a handler mid-execution, since
 * that's the state a genuine crash leaves behind regardless of how it got
 * there. `OUTBOX_PROCESSING_TIMEOUT_MS` is overridden to a small value for
 * each test so these don't need to wait out the real 5-minute default.
 */
const TIMEOUT = 20000
const EVENT_TYPE = "TestP1CrashRecoveryScenario"

describe("P1 §3/§4: outbox crash recovery and periodic sweep", () => {
  let organizationId: string
  let branchId: string
  let callCount = 0
  const createdIds: string[] = []

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchId = branch.id
    registerOutboxHandler(EVENT_TYPE, async () => {
      callCount += 1
    })
  }, TIMEOUT)

  beforeEach(() => {
    callCount = 0
  })

  afterEach(() => {
    delete process.env.OUTBOX_PROCESSING_TIMEOUT_MS
  })

  afterAll(async () => {
    await db.outboxEvent.deleteMany({ where: { id: { in: createdIds } } })
    await db.notification.deleteMany({ where: { referenceType: "outbox_event", referenceId: { in: createdIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  async function createStuckEvent(opts: { attempts: number; ageMs: number }) {
    const event = await db.outboxEvent.create({
      data: {
        organizationId,
        eventType: EVENT_TYPE,
        payload: { branchId },
        status: "processing",
        attempts: opts.attempts,
        lastAttemptAt: new Date(Date.now() - opts.ageMs),
      },
    })
    createdIds.push(event.id)
    return event
  }

  it("an event stuck in processing past the timeout, below MAX_ATTEMPTS, is returned to failed and immediately retryable", async () => {
    process.env.OUTBOX_PROCESSING_TIMEOUT_MS = "100"
    const stuck = await createStuckEvent({ attempts: 1, ageMs: 500 }) // older than the 100ms timeout

    const result = await processPendingOutboxEvents()
    expect(result.recovered).toBeGreaterThanOrEqual(1)

    // Recovered to failed+nextRetryAt=now, then picked up in the SAME sweep
    // call's subsequent dispatch pass and actually run.
    const after = await db.outboxEvent.findUniqueOrThrow({ where: { id: stuck.id } })
    expect(after.status).toBe("completed")
    expect(callCount).toBe(1)
  }, TIMEOUT)

  it("an event stuck in processing past the timeout, at MAX_ATTEMPTS, goes straight to dead_letter and notifies admins", async () => {
    process.env.OUTBOX_PROCESSING_TIMEOUT_MS = "100"
    const stuck = await createStuckEvent({ attempts: 3, ageMs: 500 })

    await processPendingOutboxEvents()

    const after = await db.outboxEvent.findUniqueOrThrow({ where: { id: stuck.id } })
    expect(after.status).toBe("dead_letter")
    expect(after.lastError).toContain("Stuck in")
    expect(callCount).toBe(0) // never re-run — it went straight to dead_letter, not back through a handler

    const notifications = await db.notification.findMany({
      where: { referenceType: "outbox_event", referenceId: stuck.id },
    })
    expect(notifications.length).toBeGreaterThan(0)
    expect(notifications[0].type).toBe("system_event_dead_letter")
  }, TIMEOUT)

  it("an event still within the processing timeout window is left untouched — not assumed crashed", async () => {
    process.env.OUTBOX_PROCESSING_TIMEOUT_MS = "60000" // 1 minute
    const inFlight = await createStuckEvent({ attempts: 1, ageMs: 1000 }) // only 1s old, well within the window

    const result = await processPendingOutboxEvents()

    const after = await db.outboxEvent.findUniqueOrThrow({ where: { id: inFlight.id } })
    expect(after.status).toBe("processing") // untouched
    expect(callCount).toBe(0) // never run — recovery correctly left it alone as "may still genuinely be executing"
    // it may still be counted among other orgs' due events in `processed`, but this event itself wasn't recovered
    void result
  }, TIMEOUT)

  it("processPendingOutboxEvents processes ordinary pending events too, not just recovery", async () => {
    const event = await db.outboxEvent.create({
      data: { organizationId, eventType: EVENT_TYPE, payload: { branchId }, status: "pending" },
    })
    createdIds.push(event.id)

    const result = await processPendingOutboxEvents()
    expect(result.processed).toBeGreaterThanOrEqual(1)

    const after = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })
    expect(after.status).toBe("completed")
    expect(callCount).toBe(1)
  }, TIMEOUT)

  it("processPendingOutboxEvents is organization-agnostic — it processes due events across every organization in one call", async () => {
    // A second, disposable organization — the point of this test is that
    // processPendingOutboxEvents() has no organizationId filter at all
    // (unlike dispatchPendingOutboxEvents, which is scoped to one), so it
    // needs a genuine second tenant to prove that against, not just a
    // second branch within the seeded organization.
    const otherOrg = await db.organization.create({
      data: { legalName: "P1 Crash Recovery Test Org", displayName: "P1 Test Org" },
    })

    try {
      const eventA = await db.outboxEvent.create({
        data: { organizationId, eventType: EVENT_TYPE, payload: {}, status: "pending" },
      })
      const eventB = await db.outboxEvent.create({
        data: { organizationId: otherOrg.id, eventType: EVENT_TYPE, payload: {}, status: "pending" },
      })
      createdIds.push(eventA.id, eventB.id)

      await processPendingOutboxEvents()

      const [afterA, afterB] = await Promise.all([
        db.outboxEvent.findUniqueOrThrow({ where: { id: eventA.id } }),
        db.outboxEvent.findUniqueOrThrow({ where: { id: eventB.id } }),
      ])
      expect(afterA.status).toBe("completed")
      expect(afterB.status).toBe("completed")
      expect(callCount).toBe(2)
    } finally {
      await db.outboxEvent.deleteMany({ where: { organizationId: otherOrg.id } })
      await db.organization.delete({ where: { id: otherOrg.id } })
    }
  }, TIMEOUT)
})
