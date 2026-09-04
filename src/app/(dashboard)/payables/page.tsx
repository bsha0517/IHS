import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listOutstandingSupplierInvoices } from "@/lib/domains/procurement/supplier-invoices"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { RecordPaymentDialog } from "@/app/(dashboard)/purchasing/record-payment-dialog"
import { PaginationControls } from "@/components/domain/pagination-controls"

export default async function PayablesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "accounting.view")) redirect("/dashboard")

  const canPay = can(session, "supplier_invoice.manage")
  const sp = await searchParams
  const { invoices, total, totalOutstanding, page, totalPages } = await listOutstandingSupplierInvoices(session, {
    page: sp.page ? Number(sp.page) : undefined,
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Payables" description={`${total} outstanding supplier invoice(s) — ${totalOutstanding.toFixed(2)} owed`} />

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    No outstanding payables.
                  </TableCell>
                </TableRow>
              )}
              {invoices.map((inv) => {
                // P3.9 §27: was `amount - paidAmount`, omitting tax — the real AP
                // obligation is amount + taxAmount (P1 §15), matching
                // recordSupplierPayment's own outstanding-balance guard.
                const outstanding = Number(inv.amount) + Number(inv.taxAmount) - Number(inv.paidAmount)
                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                    <TableCell>{inv.supplier.companyName}</TableCell>
                    <TableCell>{inv.dueDate ? formatDate(inv.dueDate) : "—"}</TableCell>
                    <TableCell className="text-right">{Number(inv.amount).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(inv.taxAmount) > 0 ? Number(inv.taxAmount).toFixed(2) : "—"}</TableCell>
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
          <PaginationControls page={page} totalPages={totalPages} total={total} basePath="/payables" searchParams={sp} />
        </CardContent>
      </Card>
    </div>
  )
}
