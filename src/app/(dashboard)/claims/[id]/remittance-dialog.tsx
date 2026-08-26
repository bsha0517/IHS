"use client"

import { Landmark } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { recordRemittanceAction, type ActionState } from "@/app/(dashboard)/claims/actions"

const initialState: ActionState = {}

export function RemittanceDialog({ claimId, approvedAmount }: { claimId: string; approvedAmount: number }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(recordRemittanceAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Landmark className="size-3.5" /> Record remittance
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Record remittance</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="claimId" value={claimId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="amount">Amount received (approved {approvedAmount.toFixed(2)})</Label>
            <Input id="amount" name="amount" type="number" min="0.01" step="0.01" defaultValue={approvedAmount} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reference">Reference (EFT/cheque #)</Label>
            <Input id="reference" name="reference" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Record remittance"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
