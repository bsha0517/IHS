"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createAssetAction, updateAssetAction, type ActionState } from "@/app/(dashboard)/assets/actions"

const initialState: ActionState = {}

type ExistingAsset = {
  id: string
  branchId: string
  departmentId: string | null
  barcode: string | null
  name: string
  category: string
  manufacturer: string | null
  model: string | null
  serialNumber: string | null
  assignedEmployeeId: string | null
  supplierId: string | null
  purchaseDate: string | null
  cost: number | null
  warrantyExpiryDate: string | null
}

export function AssetDialog({
  branches,
  departments,
  employees,
  suppliers,
  existing,
}: {
  branches: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  employees: { id: string; firstName: string; lastName: string }[]
  suppliers: { id: string; companyName: string }[]
  existing?: ExistingAsset
}) {
  const action = existing ? updateAssetAction : createAssetAction
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
            <Plus /> New asset
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit asset" : "New asset"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="assetId" value={existing.id} />}
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={existing?.name} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="category">Category</Label>
              <Input id="category" name="category" defaultValue={existing?.category} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="branchId">Branch</Label>
              <Select name="branchId" defaultValue={existing?.branchId} required>
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
              <Label htmlFor="departmentId">Department</Label>
              <Select name="departmentId" defaultValue={existing?.departmentId ?? undefined}>
                <SelectTrigger id="departmentId" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="manufacturer">Manufacturer</Label>
              <Input id="manufacturer" name="manufacturer" defaultValue={existing?.manufacturer ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="model">Model</Label>
              <Input id="model" name="model" defaultValue={existing?.model ?? ""} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="serialNumber">Serial number</Label>
              <Input id="serialNumber" name="serialNumber" defaultValue={existing?.serialNumber ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="barcode">Barcode</Label>
              <Input id="barcode" name="barcode" defaultValue={existing?.barcode ?? ""} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="assignedEmployeeId">Assigned employee</Label>
              <Select name="assignedEmployeeId" defaultValue={existing?.assignedEmployeeId ?? undefined}>
                <SelectTrigger id="assignedEmployeeId" className="w-full">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.firstName} {e.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="supplierId">Supplier</Label>
              <Select name="supplierId" defaultValue={existing?.supplierId ?? undefined}>
                <SelectTrigger id="supplierId" className="w-full">
                  <SelectValue placeholder="None" />
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
          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="purchaseDate">Purchase date</Label>
              <Input id="purchaseDate" name="purchaseDate" type="date" defaultValue={existing?.purchaseDate ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cost">Cost</Label>
              <Input id="cost" name="cost" type="number" min="0" step="0.01" defaultValue={existing?.cost ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="warrantyExpiryDate">Warranty expiry</Label>
              <Input id="warrantyExpiryDate" name="warrantyExpiryDate" type="date" defaultValue={existing?.warrantyExpiryDate ?? ""} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : existing ? "Save changes" : "Create asset"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
