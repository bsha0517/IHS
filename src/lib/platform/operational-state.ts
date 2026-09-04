import "server-only"
import { db } from "@/lib/db"
import type { Prisma } from "@/generated/prisma/client"

/**
 * P4.4 §19/§25/§32: the durable-heartbeat write side for
 * `OperationalJobState` (see that model's own doc comment in
 * schema.prisma). Two call sites use this today — the Outbox cron sweep
 * (`src/app/api/cron/outbox-sweep/route.ts`) and the logical backup script
 * (`scripts/db/backup.ts`) — both platform-wide infrastructure jobs with no
 * other durable trace of "did this actually run" beyond a single past HTTP
 * response or process exit code.
 *
 * Deliberately a plain upsert, not a job-scheduler framework: every call
 * records one attempt, updating `lastAttemptAt` always and exactly one of
 * `lastSuccessAt`/`lastFailureAt` depending on outcome — the read side
 * (`operational-health.ts`) derives Healthy/Warning/Critical/Unknown status
 * from these raw timestamps against a threshold, never from a status this
 * function itself decides.
 */
export type JobOutcome =
  | { success: true; metadata?: Record<string, unknown> }
  | { success: false; error: string; metadata?: Record<string, unknown> }

const MAX_ERROR_LENGTH = 500

export async function recordJobAttempt(key: string, outcome: JobOutcome): Promise<void> {
  const now = new Date()
  const metadata = outcome.metadata as Prisma.InputJsonValue | undefined
  const data = outcome.success
    ? { lastAttemptAt: now, lastSuccessAt: now, lastError: null, metadata: metadata ?? undefined }
    : {
        lastAttemptAt: now,
        lastFailureAt: now,
        // Never store more than a short, truncated summary — this is an
        // operational signal ("is the job failing"), not a place to dump a
        // full stack trace, and truncation also bounds how much of
        // whatever the underlying error happened to stringify ends up
        // here (see this function's own callers for what's already
        // sanitized before it reaches this point).
        lastError: outcome.error.slice(0, MAX_ERROR_LENGTH),
        metadata: metadata ?? undefined,
      }

  await db.operationalJobState.upsert({
    where: { key },
    create: { key, ...data },
    update: data,
  })
}

export async function getJobState(key: string) {
  return db.operationalJobState.findUnique({ where: { key } })
}

export async function listJobStates(keys: string[]) {
  const rows = await db.operationalJobState.findMany({ where: { key: { in: keys } } })
  const byKey = new Map(rows.map((r) => [r.key, r]))
  return keys.map((key) => byKey.get(key) ?? null)
}
