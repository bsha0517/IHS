import { describe, it, expect } from "vitest"
import { computeInvoicePostingSplit } from "@/lib/domains/accounting/posting-service"

describe("computeInvoicePostingSplit", () => {
  it("an all-non-package invoice books everything to revenue, nothing to unearned", () => {
    const result = computeInvoicePostingSplit({
      subtotal: 200,
      discountAmount: 0,
      taxAmount: 10,
      lines: [{ quantity: 1, unitPrice: 200, sourceType: "consultation" }],
    })
    expect(result.revenueAmount).toBe(200)
    expect(result.unearnedAmount).toBe(0)
    expect(result.taxAmount).toBe(10)
  })

  it("an all-package invoice books everything to unearned, nothing to revenue", () => {
    const result = computeInvoicePostingSplit({
      subtotal: 900,
      discountAmount: 0,
      taxAmount: 0,
      lines: [{ quantity: 1, unitPrice: 900, sourceType: "package" }],
    })
    expect(result.revenueAmount).toBe(0)
    expect(result.unearnedAmount).toBe(900)
  })

  it("splits a document-level discount proportionally across package and non-package subtotals, exactly (mixed-source invoice, a realistic POS scenario)", () => {
    // 200 consultation + 800 package = 1000 subtotal, 100 discount -> allocated 20/80 by each bucket's own share.
    const result = computeInvoicePostingSplit({
      subtotal: 1000,
      discountAmount: 100,
      taxAmount: 0,
      lines: [
        { quantity: 1, unitPrice: 200, sourceType: "consultation" },
        { quantity: 1, unitPrice: 800, sourceType: "package" },
      ],
    })
    expect(result.revenueAmount).toBe(180) // 200 - (100 * 200/1000)
    expect(result.unearnedAmount).toBe(720) // 800 - (100 * 800/1000)
    // The core invariant this split exists to preserve: revenue + unearned + discount === subtotal exactly.
    expect(result.revenueAmount + result.unearnedAmount + 100).toBe(1000)
  })

  it("a discount larger than one bucket's subtotal never drives that bucket negative", () => {
    const result = computeInvoicePostingSplit({
      subtotal: 100,
      discountAmount: 100,
      taxAmount: 0,
      lines: [{ quantity: 1, unitPrice: 100, sourceType: "consultation" }],
    })
    expect(result.revenueAmount).toBe(0)
    expect(result.unearnedAmount).toBe(0)
  })

  it("a zero subtotal never divides by zero computing the package share", () => {
    const result = computeInvoicePostingSplit({ subtotal: 0, discountAmount: 0, taxAmount: 0, lines: [] })
    expect(result.revenueAmount).toBe(0)
    expect(result.unearnedAmount).toBe(0)
    expect(Number.isNaN(result.revenueAmount)).toBe(false)
  })
})
