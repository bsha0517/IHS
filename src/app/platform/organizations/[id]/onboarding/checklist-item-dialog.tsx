"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { updateChecklistItemAction, type ActionState } from "@/app/platform/organizations/[id]/onboarding/actions"
import type { $Enums } from "@/generated/prisma/client"

const STATUSES: $Enums.OnboardingChecklistStatus[] = ["not_started", "in_progress", "blocked", "completed", "waived"]

const initialState: ActionState = {}

type Item = {
  id: string
  label: string
  required: boolean
  status: $Enums.OnboardingChecklistStatus
  ownerLabel: string | null
  dueDate: Date | null
  notes: string | null
  evidenceReference: string | null
}

export function ChecklistItemDialog({ organizationId, item }: { organizationId: string; item: Item }) {
  const boundAction = updateChecklistItemAction.bind(null, organizationId, item.id)
  const { open, setOpen, state, pending, submit } = useActionDialog(boundAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Update
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item.label}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-3">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="status">Status</Label>
            <Select name="status" defaultValue={item.status}>
              <SelectTrigger id="status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ownerLabel">Owner</Label>
              <Input id="ownerLabel" name="ownerLabel" defaultValue={item.ownerLabel ?? ""} placeholder="Who's doing this" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dueDate">Due date</Label>
              <Input id="dueDate" name="dueDate" type="date" defaultValue={item.dueDate ? item.dueDate.toISOString().slice(0, 10) : ""} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="evidenceReference">Evidence / reference</Label>
            <Input id="evidenceReference" name="evidenceReference" defaultValue={item.evidenceReference ?? ""} placeholder="Link or reference, no secrets" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="notes">Notes {item.required && "(explain why, if marking Waived)"}</Label>
            <Textarea id="notes" name="notes" defaultValue={item.notes ?? ""} rows={3} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
