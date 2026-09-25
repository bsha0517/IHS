import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listPayments } from "@/lib/domains/billing/payments"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { PaginationControls } from "@/components/domain/pagination-controls"

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "payment.view")) redirect("/dashboard")

  const sp = await searchParams
  const { payments, total, page, totalPages } = await listPayments(session, { page: sp.page ? Number(sp.page) : undefined })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Payments" module="billing" description={`${total} payment(s)`} />

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No payments yet.
                  </TableCell>
                </TableRow>
              )}
              {payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.receiptNumber}</TableCell>
                  <TableCell>
                    {p.allocations.map((a) => (
                      <Link key={a.id} href={`/invoices/${a.invoiceId}`} className="hover:underline">
                        {a.invoice.invoiceNumber}
                      </Link>
                    ))}
                  </TableCell>
                  <TableCell>
                    {p.allocations[0]
                      ? `${p.allocations[0].invoice.patient.firstName} ${p.allocations[0].invoice.patient.lastName}`
                      : "—"}
                  </TableCell>
                  <TableCell className="capitalize">{p.method}</TableCell>
                  <TableCell>{Number(p.amount).toFixed(2)}</TableCell>
                  <TableCell>
                    <Badge variant={p.status === "completed" ? "default" : "destructive"}>{p.status}</Badge>
                  </TableCell>
                  <TableCell>{formatDateTime(p.receivedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={page} totalPages={totalPages} total={total} basePath="/payments" searchParams={sp} />
        </CardContent>
      </Card>
    </div>
  )
}
