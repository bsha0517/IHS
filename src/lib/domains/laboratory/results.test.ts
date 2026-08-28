import { describe, it, expect } from "vitest"
import { Decimal } from "@prisma/client/runtime/client"
import { computeAbnormalFlag } from "@/lib/domains/laboratory/results"

describe("computeAbnormalFlag", () => {
  it("returns null only when NOTHING is configured — no reference range and no critical thresholds", () => {
    expect(computeAbnormalFlag(5, null, null)).toBeNull()
  })

  // P1 §22: a single configured bound is still a real reference range to
  // judge against — this changed from the prior behavior (which required
  // BOTH low and high to be non-null before flagging either).
  it("judges against a single configured bound rather than returning null", () => {
    expect(computeAbnormalFlag(0.5, new Decimal(1), null)).toBe("low") // only a low bound configured, value below it
    expect(computeAbnormalFlag(5, new Decimal(1), null)).toBe("normal") // only a low bound configured, value within it
    expect(computeAbnormalFlag(11, null, new Decimal(10))).toBe("high") // only a high bound configured, value above it
    expect(computeAbnormalFlag(5, null, new Decimal(10))).toBe("normal") // only a high bound configured, value within it
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

  // P1 §22: critical thresholds, only where configured.
  describe("critical thresholds", () => {
    it("returns critical_low below the critical-low threshold", () => {
      expect(computeAbnormalFlag(0.2, new Decimal(1), new Decimal(10), new Decimal(0.5), new Decimal(15))).toBe("critical_low")
    })

    it("returns critical_high above the critical-high threshold", () => {
      expect(computeAbnormalFlag(20, new Decimal(1), new Decimal(10), new Decimal(0.5), new Decimal(15))).toBe("critical_high")
    })

    it("critical wins over ordinary low/high when both would technically apply", () => {
      // 0.3 is both below the ordinary low bound (1) AND below the critical-low bound (0.5) — critical must win.
      expect(computeAbnormalFlag(0.3, new Decimal(1), new Decimal(10), new Decimal(0.5), new Decimal(15))).toBe("critical_low")
    })

    it("a value outside the ordinary range but within critical thresholds is only low/high, not critical", () => {
      expect(computeAbnormalFlag(0.7, new Decimal(1), new Decimal(10), new Decimal(0.5), new Decimal(15))).toBe("low")
    })

    it("not configuring critical thresholds never fabricates a critical flag — falls back to ordinary low/high", () => {
      expect(computeAbnormalFlag(0.2, new Decimal(1), new Decimal(10))).toBe("low")
    })
  })
})
