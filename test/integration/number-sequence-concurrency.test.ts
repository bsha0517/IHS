import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { nextNumber, type SequenceType } from "@/lib/platform/sequences"

/**
 * P1 §30 — re-verifies `nextNumber`'s atomic `UPDATE ... RETURNING` (see
 * sequences.ts's own doc comment) is actually race-safe for every sequence
 * type P1.md names, by firing real parallel calls against the shared
 * organization's row and confirming the returned numbers never collide.
 * Every named domain (MRN/patients, APT/appointments, ENC/encounters,
 * INV/invoices, PAY/payments, RFD/refunds — added this batch, see
 * billing/refunds.ts, CLM/claims, PO/purchase-orders, AST/assets,
 * EMP/employees) calls this exact function with no code path of its own —
 * testing the primitive directly is testing all ten call sites at once,
 * not a proxy for them.
 */
const TIMEOUT = 60000
const CONCURRENCY = 12

const SEQUENCE_TYPES: { type: SequenceType; prefix: string }[] = [
  { type: "MRN", prefix: "MRN" },
  { type: "APT", prefix: "APT" },
  { type: "ENC", prefix: "ENC" },
  { type: "INV", prefix: "INV" },
  { type: "PAY", prefix: "PAY" },
  { type: "RFD", prefix: "RFD" },
  { type: "CLM", prefix: "CLM" },
  { type: "PO", prefix: "PO" },
  { type: "AST", prefix: "AST" },
  { type: "EMP", prefix: "EMP" },
]

describe("P1 §30: number sequence concurrency", () => {
  let organizationId: string

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
  }, TIMEOUT)

  afterAll(async () => {
    await db.$disconnect()
  }, TIMEOUT)

  for (const { type, prefix } of SEQUENCE_TYPES) {
    it(`${type}: ${CONCURRENCY} parallel requests produce ${CONCURRENCY} unique numbers, no duplicates`, async () => {
      const before = await db.numberSequence.findFirst({
        where: { organizationId, sequenceType: type, branchId: null },
      })
      const startValue = before?.currentValue ?? 0

      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => nextNumber({ organizationId, sequenceType: type, prefix }))
      )

      // Uniqueness — the actual concurrency-safety claim under test. Not
      // asserting exact contiguity against `before`: every one of these
      // sequence types is org-wide (see appointments/service.ts's own P1
      // §30 fix), so other test files' domain code legitimately shares and
      // increments the very same counter while this test runs in parallel —
      // gaps from *other* legitimate callers are expected and fine; a
      // duplicate never is.
      expect(new Set(results).size).toBe(CONCURRENCY)

      // Every value is a real increment past the pre-test baseline, in the
      // expected `${prefix}-NNNNNN` shape — confirms the guard is a genuine
      // sequential counter (spec.md §68's "never use count + 1"), not just
      // "unique" via random suffixes.
      for (const value of results) {
        expect(value).toMatch(new RegExp(`^${prefix}-\\d{6,}$`))
        const numeric = Number(value.replace(`${prefix}-`, ""))
        expect(numeric).toBeGreaterThan(startValue)
      }

      const after = await db.numberSequence.findFirstOrThrow({
        where: { organizationId, sequenceType: type, branchId: null },
      })
      expect(after.currentValue).toBeGreaterThanOrEqual(startValue + CONCURRENCY)
    }, TIMEOUT)
  }
})
