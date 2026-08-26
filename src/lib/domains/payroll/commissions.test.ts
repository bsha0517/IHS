import { describe, it, expect } from "vitest"
import { Decimal } from "@prisma/client/runtime/client"
import { computeAmount } from "@/lib/domains/payroll/commissions"

describe("computeAmount", () => {
  it("fixed: returns the flat fixedAmount regardless of basis", () => {
    const rule = { type: "fixed", fixedAmount: new Decimal(50), percentageRate: null, tiers: null }
    expect(computeAmount(rule, 1)).toBe(50)
    expect(computeAmount(rule, 100000)).toBe(50)
  })

  it("fixed: treats a missing fixedAmount as 0, not an error", () => {
    const rule = { type: "fixed", fixedAmount: null, percentageRate: null, tiers: null }
    expect(computeAmount(rule, 1000)).toBe(0)
  })

  it("percentage: multiplies basis by the rate", () => {
    const rule = { type: "percentage", fixedAmount: null, percentageRate: new Decimal(0.1), tiers: null }
    expect(computeAmount(rule, 1000)).toBe(100)
  })

  it("tiered: prices the entire basis at whichever single bracket it falls into (bracket lookup, not progressive)", () => {
    const tiers = [
      { minAmount: 0, maxAmount: 999, rate: 0.05 },
      { minAmount: 1000, maxAmount: 4999, rate: 0.1 },
      { minAmount: 5000, maxAmount: null, rate: 0.15 },
    ]
    const rule = { type: "tiered", fixedAmount: null, percentageRate: null, tiers }
    // 1500 falls in the second bracket (1000-4999 @ 10%) -> entire 1500 * 0.10, not a blended/progressive split.
    expect(computeAmount(rule, 1500)).toBe(150)
  })

  it("tiered: exact bracket boundary (minAmount) is inclusive", () => {
    const tiers = [
      { minAmount: 0, maxAmount: 999, rate: 0.05 },
      { minAmount: 1000, maxAmount: 4999, rate: 0.1 },
    ]
    const rule = { type: "tiered", fixedAmount: null, percentageRate: null, tiers }
    expect(computeAmount(rule, 1000)).toBe(100)
    expect(computeAmount(rule, 999)).toBeCloseTo(49.95)
  })

  it("tiered: the last bracket's null maxAmount means unbounded", () => {
    const tiers = [{ minAmount: 5000, maxAmount: null, rate: 0.15 }]
    const rule = { type: "tiered", fixedAmount: null, percentageRate: null, tiers }
    expect(computeAmount(rule, 1_000_000)).toBe(150_000)
  })

  it("tiered: a basis amount matching no bracket accrues zero, not a fallback rate", () => {
    const tiers = [{ minAmount: 1000, maxAmount: 4999, rate: 0.1 }]
    const rule = { type: "tiered", fixedAmount: null, percentageRate: null, tiers }
    expect(computeAmount(rule, 500)).toBe(0)
  })

  it("an unrecognized rule type accrues zero rather than throwing", () => {
    const rule = { type: "unknown", fixedAmount: null, percentageRate: null, tiers: null }
    expect(computeAmount(rule, 1000)).toBe(0)
  })
})
