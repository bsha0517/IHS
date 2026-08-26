import { describe, it, expect, vi, afterEach } from "vitest"
import { calculateAge, toDateParam } from "@/lib/utils/dates"

describe("calculateAge", () => {
  afterEach(() => vi.useRealTimers())

  it("computes a whole-years age from DOB as of today", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-15T00:00:00"))
    expect(calculateAge(new Date("2000-06-15T00:00:00"))).toBe(26)
  })

  it("has not yet had this year's birthday: age is one less", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-14T00:00:00"))
    expect(calculateAge(new Date("2000-06-15T00:00:00"))).toBe(25)
  })

  it("birthday was earlier this month: age already incremented", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-16T00:00:00"))
    expect(calculateAge(new Date("2000-06-15T00:00:00"))).toBe(26)
  })
})

describe("toDateParam", () => {
  it("formats a local date as YYYY-MM-DD, zero-padded", () => {
    expect(toDateParam(new Date(2026, 0, 5))).toBe("2026-01-05")
  })

  it("uses local calendar fields, not a UTC conversion (the documented pitfall this helper exists to avoid)", () => {
    // 2026-08-26T23:30 local — a naive toISOString().slice(0,10) in a UTC+ timezone
    // would round-trip correctly, but in a UTC- timezone would silently shift a day.
    // toDateParam must read the same local date components regardless of the host's offset.
    const d = new Date(2026, 7, 26, 23, 30)
    expect(toDateParam(d)).toBe("2026-08-26")
  })
})
