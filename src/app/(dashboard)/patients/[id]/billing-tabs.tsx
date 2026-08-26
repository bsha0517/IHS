import Link from "next/link"
import { TabsContent } from "@/components/ui/tabs"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { can } from "@/lib/platform/permissions-core"
import { listPatientPackages } from "@/lib/domains/packages/service"
import { listPackages } from "@/lib/domains/packages/service"
import { listPatientInvoices } from "@/lib/domains/billing/invoices"
import { listPatientPayments } from "@/lib/domains/billing/payments"
import type { SessionContext } from "@/lib/auth/session"
import { SellPackageDialog } from "@/app/(dashboard)/patients/[id]/sell-package-dialog"
import { UseSessionDialog } from "@/app/(dashboard)/patients/[id]/use-session-dialog"

const INVOICE_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  issued: "outline",
  partially_paid: "secondary",
  paid: "default",
  void: "destructive",
}

export async function BillingTabs({
  session,
  patientId,
  branchId,
}: {
  session: SessionContext
  patientId: string
  branchId: string
}) {
  const [patientPackages, invoices, payments, catalogPackages] = await Promise.all([
    listPatientPackages(session, patientId),
    listPatientInvoices(session, patientId),
    listPatientPayments(session, patientId),
    can(session, "package.sell") ? listPackages(session) : Promise.resolve([]),
  ])

  const canSell = can(session, "package.sell")
  const canConsume = can(session, "package.consume")
  const packageOptions = catalogPackages
    .filter((p) => p.isActive)
    .map((p) => ({ id: p.id, name: p.name, price: Number(p.price) }))

  return (
    <>
      <TabsContent value="packages">
        <Card>
          <CardContent className="grid gap-4 pt-6">
            {canSell && (
              <div className="flex justify-end">
                <SellPackageDialog patientId={patientId} branchId={branchId} packages={packageOptions} />
              </div>
            )}
            {patientPackages.length === 0 && <p className="text-sm text-muted-foreground">No packages purchased.</p>}
            {patientPackages.map((pp) => (
              <div key={pp.id} className="rounded-md border border-border p-3 text-sm">
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-medium">{pp.package.name}</p>
                  <div className="flex items-center gap-2">
                    <Badge variant={pp.status === "active" ? "default" : "secondary"}>{pp.status}</Badge>
                    <span className="text-xs text-muted-foreground">
                      Purchased {formatDate(pp.purchasedAt)}
                      {pp.expiresAt && ` · Expires ${formatDate(pp.expiresAt)}`}
                    </span>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  {pp.remaining.map((r) => (
                    <div key={r.packageServiceId} className="flex items-center justify-between">
                      <span>
                        {r.serviceName}: {r.allocated - r.used} of {r.allocated} remaining
                      </span>
                      {canConsume && pp.status === "active" && r.allocated - r.used > 0 && (
                        <UseSessionDialog
                          patientId={patientId}
                          patientPackageId={pp.id}
                          packageServiceId={r.packageServiceId}
                          serviceName={r.serviceName}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="invoices">
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Outstanding</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No invoices yet.
                    </TableCell>
                  </TableRow>
                )}
                {invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>
                      <Link href={`/invoices/${inv.id}`} className="hover:underline">
                        {inv.invoiceNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDateTime(inv.createdAt)}</TableCell>
                    <TableCell>{Number(inv.totalAmount).toFixed(2)}</TableCell>
                    <TableCell>{(Number(inv.totalAmount) - Number(inv.paidAmount)).toFixed(2)}</TableCell>
                    <TableCell>
                      <Badge variant={INVOICE_STATUS_VARIANT[inv.status] ?? "outline"}>{inv.status.replace("_", " ")}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="payments">
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No payments yet.
                    </TableCell>
                  </TableRow>
                )}
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.receiptNumber}</TableCell>
                    <TableCell>
                      {p.allocations.map((a) => (
                        <Link key={a.id} href={`/invoices/${a.invoiceId}`} className="hover:underline">
                          {a.invoice.invoiceNumber}
                        </Link>
                      ))}
                    </TableCell>
                    <TableCell className="capitalize">{p.method}</TableCell>
                    <TableCell>{Number(p.amount).toFixed(2)}</TableCell>
                    <TableCell>{formatDateTime(p.receivedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </TabsContent>
    </>
  )
}
