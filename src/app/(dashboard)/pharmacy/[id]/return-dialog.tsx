"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { returnDispensingRecordAction } from "@/app/(dashboard)/pharmacy/actions"

/**
 * P3.9 §39: "Record a return" restores stock only — it does not, by
 * itself, guarantee any money moves. Rather than close silently on success
 * (this codebase's usual useActionDialog pattern) and leave that
 * distinction implicit, this dialog states it up front and reports back
 * exactly what financial action (if any) actually happened, via a toast
 * that survives the dialog closing — never lets a successful return read
 * as "refunded" when it wasn't.
 */
export function ReturnDialog({
  dispensingRecordId,
  prescriptionId,
  maxReturnable,
}: {
  dispensingRecordId: string
  prescriptionId: string
  maxReturnable: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const result = await returnDispensingRecordAction({}, formData)
      if (result.error) {
        setError(result.error)
        return
      }
      setOpen(false)
      if (result.financialReversal === "reversed") {
        toast.success("Return recorded. Stock restored and the original charge/cost were reversed (it had not been invoiced yet).")
      } else if (result.financialReversal === "manual_review_required") {
        toast.warning("Return recorded — stock restored only. This item was already invoiced, so no revenue/refund was reversed automatically. Route to Accounting for manual review.")
      } else {
        toast.success("Return recorded. Stock restored.")
      }
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setError(null) }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Undo2 className="size-3.5" /> Return
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Record a return</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          This restores the returned quantity to stock. It does <span className="font-medium">not</span> automatically
          refund or credit any money — if this item was already billed, any financial correction is a separate
          Accounting action.
        </p>
        <form action={handleSubmit} className="grid gap-4">
          <input type="hidden" name="dispensingRecordId" value={dispensingRecordId} />
          <input type="hidden" name="prescriptionId" value={prescriptionId} />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="quantityReturned">Quantity returned (max {maxReturnable})</Label>
            <Input id="quantityReturned" name="quantityReturned" type="number" min="1" max={maxReturnable} step="1" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reason">Reason</Label>
            <Textarea id="reason" name="reason" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Record return"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
