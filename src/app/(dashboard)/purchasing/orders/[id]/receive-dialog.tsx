"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createGoodsReceiptAction, type ActionState } from "@/app/(dashboard)/purchasing/actions"

const initialState: ActionState = {}

type OutstandingLine = {
  purchaseOrderLineId: string
  productId: string
  productName: string
  unit: string
  remaining: number
  unitCost: number
}

type ReceiveLine = {
  quantityReceived: string
  batchNumber: string
  manufacturingDate: string
  expiryDate: string
  unitCost: string
}

export function ReceiveDialog({ purchaseOrderId, outstandingLines }: { purchaseOrderId: string; outstandingLines: OutstandingLine[] }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createGoodsReceiptAction, initialState)
  const [lines, setLines] = useState<Record<string, ReceiveLine>>(
    Object.fromEntries(
      outstandingLines.map((l) => [
        l.purchaseOrderLineId,
        { quantityReceived: String(l.remaining), batchNumber: "", manufacturingDate: "", expiryDate: "", unitCost: String(l.unitCost) },
      ])
    )
  )

  function update(id: string, field: keyof ReceiveLine, value: string) {
    setLines((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }))
  }

  function handleSubmit(formData: FormData) {
    formData.set("purchaseOrderId", purchaseOrderId)
    const payload = outstandingLines
      .filter((l) => lines[l.purchaseOrderLineId]?.batchNumber && Number(lines[l.purchaseOrderLineId]?.quantityReceived) > 0)
      .map((l) => {
        const line = lines[l.purchaseOrderLineId]
        return {
          purchaseOrderLineId: l.purchaseOrderLineId,
          productId: l.productId,
          batchNumber: line.batchNumber,
          manufacturingDate: line.manufacturingDate || undefined,
          expiryDate: line.expiryDate || undefined,
          quantityReceived: Number(line.quantityReceived),
          unitCost: Number(line.unitCost),
        }
      })
    formData.set("lines", JSON.stringify(payload))
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Receive goods</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Receive goods</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4">
            {outstandingLines.map((l) => (
              <div key={l.purchaseOrderLineId} className="grid gap-2 rounded-md border border-border p-3">
                <p className="text-sm font-medium">
                  {l.productName} — {l.remaining} {l.unit} outstanding
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div className="grid gap-1">
                    <Label className="text-xs">Batch number</Label>
                    <Input value={lines[l.purchaseOrderLineId]?.batchNumber ?? ""} onChange={(e) => update(l.purchaseOrderLineId, "batchNumber", e.target.value)} />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Qty received</Label>
                    <Input
                      type="number"
                      min="0"
                      max={l.remaining}
                      value={lines[l.purchaseOrderLineId]?.quantityReceived ?? ""}
                      onChange={(e) => update(l.purchaseOrderLineId, "quantityReceived", e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Mfg date</Label>
                    <Input type="date" value={lines[l.purchaseOrderLineId]?.manufacturingDate ?? ""} onChange={(e) => update(l.purchaseOrderLineId, "manufacturingDate", e.target.value)} />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Expiry date</Label>
                    <Input type="date" value={lines[l.purchaseOrderLineId]?.expiryDate ?? ""} onChange={(e) => update(l.purchaseOrderLineId, "expiryDate", e.target.value)} />
                  </div>
                  <div className="grid gap-1">
                    <Label className="text-xs">Unit cost</Label>
                    <Input type="number" step="0.01" min="0" value={lines[l.purchaseOrderLineId]?.unitCost ?? ""} onChange={(e) => update(l.purchaseOrderLineId, "unitCost", e.target.value)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Leave a line&apos;s batch number blank to skip receiving it now.</p>
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Recording..." : "Record receipt"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
