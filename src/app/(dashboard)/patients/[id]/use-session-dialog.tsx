"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { consumeSessionAction, type ActionState } from "@/app/(dashboard)/packages/actions"

const initialState: ActionState = {}

export function UseSessionDialog({
  patientId,
  patientPackageId,
  packageServiceId,
  serviceName,
}: {
  patientId: string
  patientPackageId: string
  packageServiceId: string
  serviceName: string
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(consumeSessionAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Use session
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Use a session — {serviceName}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="patientId" value={patientId} />
          <input type="hidden" name="patientPackageId" value={patientPackageId} />
          <input type="hidden" name="packageServiceId" value={packageServiceId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <Textarea name="notes" placeholder="Notes (optional)" />
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Recording..." : "Record usage"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
