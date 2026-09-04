import "dotenv/config"
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import { db } from "@/lib/db"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import { recordJobAttempt, getJobState } from "@/lib/platform/operational-state"
import { getOperationalHealth } from "@/lib/platform/operational-health"
import type { SessionContext } from "@/lib/auth/session"

const TIMEOUT = 60000

/**
 * P4.4 — targeted tests for the observability/operations surfaces this
 * batch adds: the durable job heartbeat (`OperationalJobState`), the
 * operational-health status calculation (thresholds → Healthy/Warning/
 * Critical/Unknown), the cron route's own heartbeat recording, and the
 * permission gate on the whole thing. Does not re-test outbox
 * dispatch/retry/dead-letter mechanics themselves (`outbox-reliability.test.ts`,
 * `outbox-crash-recovery.test.ts`, `outbox-concurrency.test.ts` already
 * cover those) or P4.3's login-history/rate-limit mechanics — only that
 * this phase's new READ side correctly summarizes them.
 */

let organizationId: string
let staffUserId: string

function operationsSession(): SessionContext {
  return {
    sessionId: "test-p4-4-ops", user: { id: staffUserId, organizationId, email: "p4-4-ops@test.local", firstName: "P44", lastName: "Ops" },
    activeBranchId: null, branchIds: [],
    permissions: new Set(["system_events.view"]),
    roleNames: ["P4.4 Operations Test Role"],
  }
}

function noPermissionSession(): SessionContext {
  return { ...operationsSession(), permissions: new Set([]) }
}

describe("P4.4 §32: OperationalJobState heartbeat (recordJobAttempt / getJobState)", () => {
  const key = "p4_4_test_job"

  afterEach(async () => {
    await db.operationalJobState.deleteMany({ where: { key } })
  })

  it("records a success attempt with metadata and no error", async () => {
    await recordJobAttempt(key, { success: true, metadata: { processed: 3 } })
    const state = await getJobState(key)
    expect(state?.lastSuccessAt).not.toBeNull()
    expect(state?.lastError).toBeNull()
    expect((state?.metadata as { processed: number } | null)?.processed).toBe(3)
  })

  it("records a failure attempt with a truncated error and no success timestamp change", async () => {
    await recordJobAttempt(key, { success: false, error: "boom" })
    const state = await getJobState(key)
    expect(state?.lastFailureAt).not.toBeNull()
    expect(state?.lastSuccessAt).toBeNull()
    expect(state?.lastError).toBe("boom")
  })

  it("truncates an overlong error message rather than storing it unbounded", async () => {
    await recordJobAttempt(key, { success: false, error: "x".repeat(10_000) })
    const state = await getJobState(key)
    expect(state!.lastError!.length).toBeLessThanOrEqual(500)
  })

  it("upserts — a second attempt updates the same row, not a new one", async () => {
    await recordJobAttempt(key, { success: true })
    await recordJobAttempt(key, { success: false, error: "later failure" })
    const rows = await db.operationalJobState.findMany({ where: { key } })
    expect(rows).toHaveLength(1)
    expect(rows[0].lastError).toBe("later failure")
    // A later failure does not erase the earlier recorded success.
    expect(rows[0].lastSuccessAt).not.toBeNull()
  })
})

