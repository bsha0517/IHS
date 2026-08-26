"use client"

import { CalendarClock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { scheduleImagingAction, type ActionState } from "@/app/(dashboard)/radiology/actions"

const initialState: ActionState = {}

export function ScheduleDialog({
  imagingOrderId,
  clinicalOrderId,
  rooms,
}: {
  imagingOrderId: string
  clinicalOrderId: string
  rooms: { id: string; name: string; code: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(scheduleImagingAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <CalendarClock className="size-3.5" /> Schedule
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Schedule imaging</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="imagingOrderId" value={imagingOrderId} />
          <input type="hidden" name="clinicalOrderId" value={clinicalOrderId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="scheduledAt">Date/time</Label>
            <Input id="scheduledAt" name="scheduledAt" type="datetime-local" required />
          </div>
          {rooms.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="roomId">Room</Label>
              <Select name="roomId">
                <SelectTrigger id="roomId" className="w-full">
                  <SelectValue placeholder="No specific room" />
                </SelectTrigger>
                <SelectContent>
                  {rooms.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name} ({r.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
