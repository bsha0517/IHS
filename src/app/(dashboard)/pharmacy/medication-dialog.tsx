"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createMedicationAction, updateMedicationAction, type ActionState } from "@/app/(dashboard)/pharmacy/actions"

const initialState: ActionState = {}

type ExistingMedication = {
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
  genericName: string | null
  strength: string | null
  dosageForm: string
  route: string | null
  controlledSubstance: boolean
  requiresPrescription: boolean
}

export function MedicationDialog({ existing }: { existing?: ExistingMedication }) {
  const action = existing ? updateMedicationAction : createMedicationAction
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
            <Plus /> New medication
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit medication" : "New medication"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="medicationId" value={existing.id} />}
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
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={existing?.name} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="genericName">Generic name</Label>
              <Input id="genericName" name="genericName" defaultValue={existing?.genericName ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="strength">Strength</Label>
              <Input id="strength" name="strength" placeholder="500mg" defaultValue={existing?.strength ?? ""} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="dosageForm">Dosage form</Label>
              <Input id="dosageForm" name="dosageForm" placeholder="Tablet" defaultValue={existing?.dosageForm} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="route">Route</Label>
              <Input id="route" name="route" placeholder="Oral" defaultValue={existing?.route ?? ""} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="unit">Unit</Label>
              <Input id="unit" name="unit" placeholder="tablet" defaultValue={existing?.unit} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="brand">Brand</Label>
              <Input id="brand" name="brand" defaultValue={existing?.brand ?? ""} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="category">Category</Label>
              <Input id="category" name="category" defaultValue={existing?.category ?? "Medication"} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="barcode">Barcode</Label>
              <Input id="barcode" name="barcode" defaultValue={existing?.barcode ?? ""} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="purchaseCost">Purchase cost</Label>
              <Input id="purchaseCost" name="purchaseCost" type="number" min="0" step="0.01" defaultValue={existing?.purchaseCost} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sellingPrice">Selling price</Label>
              <Input id="sellingPrice" name="sellingPrice" type="number" min="0" step="0.01" defaultValue={existing?.sellingPrice ?? ""} />
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
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="requiresPrescription" defaultChecked={existing?.requiresPrescription ?? true} />
              Requires prescription
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox name="controlledSubstance" defaultChecked={existing?.controlledSubstance ?? false} />
              Controlled substance
            </label>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : existing ? "Save changes" : "Create medication"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