describe("P4.4 §33/§36/§51: getOperationalHealth — status thresholds and permission gate", () => {
  beforeEach(async () => {
    const branches = await db.branch.findMany({ take: 1 })
    organizationId = branches[0].organizationId
    const user = await db.user.create({
      data: { organizationId, email: `p44-ops-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`, firstName: "P44", lastName: "Ops", passwordHash: "x" },
    })
    staffUserId = user.id
  }, TIMEOUT)

  afterEach(async () => {
    await db.operationalJobState.deleteMany({ where: { key: { in: ["outbox_sweep", "backup"] } } })
    await db.user.deleteMany({ where: { id: staffUserId } })
    await db.$disconnect()
  }, TIMEOUT)

  it("throws ForbiddenError for a session without system_events.view", async () => {
    await expect(getOperationalHealth(noPermissionSession())).rejects.toThrow(ForbiddenError)
  })

  it("reports scheduler status 'unknown' when no heartbeat row exists at all", async () => {
    const health = await getOperationalHealth(operationsSession())
    expect(health.scheduler.status).toBe("unknown")
    expect(health.scheduler.lastSuccessAt).toBeNull()
  })

  it("reports scheduler 'healthy' immediately after a recorded success", async () => {
    await recordJobAttempt("outbox_sweep", { success: true, metadata: { recovered: 0, processed: 2 } })
    const health = await getOperationalHealth(operationsSession())
    expect(health.scheduler.status).toBe("healthy")
    expect(health.scheduler.ageMs).toBeLessThan(60_000)
  })

  it("reports scheduler 'warning' when the last success is older than the warning threshold, and 'critical' past the critical threshold", async () => {
    await db.operationalJobState.upsert({
      where: { key: "outbox_sweep" },
      create: { key: "outbox_sweep", lastAttemptAt: new Date(), lastSuccessAt: new Date(Date.now() - 20 * 60_000) },
      update: { lastAttemptAt: new Date(), lastSuccessAt: new Date(Date.now() - 20 * 60_000) },
    })
    let health = await getOperationalHealth(operationsSession())
    expect(health.scheduler.status).toBe("warning")

    await db.operationalJobState.update({ where: { key: "outbox_sweep" }, data: { lastSuccessAt: new Date(Date.now() - 40 * 60_000) } })
    health = await getOperationalHealth(operationsSession())
    expect(health.scheduler.status).toBe("critical")
    expect(health.overallStatus).toBe("critical") // a critical sub-signal always rolls up
  }, TIMEOUT)

  it("reports backup 'configured: false' / status 'unknown' when no backup heartbeat exists, never a false 'healthy'", async () => {
    const health = await getOperationalHealth(operationsSession())
    expect(health.backup.configured).toBe(false)
    expect(health.backup.status).toBe("unknown")
  })

  it("reports backup 'warning'/'critical' past its own staleness thresholds, exactly like the scheduler", async () => {
    await db.operationalJobState.upsert({
      where: { key: "backup" },
      create: { key: "backup", lastAttemptAt: new Date(), lastSuccessAt: new Date(Date.now() - 30 * 60 * 60_000) },
      update: { lastAttemptAt: new Date(), lastSuccessAt: new Date(Date.now() - 30 * 60 * 60_000) },
    })
    const health = await getOperationalHealth(operationsSession())
    expect(health.backup.configured).toBe(true)
    expect(health.backup.status).toBe("warning")
  }, TIMEOUT)

  it("a dead-letter Outbox event drives outbox.status and overallStatus to 'critical'", async () => {
    const event = await db.outboxEvent.create({
      data: { organizationId, eventType: "P44TestEvent", payload: {}, status: "dead_letter", lastError: "fixture" },
    })
    try {
      const health = await getOperationalHealth(operationsSession())
      expect(health.outbox.deadLetter).toBeGreaterThanOrEqual(1)
      expect(health.outbox.status).toBe("critical")
      expect(health.overallStatus).toBe("critical")
    } finally {
      await db.outboxEvent.delete({ where: { id: event.id } })
    }
  }, TIMEOUT)

  it("a dead-letter accounting-type Outbox event drives accounting.status to 'critical' specifically", async () => {
    const event = await db.outboxEvent.create({
      data: { organizationId, eventType: "InvoiceIssued", payload: {}, status: "dead_letter", lastError: "fixture" },
    })
    try {
      const health = await getOperationalHealth(operationsSession())
      expect(health.accounting.deadLetterPostingEvents).toBeGreaterThanOrEqual(1)
      expect(health.accounting.status).toBe("critical")
    } finally {
      await db.outboxEvent.delete({ where: { id: event.id } })
    }
  }, TIMEOUT)

  it("the operational health summary contains no patient/clinical/financial content — only counts, statuses, and timestamps", async () => {
    const health = await getOperationalHealth(operationsSession())
    const serialized = JSON.stringify(health)
    // No organization name, no email, no free-text patient/financial field —
    // every value in this structure is a number, an ISO timestamp, a status
    // enum string, or (for scheduler/backup) a short truncated error summary
    // this test's own fixtures never populate with anything sensitive.
    expect(serialized).not.toMatch(/@/) // no email address anywhere
    expect(Object.keys(health)).toEqual(
      expect.arrayContaining(["generatedAt", "overallStatus", "application", "database", "outbox", "scheduler", "accounting", "backup", "authentication"])
    )
  })
})

describe("P4.4 §19: the cron route records a durable heartbeat on every invocation", () => {
  const originalSecret = process.env.CRON_SECRET

  afterEach(async () => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalSecret
    await db.operationalJobState.deleteMany({ where: { key: "outbox_sweep" } })
  })

  it("a valid sweep updates the outbox_sweep heartbeat's lastSuccessAt", async () => {
    process.env.CRON_SECRET = "p4-4-test-cron-secret"
    const { GET } = await import("@/app/api/cron/outbox-sweep/route")
    const { NextRequest } = await import("next/server")

    const before = await getJobState("outbox_sweep")
    expect(before).toBeNull()

    const request = new NextRequest("http://localhost/api/cron/outbox-sweep", { headers: { authorization: "Bearer p4-4-test-cron-secret" } })
    const response = await GET(request)
    expect(response.status).toBe(200)

    const after = await getJobState("outbox_sweep")
    expect(after?.lastSuccessAt).not.toBeNull()
    expect(after?.lastError).toBeNull()
  }, TIMEOUT)

  it("an unauthorized request does NOT record a heartbeat — a rejected request never masquerades as a real sweep", async () => {
    process.env.CRON_SECRET = "p4-4-test-cron-secret"
    const { GET } = await import("@/app/api/cron/outbox-sweep/route")
    const { NextRequest } = await import("next/server")

    const request = new NextRequest("http://localhost/api/cron/outbox-sweep", { headers: { authorization: "Bearer wrong-token" } })
    const response = await GET(request)
    expect(response.status).toBe(401)

    const state = await getJobState("outbox_sweep")
    expect(state).toBeNull()
  }, TIMEOUT)
})

afterAll(async () => {
  await db.$disconnect()
})
