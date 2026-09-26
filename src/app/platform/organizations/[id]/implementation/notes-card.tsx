"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { EmptyState } from "@/components/ui/empty-state"
import { formatDateTime } from "@/lib/utils/dates"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { addImplementationNoteAction, type ActionState } from "@/app/platform/organizations/[id]/implementation/actions"

const initialState: ActionState = {}

type Note = { id: string; body: string; authorOperatorId: string | null; createdAt: Date }

/** P5.8 §29: freeform implementation commentary only — never PHI/clinical data, same discipline `SupportTicket.description` already follows. */
export function NotesCard({ organizationId, notes, operatorEmails }: { organizationId: string; notes: Note[]; operatorEmails: Record<string, string> }) {
  const boundAction = addImplementationNoteAction.bind(null, organizationId)
  const { state, pending, submit } = useActionDialog(boundAction, initialState)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Implementation notes</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {state.error && (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <form
          action={(formData) => {
            submit(formData)
            const textarea = document.getElementById("implementation-note-body") as HTMLTextAreaElement | null
            if (textarea) textarea.value = ""
          }}
          className="grid gap-2"
        >
          <Textarea id="implementation-note-body" name="body" placeholder="e.g. Customer requested Saturday training. No patient/clinical data." rows={2} maxLength={2000} required />
          <Button type="submit" size="sm" disabled={pending} className="justify-self-start">
            {pending ? "Adding..." : "Add note"}
          </Button>
        </form>
        {notes.length === 0 ? (
          <EmptyState title="No implementation notes yet" className="border-none" />
        ) : (
          <div className="grid gap-2">
            {notes.map((n) => (
              <div key={n.id} className="rounded-md border border-border p-2 text-sm">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {n.authorOperatorId ? (operatorEmails[n.authorOperatorId] ?? "Unknown operator") : "Unknown operator"} · {formatDateTime(n.createdAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
