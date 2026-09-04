import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { getPayment } from "@/lib/domains/billing/payments"
import { getOrganizationIdentity } from "@/lib/domains/identity/org-structure"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { formatDateTime } from "@/lib/utils/dates"
import { PrintButton } from "@/app/prescriptions/[id]/print/print-button"

// P3.7 §21: a payment previously had no receipt destination of its own —
// only the parent Invoice could be printed, which shows every payment ever
// applied to it rather than the one transaction a patient just handed cash
// or a card for. Deliberately outside the (dashboard) route group — no
// chrome — matching the exact convention every other print view in this
// codebase (prescriptions/lab/radiology/invoice) already established. Uses
// the same minimal `getOrganizationIdentity` read those pages do, never
// `settings.view`.
export default async function PaymentReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const { id } = await params
  // Targeted backlog closure, item 4 — see loadOrNotFound's own doc comment.
  const [payment, organization] = await Promise.all([loadOrNotFound(() => getPayment(session, id)), getOrganizationIdentity(session)])
  // A payment is allocated against one or more invoices (schema supports
  // many, current UI only ever produces one) — the receipt shows each
  // allocation's own invoice number and that invoice's own remaining
  // balance, never a single flattened figure that could misrepresent a
  // multi-invoice allocation.
  const allocations = payment.allocations

  return (
    <div className="mx-auto max-w-md p-8 print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <div className="border-b border-border pb-4 text-center">
        <h1 className="text-xl font-semibold">{organization.displayName}</h1>
        <p className="text-sm text-muted-foreground">Payment Receipt</p>
      </div>

      <div className="grid gap-1 border-b border-border py-4 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Receipt #</span>
          <span className="font-medium">{payment.receiptNumber}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Date/time</span>
          <span>{formatDateTime(payment.receivedAt)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Method</span>
          <span className="capitalize">{payment.method}</span>
        </div>
        {payment.reference && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Reference</span>
            <span>{payment.reference}</span>
          </div>
        )}
      </div>

      {allocations.map((a) => {
        const balance = Number(a.invoice.totalAmount) - Number(a.invoice.paidAmount)
        return (
          <div key={a.id} className="grid gap-1 border-b border-border py-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Patient</span>
              <span className="font-medium">
                {a.invoice.patient.firstName} {a.invoice.patient.lastName} ({a.invoice.patient.mrn})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Invoice #</span>
              <span>{a.invoice.invoiceNumber}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Amount paid</span>
              <span>{Number(a.amount).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Remaining balance</span>
              <span>{balance.toFixed(2)}</span>
            </div>
          </div>
        )
      })}

      <p className="pt-4 text-center text-xs text-muted-foreground">Thank you.</p>
    </div>
  )
}
