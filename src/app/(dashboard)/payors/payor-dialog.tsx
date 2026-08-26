"use client"

import { Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createPayorAction, updatePayorAction, type ActionState } from "@/app/(dashboard)/payors/actions"

const initialState: ActionState = {}

const PAYOR_TYPES = [
  { value: "self_pay", label: "Self Pay" },
  { value: "insurance_company", label: "Insurance Company" },
  { value: "corporate", label: "Corporate" },
  { value: "government", label: "Government" },
  { value: "other", label: "Other" },
] as const

type ExistingPayor = {
  id: string
  code: string
  name: string
  payorType: string
  contactName: string | null
  contactPhone: string | null
  contactEmail: string | null
  address: string | null
}

export function PayorDialog({ existing }: { existing?: ExistingPayor }) {
  const action = existing ? updatePayorAction : createPayorAction
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
            <Plus /> New payor
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit payor" : "New payor"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {existing && <input type="hidden" name="payorId" value={existing.id} />}
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
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={existing?.name} required />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="payorType">Payor type</Label>
            <Select name="payorType" defaultValue={existing?.payorType ?? "insurance_company"} required>
              <SelectTrigger id="payorType" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYOR_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="contactName">Contact name</Label>
              <Input id="contactName" name="contactName" defaultValue={existing?.contactName ?? ""} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="contactPhone">Contact phone</Label>
              <Input id="contactPhone" name="contactPhone" defaultValue={existing?.contactPhone ?? ""} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="contactEmail">Contact email</Label>
            <Input id="contactEmail" name="contactEmail" type="email" defaultValue={existing?.contactEmail ?? ""} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="address">Address</Label>
            <Input id="address" name="address" defaultValue={existing?.address ?? ""} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : existing ? "Save changes" : "Create payor"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
