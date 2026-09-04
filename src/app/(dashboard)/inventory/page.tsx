import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listStockSummary, listNearExpiryBatches, listExpiredBatches, listLedgerEntries, listBatchSummaryByProduct } from "@/lib/domains/inventory/stock"
import { listTransfers } from "@/lib/domains/inventory/transfers"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { formatDate, formatDateTime, parseLocalDateParam } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/ui/page-header"
import { ProductDialog } from "@/app/(dashboard)/inventory/product-dialog"
import { AdjustmentDialog } from "@/app/(dashboard)/inventory/adjustment-dialog"
import { TransferDialog } from "@/app/(dashboard)/inventory/transfer-dialog"
import { TransferRowActions } from "@/app/(dashboard)/inventory/transfer-row-actions"
import { BranchSelector } from "@/app/(dashboard)/inventory/branch-selector"
import { LedgerFilters } from "@/app/(dashboard)/inventory/ledger-filters"
import { PaginationControls } from "@/components/domain/pagination-controls"

const TRANSACTION_TYPE_LABEL: Record<string, string> = {
  purchase: "Purchase",
  sale: "Sale",
  dispensing: "Dispensing",
  treatment_consumption: "Treatment consumption",
  adjustment: "Adjustment",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  damage: "Damage",
  expiry: "Expiry",
  return: "Return",
}

