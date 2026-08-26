import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getInvoice } from "@/lib/domains/billing/invoices"
import { getOrganization } from "@/lib/domains/identity/org-structure"
import { formatDate } from "@/lib/utils/dates"
import { PrintButton } from "@/app/prescriptions/[id]/print/print-button"

// Deliberately outside the (dashboard) route group — no sidebar/topbar chrome,
// per spec.md §82's "professional printable ... Invoice ... Receipt".
export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const { id } = await params
  const [invoice, organization] = await Promise.all([getInvoice(session, id), getOrganization(session)])

  return (
    <div className="mx-auto max-w-2xl p-8 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold">{organization.displayName}</h1>
        <p className="text-sm text-muted-foreground">
          Invoice {invoice.invoiceNumber} · {invoice.branch.name}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 border-b border-border py-4 text-sm">
        <div>
          <p className="text-muted-foreground">Patient</p>
          <p className="font-medium">
            {invoice.patient.firstName} {invoice.patient.lastName} ({invoice.patient.mrn})
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Date</p>
          <p className="font-medium">{formatDate(invoice.createdAt)}</p>
          {invoice.provider && (
            <p>
              Dr. {invoice.provider.firstName} {invoice.provider.lastName}
            </p>
          )}
        </div>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-2">Description</th>
            <th className="py-2">Qty</th>
            <th className="py-2">Unit price</th>
            <th className="py-2">Tax</th>
            <th className="py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.id} className="border-b border-border/50">
              <td className="py-2">{line.description}</td>
              <td className="py-2">{line.quantity}</td>
              <td className="py-2">{Number(line.unitPrice).toFixed(2)}</td>
              <td className="py-2">{Number(line.taxAmount).toFixed(2)}</td>
              <td className="py-2 text-right">{Number(line.lineTotal).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 ml-auto grid w-full max-w-xs gap-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span>{Number(invoice.subtotal).toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Discount</span>
          <span>-{Number(invoice.discountAmount).toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Tax</span>
          <span>{Number(invoice.taxAmount).toFixed(2)}</span>
        </div>
        <div className="flex justify-between border-t border-border pt-1 font-medium">
          <span>Total</span>
          <span>{Number(invoice.totalAmount).toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Paid</span>
          <span>{Number(invoice.paidAmount).toFixed(2)}</span>
        </div>
        <div className="flex justify-between font-medium">
          <span>Balance due</span>
          <span>{(Number(invoice.totalAmount) - Number(invoice.paidAmount)).toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}
