import Link from "next/link"
import { CreditCard } from "lucide-react"
import { TabsContent } from "@/components/ui/tabs"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { can } from "@/lib/platform/permissions-core"
import { listPatientPackages } from "@/lib/domains/packages/service"
import { listPackages } from "@/lib/domains/packages/service"
import { listPatientInvoices } from "@/lib/domains/billing/invoices"
import { listPatientPayments } from "@/lib/domains/billing/payments"
import type { getPatientStatement } from "@/lib/domains/billing/statement"
import type { SessionContext } from "@/lib/auth/session"
import { SellPackageDialog } from "@/app/(dashboard)/patients/[id]/sell-package-dialog"
import { UseSessionDialog } from "@/app/(dashboard)/patients/[id]/use-session-dialog"

const INVOICE_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  issued: "outline",
  partially_paid: "secondary",
  paid: "default",
  void: "destructive",
}

/**
 * P3.2 §7/§21: `listPatientPackages` needs `service.view`, `listPatientInvoices`
 * needs `invoice.view`, `listPatientPayments` needs `payment.view`, and the
 * parent-fetched `statement` (see patients/[id]/page.tsx) needs both
 * `invoice.view` and `payment.view` — all were previously called
 * unconditionally from inside this component. Per the seeded role
 * permission sets, Doctor, Nurse, Laboratory Technician, Pharmacist, and
 * Radiology Technician hold none of these despite holding `patient.view`,
 * so every one of them hit a thrown `ForbiddenError` here with no catch
 * anywhere in the tree — the whole Patient 360 page failed for the majority
 * of clinical roles, not just the Billing tabs. Gated the same way
 * InsuranceTabs already guards `coverage.manage`.
 */
export async function BillingTabs({
  session,
  patientId,
  branchId,
  statement,
  canViewStatement,
}: {
  session: SessionContext
  patientId: string
  branchId: string
  // P3.2 §6/§9/§28: fetched once by the parent page (patients/[id]/page.tsx)
  // so the same statement also powers the Overview tab's financial
  // snapshot — passed down instead of fetched a second time here.
  statement: Awaited<ReturnType<typeof getPatientStatement>> | null
  canViewStatement: boolean
}) {
  const canConsume = can(session, "package.consume")
  // Doctor/Nurse hold package.consume (system-roles.ts) but not
  // service.view — without this, the only UI entry point for consuming a
  // package session (UseSessionDialog below) is unreachable by the sole
  // roles authorized to use it, since the whole Packages tab content was
  // gated behind service.view alone.
  const canViewPackages = can(session, "service.view") || canConsume
  const canViewInvoices = can(session, "invoice.view")
  const canViewPayments = can(session, "payment.view")
  const canSell = can(session, "package.sell")
  const canCollectPayment = can(session, "invoice.create")

  const [patientPackages, invoices, payments, catalogPackages] = await Promise.all([
    canViewPackages ? listPatientPackages(session, patientId) : Promise.resolve([]),
    canViewInvoices ? listPatientInvoices(session, patientId) : Promise.resolve([]),
    canViewPayments ? listPatientPayments(session, patientId) : Promise.resolve([]),
    canSell ? listPackages(session) : Promise.resolve([]),
  ])

  const packageOptions = catalogPackages
    .filter((p) => p.isActive)
    .map((p) => ({ id: p.id, name: p.name, price: Number(p.price) }))

  return (
    <>
      <TabsContent value="packages">
        <Card>
          <CardContent className="grid gap-4 pt-6">
            {!canViewPackages && <p className="text-sm text-muted-foreground">You don&apos;t have permission to view packages.</p>}
            {canSell && (
              <div className="flex justify-end">
                <SellPackageDialog patientId={patientId} branchId={branchId} packages={packageOptions} />
              </div>
            )}
            {canViewPackages && patientPackages.length === 0 && <p className="text-sm text-muted-foreground">No packages purchased.</p>}
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
            {!canViewInvoices && <p className="text-sm text-muted-foreground">You don&apos;t have permission to view invoices.</p>}
            {canViewInvoices && (
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
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="payments">
        <Card>
          <CardContent className="pt-6">
            {!canViewPayments && <p className="text-sm text-muted-foreground">You don&apos;t have permission to view payments.</p>}
            {canViewPayments && (
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
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="statement">
        <Card>
          <CardContent className="grid gap-4 pt-6">
            {!canViewStatement && <p className="text-sm text-muted-foreground">You don&apos;t have permission to view the billing statement.</p>}
            {canViewStatement && statement && (
            <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
              <div>
                <p className="text-sm text-muted-foreground">Outstanding balance</p>
                <p className="text-xl font-semibold">{statement.outstandingBalance.toFixed(2)}</p>
              </div>
              <div className="flex items-center gap-2">
                {!statement.reconciled && (
                  <Badge variant="destructive">Running balance does not reconcile — contact support</Badge>
                )}
                {/* P3.2: closes a real workflow dead end — seeing "this patient
                    owes money" here previously had no path to actually collect
                    it without leaving the page and re-searching for the same
                    patient at POS. `/pos` already supports pre-selecting a
                    patient via ?patientId=; this was simply never linked to. */}
                {canCollectPayment && statement.outstandingBalance > 0 && (
                  <Button size="sm" asChild>
                    <Link href={`/pos?patientId=${patientId}`}>
                      <CreditCard /> Collect payment
                    </Link>
                  </Button>
                )}
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Charge</TableHead>
                  <TableHead>Credit</TableHead>
                  <TableHead>Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statement.lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No billing activity yet.
                    </TableCell>
                  </TableRow>
                )}
                {statement.lines.map((line, i) => (
                  <TableRow key={`${line.type}-${line.referenceId}-${i}`}>
                    <TableCell>{formatDateTime(line.date)}</TableCell>
                    <TableCell>
                      {line.type === "invoice" ? (
                        <Link href={`/invoices/${line.referenceId}`} className="hover:underline">
                          {line.description}
                        </Link>
                      ) : (
                        line.description
                      )}
                    </TableCell>
                    <TableCell>{line.charge > 0 ? line.charge.toFixed(2) : "—"}</TableCell>
                    <TableCell>{line.credit > 0 ? line.credit.toFixed(2) : "—"}</TableCell>
                    <TableCell className="font-medium">{line.runningBalance.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </>
  )
}
