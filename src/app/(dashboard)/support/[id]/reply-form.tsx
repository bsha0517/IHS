"use client"

import { useActionState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { addClinicNoteAction, type ActionState } from "@/app/(dashboard)/support/actions"

const initialState: ActionState = {}

export function ReplyForm({ ticketId }: { ticketId: string }) {
  const boundAction = addClinicNoteAction.bind(null, ticketId)
  const [state, formAction, pending] = useActionState(boundAction, initialState)

  return (
    <form action={formAction} className="grid gap-2">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <Textarea name="body" rows={3} required placeholder="Reply — please do not include patient or clinical information." />
      <Button type="submit" disabled={pending} size="sm" className="justify-self-start">
        {pending ? "Sending..." : "Send reply"}
      </Button>
    </form>
  )
}
