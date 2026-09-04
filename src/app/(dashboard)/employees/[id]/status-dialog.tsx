"use client"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { updateEmployeeStatusAction, type ActionState } from "@/app/(dashboard)/employees/actions"

const initialState: ActionState = {}
const STATUSES = ["active", "on_leave", "terminated"] as const

// P3.10 §12/§13/§54: a confirmation step before a status change, matching
// this codebase's convention for finalization/destructive actions elsewhere
// (e.g. MarkPaidDialog) — "terminated" in particular is not something that
// should be one accidental click away, even though the underlying action
// never deletes any history and can be reversed by setting status back.
export function EmployeeStatusDialog({ employeeId, currentStatus }: { employeeId: string; currentStatus: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(updateEmployeeStatusAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Change status
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change employment status</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="employeeId" value={employeeId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="status">Status</Label>
            <Select name="status" defaultValue={currentStatus} required>
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
          <p className="text-xs text-muted-foreground">
            This only changes the employee&apos;s status. Attendance, leave, and payroll history are preserved either way.
          </p>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save status"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
