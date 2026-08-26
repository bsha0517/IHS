"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { addPatientCoverageAction, type ActionState } from "@/app/(dashboard)/claims/actions"

const initialState: ActionState = {}

export function AddCoverageDialog({ patientId, policies }: { patientId: string; policies: { id: string; label: string }[] }) {
  const { open, setOpen, state, pending, submit } = useActionDialog(addPatientCoverageAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Add coverage
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add insurance coverage</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="patientId" value={patientId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="policyId">Policy</Label>
            <Select name="policyId" required>
              <SelectTrigger id="policyId" className="w-full">
                <SelectValue placeholder="Select a policy" />
              </SelectTrigger>
              <SelectContent>
                {policies.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="memberId">Member ID</Label>
              <Input id="memberId" name="memberId" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="relationshipToSubscriber">Relationship to subscriber</Label>
              <Input id="relationshipToSubscriber" name="relationshipToSubscriber" defaultValue="self" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="startDate">Start date</Label>
              <Input id="startDate" name="startDate" type="date" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="endDate">End date</Label>
              <Input id="endDate" name="endDate" type="date" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="copayAmount">Copay amount</Label>
              <Input id="copayAmount" name="copayAmount" type="number" min="0" step="0.01" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="copayPercent">Copay percent</Label>
              <Input id="copayPercent" name="copayPercent" type="number" min="0" max="100" step="0.1" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="deductibleAmount">Deductible</Label>
              <Input id="deductibleAmount" name="deductibleAmount" type="number" min="0" step="0.01" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="annualLimitAmount">Annual limit</Label>
              <Input id="annualLimitAmount" name="annualLimitAmount" type="number" min="0" step="0.01" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isPrimary" defaultChecked />
            Primary coverage
          </label>
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Input id="notes" name="notes" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Add coverage"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
