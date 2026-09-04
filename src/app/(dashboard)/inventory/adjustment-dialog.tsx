"use client"

import { useState } from "react"
import { SquarePen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { recordAdjustmentAction, type ActionState } from "@/app/(dashboard)/inventory/actions"

const initialState: ActionState = {}

type BatchOption = {
  id: string
  batchNumber: string
  balance: number
  expiryLabel: string
  isExpired: boolean
}

/**
 * P2 §5: batch-aware by construction now — batchId is required for a
 * reduction (from `batches`, including expired ones so expired stock can
 * actually be written off, which the FEFO-allocatable pool deliberately
 * excludes) and, for an addition, the user explicitly chooses between
 * adding to an existing batch or creating a new one; there's no path
 * through this form that produces a batch-less ledger entry. See
 * recordAdjustment's own doc comment (stock.ts) for the server-side half
 * of this — every field here is re-validated there, never trusted as-is.
 */
export function AdjustmentDialog({
  branchId,
  productId,
  productName,
  batches,
}: {
  branchId: string
  productId: string
  productName: string
  batches: BatchOption[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(recordAdjustmentAction, initialState)
  const [direction, setDirection] = useState<"in" | "out">("in")
  const [inBatchMode, setInBatchMode] = useState<"existing" | "new">(batches.length > 0 ? "existing" : "new")

  const reducibleBatches = batches.filter((b) => b.balance > 0)

  function handleDirectionChange(value: string) {
    setDirection(value as "in" | "out")
    setInBatchMode(batches.length > 0 ? "existing" : "new")
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setDirection("in")
      setInBatchMode(batches.length > 0 ? "existing" : "new")
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Adjust stock">
          <SquarePen className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust stock — {productName}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="branchId" value={branchId} />
          <input type="hidden" name="productId" value={productId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="direction">Direction</Label>
              <Select name="direction" value={direction} onValueChange={handleDirectionChange}>
                <SelectTrigger id="direction" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in">Stock in</SelectItem>
                  <SelectItem value="out">Stock out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="transactionType">Type</Label>
              <Select name="transactionType" defaultValue="adjustment">
                <SelectTrigger id="transactionType" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="adjustment">Adjustment</SelectItem>
                  <SelectItem value="damage">Damage</SelectItem>
                  <SelectItem value="expiry">Expiry</SelectItem>
                  <SelectItem value="return">Return</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {direction === "out" ? (
            <div className="grid gap-2">
              <Label htmlFor="batchId">Batch</Label>
              <Select name="batchId" required>
                <SelectTrigger id="batchId" className="w-full">
                  <SelectValue placeholder={reducibleBatches.length === 0 ? "No batches with stock" : "Select a batch"} />
                </SelectTrigger>
                <SelectContent>
                  {reducibleBatches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.batchNumber} — {b.balance} on hand — {b.isExpired ? `EXPIRED ${b.expiryLabel}` : b.expiryLabel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {reducibleBatches.length === 0 && (
                <p className="text-xs text-muted-foreground">This product has no batch with stock at this branch — nothing to remove.</p>
              )}
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-2">
                <Label htmlFor="inBatchMode">Batch</Label>
                <Select value={inBatchMode} onValueChange={(v) => setInBatchMode(v as "existing" | "new")}>
                  <SelectTrigger id="inBatchMode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="existing" disabled={batches.length === 0}>
                      Add to existing batch
                    </SelectItem>
                    <SelectItem value="new">Create new batch</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {inBatchMode === "existing" ? (
                <div className="grid gap-2">
                  <Label htmlFor="batchId">Existing batch</Label>
                  <Select name="batchId" required>
                    <SelectTrigger id="batchId" className="w-full">
                      <SelectValue placeholder="Select a batch" />
                    </SelectTrigger>
                    <SelectContent>
                      {batches.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.batchNumber} — {b.balance} on hand — {b.isExpired ? `EXPIRED ${b.expiryLabel}` : b.expiryLabel}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2 col-span-2">
                    <Label htmlFor="newBatchNumber">New batch number</Label>
                    <Input id="newBatchNumber" name="newBatchNumber" required placeholder="e.g. LOT-2026-014" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="newBatchManufacturingDate">Manufactured</Label>
                    <Input id="newBatchManufacturingDate" name="newBatchManufacturingDate" type="date" />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="newBatchExpiryDate">Expires</Label>
                    <Input id="newBatchExpiryDate" name="newBatchExpiryDate" type="date" />
                  </div>
                  <div className="grid gap-2 col-span-2">
                    <Label htmlFor="newBatchPurchaseCost">Unit cost (optional)</Label>
                    <Input id="newBatchPurchaseCost" name="newBatchPurchaseCost" type="number" step="0.01" min="0" placeholder="Defaults to the product's cost" />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="quantity">Quantity</Label>
            <Input id="quantity" name="quantity" type="number" step="0.001" min="0.001" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reason">Reason</Label>
            <Textarea id="reason" name="reason" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reference">Reference (optional)</Label>
            <Input id="reference" name="reference" placeholder="e.g. count sheet #, damage report #" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Record adjustment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
