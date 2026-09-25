import Link from "next/link"
import { listSupportTicketsForClinic } from "@/lib/domains/commercial/support-tickets"
import { getCurrentSession } from "@/lib/auth/session"
import { assertCan } from "@/lib/platform/permissions-core"
import { PageHeader } from "@/components/ui/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge } from "@/components/ui/status-badge"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty-state"
import { formatDateTime } from "@/lib/utils/dates"
import { NewClinicTicketDialog } from "@/app/(dashboard)/support/new-ticket-dialog"
import { redirect } from "next/navigation"

export default async function SupportPage() {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  assertCan(session, "support_ticket.manage")

  const tickets = await listSupportTicketsForClinic(session)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Support"
        module="support"
        description="Contact Avant's platform support team — never include patient or clinical information in a ticket."
        primaryAction={<NewClinicTicketDialog />}
      />

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticket</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="p-0">
                    <EmptyState title="No support tickets" description="Open a ticket if you need help from Avant support." className="border-none" />
                  </TableCell>
                </TableRow>
              )}
              {tickets.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link href={`/support/${t.id}`} className="hover:underline">
                      <div className="font-mono text-xs">{t.ticketNumber}</div>
                      <div className="font-medium">{t.title}</div>
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize">{t.category.replace(/_/g, " ")}</TableCell>
                  <TableCell>
                    <Badge variant={t.priority === "critical" ? "destructive" : t.priority === "high" ? "warning" : "outline"}>{t.priority}</Badge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell>{formatDateTime(t.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
