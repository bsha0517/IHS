"use client"

import { useState, useTransition, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { MODULE_LABELS, type ModuleKey } from "@/lib/platform/entitlements-shared"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { updateSubscriptionAction, getPlanChangeImpactAction, type ActionState } from "@/app/platform/organizations/[id]/actions"
import type { PlanChangeImpact } from "@/lib/domains/commercial/organizations"

const initialState: ActionState = {}

/**
 * P5.1 §10/§18/§41: submitting this ALWAYS creates a new subscription row
 * (see organizations.ts's updateSubscription) — history is preserved, never
 * mutated in place. Limits here are the per-organization override
 * (§18 "keep overrides explicit") — leave blank to fall back to the
 * selected plan's own limits.
 *
 * P5.7 Part 12/13: whenever the selected plan or either limit override
 * changes, fetches a live impact preview (`getPlanChangeImpactAction`) —
 * modules that would be added/removed against the org's CURRENT
 * entitlements, and whether current active user/branch usage would exceed
 * the new effective limit. The Save button is disabled whenever the
 * preview reports `blocked`; `updateSubscriptionAction` independently
 * re-enforces the same check server-side regardless of this UI state.
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

  const [planId, setPlanId] = useState(current?.planId ?? plans[0]?.id ?? "")
  const [agreedUserLimit, setAgreedUserLimit] = useState(current?.agreedUserLimit?.toString() ?? "")
  const [agreedBranchLimit, setAgreedBranchLimit] = useState(current?.agreedBranchLimit?.toString() ?? "")
  const [impact, setImpact] = useState<PlanChangeImpact | null>(null)
  const [impactError, setImpactError] = useState<string | null>(null)
  const [, startImpactTransition] = useTransition()

  useEffect(() => {
    if (!open || !planId) return
    startImpactTransition(async () => {
      const result = await getPlanChangeImpactAction(
        organizationId,
        planId,
        agreedUserLimit ? Number(agreedUserLimit) : null,
        agreedBranchLimit ? Number(agreedBranchLimit) : null
      )
      if (result.error) {
        setImpactError(result.error)
        setImpact(null)
      } else {
        setImpactError(null)
        setImpact(result.impact ?? null)
      }
    })
  }, [open, organizationId, planId, agreedUserLimit, agreedBranchLimit])

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
            <Select name="planId" value={planId} onValueChange={setPlanId}>
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
              <Input
                id="agreedUserLimit"
                name="agreedUserLimit"
                type="number"
                min={1}
                value={agreedUserLimit}
                onChange={(e) => setAgreedUserLimit(e.target.value)}
                placeholder="Plan default"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agreedBranchLimit">Agreed branch limit</Label>
              <Input
                id="agreedBranchLimit"
                name="agreedBranchLimit"
                type="number"
                min={1}
                value={agreedBranchLimit}
                onChange={(e) => setAgreedBranchLimit(e.target.value)}
                placeholder="Plan default"
              />
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

          {impactError && (
            <Alert variant="destructive">
              <AlertDescription>{impactError}</AlertDescription>
            </Alert>
          )}

          {impact && (
            <div className="grid gap-2 rounded-md border border-border p-3 text-sm">
              <div className="font-medium">Impact of this change</div>
              {impact.blocked && (
                <Alert variant="destructive">
                  <AlertDescription>{impact.blockReasons.join(" ")}</AlertDescription>
                </Alert>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  Current plan: <span className="font-medium">{impact.currentPlan ? `${impact.currentPlan.name} (${impact.currentPlan.code})` : "None"}</span>
                </div>
                <div>
                  New plan: <span className="font-medium">{impact.newPlan.name} ({impact.newPlan.code})</span>
                </div>
                <div>
                  Active users: <span className="font-medium">{impact.currentUserCount}</span> / new limit{" "}
                  <span className="font-medium">{impact.effectiveNewUserLimit ?? "Unlimited"}</span>
                </div>
                <div>
                  Active branches: <span className="font-medium">{impact.currentBranchCount}</span> / new limit{" "}
                  <span className="font-medium">{impact.effectiveNewBranchLimit ?? "Unlimited"}</span>
                </div>
              </div>
              {(impact.modulesToBeAdded.length > 0 || impact.modulesToBeRemoved.length > 0) && (
                <div className="grid gap-1">
                  {impact.modulesToBeAdded.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-xs text-muted-foreground">New plan default adds:</span>
                      {impact.modulesToBeAdded.map((m: ModuleKey) => (
                        <Badge key={m} variant="success" className="text-[10px]">
                          {MODULE_LABELS[m]}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {impact.modulesToBeRemoved.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-xs text-muted-foreground">Not in new plan default (currently enabled — stays enabled unless you separately reset to plan defaults):</span>
                      {impact.modulesToBeRemoved.map((m: ModuleKey) => (
                        <Badge key={m} variant="warning" className="text-[10px]">
                          {MODULE_LABELS[m]}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="submit" disabled={pending || Boolean(impact?.blocked)}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
