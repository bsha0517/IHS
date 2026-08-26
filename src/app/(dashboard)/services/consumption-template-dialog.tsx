"use client"

import { useState } from "react"
import { Boxes, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { setServiceConsumptionAction, type ActionState } from "@/app/(dashboard)/services/actions"

const initialState: ActionState = {}

type Line = { productId: string; quantityPerUnit: string }

export function ConsumptionTemplateDialog({
  serviceId,
  serviceName,
  products,
  existing,
}: {
  serviceId: string
  serviceName: string
  products: { id: string; name: string; unit: string }[]
  existing: { productId: string; quantityPerUnit: number }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(setServiceConsumptionAction, initialState)
  const [lines, setLines] = useState<Line[]>(
    existing.length > 0
      ? existing.map((l) => ({ productId: l.productId, quantityPerUnit: String(l.quantityPerUnit) }))
      : [{ productId: "", quantityPerUnit: "1" }]
  )

  function update(index: number, field: keyof Line, value: string) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }

  function handleSubmit(formData: FormData) {
    formData.set(
      "lines",
      JSON.stringify(
        lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantityPerUnit: Number(l.quantityPerUnit) }))
      )
    )
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Consumption template">
          <Boxes className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Consumption template — {serviceName}</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          <input type="hidden" name="serviceId" value={serviceId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">
            Products automatically deducted from stock each time this service is billed.
          </p>

          <div className="grid gap-2">
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
                <Input
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="Qty"
                  value={line.quantityPerUnit}
                  onChange={(e) => update(index, "quantityPerUnit", e.target.value)}
                />
                {lines.length > 1 && (
                  <Button type="button" size="icon-sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLines((prev) => [...prev, { productId: "", quantityPerUnit: "1" }])}
            >
              <Plus /> Add product
            </Button>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
