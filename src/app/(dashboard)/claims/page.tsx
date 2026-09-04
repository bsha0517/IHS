import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listClaims } from "@/lib/domains/claims/service"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { PaginationControls } from "@/components/domain/pagination-controls"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  submitted: "secondary",
  adjudicated: "secondary",
  rejected: "destructive",
  remitted: "default",
  void: "destructive",
}

export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "claim.create")) redirect("/dashboard")

  const sp = await searchParams
  const { claims, total, page, totalPages } = await listClaims(session, { page: sp.page ? Number(sp.page) : undefined })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Claims" description={`${total} claim(s)`} />

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Claim #</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Payor</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead className="text-right">Submitted</TableHead>
                <TableHead className="text-right">Approved</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {claims.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No claims yet.
                  </TableCell>
                </TableRow>
              )}
              {claims.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link href={`/claims/${c.id}`} className="font-medium hover:underline">
                      {c.claimNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {c.patient.firstName} {c.patient.lastName}
                  </TableCell>
                  <TableCell>{c.payor.name}</TableCell>
                  <TableCell>
                    <Link href={`/invoices/${c.invoice.id}`} className="hover:underline">
                      {c.invoice.invoiceNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">{Number(c.submittedAmount).toFixed(2)}</TableCell>
                  <TableCell className="text-right">{c.approvedAmount != null ? Number(c.approvedAmount).toFixed(2) : "—"}</TableCell>
                  <TableCell>{formatDate(c.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[c.status] ?? "outline"}>{c.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={page} totalPages={totalPages} total={total} basePath="/claims" searchParams={sp} />
        </CardContent>
      </Card>
    </div>
  )
}
