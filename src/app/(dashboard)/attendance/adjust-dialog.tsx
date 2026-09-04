"use client"

import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { adjustAttendanceAction, type ActionState } from "@/app/(dashboard)/attendance/actions"

const initialState: ActionState = {}
const STATUSES = ["present", "absent", "half_day", "on_leave", "holiday"] as const

function toLocalInput(value: string | null): string {
  if (!value) return ""
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// P3.10 §16: `adjustAttendance` (hr/attendance.ts) already existed and was
// fully server-implemented — permission-gated, branch-checked, audited —
// but no UI anywhere ever called it, so HR had no way to correct a wrong
// check-in/check-out or mark a day absent/on-leave/holiday after the fact.
// This wires the existing action, it does not add new domain behavior.
export function AdjustAttendanceDialog({
  record,
}: {
  record: {
    id: string
    employeeName: string
    checkInAt: string | null
    checkOutAt: string | null
    breakMinutes: number
    status: string
    notes: string | null
  }
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(adjustAttendanceAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Adjust">
          <Pencil className="size-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust attendance — {record.employeeName}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="attendanceRecordId" value={record.id} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="checkInAt">Check-in</Label>
              <Input id="checkInAt" name="checkInAt" type="datetime-local" defaultValue={toLocalInput(record.checkInAt)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="checkOutAt">Check-out</Label>
              <Input id="checkOutAt" name="checkOutAt" type="datetime-local" defaultValue={toLocalInput(record.checkOutAt)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="breakMinutes">Break (minutes)</Label>
              <Input id="breakMinutes" name="breakMinutes" type="number" min="0" max="1440" defaultValue={record.breakMinutes} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="status">Status</Label>
              <Select name="status" defaultValue={record.status} required>
                <SelectTrigger id="status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" defaultValue={record.notes ?? ""} placeholder="Reason for this adjustment" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save adjustment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
