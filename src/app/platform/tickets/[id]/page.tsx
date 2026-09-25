import Link from "next/link"
import { getSupportTicketForPlatform } from "@/lib/domains/commercial/support-tickets"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { DetailHeader } from "@/components/ui/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDateTime } from "@/lib/utils/dates"
import { TicketStatusSelect } from "@/app/platform/tickets/[id]/status-select"
import { AddOperatorNoteDialog } from "@/app/platform/tickets/[id]/note-dialog"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"

export default async function PlatformTicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requirePlatformOperator()
  const ticket = await loadOrNotFound(() => getSupportTicketForPlatform(id))

  return (
    <PlatformPageShell>
      <div className="flex flex-col gap-6">
        <DetailHeader
          module="platform"
          title={ticket.title}
          meta={
            <>
              {ticket.ticketNumber} ·{" "}
              <Link href={`/platform/organizations/${ticket.organization.id}`} className="hover:underline">
                {ticket.organization.displayName}
              </Link>{" "}
              · {formatDateTime(ticket.createdAt)}
            </>
          }
          badge={<Badge variant={ticket.priority === "critical" ? "destructive" : ticket.priority === "high" ? "warning" : "outline"}>{ticket.priority}</Badge>}
          actions={
            <div className="flex items-center gap-2">
              <TicketStatusSelect ticketId={ticket.id} status={ticket.status} />
              <Button asChild size="sm" variant="outline">
                <Link href="/platform/tickets">Back to tickets</Link>
              </Button>
            </div>
          }
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Description</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{ticket.description}</CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Notes</CardTitle>
            <AddOperatorNoteDialog ticketId={ticket.id} />
          </CardHeader>
          <CardContent className="grid gap-2">
            {ticket.notes.length === 0 && <p className="text-sm text-muted-foreground">No notes yet.</p>}
            {ticket.notes.map((n) => (
              <div key={n.id} className="grid gap-1 rounded-md border border-border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={n.visibility === "customer" ? "info" : "neutral"}>{n.visibility === "customer" ? "Customer-visible" : "Internal only"}</Badge>
                  <span className="text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap">{n.body}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </PlatformPageShell>
  )
}
