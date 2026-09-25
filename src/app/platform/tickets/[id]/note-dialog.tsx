"use client"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { addOperatorNoteAction, type ActionState } from "@/app/platform/tickets/actions"

const initialState: ActionState = {}

export function AddOperatorNoteDialog({ ticketId }: { ticketId: string }) {
  const boundAction = addOperatorNoteAction.bind(null, ticketId)
  const { open, setOpen, state, pending, submit } = useActionDialog(boundAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Add note</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a note</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-3">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <Select name="visibility" defaultValue="internal">
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="internal">Internal only (never visible to the clinic)</SelectItem>
              <SelectItem value="customer">Customer-visible (the clinic will see this)</SelectItem>
            </SelectContent>
          </Select>
          <Textarea name="body" rows={4} required placeholder="Do not include patient names, MRNs, diagnoses, or other clinical information." />
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Add note"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
