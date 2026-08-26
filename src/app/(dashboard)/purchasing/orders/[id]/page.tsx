import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getPurchaseOrder } from "@/lib/domains/procurement/purchase-orders"
import { listGoodsReceipts } from "@/lib/domains/procurement/goods-receipts"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ReceiveDialog } from "@/app/(dashboard)/purchasing/orders/[id]/receive-dialog"
import { SupplierInvoiceDialog } from "@/app/(dashboard)/purchasing/supplier-invoice-dialog"
import { ReasonDialog } from "@/app/(dashboard)/invoices/[id]/reason-dialog"
import { cancelPurchaseOrderAction } from "@/app/(dashboard)/purchasing/actions"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  issued: "outline",
  partially_received: "secondary",
  received: "default",
  cancelled: "destructive",
}

export default async function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "purchase_order.create")) redirect("/dashboard")

  const { id } = await params
  const [po, receipts, branches] = await Promise.all([
    getPurchaseOrder(session, id),
    listGoodsReceipts(session, { purchaseOrderId: id }),
    listAccessibleBranches(session),
  ])

  const outstandingLines = po.lines
    .filter((l) => l.receivedQuantity < l.quantity)
    .map((l) => ({
      purchaseOrderLineId: l.id,
      productId: l.productId,
      productName: l.product.name,
      unit: l.product.unit,
      remaining: l.quantity - l.receivedQuantity,
      unitCost: Number(l.unitCost),
    }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{po.poNumber}</h1>
          <p className="text-sm text-muted-foreground">
            {po.supplier.companyName} · {po.branch.name} · {formatDateTime(po.createdAt)}
            {po.expectedDeliveryDate && ` · Expected ${formatDate(po.expectedDeliveryDate)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[po.status] ?? "outline"} className="capitalize">
            {po.status.replace("_", " ")}
          </Badge>
          {outstandingLines.length > 0 && po.status !== "cancelled" && (
            <ReceiveDialog purchaseOrderId={po.id} outstandingLines={outstandingLines} />
          )}
          <SupplierInvoiceDialog branches={branches} suppliers={[{ id: po.supplierId, companyName: po.supplier.companyName }]} purchaseOrderId={po.id} />
          {po.status !== "received" && po.status !== "cancelled" && (
            <ReasonDialog triggerLabel="Cancel" title="Cancel purchase order" variant="destructive" action={cancelPurchaseOrderAction} args={[po.id]} />
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Ordered</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Remaining</TableHead>
                <TableHead>Unit cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {po.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>{line.product.name}</TableCell>
                  <TableCell>{line.quantity}</TableCell>
                  <TableCell>{line.receivedQuantity}</TableCell>
                  <TableCell>{line.quantity - line.receivedQuantity}</TableCell>
                  <TableCell>{Number(line.unitCost).toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Goods receipts</CardTitle>
        </CardHeader>
        <CardContent>
          {receipts.length === 0 && <p className="text-sm text-muted-foreground">Nothing received yet.</p>}
          {receipts.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt #</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipts.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.receiptNumber}</TableCell>
                    <TableCell>{formatDateTime(r.receivedAt)}</TableCell>
                    <TableCell>{r.notes ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
