import Link from "next/link"
import { listSupportTicketsForPlatform } from "@/lib/domains/commercial/support-tickets"
import { listOrganizationsForPlatform } from "@/lib/domains/commercial/organizations"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import { PageHeader } from "@/components/ui/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge } from "@/components/ui/status-badge"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty-state"
import { formatDateTime } from "@/lib/utils/dates"
import { NewTicketDialog } from "@/app/platform/tickets/new-ticket-dialog"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"
import type { $Enums } from "@/generated/prisma/client"

const STATUSES: $Enums.SupportTicketStatus[] = ["open", "in_progress", "waiting_on_customer", "resolved", "closed"]

export default async function PlatformTicketsPage({ searchParams }: { searchParams: Promise<{ organizationId?: string; status?: string }> }) {
  const sp = await searchParams
  await requirePlatformOperator()
  const status = sp.status && (STATUSES as string[]).includes(sp.status) ? (sp.status as $Enums.SupportTicketStatus) : undefined

  const [tickets, { organizations }] = await Promise.all([
    listSupportTicketsForPlatform({ organizationId: sp.organizationId, status }),
    listOrganizationsForPlatform({ pageSize: 100 }),
  ])

  return (
    <PlatformPageShell>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Support Tickets"
          module="platform"
          description={`${tickets.length} ticket(s)${sp.organizationId ? " for this organization" : ""}`}
          primaryAction={<NewTicketDialog organizations={organizations.map((o) => ({ id: o.id, displayName: o.displayName }))} defaultOrganizationId={sp.organizationId} />}
        />

        <div className="flex flex-wrap gap-2">
          <Link href="/platform/tickets" className={!sp.status ? "font-semibold underline" : "text-muted-foreground"}>
            All
          </Link>
          {STATUSES.map((s) => (
            <Link
              key={s}
              href={`/platform/tickets?status=${s}${sp.organizationId ? `&organizationId=${sp.organizationId}` : ""}`}
              className={sp.status === s ? "font-semibold underline" : "text-muted-foreground"}
            >
              {s.replace(/_/g, " ")}
            </Link>
          ))}
        </div>

        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ticket</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState title="No support tickets" className="border-none" />
                    </TableCell>
                  </TableRow>
                )}
                {tickets.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link href={`/platform/tickets/${t.id}`} className="hover:underline">
                        <div className="font-mono text-xs">{t.ticketNumber}</div>
                        <div className="font-medium">{t.title}</div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/platform/organizations/${t.organization.id}`} className="hover:underline">
                        {t.organization.displayName}
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
    </PlatformPageShell>
  )
}
