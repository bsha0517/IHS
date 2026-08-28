import { redirect } from "next/navigation"
import Link from "next/link"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listSystemEvents } from "@/lib/platform/system-events"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RetryButton } from "@/app/(dashboard)/admin/system-events/retry-button"
import { SweepButton } from "@/app/(dashboard)/admin/system-events/sweep-button"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  processing: "secondary",
  completed: "outline",
  failed: "default",
  dead_letter: "destructive",
}

export default async function SystemEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "system_events.view")) {
    redirect("/dashboard")
  }

  const { page: pageParam, status } = await searchParams
  const page = Math.max(1, Number(pageParam ?? 1) || 1)
  const { events, total, totalPages } = await listSystemEvents(session, { status, page })
  const canRetry = can(session, "system_events.retry")

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System Events</h1>
          <p className="text-sm text-muted-foreground">
            The background outbox that wires domain events (invoice posting, commission accrual, notifications, ...) to
            their handlers. A financial or operational event that fails after 3 attempts lands here as{" "}
            <span className="font-medium">dead_letter</span> and notifies every admin — nothing fails silently. An
            event stuck in <span className="font-medium">processing</span> (a crashed or killed process) is
            automatically recovered once it&apos;s been stuck longer than the configured processing timeout.
          </p>
        </div>
        {canRetry && <SweepButton />}
      </div>

      <div className="flex gap-2">
        {["", "pending", "failed", "dead_letter", "completed"].map((s) => (
          <Button key={s || "all"} variant={status === s || (!status && !s) ? "default" : "outline"} size="sm" asChild>
            <Link href={s ? `/admin/system-events?status=${s}` : "/admin/system-events"}>{s || "All"}</Link>
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Events</CardTitle>
          <CardDescription>{total} total</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Last attempt</TableHead>
                <TableHead>Next retry</TableHead>
                {canRetry && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canRetry ? 8 : 7} className="text-center text-muted-foreground">
                    No events in this status.
                  </TableCell>
                </TableRow>
              )}
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-medium">
                    {event.eventType}
                    <div className="text-xs text-muted-foreground">#{event.id.slice(0, 8)}</div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{event.attempts}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[event.status] ?? "outline"}>{event.status}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={event.lastError ?? undefined}>
                    {event.lastError ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {event.lastAttemptAt ? new Date(event.lastAttemptAt).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {event.nextRetryAt ? new Date(event.nextRetryAt).toLocaleString() : "—"}
                  </TableCell>
                  {canRetry && (
                    <TableCell>
                      {(event.status === "failed" || event.status === "dead_letter") && <RetryButton eventId={event.id} />}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
                {page > 1 ? (
                  <Link href={`/admin/system-events?page=${page - 1}${status ? `&status=${status}` : ""}`}>Previous</Link>
                ) : (
                  <span>Previous</span>
                )}
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} asChild={page < totalPages}>
                {page < totalPages ? (
                  <Link href={`/admin/system-events?page=${page + 1}${status ? `&status=${status}` : ""}`}>Next</Link>
                ) : (
                  <span>Next</span>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
