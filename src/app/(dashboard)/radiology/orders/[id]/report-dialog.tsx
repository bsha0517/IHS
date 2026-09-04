"use client"

import { FileText, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { writeReportAction, amendReportAction, type ActionState } from "@/app/(dashboard)/radiology/actions"

const initialState: ActionState = {}

export function ReportDialog({ imagingOrderId, clinicalOrderId }: { imagingOrderId: string; clinicalOrderId: string }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(writeReportAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <FileText className="size-3.5" /> Write report
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Radiology report</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="imagingOrderId" value={imagingOrderId} />
          <input type="hidden" name="clinicalOrderId" value={clinicalOrderId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="reportText">Findings</Label>
            <Textarea id="reportText" name="reportText" rows={6} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="impression">Impression</Label>
            <Textarea id="impression" name="impression" rows={2} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save report"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Targeted backlog closure, item 7: corrects an already-verified report.
 * Mirrors laboratory's own "Amend result" dialog (result-entry-dialog.tsx,
 * mode="amend") — same shape, same trigger placement next to a verified
 * result — except `reason` is a required field here (Lab's own `notes` is
 * optional), matching item 7's own explicit requirement.
 */
export function AmendReportDialog({
  imagingOrderId,
  clinicalOrderId,
  currentReportText,
  currentImpression,
}: {
  imagingOrderId: string
  clinicalOrderId: string
  currentReportText: string
  currentImpression: string | null
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(amendReportAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Pencil className="size-3.5" /> Amend report
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Amend radiology report</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="imagingOrderId" value={imagingOrderId} />
          <input type="hidden" name="clinicalOrderId" value={clinicalOrderId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <Alert>
            <AlertDescription>
              The original verified report is preserved, not overwritten. This creates a new, separately-attributed
              correction.
            </AlertDescription>
          </Alert>
          <div className="grid gap-2">
            <Label htmlFor="amend-reportText">Findings</Label>
            <Textarea id="amend-reportText" name="reportText" rows={6} defaultValue={currentReportText} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="amend-impression">Impression</Label>
            <Textarea id="amend-impression" name="impression" rows={2} defaultValue={currentImpression ?? ""} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="amend-reason">Reason for amendment</Label>
            <Textarea id="amend-reason" name="reason" rows={2} placeholder="Why is this report being corrected?" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save amendment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
