import { describe, it, expect } from "vitest"
import { Decimal } from "@prisma/client/runtime/client"
import { computeAbnormalFlag } from "@/lib/domains/laboratory/results"

describe("computeAbnormalFlag", () => {
  it("returns null when either bound is missing (no reference range to judge against)", () => {
    expect(computeAbnormalFlag(5, null, new Decimal(10))).toBeNull()
    expect(computeAbnormalFlag(5, new Decimal(1), null)).toBeNull()
    expect(computeAbnormalFlag(5, null, null)).toBeNull()
  })

  it("flags below the low bound as low", () => {
    expect(computeAbnormalFlag(0.9, new Decimal(1), new Decimal(10))).toBe("low")
  })

  it("flags above the high bound as high", () => {
    expect(computeAbnormalFlag(10.1, new Decimal(1), new Decimal(10))).toBe("high")
  })

  it("treats the exact low bound as normal (inclusive), not low", () => {
    expect(computeAbnormalFlag(1, new Decimal(1), new Decimal(10))).toBe("normal")
  })

  it("treats the exact high bound as normal (inclusive), not high", () => {
    expect(computeAbnormalFlag(10, new Decimal(1), new Decimal(10))).toBe("normal")
  })

  it("flags a value strictly inside the range as normal", () => {
    expect(computeAbnormalFlag(5, new Decimal(1), new Decimal(10))).toBe("normal")
  })
})
