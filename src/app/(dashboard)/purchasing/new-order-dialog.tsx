"use client"

import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createPurchaseOrderAction, type ActionState } from "@/app/(dashboard)/purchasing/actions"

const initialState: ActionState = {}

type Line = { productId: string; quantity: string; unitCost: string }

type ApprovedRequest = {
  id: string
  requestNumber: string
  branchId: string
  lines: { productId: string; quantity: number }[]
}

export function NewOrderDialog({
  branches,
  suppliers,
  products,
  approvedRequests,
}: {
  branches: { id: string; name: string }[]
  suppliers: { id: string; companyName: string }[]
  products: { id: string; name: string; unit: string; purchaseCost: number }[]
  approvedRequests: ApprovedRequest[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createPurchaseOrderAction, initialState)
  const [lines, setLines] = useState<Line[]>([{ productId: "", quantity: "1", unitCost: "0" }])
  const [branchId, setBranchId] = useState("")
  const [purchaseRequestId, setPurchaseRequestId] = useState("")

  function update(index: number, field: keyof Line, value: string) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }

  function applyRequest(requestId: string) {
    setPurchaseRequestId(requestId)
    const request = approvedRequests.find((r) => r.id === requestId)
    if (!request) return
    setBranchId(request.branchId)
    setLines(
      request.lines.map((l) => {
        const product = products.find((p) => p.id === l.productId)
        return { productId: l.productId, quantity: String(l.quantity), unitCost: String(product?.purchaseCost ?? 0) }
      })
    )
  }

  function handleSubmit(formData: FormData) {
    formData.set(
      "lines",
      JSON.stringify(
        lines
          .filter((l) => l.productId)
          .map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitCost: Number(l.unitCost) }))
      )
    )
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New order
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New purchase order</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          <input type="hidden" name="purchaseRequestId" value={purchaseRequestId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          {approvedRequests.length > 0 && (
            <div className="grid gap-2">
              <Label>From approved request (optional)</Label>
              <Select value={purchaseRequestId} onValueChange={applyRequest}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="None — build manually" />
                </SelectTrigger>
                <SelectContent>
                  {approvedRequests.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.requestNumber}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="branchId">Branch</Label>
              <Select name="branchId" value={branchId} onValueChange={setBranchId} required>
                <SelectTrigger id="branchId" className="w-full">
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
              <Label htmlFor="supplierId">Supplier</Label>
              <Select name="supplierId" required>
                <SelectTrigger id="supplierId" className="w-full">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.companyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label className="text-xs">Products</Label>
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-[1fr_80px_90px_auto] items-end gap-2">
                <Select value={line.productId} onValueChange={(v) => update(index, "productId", v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Product" />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.unit})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input type="number" min="1" placeholder="Qty" value={line.quantity} onChange={(e) => update(index, "quantity", e.target.value)} />
                <Input type="number" step="0.01" min="0" placeholder="Cost" value={line.unitCost} onChange={(e) => update(index, "unitCost", e.target.value)} />
                {lines.length > 1 && (
                  <Button type="button" size="icon-sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, { productId: "", quantity: "1", unitCost: "0" }])}>
              <Plus /> Add product
            </Button>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="expectedDeliveryDate">Expected delivery</Label>
            <Input id="expectedDeliveryDate" name="expectedDeliveryDate" type="date" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Issue order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
