import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listInvoices } from "@/lib/domains/billing/invoices"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  issued: "outline",
  partially_paid: "secondary",
  paid: "default",
  void: "destructive",
}

export default async function InvoicesPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "invoice.view")) redirect("/dashboard")

  const invoices = await listInvoices(session)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
        <p className="text-sm text-muted-foreground">{invoices.length} invoice(s)</p>
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Outstanding</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No invoices yet.
                  </TableCell>
                </TableRow>
              )}
              {invoices.map((inv) => (
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
                  <TableCell>{formatDateTime(inv.createdAt)}</TableCell>
                  <TableCell>{Number(inv.totalAmount).toFixed(2)}</TableCell>
                  <TableCell>{(Number(inv.totalAmount) - Number(inv.paidAmount)).toFixed(2)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[inv.status] ?? "outline"}>{inv.status.replace("_", " ")}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
