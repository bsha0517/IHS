"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createSupplierInvoiceAction, type ActionState } from "@/app/(dashboard)/purchasing/actions"

const initialState: ActionState = {}

export function SupplierInvoiceDialog({
  branches,
  suppliers,
  purchaseOrderId,
}: {
  branches: { id: string; name: string }[]
  suppliers: { id: string; companyName: string }[]
  purchaseOrderId?: string
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(createSupplierInvoiceAction, initialState)
  // P3.8 §41: one key per dialog-open, resubmitted unchanged by every retry
  // of that same attempt — the same idempotency-key pattern ReceiveDialog
  // already established (receive-dialog.tsx). Regenerated on open, not in
  // an effect.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  function handleOpenChange(next: boolean) {
    if (next) setIdempotencyKey(crypto.randomUUID())
    setOpen(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Record supplier invoice
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record supplier invoice</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {purchaseOrderId && <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />}
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="branchId">Branch</Label>
              <Select name="branchId" required>
                <SelectTrigger id="branchId" className="w-full">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="supplierId">Supplier</Label>
              <Select name="supplierId" required>
                <SelectTrigger id="supplierId" className="w-full">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.companyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="invoiceNumber">Supplier&apos;s invoice number</Label>
            <Input id="invoiceNumber" name="invoiceNumber" required />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="amount">Amount</Label>
              <Input id="amount" name="amount" type="number" step="0.01" min="0.01" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="taxAmount">Recoverable tax</Label>
              <Input id="taxAmount" name="taxAmount" type="number" step="0.01" min="0" placeholder="0.00" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dueDate">Due date</Label>
              <Input id="dueDate" name="dueDate" type="date" />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Record invoice"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
