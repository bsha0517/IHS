"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createProductAction, updateProductAction, type ActionState } from "@/app/(dashboard)/inventory/actions"

const initialState: ActionState = {}

type ExistingProduct = {
  id: string
  sku: string
  barcode: string | null
  name: string
  category: string
  brand: string | null
  unit: string
  purchaseCost: number
  sellingPrice: number | null
  reorderLevel: number
  minimumStock: number
  maximumStock: number | null
}

export function ProductDialog({ existing }: { existing?: ExistingProduct }) {
  const action = existing ? updateProductAction : createProductAction
  const { open, setOpen, state, pending, submit } = useActionDialog(action, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {existing ? (
          <Button size="icon-sm" variant="ghost" aria-label="Edit">
            <Pencil className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm">
            <Plus /> New product
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit product" : "New product"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="productId" value={existing.id} />}
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="sku">SKU</Label>
              <Input id="sku" name="sku" defaultValue={existing?.sku} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="barcode">Barcode</Label>
              <Input id="barcode" name="barcode" defaultValue={existing?.barcode ?? ""} />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" defaultValue={existing?.name} required />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="category">Category</Label>
              <Input id="category" name="category" defaultValue={existing?.category} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="brand">Brand</Label>
              <Input id="brand" name="brand" defaultValue={existing?.brand ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="unit">Unit</Label>
              <Input id="unit" name="unit" placeholder="box, piece, ml" defaultValue={existing?.unit} required />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="purchaseCost">Purchase cost</Label>
              <Input id="purchaseCost" name="purchaseCost" type="number" step="0.01" min="0" defaultValue={existing?.purchaseCost ?? 0} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sellingPrice">Selling price</Label>
              <Input id="sellingPrice" name="sellingPrice" type="number" step="0.01" min="0" defaultValue={existing?.sellingPrice ?? ""} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="reorderLevel">Reorder level</Label>
              <Input id="reorderLevel" name="reorderLevel" type="number" min="0" defaultValue={existing?.reorderLevel ?? 0} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="minimumStock">Minimum stock</Label>
              <Input id="minimumStock" name="minimumStock" type="number" min="0" defaultValue={existing?.minimumStock ?? 0} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="maximumStock">Maximum stock</Label>
              <Input id="maximumStock" name="maximumStock" type="number" min="0" defaultValue={existing?.maximumStock ?? ""} />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : existing ? "Save changes" : "Create product"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
