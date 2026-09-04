import { describe, it, expect, vi, afterEach } from "vitest"
import { log } from "@/lib/platform/logger"

/**
 * P2 Batch 8 (§16) — the centralized structured logger. No database
 * involved (the logger writes to console, not a table), so this is a
 * pure unit test, not an integration test against the real dev DB like
 * every other file in this directory — kept here anyway to match this
 * project's established single `test/integration/` convention rather than
 * inventing a parallel `test/unit/` directory for one file.
 */
describe("P2 §16: structured logger", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("routes level: 'error' to console.error as one structured JSON line with the expected fields", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    log({
      level: "error", event: "test.something_failed", domain: "test", operation: "unitTest",
      organizationId: "org-1", branchId: "branch-1", userId: "user-1", entityId: "entity-1", reference: "widget",
    })
    expect(spy).toHaveBeenCalledOnce()
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.level).toBe("error")
    expect(parsed.event).toBe("test.something_failed")
    expect(parsed.domain).toBe("test")
    expect(parsed.operation).toBe("unitTest")
    expect(parsed.organizationId).toBe("org-1")
    expect(parsed.branchId).toBe("branch-1")
    expect(parsed.userId).toBe("user-1")
    expect(parsed.entityId).toBe("entity-1")
    expect(parsed.reference).toBe("widget")
    expect(typeof parsed.timestamp).toBe("string")
    expect(new Date(parsed.timestamp).toString()).not.toBe("Invalid Date")
  })

  it("routes level: 'warn' to console.warn, and level: 'info'/'debug' to console.log — never console.error for a non-error level", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    log({ level: "warn", event: "test.warn" })
    log({ level: "info", event: "test.info" })
    log({ level: "debug", event: "test.debug" })

    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(logSpy).toHaveBeenCalledTimes(2)
  })

  it("normalizes a real Error into {name, message, stack} rather than logging the raw Error object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const err = new TypeError("something broke")
    log({ level: "error", event: "test.with_error", error: err })
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.error.name).toBe("TypeError")
    expect(parsed.error.message).toBe("something broke")
    expect(typeof parsed.error.stack).toBe("string")
  })

  it("normalizes a non-Error thrown value (e.g. a string or plain object) without crashing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    log({ level: "error", event: "test.string_throw", error: "a plain string error" })
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.error.name).toBe("UnknownError")
    expect(parsed.error.message).toBe("a plain string error")
  })

  it("omits the error field entirely when none was given — never fabricates one", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    log({ level: "info", event: "test.no_error" })
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.error).toBeUndefined()
  })

  it("never throws, even if a field's value can't be JSON-serialized (a circular reference)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => log({ level: "error", event: "test.circular", error: circular })).not.toThrow()
    // The fallback path still logs something rather than losing the event silently.
    expect(errorSpy).toHaveBeenCalled()
  })
})
