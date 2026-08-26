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
import { createPurchaseRequestAction, type ActionState } from "@/app/(dashboard)/purchasing/actions"

const initialState: ActionState = {}

type Line = { productId: string; quantity: string }

export function NewRequestDialog({
  branches,
  products,
}: {
  branches: { id: string; name: string }[]
  products: { id: string; name: string; unit: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createPurchaseRequestAction, initialState)
  const [lines, setLines] = useState<Line[]>([{ productId: "", quantity: "1" }])

  function update(index: number, field: keyof Line, value: string) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }

  function handleSubmit(formData: FormData) {
    formData.set(
      "lines",
      JSON.stringify(lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })))
    )
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New request
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New purchase request</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="branchId">Branch</Label>
            <Select name="branchId" required>
              <SelectTrigger id="branchId" className="w-full">
                <SelectValue placeholder="Select a branch" />
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
            <Label className="text-xs">Products</Label>
            {lines.map((line, index) => (
              <div key={index} className="grid grid-cols-[1fr_100px_auto] items-end gap-2">
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
                {lines.length > 1 && (
                  <Button type="button" size="icon-sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, { productId: "", quantity: "1" }])}>
              <Plus /> Add product
            </Button>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Submitting..." : "Submit request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
