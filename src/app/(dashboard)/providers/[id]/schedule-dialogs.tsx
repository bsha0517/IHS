"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import {
  createProviderScheduleAction,
  createProviderLeaveBlockAction,
  deleteProviderScheduleAction,
  deleteProviderLeaveBlockAction,
  type ActionState,
} from "@/app/(dashboard)/providers/actions"

const initialState: ActionState = {}
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

export function AddScheduleDialog({ providerId, branches }: { providerId: string; branches: { id: string; name: string }[] }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createProviderScheduleAction, initialState)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add hours
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add working hours</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="providerId" value={providerId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="branchId">Branch</Label>
            <Select name="branchId" required>
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
            <Label htmlFor="dayOfWeek">Day</Label>
            <Select name="dayOfWeek" required defaultValue="1">
              <SelectTrigger id="dayOfWeek" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_NAMES.map((day, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {day}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="startTime">Start</Label>
              <Input id="startTime" name="startTime" type="time" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="endTime">End</Label>
              <Input id="endTime" name="endTime" type="time" required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="slotDurationMinutes">Slot duration (min)</Label>
            <Input id="slotDurationMinutes" name="slotDurationMinutes" type="number" min="5" defaultValue="30" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteScheduleButton({ providerId, scheduleId }: { providerId: string; scheduleId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await deleteProviderScheduleAction(providerId, scheduleId)
          router.refresh()
        })
      }
      aria-label="Remove"
    >
      <Trash2 className="size-3.5" />
    </Button>
  )
}

export function AddLeaveBlockDialog({ providerId }: { providerId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createProviderLeaveBlockAction, initialState)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Add leave
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Block time off</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="providerId" value={providerId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="startAt">From</Label>
            <Input id="startAt" name="startAt" type="datetime-local" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="endAt">To</Label>
            <Input id="endAt" name="endAt" type="datetime-local" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reason">Reason</Label>
            <Input id="reason" name="reason" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Block time"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteLeaveBlockButton({ providerId, blockId }: { providerId: string; blockId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await deleteProviderLeaveBlockAction(providerId, blockId)
          router.refresh()
        })
      }
      aria-label="Remove"
    >
      <Trash2 className="size-3.5" />
    </Button>
  )
}

export { DAY_NAMES }
