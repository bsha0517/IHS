import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getInvoice } from "@/lib/domains/billing/invoices"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { getMyOpenSession } from "@/lib/domains/billing/cashier"
import { listPatientCoverage } from "@/lib/domains/claims/coverage"
import { formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RecordPaymentDialog } from "@/app/(dashboard)/invoices/[id]/record-payment-dialog"
import { RequestRefundDialog } from "@/app/(dashboard)/invoices/[id]/request-refund-dialog"
import { RefundActions } from "@/app/(dashboard)/invoices/[id]/refund-actions"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { CreateClaimDialog } from "@/app/(dashboard)/invoices/[id]/create-claim-dialog"
import { voidInvoiceAction } from "@/app/(dashboard)/invoices/actions"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  issued: "outline",
  partially_paid: "secondary",
  paid: "default",
  void: "destructive",
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "invoice.view")) redirect("/dashboard")

  const { id } = await params
  // Targeted backlog closure, item 4 — see loadOrNotFound's own doc comment.
  const [invoice, cashierSession] = await Promise.all([loadOrNotFound(() => getInvoice(session, id)), getMyOpenSession(session)])
  const coverages = can(session, "coverage.manage") ? await listPatientCoverage(session, invoice.patientId) : []

  const outstanding = Number(invoice.totalAmount) - Number(invoice.paidAmount)
  const coverageOptions = coverages
    .filter((c) => c.status === "active")
    .map((c) => ({ id: c.id, label: `${c.policy.insurancePlan.payor.name} — ${c.policy.insurancePlan.name} (${c.memberId})` }))
  const lineOptions = invoice.lines.map((l) => ({ id: l.id, description: l.description, lineTotal: Number(l.lineTotal) }))
  const payments = invoice.paymentAllocations.map((a) => ({
    id: a.payment.id,
    receiptNumber: a.payment.receiptNumber,
    method: a.payment.method,
    amount: Number(a.amount),
    receivedAt: a.payment.receivedAt,
    reference: a.payment.reference,
  }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{invoice.invoiceNumber}</h1>
          <p className="text-sm text-muted-foreground">
            <Link href={`/patients/${invoice.patientId}`} className="hover:underline">
              {invoice.patient.firstName} {invoice.patient.lastName}
            </Link>{" "}
            ({invoice.patient.mrn}) · {invoice.branch.name} · {formatDateTime(invoice.createdAt)}
            {invoice.provider && (
              <>
                {" "}
                · Dr. {invoice.provider.firstName} {invoice.provider.lastName}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[invoice.status] ?? "outline"} className="capitalize">
            {invoice.status.replace("_", " ")}
          </Badge>
          <Button asChild size="sm" variant="outline">
            <Link href={`/invoices/${invoice.id}/print`} target="_blank">
              Print
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Unit price</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead>Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>{line.description}</TableCell>
                  <TableCell>{line.quantity}</TableCell>
                  <TableCell>{Number(line.unitPrice).toFixed(2)}</TableCell>
                  <TableCell>{Number(line.taxAmount).toFixed(2)}</TableCell>
                  <TableCell>{Number(line.lineTotal).toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

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
            <div className="flex justify-between font-medium">
              <span>Total</span>
              <span>{Number(invoice.totalAmount).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Paid</span>
              <span>{Number(invoice.paidAmount).toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Outstanding</span>
              <span>{outstanding.toFixed(2)}</span>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {outstanding > 0 && invoice.status !== "void" && can(session, "payment.create") && (
              cashierSession ? (
                <RecordPaymentDialog invoiceId={invoice.id} cashierSessionId={cashierSession.id} outstanding={outstanding} />
              ) : (
                <p className="text-sm text-muted-foreground">Open a cashier register to record a payment.</p>
              )
            )}
            {Number(invoice.paidAmount) > 0 && can(session, "refund.request") && (
              <RequestRefundDialog invoiceId={invoice.id} paidAmount={Number(invoice.paidAmount)} payments={payments} />
            )}
            {Number(invoice.paidAmount) === 0 && invoice.status !== "void" && can(session, "invoice.void") && (
              <ReasonDialog
                triggerLabel="Void invoice"
                title="Void invoice"
                variant="destructive"
                action={voidInvoiceAction}
                args={[invoice.id]}
              />
            )}
            {/* P3.7 §26: the actual system rule — a paid/partially-paid
                invoice cannot be voided directly (billing/invoices.ts's own
                voidInvoice enforces this server-side); surfaced here so the
                rule is explained rather than the Void button just quietly
                not appearing. */}
            {Number(invoice.paidAmount) > 0 && invoice.status !== "void" && can(session, "invoice.void") && (
              <p className="w-full text-sm text-muted-foreground">
                This invoice has payments applied and cannot be voided directly — issue a refund for the paid amount first.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payments</CardTitle>
        </CardHeader>
        <CardContent>
          {payments.length === 0 && <p className="text-sm text-muted-foreground">No payments recorded.</p>}
          {payments.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.receiptNumber}</TableCell>
                    <TableCell className="capitalize">{p.method}</TableCell>
                    <TableCell>{p.reference ?? "—"}</TableCell>
                    <TableCell>{p.amount.toFixed(2)}</TableCell>
                    <TableCell>{formatDateTime(p.receivedAt)}</TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/payments/${p.id}/print`} target="_blank">
                          Receipt
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {can(session, "claim.create") && coverageOptions.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Insurance claims</CardTitle>
            {invoice.status !== "void" && <CreateClaimDialog invoiceId={invoice.id} coverages={coverageOptions} lines={lineOptions} />}
          </CardHeader>
          <CardContent>
            {invoice.claims.length === 0 && <p className="text-sm text-muted-foreground">No claims created for this invoice yet.</p>}
            {invoice.claims.length > 0 && (
              <div className="grid gap-2">
                {invoice.claims.map((c) => (
                  <Link
                    key={c.id}
                    href={`/claims/${c.id}`}
                    className="flex items-center justify-between rounded-md border border-border p-2 text-sm hover:bg-muted"
                  >
                    <span>{c.claimNumber}</span>
                    <span className="flex items-center gap-2">
                      {Number(c.submittedAmount).toFixed(2)}
                      <Badge variant={c.status === "remitted" ? "default" : c.status === "rejected" ? "destructive" : "outline"}>
                        {c.status}
                      </Badge>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {invoice.refunds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Refunds</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {invoice.refunds.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <div>
                  <p>
                    {r.refundNumber ? `${r.refundNumber} — ` : ""}
                    {Number(r.amount).toFixed(2)} via {r.method} — {r.reason}
                  </p>
                  <p className="text-xs text-muted-foreground">Requested {formatDateTime(r.requestedAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={r.status === "completed" ? "default" : r.status === "rejected" ? "destructive" : "outline"}>
                    {r.status}
                  </Badge>
                  {can(session, "refund.authorize") && (
                    <RefundActions
                      invoiceId={invoice.id}
                      refundId={r.id}
                      status={r.status}
                      cashierSessionId={cashierSession?.id}
                    />
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
