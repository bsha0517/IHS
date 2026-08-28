import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listPurchaseRequests } from "@/lib/domains/procurement/purchase-requests"
import { listPurchaseOrders } from "@/lib/domains/procurement/purchase-orders"
import { listSupplierInvoices } from "@/lib/domains/procurement/supplier-invoices"
import { listSuppliers } from "@/lib/domains/procurement/suppliers"
import { listProducts } from "@/lib/domains/inventory/products"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { NewRequestDialog } from "@/app/(dashboard)/purchasing/new-request-dialog"
import { RequestActions } from "@/app/(dashboard)/purchasing/request-actions"
import { NewOrderDialog } from "@/app/(dashboard)/purchasing/new-order-dialog"
import { SupplierInvoiceDialog } from "@/app/(dashboard)/purchasing/supplier-invoice-dialog"
import { RecordPaymentDialog } from "@/app/(dashboard)/purchasing/record-payment-dialog"

const PO_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  issued: "outline",
  partially_received: "secondary",
  received: "default",
  cancelled: "destructive",
}

export default async function PurchasingPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "purchase_request.create")) redirect("/dashboard")

  const [requests, orders, invoices, suppliers, products, branches] = await Promise.all([
    listPurchaseRequests(session),
    listPurchaseOrders(session),
    can(session, "supplier_invoice.manage") ? listSupplierInvoices(session) : Promise.resolve([]),
    can(session, "purchase_order.create") ? listSuppliers(session) : Promise.resolve([]),
    listProducts(session),
    listAccessibleBranches(session),
  ])

  const canApprove = can(session, "purchase_request.approve")
  const canCreateOrder = can(session, "purchase_order.create")
  const canManageInvoices = can(session, "supplier_invoice.manage")

  const approvedRequests = requests
    .filter((r) => r.status === "approved")
    .map((r) => ({
      id: r.id,
      requestNumber: r.requestNumber,
      branchId: r.branchId,
      lines: r.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
    }))
  const productOptions = products.map((p) => ({ id: p.id, name: p.name, unit: p.unit }))
  const productOptionsWithCost = products.map((p) => ({ id: p.id, name: p.name, unit: p.unit, purchaseCost: Number(p.purchaseCost) }))
  const supplierOptions = suppliers.map((s) => ({ id: s.id, companyName: s.companyName }))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Purchasing</h1>

      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">Purchase Requests</TabsTrigger>
          <TabsTrigger value="orders">Purchase Orders</TabsTrigger>
          {canManageInvoices && <TabsTrigger value="invoices">Supplier Invoices</TabsTrigger>}
        </TabsList>

        <TabsContent value="requests" className="grid gap-4">
          <div className="flex justify-end">
            <NewRequestDialog branches={branches} products={productOptions} />
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Lines</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No purchase requests yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {requests.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.requestNumber}</TableCell>
                      <TableCell>{r.branch.name}</TableCell>
                      <TableCell>{r.lines.map((l) => `${l.product.name} x${l.quantity}`).join(", ")}</TableCell>
                      <TableCell>
                        <Badge variant={r.status === "approved" ? "default" : r.status === "rejected" ? "destructive" : "outline"}>
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDate(r.createdAt)}</TableCell>
                      <TableCell>{canApprove && r.status === "submitted" && <RequestActions requestId={r.id} />}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orders" className="grid gap-4">
          {canCreateOrder && (
            <div className="flex justify-end">
              <NewOrderDialog branches={branches} suppliers={supplierOptions} products={productOptionsWithCost} approvedRequests={approvedRequests} />
            </div>
          )}
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>PO Number</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No purchase orders yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <Link href={`/purchasing/orders/${o.id}`} className="font-medium hover:underline">
                          {o.poNumber}
                        </Link>
                      </TableCell>
                      <TableCell>{o.supplier.companyName}</TableCell>
                      <TableCell>{o.branch.name}</TableCell>
                      <TableCell>
                        <Badge variant={PO_STATUS_VARIANT[o.status] ?? "outline"}>{o.status.replace("_", " ")}</Badge>
                      </TableCell>
                      <TableCell>{formatDateTime(o.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {canManageInvoices && (
          <TabsContent value="invoices" className="grid gap-4">
            <div className="flex justify-end">
              <SupplierInvoiceDialog branches={branches} suppliers={supplierOptions} />
            </div>
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Tax</TableHead>
                      <TableHead>Outstanding</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground">
                          No supplier invoices yet.
                        </TableCell>
                      </TableRow>
                    )}
                    {invoices.map((inv) => {
                      // Total AP obligation is amount + taxAmount (P1 §15) — matching
                      // what postSupplierInvoiceCreated actually credited to Accounts
                      // Payable, and what recordSupplierPayment's own outstanding-balance
                      // guard (supplier-invoices.ts) checks against.
                      const outstanding = Number(inv.amount) + Number(inv.taxAmount) - Number(inv.paidAmount)
                      return (
                        <TableRow key={inv.id}>
                          <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                          <TableCell>{inv.supplier.companyName}</TableCell>
                          <TableCell>{Number(inv.amount).toFixed(2)}</TableCell>
                          <TableCell>{Number(inv.taxAmount) > 0 ? Number(inv.taxAmount).toFixed(2) : "—"}</TableCell>
                          <TableCell>{outstanding.toFixed(2)}</TableCell>
                          <TableCell>
                            <Badge variant={inv.status === "paid" ? "default" : inv.status === "cancelled" ? "destructive" : "outline"}>
                              {inv.status.replace("_", " ")}
                            </Badge>
                          </TableCell>
                          <TableCell>{inv.dueDate ? formatDate(inv.dueDate) : "—"}</TableCell>
                          <TableCell>{outstanding > 0 && <RecordPaymentDialog supplierInvoiceId={inv.id} outstanding={outstanding} />}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
