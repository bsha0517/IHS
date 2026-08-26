import { describe, it, expect } from "vitest"
import { Decimal } from "@prisma/client/runtime/client"
import { allocateFefo } from "@/lib/domains/inventory/stock"

describe("allocateFefo", () => {
  it("takes everything needed from a single batch when it has enough", () => {
    const batches = [{ batchId: "b1", balance: new Decimal(20) }]
    const result = allocateFefo(batches, new Decimal(5), "Gauze")
    expect(result).toEqual([{ batchId: "b1", take: new Decimal(5) }])
  })

  it("spans multiple batches in the given (earliest-expiry-first) order when one alone isn't enough", () => {
    const batches = [
      { batchId: "earliest", balance: new Decimal(8) },
      { batchId: "later", balance: new Decimal(20) },
    ]
    const result = allocateFefo(batches, new Decimal(12), "Gauze")
    expect(result).toEqual([
      { batchId: "earliest", take: new Decimal(8) },
      { batchId: "later", take: new Decimal(4) },
    ])
  })

  it("throws with a clear message, taking nothing from any batch, when total available is insufficient", () => {
    const batches = [
      { batchId: "b1", balance: new Decimal(3) },
      { batchId: "b2", balance: new Decimal(4) },
    ]
    expect(() => allocateFefo(batches, new Decimal(100), "Paracetamol")).toThrow(
      'Insufficient stock for "Paracetamol" — need 100, have 7.'
    )
  })

  it("stops walking batches once the requested quantity is exactly satisfied, never over-allocating", () => {
    const batches = [
      { batchId: "b1", balance: new Decimal(10) },
      { batchId: "b2", balance: new Decimal(10) },
    ]
    const result = allocateFefo(batches, new Decimal(10), "Gauze")
    expect(result).toEqual([{ batchId: "b1", take: new Decimal(10) }])
  })

  it("an empty batch list with a positive quantity requested throws rather than silently allocating nothing", () => {
    expect(() => allocateFefo([], new Decimal(1), "Gauze")).toThrow("Insufficient stock")
  })

  it("a zero quantity request allocates nothing and does not throw", () => {
    const batches = [{ batchId: "b1", balance: new Decimal(5) }]
    expect(allocateFefo(batches, new Decimal(0), "Gauze")).toEqual([])
  })
})
