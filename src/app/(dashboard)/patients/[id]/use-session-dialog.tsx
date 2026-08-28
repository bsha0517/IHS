"use client"

import { useState } from "react"
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
  // P1 §33: one key per dialog-open, resubmitted unchanged by every retry of
  // that attempt — a double-click can't burn two sessions for one visit.
  // Regenerated in onOpenChange (an event, not an effect — see
  // use-action-dialog.ts's own doc comment).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setIdempotencyKey(crypto.randomUUID())
        setOpen(o)
      }}
    >
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
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
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
