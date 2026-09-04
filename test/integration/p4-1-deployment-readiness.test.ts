import { describe, it, expect, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { validateEnv } from "@/lib/env"

/**
 * P4.1 §54 — targeted tests for this batch's new production-deployment
 * surfaces: the centralized env-validation layer, the health-check
 * endpoint, and the cron endpoint's bearer-token authorization. Kept
 * narrowly scoped to what P4.1 actually added/changed — this is not a
 * general re-test of pre-existing, unchanged auth/session code (see the
 * P4.1 report's Security Review for what was verified by inspection
 * instead of by a new automated test, and why).
 */
describe("P4.1 §7: environment validation (src/lib/env.ts)", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Restore exactly, including deleting keys a test added that weren't
    // there originally — process.env is a live object every test in this
    // describe block mutates directly.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it("accepts the real test environment as-is (DATABASE_URL present, NODE_ENV=test)", () => {
    expect(() => validateEnv()).not.toThrow()
    const parsed = validateEnv()
    expect(parsed.DATABASE_URL).toBeTruthy()
    expect(parsed.NODE_ENV).toBe("test")
  })

  it("throws, naming DATABASE_URL, when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL
    expect(() => validateEnv()).toThrow(/DATABASE_URL/)
  })

  it("throws when NODE_ENV holds a value outside development/production/test", () => {
    // NODE_ENV is typed read-only (Next augments it to a fixed literal union) —
    // write through a loosely-typed alias to the same live object, exactly as
    // any real misconfigured shell environment would set it.
    ;(process.env as Record<string, string>).NODE_ENV = "staging"
    expect(() => validateEnv()).toThrow(/NODE_ENV/)
  })

  it("throws, naming APP_BASE_URL, when APP_BASE_URL is set but not a valid URL", () => {
    process.env.APP_BASE_URL = "not-a-url"
    expect(() => validateEnv()).toThrow(/APP_BASE_URL/)
  })

  it("accepts a well-formed APP_BASE_URL and passes it through unchanged", () => {
    process.env.APP_BASE_URL = "https://app.example.com"
    const parsed = validateEnv()
    expect(parsed.APP_BASE_URL).toBe("https://app.example.com")
  })

  it("does not require CRON_SECRET or OUTBOX_PROCESSING_TIMEOUT_MS — both stay optional", () => {
    delete process.env.CRON_SECRET
    delete process.env.OUTBOX_PROCESSING_TIMEOUT_MS
    expect(() => validateEnv()).not.toThrow()
  })

  it("coerces a numeric-string OUTBOX_PROCESSING_TIMEOUT_MS and rejects a non-numeric one", () => {
    process.env.OUTBOX_PROCESSING_TIMEOUT_MS = "45000"
    expect(validateEnv().OUTBOX_PROCESSING_TIMEOUT_MS).toBe(45000)

    process.env.OUTBOX_PROCESSING_TIMEOUT_MS = "not-a-number"
    expect(() => validateEnv()).toThrow(/OUTBOX_PROCESSING_TIMEOUT_MS/)
  })
})

describe("P4.1 §23-25: GET /api/health", () => {
  it("reports healthy with a reachable database, a timestamp, and no secret/error detail", async () => {
    const { GET } = await import("@/app/api/health/route")
    const response = await GET()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe("healthy")
    expect(body.database).toBe("reachable")
    expect(typeof body.timestamp).toBe("string")
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date")
    expect(typeof body.durationMs).toBe("number")
    // Never a connection string, a stack trace, or any other internal detail.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//i)
  })
})

describe("P4.1 §11-14: GET /api/cron/outbox-sweep authorization", () => {
  const originalSecret = process.env.CRON_SECRET

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalSecret
  })

  it("refuses with 503 (not 200, not a silent unauthenticated run) when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET
    const { GET } = await import("@/app/api/cron/outbox-sweep/route")
    const request = new NextRequest("http://localhost/api/cron/outbox-sweep")
    const response = await GET(request)
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error.code).toBe("not_configured")
  })

  it("rejects a request with no Authorization header once CRON_SECRET is configured", async () => {
    process.env.CRON_SECRET = "test-cron-secret-p4-1"
    const { GET } = await import("@/app/api/cron/outbox-sweep/route")
    const request = new NextRequest("http://localhost/api/cron/outbox-sweep")
    const response = await GET(request)
    expect(response.status).toBe(401)
  })

  it("rejects a request bearing the wrong bearer token", async () => {
    process.env.CRON_SECRET = "test-cron-secret-p4-1"
    const { GET } = await import("@/app/api/cron/outbox-sweep/route")
    const request = new NextRequest("http://localhost/api/cron/outbox-sweep", {
      headers: { authorization: "Bearer wrong-token" },
    })
    const response = await GET(request)
    expect(response.status).toBe(401)
  })

  it("runs the sweep and returns 200 when the bearer token matches CRON_SECRET exactly", async () => {
    process.env.CRON_SECRET = "test-cron-secret-p4-1"
    const { GET } = await import("@/app/api/cron/outbox-sweep/route")
    const request = new NextRequest("http://localhost/api/cron/outbox-sweep", {
      headers: { authorization: "Bearer test-cron-secret-p4-1" },
    })
    const response = await GET(request)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
  })
})
