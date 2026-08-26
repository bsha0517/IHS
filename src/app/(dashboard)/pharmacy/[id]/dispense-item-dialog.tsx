"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createDispensingRecordAction, type ActionState } from "@/app/(dashboard)/pharmacy/actions"

const initialState: ActionState = {}

export function DispenseItemDialog({
  prescriptionId,
  prescriptionItemId,
  medications,
}: {
  prescriptionId: string
  prescriptionItemId: string
  medications: { id: string; label: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createDispensingRecordAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Dispense
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Dispense medication</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="prescriptionId" value={prescriptionId} />
          <input type="hidden" name="prescriptionItemId" value={prescriptionItemId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="medicationId">Medication</Label>
            <Select name="medicationId" required>
              <SelectTrigger id="medicationId" className="w-full">
                <SelectValue placeholder="Select a medication" />
              </SelectTrigger>
              <SelectContent>
                {medications.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="quantityDispensed">Quantity</Label>
            <Input id="quantityDispensed" name="quantityDispensed" type="number" min="1" step="1" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Create dispensing record"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
