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
  | "RFD"
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
  | "ICV"

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
 *
 * P1 §30: first-use-ever creation is raced by retrying the WHOLE transaction,
 * not by catching the create() failure and issuing another statement inside
 * the same Postgres transaction — that used to throw "current transaction is
 * aborted, commands ignored until end of transaction block" (25P02), since
 * Postgres refuses every further statement once one has errored, no matter
 * how the JS-level try/catch reads. A real concurrency test (12 parallel
 * first-ever callers for one sequence) reproduced this directly: the create()
 * winner succeeded, but all 11 losers hit 25P02 instead of successfully
 * falling back to the UPDATE. Retrying nextNumber() itself opens a fresh
 * transaction, which now finds the winner's row and takes the normal UPDATE
 * path — bounded to a handful of attempts since only the very first call
 * for a given (organizationId, branchId, sequenceType) can ever race this way.
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

  const MAX_ATTEMPTS = 5
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Widened from Prisma's 2000ms/5000ms defaults — this transaction is
      // frequently opened as a NESTED transaction from inside an outer
      // $transaction (every posting-service.ts function, recordPayment,
      // completeRefund, ...), each needing its own separate connection from
      // `pg.Pool`'s deliberately small max:3 (src/lib/db.ts) while the outer
      // transaction holds one too. Under this environment's real Supabase
      // pooler latency, "Unable to start a transaction in the given time" (a
      // maxWait failure, not a slow-query one) was observed here directly
      // during P1 batch 2's own test runs once callers started doing more work
      // per transaction (P1 §29's atomic payment/refund guard).
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

        // Row doesn't exist yet — create it starting at 1. If a concurrent
        // caller races us here, the unique index rejects us and this whole
        // transaction aborts; the outer loop retries nextNumber() from
        // scratch rather than issuing more statements in this now-dead
        // transaction.
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
      }, { timeout: 20_000, maxWait: 10_000 })

      return `${params.prefix}-${String(value).padStart(padding, "0")}`
    } catch (error) {
      lastError = error
      const isRowCreationRace = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
      if (!isRowCreationRace || attempt === MAX_ATTEMPTS) throw error
      // Fall through and retry with a fresh transaction.
    }
  }
  throw lastError
}

export type PlatformSequenceType = "SUP"

/**
 * P5.2 §7: the platform-wide counterpart to `nextNumber()` — identical
 * atomic-UPDATE-then-create-on-first-use/retry-on-race strategy, against
 * `PlatformNumberSequence` (no organizationId) instead of `NumberSequence`.
 * See that model's own doc comment for why a separate table exists rather
 * than reusing `NumberSequence` with some sentinel organization id.
 */
export async function nextPlatformNumber(params: { sequenceType: PlatformSequenceType; prefix: string; padding?: number }): Promise<string> {
  const padding = params.padding ?? DEFAULT_PADDING

  const MAX_ATTEMPTS = 5
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const value = await db.$transaction(async (tx) => {
        const updated = await tx.$queryRaw<{ current_value: number }[]>(Prisma.sql`
          UPDATE "platform_number_sequence"
          SET "current_value" = "current_value" + 1
          WHERE "sequence_type" = ${params.sequenceType}
          RETURNING "current_value"
        `)

        if (updated.length > 0) {
          return updated[0].current_value
        }

        const created = await tx.platformNumberSequence.create({
          data: { sequenceType: params.sequenceType, currentValue: 1 },
        })
        return created.currentValue
      }, { timeout: 20_000, maxWait: 10_000 })

      return `${params.prefix}-${String(value).padStart(padding, "0")}`
    } catch (error) {
      lastError = error
      const isRowCreationRace = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
      if (!isRowCreationRace || attempt === MAX_ATTEMPTS) throw error
    }
  }
  throw lastError
}
