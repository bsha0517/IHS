import { Decimal } from "@prisma/client/runtime/client"

/**
 * Recursively converts Prisma `Decimal` instances to plain numbers. Next.js's
 * Server->Client Component boundary only accepts plain objects — a Decimal
 * instance nested anywhere in a prop tree throws at render time, and (worse)
 * fails silently enough that the page half-renders rather than erroring
 * loudly (see PROJECT_STATUS.md Phase 3 "Known Issues" for how this first
 * surfaced). Rather than hand-picking Decimal-free fields at every call site
 * — which is exactly the discipline that already slipped once in Phase 2 —
 * apply this once at the point data crosses into a "use client" subtree.
 * Dates, null, and primitives pass through unchanged.
 */
export function serializeDecimals<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (value instanceof Decimal) return Number(value) as unknown as T
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map((item) => serializeDecimals(item)) as unknown as T
  if (typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = serializeDecimals(nested)
    }
    return result as T
  }
  return value
}
