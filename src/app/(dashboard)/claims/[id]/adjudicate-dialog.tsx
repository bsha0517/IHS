"use client"

import { useState } from "react"
import { Gavel } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { adjudicateClaimAction, type ActionState } from "@/app/(dashboard)/claims/actions"

const initialState: ActionState = {}

type Item = { id: string; description: string; submittedAmount: number }

export function AdjudicateDialog({ claimId, items }: { claimId: string; items: Item[] }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(adjudicateClaimAction, initialState)
  const [approved, setApproved] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((i) => [i.id, String(i.submittedAmount)]))
  )
  const [denials, setDenials] = useState<Record<string, string>>({})
  const [rejectionReason, setRejectionReason] = useState("")

  function handleSubmit(formData: FormData) {
    const payload = items.map((i) => ({
      claimItemId: i.id,
      approvedAmount: Number(approved[i.id] ?? 0),
      denialReason: denials[i.id] ?? null,
    }))
    formData.set("items", JSON.stringify(payload))
    formData.set("rejectionReason", rejectionReason)
    submit(formData)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Gavel className="size-3.5" /> Record adjudication
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record adjudication</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="grid gap-4">
          <input type="hidden" name="claimId" value={claimId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3">
            {items.map((item) => (
              <div key={item.id} className="grid gap-2 rounded-md border border-border p-2">
                <div className="flex items-center justify-between text-sm">
                  <span>{item.description}</span>
                  <span className="text-muted-foreground">submitted {item.submittedAmount.toFixed(2)}</span>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`approved-${item.id}`} className="text-xs">
                    Approved amount
                  </Label>
                  <Input
                    id={`approved-${item.id}`}
                    type="number"
                    min="0"
                    max={item.submittedAmount}
                    step="0.01"
                    value={approved[item.id] ?? ""}
                    onChange={(e) => setApproved((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  />
                </div>
                {Number(approved[item.id] ?? 0) < item.submittedAmount && (
                  <div className="grid gap-1.5">
                    <Label htmlFor={`denial-${item.id}`} className="text-xs">
                      Denial reason (for the unapproved portion)
                    </Label>
                    <Input
                      id={`denial-${item.id}`}
                      value={denials[item.id] ?? ""}
                      onChange={(e) => setDenials((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rejectionReason">Overall rejection reason (only if nothing was approved)</Label>
            <Textarea id="rejectionReason" value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save adjudication"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