type InventorySearchParams = {
  page?: string
  transfersPage?: string
  activeBranchId?: string
  ledgerBranchId?: string
  ledgerProductId?: string
  ledgerType?: string
  ledgerFrom?: string
  ledgerTo?: string
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<InventorySearchParams>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "inventory.view")) redirect("/dashboard")
  const sp = await searchParams

  const [stock, nearExpiry, expired, transfersResult, branches] = await Promise.all([
    listStockSummary(session),
    listNearExpiryBatches(session),
    listExpiredBatches(session),
    listTransfers(session, { page: sp.transfersPage ? Number(sp.transfersPage) : undefined }),
    listAccessibleBranches(session),
  ])
  const { transfers, total: transferTotal, page: transferPage, totalPages: transferTotalPages } = transfersResult

  const canManageProduct = can(session, "product.manage")
  const canAdjust = can(session, "inventory.adjust")
  const canTransfer = can(session, "stock.transfer")

  // P3.8 §17: multi-branch users pick which branch adjustments target
  // (server already authorizes any session-accessible branch — see
  // recordAdjustment's `assertCan(...,{branchId})` — this was purely a UI
  // gap); single-branch users see no selector at all, just their one branch.
  // P3.12 §17: the ultimate fallback used to be `branches[0]` regardless of
  // the session's own preferred branch — inconsistent with the topbar's
  // global branch switcher (org-structure.ts's `setActiveBranch`) once
  // that existed. `session.activeBranchId` is checked before falling all
  // the way back to an arbitrary first branch.
  const preferredBranchId =
    session.activeBranchId && branches.some((b) => b.id === session.activeBranchId) ? session.activeBranchId : undefined
  const activeBranchId =
    (sp.activeBranchId && branches.some((b) => b.id === sp.activeBranchId) ? sp.activeBranchId : undefined) ??
    preferredBranchId ??
    branches[0]?.id ??
    ""
  const activeBranchName = branches.find((b) => b.id === activeBranchId)?.name

  const productOptions = stock.map((p) => ({ id: p.id, name: p.name, unit: p.unit }))
  const lowStockCount = stock.filter((p) => p.isLowStock).length

  // P2 §5: one batched fetch for every product's batches (2 queries total),
  // not one query per row's AdjustmentDialog — see listBatchSummaryByProduct's
  // own doc comment. Re-fetched for whichever branch is currently active.
  const batchesByProduct = canAdjust && activeBranchId
    ? await listBatchSummaryByProduct(session, stock.map((p) => p.id), activeBranchId)
    : new Map<string, { id: string; batchNumber: string; expiryDate: Date | null; balance: number }[]>()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inventory"
        description={`${stock.length} product(s)`}
        secondaryActions={
          canAdjust && branches.length > 1 ? (
            <BranchSelector branches={branches} activeBranchId={activeBranchId} />
          ) : (
            activeBranchName && (
              <Badge variant="outline" className="text-sm font-normal">
                Branch: {activeBranchName}
              </Badge>
            )
          )
        }
        primaryAction={canManageProduct && <ProductDialog />}
      />

      <Tabs defaultValue={sp.page || sp.transfersPage ? (sp.transfersPage ? "transfers" : "ledger") : "stock"}>
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
                    <TableHead>On hand (all branches)</TableHead>
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
                        {canAdjust && activeBranchId && (
                          <AdjustmentDialog
                            branchId={activeBranchId}
                            productId={p.id}
                            productName={p.name}
                            batches={(batchesByProduct.get(p.id) ?? []).map((b) => ({
                              id: b.id,
                              batchNumber: b.batchNumber,
                              balance: b.balance,
                              expiryLabel: b.expiryDate ? formatDate(b.expiryDate) : "No expiry",
                              isExpired: b.expiryDate ? b.expiryDate.getTime() < Date.now() : false,
                            }))}
                          />
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
                    Batch {batch.batchNumber} · {balance.toString()} units — write off via Adjust stock (Stock out) on the Stock tab
                  </span>
                  <Badge variant="destructive">Expired {formatDate(batch.expiryDate!)}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ledger" className="grid gap-4">
          <LedgerFilters branches={branches} products={productOptions} sp={sp} />
          <LedgerTable session={session} sp={sp} />
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
                    <TableHead>Batch</TableHead>
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
                      <TableCell colSpan={8} className="text-center text-muted-foreground">
                        No transfers yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {transfers.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>{t.product.name}</TableCell>
                      <TableCell>{t.batch?.batchNumber ?? "—"}</TableCell>
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
              <PaginationControls
                page={transferPage}
                totalPages={transferTotalPages}
                total={transferTotal}
                basePath="/inventory"
                searchParams={{ ...sp, transfersPage: String(transferPage) }}
                pageParam="transfersPage"
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

async function LedgerTable({
  session,
  sp,
}: {
  session: Awaited<ReturnType<typeof getCurrentSession>>
  sp: InventorySearchParams
}) {
  if (!session) return null
  const { entries, total, page: currentPage, totalPages } = await listLedgerEntries(session, {
    page: sp.page ? Number(sp.page) : undefined,
    branchId: sp.ledgerBranchId || undefined,
    productId: sp.ledgerProductId || undefined,
    transactionType: sp.ledgerType || undefined,
    // P4.7 §44/§45: was `new Date(sp.ledgerFrom)` (no time component — parsed
    // as UTC midnight, shifting the boundary by the server's own UTC offset)
    // and a `...T23:59:59.999Z` end boundary (same UTC-vs-local mismatch,
    // the opposite direction) — both replaced with the shared local-day
    // boundary helper every other date-range filter in this phase now uses.
    dateFrom: parseLocalDateParam(sp.ledgerFrom, "start"),
    dateTo: parseLocalDateParam(sp.ledgerTo, "end"),
  })
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
              <TableHead>Actor</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  No ledger entries match these filters.
                </TableCell>
              </TableRow>
            )}
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{formatDateTime(e.createdAt)}</TableCell>
                <TableCell>{e.product.name}</TableCell>
                <TableCell>{e.branch.name}</TableCell>
                <TableCell>{TRANSACTION_TYPE_LABEL[e.transactionType] ?? e.transactionType.replace("_", " ")}</TableCell>
                <TableCell className={Number(e.quantity) < 0 ? "text-destructive" : ""}>{Number(e.quantity)}</TableCell>
                <TableCell>{e.batch?.batchNumber ?? "—"}</TableCell>
                <TableCell>{e.actorName ?? "—"}</TableCell>
                <TableCell>{e.reason ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <PaginationControls
          page={currentPage}
          totalPages={totalPages}
          total={total}
          basePath="/inventory"
          searchParams={{ ...sp, page: String(currentPage) }}
        />
      </CardContent>
    </Card>
  )
}
