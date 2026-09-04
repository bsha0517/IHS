"use client"

import { useEffect, useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createTransferAction, listAvailableBatchesForTransferAction, type ActionState } from "@/app/(dashboard)/inventory/actions"

const initialState: ActionState = {}

type BatchOption = { id: string; batchNumber: string; balance: number; expiryDate: string | null }

/**
 * P3.8 §20-25: batch selection is now mandatory and driven by the real
 * available (non-expired, non-zero-balance) batches at the chosen source
 * branch — fetched via listAvailableBatchesForTransferAction, the same FEFO
 * candidate pool consumeStock allocates from, never a fabricated batch id.
 * Refetches whenever "From branch" or "Product" changes; the batch selector
 * is disabled until both are chosen.
 */
export function TransferDialog({
  branches,
  products,
}: {
  branches: { id: string; name: string }[]
  products: { id: string; name: string; unit: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createTransferAction, initialState)
  const [fromBranchId, setFromBranchId] = useState("")
  const [productId, setProductId] = useState("")
  const [batchId, setBatchId] = useState("")
  const [batches, setBatches] = useState<BatchOption[]>([])
  const [loadingBatches, setLoadingBatches] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)

  // The batch list is entirely a function of (fromBranchId, productId) — an
  // external fetch to synchronize with, the case useEffect is actually for.
  // batchId's own reset lives in the two Select onValueChange handlers below
  // instead (a direct response to the user's own action, not a value this
  // effect needs to own) so the effect body itself never calls setState
  // synchronously — only from inside the async fetch's own callbacks.
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!fromBranchId || !productId) {
        if (!cancelled) setBatches([])
        return
      }
      setLoadingBatches(true)
      setBatchError(null)
      try {
        const result = await listAvailableBatchesForTransferAction(fromBranchId, productId)
        if (!cancelled) setBatches(result)
      } catch (e) {
        if (!cancelled) setBatchError(e instanceof Error ? e.message : "Failed to load batches.")
      } finally {
        if (!cancelled) setLoadingBatches(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [fromBranchId, productId])

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setFromBranchId("")
      setProductId("")
      setBatchId("")
      setBatches([])
    }
  }

  const selectedBatch = batches.find((b) => b.id === batchId)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> New transfer
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New stock transfer</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="batchId" value={batchId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="fromBranchId">From branch</Label>
              <Select
                name="fromBranchId"
                required
                value={fromBranchId}
                onValueChange={(v) => {
                  setFromBranchId(v)
                  setBatchId("")
                }}
              >
                <SelectTrigger id="fromBranchId" className="w-full">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="toBranchId">To branch</Label>
              <Select name="toBranchId" required>
                <SelectTrigger id="toBranchId" className="w-full">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {branches
                    .filter((b) => b.id !== fromBranchId)
                    .map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="productId">Product</Label>
            <Select
              name="productId"
              required
              value={productId}
              onValueChange={(v) => {
                setProductId(v)
                setBatchId("")
              }}
            >
              <SelectTrigger id="productId" className="w-full">
                <SelectValue placeholder="Select a product" />
              </SelectTrigger>
              <SelectContent>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.unit})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="batchIdSelect">Source batch</Label>
            <Select
              name="batchIdSelect"
              required
              disabled={!fromBranchId || !productId || loadingBatches}
              value={batchId}
              onValueChange={setBatchId}
            >
              <SelectTrigger id="batchIdSelect" className="w-full">
                <SelectValue
                  placeholder={
                    !fromBranchId || !productId
                      ? "Choose a from branch and product first"
                      : loadingBatches
                        ? "Loading batches..."
                        : batches.length === 0
                          ? "No available (non-expired) batches at this branch"
                          : "Select a batch"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {batches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.batchNumber} — {b.balance} on hand — {b.expiryDate ? `expires ${new Date(b.expiryDate).toLocaleDateString()}` : "no expiry"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {batchError && <p className="text-xs text-destructive">{batchError}</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="quantity">Quantity</Label>
            <Input
              id="quantity"
              name="quantity"
              type="number"
              step="0.001"
              min="0.001"
              max={selectedBatch?.balance}
              required
            />
            {selectedBatch && <p className="text-xs text-muted-foreground">Up to {selectedBatch.balance} available in this batch.</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending || !batchId}>
              {pending ? "Creating..." : "Create transfer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
