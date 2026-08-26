"use client"

import { Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { returnDispensingRecordAction, type ActionState } from "@/app/(dashboard)/pharmacy/actions"

const initialState: ActionState = {}

export function ReturnDialog({
  dispensingRecordId,
  prescriptionId,
  maxReturnable,
}: {
  dispensingRecordId: string
  prescriptionId: string
  maxReturnable: number
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(returnDispensingRecordAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Undo2 className="size-3.5" /> Return
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Record a return</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="dispensingRecordId" value={dispensingRecordId} />
          <input type="hidden" name="prescriptionId" value={prescriptionId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="quantityReturned">Quantity returned (max {maxReturnable})</Label>
            <Input id="quantityReturned" name="quantityReturned" type="number" min="1" max={maxReturnable} step="1" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reason">Reason</Label>
            <Textarea id="reason" name="reason" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Record return"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
