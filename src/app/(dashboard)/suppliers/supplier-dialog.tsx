"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createSupplierAction, updateSupplierAction, type ActionState } from "@/app/(dashboard)/suppliers/actions"

const initialState: ActionState = {}

type ExistingSupplier = {
  id: string
  code: string
  companyName: string
  contactName: string | null
  phone: string | null
  email: string | null
  address: string | null
  taxNumber: string | null
  paymentTerms: string | null
  bankDetails: string | null
}

export function SupplierDialog({ existing }: { existing?: ExistingSupplier }) {
  const action = existing ? updateSupplierAction : createSupplierAction
  const { open, setOpen, state, pending, submit } = useActionDialog(action, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {existing ? (
          <Button size="icon-sm" variant="ghost" aria-label="Edit">
            <Pencil className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm">
            <Plus /> New supplier
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit supplier" : "New supplier"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="supplierId" value={existing.id} />}
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="code">Code</Label>
              <Input id="code" name="code" defaultValue={existing?.code} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="companyName">Company</Label>
              <Input id="companyName" name="companyName" defaultValue={existing?.companyName} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="contactName">Contact name</Label>
              <Input id="contactName" name="contactName" defaultValue={existing?.contactName ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" defaultValue={existing?.phone ?? ""} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" defaultValue={existing?.email ?? ""} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="address">Address</Label>
            <Textarea id="address" name="address" defaultValue={existing?.address ?? ""} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="taxNumber">Tax number</Label>
              <Input id="taxNumber" name="taxNumber" defaultValue={existing?.taxNumber ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="paymentTerms">Payment terms</Label>
              <Input id="paymentTerms" name="paymentTerms" placeholder="Net 30" defaultValue={existing?.paymentTerms ?? ""} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bankDetails">Bank details</Label>
            <Textarea id="bankDetails" name="bankDetails" defaultValue={existing?.bankDetails ?? ""} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : existing ? "Save changes" : "Create supplier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
