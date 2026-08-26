import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listSupplierInvoices } from "@/lib/domains/procurement/supplier-invoices"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { RecordPaymentDialog } from "@/app/(dashboard)/purchasing/record-payment-dialog"

export default async function PayablesPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "accounting.view")) redirect("/dashboard")

  const canPay = can(session, "supplier_invoice.manage")
  const allInvoices = await listSupplierInvoices(session)
  const invoices = allInvoices.filter((inv) => inv.status === "pending" || inv.status === "partially_paid")
  const totalOutstanding = invoices.reduce((sum, inv) => sum + (Number(inv.amount) - Number(inv.paidAmount)), 0)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payables</h1>
        <p className="text-sm text-muted-foreground">
          {invoices.length} outstanding supplier invoice(s) — {totalOutstanding.toFixed(2)} owed
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No outstanding payables.
                  </TableCell>
                </TableRow>
              )}
              {invoices.map((inv) => {
                const outstanding = Number(inv.amount) - Number(inv.paidAmount)
                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                    <TableCell>{inv.supplier.companyName}</TableCell>
                    <TableCell>{inv.dueDate ? formatDate(inv.dueDate) : "—"}</TableCell>
                    <TableCell className="text-right">{Number(inv.amount).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(inv.paidAmount).toFixed(2)}</TableCell>
                    <TableCell className="text-right font-medium">{outstanding.toFixed(2)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{inv.status.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell>{canPay && <RecordPaymentDialog supplierInvoiceId={inv.id} outstanding={outstanding} />}</TableCell>
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
