import { redirect } from "next/navigation"
import Link from "next/link"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getOperationalHealth, type StatusLevel } from "@/lib/platform/operational-health"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

const STATUS_LABEL: Record<StatusLevel, string> = {
  healthy: "Healthy",
  warning: "Warning",
  critical: "Critical",
  unknown: "Unknown",
}

const STATUS_VARIANT: Record<StatusLevel, "default" | "secondary" | "destructive" | "outline"> = {
  healthy: "outline",
  warning: "secondary",
  critical: "destructive",
  unknown: "secondary",
}

function StatusBadge({ status }: { status: StatusLevel }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "never"
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatTimestamp(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—"
}

/**
 * P4.4 §33-36: platform-wide infrastructure operations, not a business
 * dashboard — see operational-health.ts's own doc comment for why this is
 * deliberately NOT organization-scoped like `/admin/system-events` and
 * `/accounting/exceptions` (both linked below for org-scoped drill-down).
 * Gated on the same `system_events.view` permission those pages already
 * use — no new permission was introduced (P4.4 §51).
 */
export default async function OperationsPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "system_events.view")) {
    redirect("/dashboard")
  }

  const health = await getOperationalHealth(session)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
          <p className="text-sm text-muted-foreground">
            Platform-wide infrastructure status — application, database, the shared Outbox scheduler, backup, and
            authentication-abuse signals. Business-level queues (this organization&apos;s own outbox events, accounting
            exceptions) are linked below for detail; this page shows only safe aggregate counts, never patient or
            financial content.
          </p>
        </div>
        <StatusBadge status={health.overallStatus} />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Application</CardTitle>
              <StatusBadge status={health.application.status} />
            </div>
            <CardDescription>This instance is running and able to serve requests.</CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Database</CardTitle>
              <StatusBadge status={health.database.status} />
            </div>
            <CardDescription>
              {health.database.reachable ? `Reachable (${health.database.queryDurationMs}ms)` : "Unreachable"}
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Outbox</CardTitle>
              <StatusBadge status={health.outbox.status} />
            </div>
            <CardDescription>
              {health.outbox.pending} pending · {health.outbox.processing} processing · {health.outbox.failedRetrying} retrying ·{" "}
              {health.outbox.deadLetter} dead-letter
              {health.outbox.oldestPendingAgeMs !== null && (
                <> · oldest pending {formatAge(health.outbox.oldestPendingAgeMs)}</>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/admin/system-events" className="text-sm underline underline-offset-4">
              View this organization&apos;s events →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Scheduler</CardTitle>
              <StatusBadge status={health.scheduler.status} />
            </div>
            <CardDescription>
              {health.scheduler.lastSuccessAt
                ? `Last successful sweep: ${formatAge(health.scheduler.ageMs)} (${formatTimestamp(health.scheduler.lastSuccessAt)})`
                : "No successful sweep recorded yet — the outbox cron/scheduler may not be configured."}
              {health.scheduler.lastError && (
                <span className="mt-1 block text-xs text-destructive">Last error: {health.scheduler.lastError}</span>
              )}
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Accounting</CardTitle>
              <StatusBadge status={health.accounting.status} />
            </div>
            <CardDescription>
              {health.accounting.failedPostingEvents} failed/retrying · {health.accounting.deadLetterPostingEvents} dead-letter posting
              events across all organizations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/accounting" className="text-sm underline underline-offset-4">
              View this organization&apos;s accounting exceptions →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Backup</CardTitle>
              <StatusBadge status={health.backup.status} />
            </div>
            <CardDescription>
              {health.backup.configured
                ? `Last successful backup: ${formatAge(health.backup.ageMs)} (${formatTimestamp(health.backup.lastSuccessAt)})`
                : "Not configured — no backup has ever recorded a heartbeat in this environment."}
              {health.backup.lastError && (
                <span className="mt-1 block text-xs text-destructive">Last error: {health.backup.lastError}</span>
              )}
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Authentication</CardTitle>
              <StatusBadge status={health.authentication.status} />
            </div>
            <CardDescription>
              Last {health.authentication.windowMinutes} minutes: {health.authentication.recentFailedStaffLogins} failed staff logins,{" "}
              {health.authentication.recentFailedPortalLogins} failed portal logins, {health.authentication.recentThrottledAttempts}{" "}
              throttled attempts.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    </div>
  )
}
