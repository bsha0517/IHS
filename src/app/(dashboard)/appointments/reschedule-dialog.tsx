"use client"

import { useState } from "react"
import { CalendarClock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { AvailableSlotsPicker } from "@/components/domain/available-slots-picker"
import { rescheduleAppointmentAction, type ActionState } from "@/app/(dashboard)/appointments/actions"

const initialState: ActionState = {}

/**
 * P1 §26: the UI surface for `rescheduleAppointment` — the service function
 * and its "real workflow" history (original reference, changed-by, reason,
 * timestamp) already existed, but nothing in the app rendered a way to
 * actually trigger it. `assertNoLeaveConflict` plus the DB's own exclusion
 * constraint (see service.ts's `translateBookingError`) is what actually
 * rejects a provider/room conflict on the new slot — this dialog just
 * surfaces whatever error that produces.
 *
 * P3.1 §13/§14: now also shows real available-slot options for the newly
 * (or still-)selected provider, the same picker `NewAppointmentDialog` uses
 * — a receptionist rescheduling should see genuine availability, not just a
 * blank time field, without a second scheduling engine being built for it.
 */
export function RescheduleDialog({
  appointmentId,
  branchId,
  providers,
  defaultProviderId,
}: {
  appointmentId: string
  /** Needed only to power the slot picker — the appointment's own branch never changes on reschedule. */
  branchId?: string
  providers: { id: string; firstName: string; lastName: string }[]
  defaultProviderId?: string
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(rescheduleAppointmentAction, initialState)
  const [providerId, setProviderId] = useState(defaultProviderId ?? "")
  const [duration, setDuration] = useState(30)
  const [startTime, setStartTime] = useState("")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <CalendarClock /> Reschedule
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reschedule appointment</DialogTitle>
          <DialogDescription>
            This keeps the original appointment as history and creates a new one at the time you pick — it is never edited in place.
          </DialogDescription>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="appointmentId" value={appointmentId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label htmlFor="providerId">Provider</Label>
            <Select name="providerId" defaultValue={defaultProviderId} onValueChange={setProviderId}>
              <SelectTrigger id="providerId" className="w-full">
                <SelectValue placeholder="Keep current provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.firstName} {p.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {branchId && (
            <AvailableSlotsPicker
              providerId={providerId}
              branchId={branchId}
              durationMinutes={duration}
              selectedValue={startTime}
              onPick={setStartTime}
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="startTime">New date &amp; time</Label>
              <Input
                id="startTime"
                name="startTime"
                type="datetime-local"
                required
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="durationMinutes">Duration (min)</Label>
              <Input
                id="durationMinutes"
                name="durationMinutes"
                type="number"
                min="5"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                required
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="reason">Reason for rescheduling</Label>
            <Textarea id="reason" name="reason" required maxLength={500} />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Rescheduling..." : "Reschedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
