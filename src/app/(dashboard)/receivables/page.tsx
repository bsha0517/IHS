import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listOutstandingInvoices, getReceivablesAging } from "@/lib/domains/billing/invoices"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { PaginationControls } from "@/components/domain/pagination-controls"

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "accounting.view")) redirect("/dashboard")

  const sp = await searchParams
  const [{ invoices, total, totalOutstanding, page, totalPages }, aging] = await Promise.all([
    listOutstandingInvoices(session, { page: sp.page ? Number(sp.page) : undefined }),
    getReceivablesAging(session),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Receivables" description={`${total} outstanding invoice(s) — ${totalOutstanding.toFixed(2)} owed`} />

      {/* P3.9 §26: basic aging buckets — a small extension of the same outstanding-invoice
          population/total this page already shows, not a separate aging engine. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground">Current (0-30d)</p>
            <p className="text-lg font-semibold">{aging.current.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground">31-60 days</p>
            <p className="text-lg font-semibold">{aging.days31to60.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground">61-90 days</p>
            <p className="text-lg font-semibold">{aging.days61to90.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card className={aging.over90 > 0 ? "border-destructive/50" : undefined}>
          <CardContent className="pt-6">
            <p className="text-xs text-muted-foreground">Over 90 days</p>
            <p className={`text-lg font-semibold ${aging.over90 > 0 ? "text-destructive" : ""}`}>{aging.over90.toFixed(2)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No outstanding invoices.
                  </TableCell>
                </TableRow>
              )}
              {invoices.map((inv) => {
                const outstanding = Number(inv.totalAmount) - Number(inv.paidAmount)
                return (
                  <TableRow key={inv.id}>
                    <TableCell>
                      <Link href={`/invoices/${inv.id}`} className="font-medium hover:underline">
                        {inv.invoiceNumber}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {inv.patient.firstName} {inv.patient.lastName}
                    </TableCell>
                    <TableCell>{inv.branch.name}</TableCell>
                    <TableCell>{formatDate(inv.issuedAt)}</TableCell>
                    <TableCell className="text-right">{Number(inv.totalAmount).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(inv.paidAmount).toFixed(2)}</TableCell>
                    <TableCell className="text-right font-medium">{outstanding.toFixed(2)}</TableCell>
                    <TableCell>
                      <Badge variant={inv.status === "partially_paid" ? "secondary" : "outline"}>{inv.status.replace("_", " ")}</Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <PaginationControls page={page} totalPages={totalPages} total={total} basePath="/receivables" searchParams={sp} />
        </CardContent>
      </Card>
    </div>
  )
}
