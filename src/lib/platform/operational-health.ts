import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { listJobStates } from "@/lib/platform/operational-state"
import { ACCOUNTING_EVENT_TYPES } from "@/lib/domains/accounting/exceptions"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P4.4 §33: the one service function that assembles every safe production
 * signal this phase adds visibility into. Deliberately platform-wide, not
 * organization-scoped — unlike `/admin/system-events` (P0-02) and
 * `/accounting/exceptions` (P3.9), which each show ONE organization's own
 * business queue, this answers infrastructure-level questions ("is the
 * shared outbox mechanism falling behind across every organization it
 * processes," "is the shared scheduler alive," "is the shared backup job
 * healthy") that don't have a natural per-tenant answer in a single shared
 * database/scheduler/backup job. Every count returned here is a bare
 * number — no organization name, no patient/financial content, no PHI —
 * safe for any session already authorized to view `/admin/system-events`
 * (gated on the same `system_events.view` permission, reused rather than
 * inventing a new one — see the P4.4 report's own reasoning for why no new
 * "platform operator" role/permission was introduced).
 *
 * Bounded and cheap by design (§66): every query below is either a COUNT
 * against an already-indexed column, or a `take`-limited read of at most
 * one row — nothing here scans an unbounded table.
 */

export type StatusLevel = "healthy" | "warning" | "critical" | "unknown"

// P4.4 §20: tuned to this project's documented cron reality (P4.1/DEPLOYMENT.md) —
// Vercel Hobby's daily-only cron means a real deployment without an external
// scheduler configured is EXPECTED to look stale by these numbers most of the
// day; that's an honest signal, not a bug in the threshold (see the report's
// own Scheduler Heartbeat section for how "Not Configured" is distinguished
// from "Critical").
const SCHEDULER_WARNING_MS = 15 * 60_000
const SCHEDULER_CRITICAL_MS = 30 * 60_000

// P4.4 §26: tuned to the documented daily independent-logical-backup cadence
// (docs/BACKUP_DISASTER_RECOVERY.md's Retention Policy).
const BACKUP_WARNING_MS = 26 * 60 * 60_000
const BACKUP_CRITICAL_MS = 48 * 60 * 60_000

// P4.4 §46: tuned to a 5-minute expected sweep cadence.
const OUTBOX_BACKLOG_WARNING_MS = 10 * 60_000
const OUTBOX_BACKLOG_CRITICAL_MS = 30 * 60_000

// P4.4 §29/§30: a window for "recent" login-abuse signals — wide enough to
// show a real spike, narrow enough to stay a cheap indexed query
// (LoginHistory's own `(ip, channel, createdAt)` index, P4.3).
const AUTH_ABUSE_WINDOW_MS = 15 * 60_000
// A meaningful-spike threshold, not "alert on every failed login" (§30).
const AUTH_ABUSE_WARNING_FAILURES = 25
const AUTH_ABUSE_CRITICAL_FAILURES = 75

function worse(a: StatusLevel, b: StatusLevel): StatusLevel {
  const rank: Record<StatusLevel, number> = { healthy: 0, unknown: 1, warning: 2, critical: 3 }
  return rank[b] > rank[a] ? b : a
}

function ageStatus(lastSuccessAt: Date | null, warnMs: number, criticalMs: number): { status: StatusLevel; ageMs: number | null } {
  if (!lastSuccessAt) return { status: "unknown", ageMs: null }
  const ageMs = Date.now() - lastSuccessAt.getTime()
  if (ageMs > criticalMs) return { status: "critical", ageMs }
  if (ageMs > warnMs) return { status: "warning", ageMs }
  return { status: "healthy", ageMs }
}

export type OperationalHealthSummary = {
  generatedAt: string
  overallStatus: StatusLevel
  application: { status: StatusLevel }
  database: { status: StatusLevel; reachable: boolean; queryDurationMs: number }
  outbox: {
    status: StatusLevel
    pending: number
    processing: number
    failedRetrying: number
    deadLetter: number
    oldestPendingAgeMs: number | null
  }
  scheduler: {
    status: StatusLevel
    lastAttemptAt: string | null
    lastSuccessAt: string | null
    lastError: string | null
    ageMs: number | null
  }
  accounting: {
    status: StatusLevel
    failedPostingEvents: number
    deadLetterPostingEvents: number
  }
  backup: {
    status: StatusLevel
    configured: boolean
    lastAttemptAt: string | null
    lastSuccessAt: string | null
    lastError: string | null
    ageMs: number | null
  }
  authentication: {
    status: StatusLevel
    recentFailedStaffLogins: number
    recentFailedPortalLogins: number
    recentThrottledAttempts: number
    windowMinutes: number
  }
}

export async function getOperationalHealth(session: SessionContext): Promise<OperationalHealthSummary> {
  assertCan(session, "system_events.view")

  const dbStart = Date.now()
  let dbReachable = true
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    dbReachable = false
  }
  const queryDurationMs = Date.now() - dbStart
  const database: OperationalHealthSummary["database"] = {
    status: dbReachable ? "healthy" : "critical",
    reachable: dbReachable,
    queryDurationMs,
  }

  // If the database itself is unreachable, every query below would just
  // throw — return early with everything else honestly "unknown" rather
  // than a misleading partial summary.
  if (!dbReachable) {
    return {
      generatedAt: new Date().toISOString(),
      overallStatus: "critical",
      application: { status: "healthy" },
      database,
      outbox: { status: "unknown", pending: 0, processing: 0, failedRetrying: 0, deadLetter: 0, oldestPendingAgeMs: null },
      scheduler: { status: "unknown", lastAttemptAt: null, lastSuccessAt: null, lastError: null, ageMs: null },
      accounting: { status: "unknown", failedPostingEvents: 0, deadLetterPostingEvents: 0 },
      backup: { status: "unknown", configured: false, lastAttemptAt: null, lastSuccessAt: null, lastError: null, ageMs: null },
      authentication: { status: "unknown", recentFailedStaffLogins: 0, recentFailedPortalLogins: 0, recentThrottledAttempts: 0, windowMinutes: AUTH_ABUSE_WINDOW_MS / 60_000 },
    }
  }

  const [outboxGrouped, oldestPending, jobStates, accountingGrouped, authWindow] = await Promise.all([
    db.outboxEvent.groupBy({ by: ["status"], _count: true }),
    db.outboxEvent.findFirst({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    listJobStates(["outbox_sweep", "backup"]),
    db.outboxEvent.groupBy({ by: ["status"], where: { eventType: { in: [...ACCOUNTING_EVENT_TYPES] } }, _count: true }),
    (async () => {
      const since = new Date(Date.now() - AUTH_ABUSE_WINDOW_MS)
      const [staffFailed, portalFailed, throttled] = await Promise.all([
        db.loginHistory.count({ where: { channel: "staff", success: false, createdAt: { gte: since } } }),
        db.loginHistory.count({ where: { channel: "portal", success: false, createdAt: { gte: since } } }),
        db.loginHistory.count({ where: { reason: "ip_throttled", createdAt: { gte: since } } }),
      ])
      return { staffFailed, portalFailed, throttled }
    })(),
  ])

  const outboxCounts = Object.fromEntries(outboxGrouped.map((g) => [g.status, g._count])) as Record<string, number>
  const oldestPendingAgeMs = oldestPending ? Date.now() - oldestPending.createdAt.getTime() : null
  let outboxStatus: StatusLevel = "healthy"
  if ((outboxCounts.dead_letter ?? 0) > 0) outboxStatus = "critical"
  else if (oldestPendingAgeMs !== null && oldestPendingAgeMs > OUTBOX_BACKLOG_CRITICAL_MS) outboxStatus = "critical"
  else if (oldestPendingAgeMs !== null && oldestPendingAgeMs > OUTBOX_BACKLOG_WARNING_MS) outboxStatus = "warning"

  const outbox: OperationalHealthSummary["outbox"] = {
    status: outboxStatus,
    pending: outboxCounts.pending ?? 0,
    processing: outboxCounts.processing ?? 0,
    failedRetrying: outboxCounts.failed ?? 0,
    deadLetter: outboxCounts.dead_letter ?? 0,
    oldestPendingAgeMs,
  }

  const [schedulerState, backupState] = jobStates
  const schedulerAge = ageStatus(schedulerState?.lastSuccessAt ?? null, SCHEDULER_WARNING_MS, SCHEDULER_CRITICAL_MS)
  const scheduler: OperationalHealthSummary["scheduler"] = {
    status: schedulerState ? schedulerAge.status : "unknown",
    lastAttemptAt: schedulerState?.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: schedulerState?.lastSuccessAt?.toISOString() ?? null,
    lastError: schedulerState?.lastError ?? null,
    ageMs: schedulerAge.ageMs,
  }

  const accountingCounts = Object.fromEntries(accountingGrouped.map((g) => [g.status, g._count])) as Record<string, number>
  const accountingDeadLetter = accountingCounts.dead_letter ?? 0
  const accountingFailed = accountingCounts.failed ?? 0
  const accounting: OperationalHealthSummary["accounting"] = {
    status: accountingDeadLetter > 0 ? "critical" : accountingFailed > 0 ? "warning" : "healthy",
    failedPostingEvents: accountingFailed,
    deadLetterPostingEvents: accountingDeadLetter,
  }

  // P4.4 §49: a missing heartbeat row means backup has genuinely never run
  // (or the production scheduling job isn't configured at all) — reported
  // as "Not Configured / Unknown," never as a false "Healthy."
  const backupAge = ageStatus(backupState?.lastSuccessAt ?? null, BACKUP_WARNING_MS, BACKUP_CRITICAL_MS)
  const backup: OperationalHealthSummary["backup"] = {
    status: backupState ? backupAge.status : "unknown",
    configured: backupState !== null,
    lastAttemptAt: backupState?.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: backupState?.lastSuccessAt?.toISOString() ?? null,
    lastError: backupState?.lastError ?? null,
    ageMs: backupAge.ageMs,
  }

  const authTotalFailures = authWindow.staffFailed + authWindow.portalFailed
  let authStatus: StatusLevel = "healthy"
  if (authTotalFailures >= AUTH_ABUSE_CRITICAL_FAILURES || authWindow.throttled >= 5) authStatus = "critical"
  else if (authTotalFailures >= AUTH_ABUSE_WARNING_FAILURES || authWindow.throttled > 0) authStatus = "warning"
  const authentication: OperationalHealthSummary["authentication"] = {
    status: authStatus,
    recentFailedStaffLogins: authWindow.staffFailed,
    recentFailedPortalLogins: authWindow.portalFailed,
    recentThrottledAttempts: authWindow.throttled,
    windowMinutes: AUTH_ABUSE_WINDOW_MS / 60_000,
  }

  // P4.4 §45: the overall rollup is informational for the operations page —
  // it deliberately has no bearing on /api/health, which must not fail
  // merely because (say) one old dead-letter event exists while the app and
  // DB are otherwise perfectly usable.
  const overallStatus = [database.status, outbox.status, scheduler.status, accounting.status, backup.status, authentication.status].reduce(
    worse,
    "healthy" as StatusLevel
  )

  return {
    generatedAt: new Date().toISOString(),
    overallStatus,
    application: { status: "healthy" },
    database,
    outbox,
    scheduler,
    accounting,
    backup,
    authentication,
  }
}
