"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { requestRefundAction, type ActionState } from "@/app/(dashboard)/invoices/actions"

const initialState: ActionState = {}
const METHODS = ["cash", "card", "bank", "online", "insurance", "credit", "other"] as const

export function RequestRefundDialog({
  invoiceId,
  paidAmount,
  payments,
}: {
  invoiceId: string
  paidAmount: number
  payments: { id: string; receiptNumber: string; method: string; amount: number }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(requestRefundAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Request refund
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request refund</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="invoiceId" value={invoiceId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">Paid on this invoice: {paidAmount.toFixed(2)}</p>
          <div className="grid gap-2">
            <Label htmlFor="paymentId">Against payment (optional)</Label>
            <Select name="paymentId">
              <SelectTrigger id="paymentId" className="w-full">
                <SelectValue placeholder="General credit — not tied to one payment" />
              </SelectTrigger>
              <SelectContent>
                {payments.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.receiptNumber} — {p.method} — {p.amount.toFixed(2)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="method">Refund method</Label>
            <Select name="method" defaultValue="cash">
              <SelectTrigger id="method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="amount">Amount</Label>
            <Input id="amount" name="amount" type="number" step="0.01" min="0.01" max={paidAmount} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reason">Reason</Label>
            <Textarea id="reason" name="reason" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Submitting..." : "Request refund"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
