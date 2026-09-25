import { getCurrentSession } from "@/lib/auth/session"
import { assertCan } from "@/lib/platform/permissions-core"
import { getSupportTicketForClinic } from "@/lib/domains/commercial/support-tickets"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { DetailHeader } from "@/components/ui/page-header"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { formatDateTime } from "@/lib/utils/dates"
import { ReplyForm } from "@/app/(dashboard)/support/[id]/reply-form"
import { redirect } from "next/navigation"

export default async function SupportTicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  assertCan(session, "support_ticket.manage")

  const ticket = await loadOrNotFound(() => getSupportTicketForClinic(session, id))

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader
        module="support"
        title={ticket.title}
        meta={`${ticket.ticketNumber} · ${formatDateTime(ticket.createdAt)}`}
        badge={<StatusBadge status={ticket.status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Description</CardTitle>
        </CardHeader>
        <CardContent className="text-sm whitespace-pre-wrap">{ticket.description}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conversation</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {ticket.notes.length === 0 && <p className="text-sm text-muted-foreground">No replies yet.</p>}
          {ticket.notes.map((n) => (
            <div key={n.id} className="grid gap-1 rounded-md border border-border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <Badge variant={n.authorUserId ? "outline" : "info"}>{n.authorUserId ? "Your clinic" : "Avant support"}</Badge>
                <span className="text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap">{n.body}</p>
            </div>
          ))}
          <ReplyForm ticketId={ticket.id} />
        </CardContent>
      </Card>
    </div>
  )
}
