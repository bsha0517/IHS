import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listOutstandingInvoices } from "@/lib/domains/billing/invoices"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

export default async function ReceivablesPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "accounting.view")) redirect("/dashboard")

  const invoices = await listOutstandingInvoices(session)
  const totalOutstanding = invoices.reduce((sum, inv) => sum + (Number(inv.totalAmount) - Number(inv.paidAmount)), 0)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Receivables</h1>
        <p className="text-sm text-muted-foreground">
          {invoices.length} outstanding invoice(s) — {totalOutstanding.toFixed(2)} owed
        </p>
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
        </CardContent>
      </Card>
    </div>
  )
}
