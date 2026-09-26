"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { updateImplementationSummaryAction, type ActionState } from "@/app/platform/organizations/[id]/implementation/actions"

const initialState: ActionState = {}

/** P5.8 §27/§28: two small, independent fields — a planned date and a free-text owner (already `OrganizationCommercialProfile.implementationOwner`) — edited together via one dialog since that's how an operator sets both at the start of an implementation. */
export function SummaryEditDialog({ organizationId, targetGoLiveDate, implementationOwner }: { organizationId: string; targetGoLiveDate: Date | null; implementationOwner: string | null }) {
  const boundAction = updateImplementationSummaryAction.bind(null, organizationId)
  const { open, setOpen, state, pending, submit } = useActionDialog(boundAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Edit target date / owner
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Target go-live &amp; implementation owner</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-3">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="targetGoLiveDate">Target go-live date</Label>
            <Input id="targetGoLiveDate" name="targetGoLiveDate" type="date" defaultValue={targetGoLiveDate ? new Date(targetGoLiveDate).toISOString().slice(0, 10) : ""} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="implementationOwner">Implementation owner</Label>
            <Input id="implementationOwner" name="implementationOwner" defaultValue={implementationOwner ?? ""} placeholder="Who at Avant is implementing this clinic" maxLength={200} />
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
