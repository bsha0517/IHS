"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { updateSubscriptionAction, type ActionState } from "@/app/platform/organizations/[id]/actions"

const initialState: ActionState = {}

/**
 * P5.1 §10/§18/§41: submitting this ALWAYS creates a new subscription row
 * (see organizations.ts's updateSubscription) — history is preserved, never
 * mutated in place. Limits here are the per-organization override
 * (§18 "keep overrides explicit") — leave blank to fall back to the
 * selected plan's own limits.
 */
export function SubscriptionDialog({
  organizationId,
  plans,
  current,
}: {
  organizationId: string
  plans: { id: string; name: string; code: string }[]
  current: {
    planId: string
    status: string
    startDate: Date
    trialEndsAt: Date | null
    agreedUserLimit: number | null
    agreedBranchLimit: number | null
    agreedAmount: string | null
    currency: string | null
    billingCycle: string | null
    notes: string | null
  } | null
}) {
  const boundAction = updateSubscriptionAction.bind(null, organizationId)
  const { open, setOpen, state, pending, submit } = useActionDialog(boundAction, initialState)

  const toDateInput = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {current ? "Change plan / subscription" : "Assign plan"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Plan / subscription</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="planId">Plan</Label>
            <Select name="planId" defaultValue={current?.planId}>
              <SelectTrigger id="planId" className="w-full">
                <SelectValue placeholder="Select a plan" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="status">Status</Label>
            <Select name="status" defaultValue={current?.status ?? "trial"}>
              <SelectTrigger id="status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="past_due">Past due</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="startDate">Start date</Label>
              <Input id="startDate" name="startDate" type="date" defaultValue={toDateInput(current?.startDate) || toDateInput(new Date())} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="trialEndsAt">Trial ends</Label>
              <Input id="trialEndsAt" name="trialEndsAt" type="date" defaultValue={toDateInput(current?.trialEndsAt)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="agreedUserLimit">Agreed user limit</Label>
              <Input id="agreedUserLimit" name="agreedUserLimit" type="number" min={1} defaultValue={current?.agreedUserLimit ?? ""} placeholder="Plan default" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agreedBranchLimit">Agreed branch limit</Label>
              <Input id="agreedBranchLimit" name="agreedBranchLimit" type="number" min={1} defaultValue={current?.agreedBranchLimit ?? ""} placeholder="Plan default" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="agreedAmount">Agreed amount</Label>
              <Input id="agreedAmount" name="agreedAmount" type="number" step="0.01" min={0} defaultValue={current?.agreedAmount ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="currency">Currency</Label>
              <Input id="currency" name="currency" maxLength={3} defaultValue={current?.currency ?? ""} placeholder="USD" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="billingCycle">Billing cycle</Label>
              <Select name="billingCycle" defaultValue={current?.billingCycle ?? undefined}>
                <SelectTrigger id="billingCycle" className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="annual">Annual</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" defaultValue={current?.notes ?? ""} rows={2} placeholder="Manual invoicing/payment reference, contract terms, etc." />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
