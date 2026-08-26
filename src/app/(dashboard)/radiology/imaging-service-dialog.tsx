"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createImagingServiceAction, updateImagingServiceAction, type ActionState } from "@/app/(dashboard)/radiology/actions"

const initialState: ActionState = {}

type ExistingService = {
  id: string
  code: string
  name: string
  category: string
  bodyPart: string | null
  price: number
  turnaroundHours: number | null
}

export function ImagingServiceDialog({ existing }: { existing?: ExistingService }) {
  const action = existing ? updateImagingServiceAction : createImagingServiceAction
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
            <Plus /> New imaging service
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit imaging service" : "New imaging service"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="imagingServiceId" value={existing.id} />}
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
              <Label htmlFor="category">Category (modality)</Label>
              <Input id="category" name="category" placeholder="X-Ray, CT, MRI, Ultrasound" defaultValue={existing?.category} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bodyPart">Body part</Label>
              <Input id="bodyPart" name="bodyPart" defaultValue={existing?.bodyPart ?? ""} />
            </div>
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
              {pending ? "Saving..." : existing ? "Save changes" : "Create service"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
