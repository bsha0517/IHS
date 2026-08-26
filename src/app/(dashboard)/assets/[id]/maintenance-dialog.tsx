"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { addMaintenanceRecordAction, type ActionState } from "@/app/(dashboard)/assets/actions"

const initialState: ActionState = {}

export function MaintenanceDialog({ assetId }: { assetId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(addMaintenanceRecordAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Log maintenance
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log maintenance</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="assetId" value={assetId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="maintenanceType">Type</Label>
              <Select name="maintenanceType" required>
                <SelectTrigger id="maintenanceType" className="w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preventive">Preventive</SelectItem>
                  <SelectItem value="corrective">Corrective</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="serviceDate">Service date</Label>
              <Input id="serviceDate" name="serviceDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="serviceProvider">Service provider</Label>
            <Input id="serviceProvider" name="serviceProvider" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workPerformed">Work performed</Label>
            <Textarea id="workPerformed" name="workPerformed" required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="cost">Cost</Label>
              <Input id="cost" name="cost" type="number" min="0" step="0.01" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="nextServiceDate">Next service</Label>
              <Input id="nextServiceDate" name="nextServiceDate" type="date" />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Log maintenance"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
