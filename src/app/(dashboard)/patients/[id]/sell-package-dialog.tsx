"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { purchasePackageAction, type ActionState } from "@/app/(dashboard)/packages/actions"

const initialState: ActionState = {}

export function SellPackageDialog({
  patientId,
  branchId,
  packages,
}: {
  patientId: string
  branchId: string
  packages: { id: string; name: string; price: number }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(purchasePackageAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> Sell package
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sell package</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="patientId" value={patientId} />
          <input type="hidden" name="branchId" value={branchId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="packageId">Package</Label>
            <Select name="packageId" required>
              <SelectTrigger id="packageId" className="w-full">
                <SelectValue placeholder="Select a package" />
              </SelectTrigger>
              <SelectContent>
                {packages.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} — {p.price.toFixed(2)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="priceOverride">Price override (optional)</Label>
            <Input id="priceOverride" name="priceOverride" type="number" step="0.01" min="0" placeholder="Use package price" />
          </div>
          <p className="text-xs text-muted-foreground">
            This creates a pending charge — take payment for it at the POS.
          </p>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Selling..." : "Sell package"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
