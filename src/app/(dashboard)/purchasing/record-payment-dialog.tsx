"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { recordSupplierPaymentAction, type ActionState } from "@/app/(dashboard)/purchasing/actions"

const initialState: ActionState = {}
const METHODS = ["cash", "card", "bank", "online", "insurance", "credit", "other"] as const

export function RecordPaymentDialog({ supplierInvoiceId, outstanding }: { supplierInvoiceId: string; outstanding: number }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(recordSupplierPaymentAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Pay</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="supplierInvoiceId" value={supplierInvoiceId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">Outstanding: {outstanding.toFixed(2)}</p>
          <div className="grid gap-2">
            <Label htmlFor="method">Method</Label>
            <Select name="method" defaultValue="bank">
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
            <Input id="amount" name="amount" type="number" step="0.01" min="0.01" max={outstanding} defaultValue={outstanding.toFixed(2)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reference">Reference</Label>
            <Input id="reference" name="reference" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Record payment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
