"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { FormSection, FormFieldFull } from "@/components/ui/form-section"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { MODULE_KEYS, MODULE_LABELS } from "@/lib/platform/entitlements-shared"
import { createPlanAction, updatePlanAction, type PlanActionState } from "@/app/platform/plans/actions"

const initialState: PlanActionState = {}

type PlanFields = {
  id: string
  code: string
  name: string
  description: string | null
  active: boolean
  userLimit: number | null
  branchLimit: number | null
  defaultModuleKeys: string[]
  notes: string | null
}

export function PlanDialog({ plan }: { plan?: PlanFields }) {
  const boundAction = plan ? updatePlanAction.bind(null, plan.id) : createPlanAction
  const { open, setOpen, state, pending, submit } = useActionDialog<PlanActionState>(boundAction, initialState)
  const [selectedModules, setSelectedModules] = useState<string[]>(plan?.defaultModuleKeys ?? [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={plan ? "outline" : "default"}>
          {plan ? "Edit" : "New plan"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{plan ? "Edit plan" : "New commercial plan"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="code">Code</Label>
              <Input id="code" name="code" defaultValue={plan?.code} placeholder="starter" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={plan?.name} placeholder="Starter" required />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" defaultValue={plan?.description ?? ""} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="userLimit">User limit (blank = unlimited)</Label>
              <Input id="userLimit" name="userLimit" type="number" min={1} defaultValue={plan?.userLimit ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="branchLimit">Branch limit (blank = unlimited)</Label>
              <Input id="branchLimit" name="branchLimit" type="number" min={1} defaultValue={plan?.branchLimit ?? ""} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="active" defaultChecked={plan?.active ?? true} /> Active (selectable when provisioning)
          </label>
          <FormSection title="Default modules" grid={false} className="border-0 p-0">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {MODULE_KEYS.map((key) => (
                <label key={key} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm">
                  <Checkbox
                    name="defaultModuleKeys"
                    value={key}
                    checked={selectedModules.includes(key)}
                    onCheckedChange={(checked) => setSelectedModules((prev) => (checked === true ? [...prev, key] : prev.filter((k) => k !== key)))}
                  />
                  {MODULE_LABELS[key]}
                </label>
              ))}
            </div>
          </FormSection>
          <FormFieldFull>
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" defaultValue={plan?.notes ?? ""} rows={2} />
          </FormFieldFull>
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
