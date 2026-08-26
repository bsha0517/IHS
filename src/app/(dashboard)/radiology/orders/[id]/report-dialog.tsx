"use client"

import { FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { writeReportAction, type ActionState } from "@/app/(dashboard)/radiology/actions"

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
