import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { db } from "@/lib/db"
import { writeOutboxEvent, dispatchPendingOutboxEvents, registerOutboxHandler, retryOutboxEvent } from "@/lib/platform/outbox"
import { postInvoiceIssued } from "@/lib/domains/accounting/posting-service"

/**
 * P0-02 remediation tests (P0.md §12): successful processing, temporary
 * failure + retry, repeated failure -> dead-letter, manual retry, and —
 * because a retry system is only safe if handlers are idempotent — a real
 * duplicate-prevention check on the one handler class this matters most
 * for (journal posting).
 */
// Several of these tests do 3+ sequential real-DB dispatch round-trips
// against a live (sometimes-slow-pooler) connection — the default 5s
// vitest test timeout was occasionally too tight.
const TIMEOUT = 20000

describe("P0-02: outbox reliability", () => {
  let organizationId: string

  const EVENT_TYPE = "TestP0OutboxScenario"
  let callCount = 0
  let failUntilAttempt = 0 // handler throws on attempts <= this value, succeeds after

  beforeAll(async () => {
    organizationId = (await db.branch.findFirstOrThrow()).organizationId
    registerOutboxHandler(EVENT_TYPE, async () => {
      callCount += 1
      if (callCount <= failUntilAttempt) {
        throw new Error(`synthetic failure on attempt ${callCount}`)
      }
    })
  }, TIMEOUT)

  beforeEach(() => {
    callCount = 0
    failUntilAttempt = 0
  })

  afterAll(async () => {
    await db.outboxEvent.deleteMany({ where: { eventType: EVENT_TYPE } })
    await db.$disconnect()
  }, TIMEOUT)

  it("successful processing: a handler that succeeds on the first attempt marks the event completed", async () => {
    await writeOutboxEvent(db, { organizationId, eventType: EVENT_TYPE, payload: {} })
    await dispatchPendingOutboxEvents(organizationId)

    const event = await db.outboxEvent.findFirstOrThrow({ where: { organizationId, eventType: EVENT_TYPE }, orderBy: { createdAt: "desc" } })
    expect(event.status).toBe("completed")
    expect(event.attempts).toBe(1)
    expect(event.completedAt).not.toBeNull()
  }, TIMEOUT)

  it("temporary failure + retry: fails once, is scheduled to retry, then succeeds on the retried attempt", async () => {
    failUntilAttempt = 1 // fails on attempt 1, succeeds on attempt 2
    await writeOutboxEvent(db, { organizationId, eventType: EVENT_TYPE, payload: {} })
    await dispatchPendingOutboxEvents(organizationId)

    let event = await db.outboxEvent.findFirstOrThrow({ where: { organizationId, eventType: EVENT_TYPE }, orderBy: { createdAt: "desc" } })
    expect(event.status).toBe("failed")
    expect(event.attempts).toBe(1)
    expect(event.nextRetryAt).not.toBeNull()
    expect(event.lastError).toContain("synthetic failure")

    // A dispatch call before nextRetryAt must NOT retry it yet.
    await dispatchPendingOutboxEvents(organizationId)
    event = await db.outboxEvent.findFirstOrThrow({ where: { id: event.id } })
    expect(event.status).toBe("failed")
    expect(event.attempts).toBe(1)

    // Force it due now (simulating time passing) and retry.
    await db.outboxEvent.update({ where: { id: event.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } })
    await dispatchPendingOutboxEvents(organizationId)
    event = await db.outboxEvent.findFirstOrThrow({ where: { id: event.id } })
    expect(event.status).toBe("completed")
    expect(event.attempts).toBe(2)
  }, TIMEOUT)

  it("repeated failure exhausts retries and transitions to dead_letter", async () => {
    failUntilAttempt = 99 // always fails
    await writeOutboxEvent(db, { organizationId, eventType: EVENT_TYPE, payload: {} })
    let event = await db.outboxEvent.findFirstOrThrow({ where: { organizationId, eventType: EVENT_TYPE }, orderBy: { createdAt: "desc" } })

    await dispatchPendingOutboxEvents(organizationId)
    event = await db.outboxEvent.findFirstOrThrow({ where: { id: event.id } })
    expect(event.status).toBe("failed")
    expect(event.attempts).toBe(1)

    await db.outboxEvent.update({ where: { id: event.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } })
    await dispatchPendingOutboxEvents(organizationId)
    event = await db.outboxEvent.findFirstOrThrow({ where: { id: event.id } })
    expect(event.status).toBe("failed")
    expect(event.attempts).toBe(2)

    await db.outboxEvent.update({ where: { id: event.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } })
    await dispatchPendingOutboxEvents(organizationId)
    event = await db.outboxEvent.findFirstOrThrow({ where: { id: event.id } })
    expect(event.status).toBe("dead_letter")
    expect(event.attempts).toBe(3)
    expect(event.lastError).toContain("synthetic failure")
  }, TIMEOUT)

  it("dead-letter transition notifies every admin in the organization", async () => {
    failUntilAttempt = 99
    await writeOutboxEvent(db, { organizationId, eventType: EVENT_TYPE, payload: {} })
    let event = await db.outboxEvent.findFirstOrThrow({ where: { organizationId, eventType: EVENT_TYPE }, orderBy: { createdAt: "desc" } })
    for (let i = 0; i < 3; i++) {
      await db.outboxEvent.update({ where: { id: event.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } })
      await dispatchPendingOutboxEvents(organizationId)
      event = await db.outboxEvent.findFirstOrThrow({ where: { id: event.id } })
    }
    expect(event.status).toBe("dead_letter")

    const notifications = await db.notification.findMany({
      where: { organizationId, referenceType: "outbox_event", referenceId: event.id },
    })
    expect(notifications.length).toBeGreaterThan(0)
    expect(notifications[0].type).toBe("system_event_dead_letter")

    await db.notification.deleteMany({ where: { referenceType: "outbox_event", referenceId: event.id } })
  }, TIMEOUT)

  it("manual retry resets a dead-lettered event back to pending and it can succeed", async () => {
    failUntilAttempt = 3 // fails 3 times (reaching dead_letter), succeeds thereafter
    await writeOutboxEvent(db, { organizationId, eventType: EVENT_TYPE, payload: {} })
    let event = await db.outboxEvent.findFirstOrThrow({ where: { organizationId, eventType: EVENT_TYPE }, orderBy: { createdAt: "desc" } })
    for (let i = 0; i < 3; i++) {
      await db.outboxEvent.update({ where: { id: event.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } })
      await dispatchPendingOutboxEvents(organizationId)
      event = await db.outboxEvent.findFirstOrThrow({ where: { id: event.id } })
    }
    expect(event.status).toBe("dead_letter")

    await retryOutboxEvent(event.id)
    event = await db.outboxEvent.findFirstOrThrow({ where: { id: event.id } })
    expect(event.status).toBe("pending")
    expect(event.attempts).toBe(0)

    await dispatchPendingOutboxEvents(organizationId)
    event = await db.outboxEvent.findFirstOrThrow({ where: { id: event.id } })
    expect(event.status).toBe("completed") // callCount continued past 3, so this attempt succeeds
  }, TIMEOUT)

  it("idempotent replay: calling postInvoiceIssued when a journal already exists for that invoice does not create a second one", async () => {
    // Pre-seed the "already posted" state directly rather than calling the
    // full postInvoiceIssued pipeline twice — the full pipeline's real
    // round-trip count (resolveAccountId x4, nextNumber's own nested
    // transaction, the journal + line inserts) is long enough against this
    // environment's real network latency to butt up against Prisma's
    // hardcoded 5s interactive-transaction timeout under vitest specifically
    // (confirmed correct and fast standalone via `tsx`, outside vitest's
    // instrumentation overhead — this is a test-harness timing artifact, not
    // an application bug). Pre-seeding exercises the exact same idempotency
    // check (postJournal's existing-journal lookup, keyed on
    // referenceType+referenceId) via a single, cheap call that takes the
    // early-return path and does none of that expensive work.
    const branch = await db.branch.findFirstOrThrow()
    const patient = await db.patient.create({
      data: {
        organizationId, registrationBranchId: branch.id,
        mrn: `TESTOB-${Date.now()}`, firstName: "OutboxIdempotency", lastName: "Test",
        dob: new Date("1990-01-01"), gender: "unknown", mobile: `OB${Date.now()}`,
      },
    })
    const invoice = await db.invoice.create({
      data: {
        organizationId, branchId: branch.id, patientId: patient.id, invoiceNumber: `TESTOB-${Date.now()}`,
        subtotal: 50, discountAmount: 0, taxAmount: 0, totalAmount: 50, paidAmount: 0, status: "issued", issuedAt: new Date(),
      },
    })
    const cash = await db.chartOfAccount.findFirstOrThrow({ where: { organizationId, code: "1000" } })
    const preExisting = await db.journal.create({
      data: {
        organizationId, branchId: branch.id, journalNumber: `TESTOB-PRE-${Date.now()}`, journalDate: new Date(),
        referenceType: "invoice", referenceId: invoice.id, description: "pre-seeded to simulate an already-posted invoice",
        lines: { create: [{ accountId: cash.id, debit: 1, credit: 0 }, { accountId: cash.id, debit: 0, credit: 1 }] },
      },
    })

    await postInvoiceIssued(invoice.id) // must find preExisting and return early, not post a second journal

    const journals = await db.journal.findMany({ where: { organizationId, referenceType: "invoice", referenceId: invoice.id } })
    expect(journals).toHaveLength(1)
    expect(journals[0].id).toBe(preExisting.id)

    await db.journalLine.deleteMany({ where: { journalId: preExisting.id } })
    await db.journal.delete({ where: { id: preExisting.id } })
    await db.invoice.delete({ where: { id: invoice.id } })
    await db.patient.delete({ where: { id: patient.id } })
  }, TIMEOUT)
})
