import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listStockSummary, listNearExpiryBatches, listExpiredBatches, listLedgerEntries } from "@/lib/domains/inventory/stock"
import { listTransfers } from "@/lib/domains/inventory/transfers"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { formatDate, formatDateTime } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProductDialog } from "@/app/(dashboard)/inventory/product-dialog"
import { AdjustmentDialog } from "@/app/(dashboard)/inventory/adjustment-dialog"
import { TransferDialog } from "@/app/(dashboard)/inventory/transfer-dialog"
import { TransferRowActions } from "@/app/(dashboard)/inventory/transfer-row-actions"

export default async function InventoryPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "inventory.view")) redirect("/dashboard")

  const [stock, nearExpiry, expired, transfers, branches] = await Promise.all([
    listStockSummary(session),
    listNearExpiryBatches(session),
    listExpiredBatches(session),
    listTransfers(session),
    listAccessibleBranches(session),
  ])

  const canManageProduct = can(session, "product.manage")
  const canAdjust = can(session, "inventory.adjust")
  const canTransfer = can(session, "stock.transfer")
  const defaultBranchId = branches[0]?.id ?? ""
  const productOptions = stock.map((p) => ({ id: p.id, name: p.name, unit: p.unit }))
  const lowStockCount = stock.filter((p) => p.isLowStock).length

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-sm text-muted-foreground">{stock.length} product(s)</p>
        </div>
        {canManageProduct && <ProductDialog />}
      </div>

      <Tabs defaultValue="stock">
        <TabsList>
          <TabsTrigger value="stock">Stock{lowStockCount > 0 && ` (${lowStockCount} low)`}</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
        </TabsList>

        <TabsContent value="stock">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>On hand</TableHead>
                    <TableHead>Reorder level</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stock.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        No products yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {stock.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.sku}</TableCell>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>{p.category}</TableCell>
                      <TableCell>
                        {p.balance} {p.unit}
                      </TableCell>
                      <TableCell>{p.reorderLevel}</TableCell>
                      <TableCell>
                        {p.isOutOfStock ? (
                          <Badge variant="destructive">out of stock</Badge>
                        ) : p.isLowStock ? (
                          <Badge variant="secondary">low stock</Badge>
                        ) : (
                          <Badge variant="outline">ok</Badge>
                        )}
                      </TableCell>
                      <TableCell className="flex items-center gap-1">
                        {canAdjust && defaultBranchId && (
                          <AdjustmentDialog branchId={defaultBranchId} productId={p.id} productName={p.name} />
                        )}
                        {canManageProduct && (
                          <ProductDialog
                            existing={{
                              id: p.id,
                              sku: p.sku,
                              barcode: p.barcode,
                              name: p.name,
                              category: p.category,
                              brand: p.brand,
                              unit: p.unit,
                              purchaseCost: Number(p.purchaseCost),
                              sellingPrice: p.sellingPrice ? Number(p.sellingPrice) : null,
                              reorderLevel: p.reorderLevel,
                              minimumStock: p.minimumStock,
                              maximumStock: p.maximumStock,
                            }}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="alerts" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Near expiry (next 90 days)</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {nearExpiry.length === 0 && <p className="text-sm text-muted-foreground">Nothing near expiry.</p>}
              {nearExpiry.map(({ batch, balance }) => (
                <div key={batch.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                  <span>
                    Batch {batch.batchNumber} · {balance.toString()} units
                  </span>
                  <Badge variant="secondary">Expires {formatDate(batch.expiryDate!)}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Expired</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {expired.length === 0 && <p className="text-sm text-muted-foreground">No expired stock on hand.</p>}
              {expired.map(({ batch, balance }) => (
                <div key={batch.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                  <span>
                    Batch {batch.batchNumber} · {balance.toString()} units
                  </span>
                  <Badge variant="destructive">Expired {formatDate(batch.expiryDate!)}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ledger">
          <LedgerTable session={session} />
        </TabsContent>

        <TabsContent value="transfers" className="grid gap-4">
          {canTransfer && (
            <div className="flex justify-end">
              <TransferDialog branches={branches} products={productOptions} />
            </div>
          )}
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Quantity</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transfers.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        No transfers yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {transfers.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>{t.product.name}</TableCell>
                      <TableCell>{t.fromBranch.name}</TableCell>
                      <TableCell>{t.toBranch.name}</TableCell>
                      <TableCell>{Number(t.quantity)}</TableCell>
                      <TableCell>
                        <Badge variant={t.status === "completed" ? "default" : t.status === "cancelled" ? "destructive" : "outline"}>
                          {t.status.replace("_", " ")}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDateTime(t.requestedAt)}</TableCell>
                      <TableCell>
                        {canTransfer && (t.status === "pending" || t.status === "in_transit") && (
                          <TransferRowActions transferId={t.id} />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

async function LedgerTable({ session }: { session: Awaited<ReturnType<typeof getCurrentSession>> }) {
  if (!session) return null
  const entries = await listLedgerEntries(session)
  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Quantity</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No ledger entries yet.
                </TableCell>
              </TableRow>
            )}
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{formatDateTime(e.createdAt)}</TableCell>
                <TableCell>{e.product.name}</TableCell>
                <TableCell>{e.branch.name}</TableCell>
                <TableCell className="capitalize">{e.transactionType.replace("_", " ")}</TableCell>
                <TableCell className={Number(e.quantity) < 0 ? "text-destructive" : ""}>{Number(e.quantity)}</TableCell>
                <TableCell>{e.batch?.batchNumber ?? "—"}</TableCell>
                <TableCell>{e.reason ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
