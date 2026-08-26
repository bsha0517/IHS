"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createLabTestAction, updateLabTestAction, type ActionState } from "@/app/(dashboard)/laboratory/actions"

const initialState: ActionState = {}

type ExistingTest = {
  id: string
  code: string
  name: string
  category: string
  specimenType: string
  resultType: "numeric" | "text"
  unit: string | null
  referenceRangeLow: number | null
  referenceRangeHigh: number | null
  referenceRangeText: string | null
  price: number
  turnaroundHours: number | null
}

export function LabTestDialog({ existing }: { existing?: ExistingTest }) {
  const action = existing ? updateLabTestAction : createLabTestAction
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
            <Plus /> New test
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit lab test" : "New lab test"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="labTestId" value={existing.id} />}
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="code">Code</Label>
              <Input id="code" name="code" defaultValue={existing?.code} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={existing?.name} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="category">Category</Label>
              <Input id="category" name="category" defaultValue={existing?.category} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="specimenType">Specimen type</Label>
              <Input id="specimenType" name="specimenType" placeholder="blood" defaultValue={existing?.specimenType} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="resultType">Result type</Label>
              <Select name="resultType" defaultValue={existing?.resultType ?? "numeric"} required>
                <SelectTrigger id="resultType" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="numeric">Numeric</SelectItem>
                  <SelectItem value="text">Text</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="unit">Unit</Label>
              <Input id="unit" name="unit" placeholder="mg/dL" defaultValue={existing?.unit ?? ""} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="referenceRangeLow">Reference low</Label>
              <Input id="referenceRangeLow" name="referenceRangeLow" type="number" step="0.001" defaultValue={existing?.referenceRangeLow ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="referenceRangeHigh">Reference high</Label>
              <Input id="referenceRangeHigh" name="referenceRangeHigh" type="number" step="0.001" defaultValue={existing?.referenceRangeHigh ?? ""} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="referenceRangeText">Reference text (for text-result tests)</Label>
            <Input id="referenceRangeText" name="referenceRangeText" placeholder="Negative" defaultValue={existing?.referenceRangeText ?? ""} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="price">Price</Label>
              <Input id="price" name="price" type="number" min="0" step="0.01" defaultValue={existing?.price} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="turnaroundHours">Turnaround (hours)</Label>
              <Input id="turnaroundHours" name="turnaroundHours" type="number" min="0" defaultValue={existing?.turnaroundHours ?? ""} />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : existing ? "Save changes" : "Create test"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
