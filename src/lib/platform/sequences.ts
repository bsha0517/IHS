import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"

export type SequenceType =
  | "MRN"
  | "APT"
  | "EPS"
  | "ENC"
  | "ORD"
  | "RX"
  | "LAB"
  | "INV"
  | "PAY"
  | "CLM"
  | "PO"
  | "PR"
  | "GR"
  | "JRN"
  | "EMP"
  | "AST"
  | "QUEUE"
  | "DISP"
  | "RAD"

export type SequenceResetPeriod = "never" | "daily"

const DEFAULT_PADDING = 6

/**
 * Concurrency-safe number sequence generator (spec.md §68 — "never use count + 1").
 * The increment is a single atomic UPDATE ... RETURNING; Postgres row-level locking
 * during that statement is what actually prevents two concurrent callers from
 * getting the same value, not application-level locking. First-use-ever creation
 * of a sequence row is protected by the COALESCE(branch_id, sentinel) unique index
 * added in the number_sequence_null_branch_uniqueness migration.
 *
 * `resetPeriod: "daily"` (used for queue tokens) still goes through the same
 * single atomic statement — the reset-to-1 and the increment are two branches
 * of one CASE expression in the same UPDATE, so a same-instant race at the
 * midnight boundary is still race-safe, not a second unguarded step.
 */
export async function nextNumber(params: {
  organizationId: string
  branchId?: string | null
  sequenceType: SequenceType
  prefix: string
  padding?: number
  resetPeriod?: SequenceResetPeriod
}): Promise<string> {
  const branchId = params.branchId ?? null
  const padding = params.padding ?? DEFAULT_PADDING
  const resetPeriod = params.resetPeriod ?? "never"

  const value = await db.$transaction(async (tx) => {
    const branchFilter =
      branchId === null ? Prisma.sql`"branch_id" IS NULL` : Prisma.sql`"branch_id" = ${branchId}`

    const updated = await tx.$queryRaw<{ current_value: number }[]>(Prisma.sql`
      UPDATE "number_sequence"
      SET
        "current_value" = CASE
          WHEN "reset_period" = 'daily' AND "last_reset_at"::date <> (now() AT TIME ZONE 'UTC')::date THEN 1
          ELSE "current_value" + 1
        END,
        "last_reset_at" = CASE
          WHEN "reset_period" = 'daily' AND "last_reset_at"::date <> (now() AT TIME ZONE 'UTC')::date THEN now()
          ELSE "last_reset_at"
        END
      WHERE "organization_id" = ${params.organizationId}
        AND "sequence_type" = ${params.sequenceType}
        AND ${branchFilter}
      RETURNING "current_value"
    `)

    if (updated.length > 0) {
      return updated[0].current_value
    }

    // Row doesn't exist yet — create it starting at 1. If a concurrent caller
    // races us here, the unique index rejects the loser, who retries the UPDATE.
    try {
      const created = await tx.numberSequence.create({
        data: {
          organizationId: params.organizationId,
          branchId,
          sequenceType: params.sequenceType,
          prefix: params.prefix,
          currentValue: 1,
          padding,
          resetPeriod,
        },
      })
      return created.currentValue
    } catch {
      const retried = await tx.$queryRaw<{ current_value: number }[]>(Prisma.sql`
        UPDATE "number_sequence"
        SET "current_value" = "current_value" + 1
        WHERE "organization_id" = ${params.organizationId}
          AND "sequence_type" = ${params.sequenceType}
          AND ${branchFilter}
        RETURNING "current_value"
      `)
      return retried[0].current_value
    }
  })

  return `${params.prefix}-${String(value).padStart(padding, "0")}`
}
