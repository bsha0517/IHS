"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { createPilotUatAction, recordUatScenarioAction, completePilotUatAction, type ActionState } from "@/app/platform/organizations/[id]/uat/actions"

const initialState: ActionState = {}

export function NewUatCycleDialog({ organizationId }: { organizationId: string }) {
  const boundAction = createPilotUatAction.bind(null, organizationId)
  const { open, setOpen, state, pending, submit } = useActionDialog(boundAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New UAT cycle</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a new pilot UAT cycle</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-3">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="cycleLabel">Cycle label</Label>
            <Input id="cycleLabel" name="cycleLabel" placeholder="UAT Cycle 1" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="testerName">Tester</Label>
            <Input id="testerName" name="testerName" placeholder="Clinic staff or Avant implementation team member" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Starting..." : "Start cycle"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const SCENARIO_AREAS = ["reception", "doctor", "inventory", "billing", "finance", "laboratory", "radiology", "pharmacy", "multi_user", "multi_branch", "security"]

export function AddScenarioDialog({ organizationId, uatId }: { organizationId: string; uatId: string }) {
  const boundAction = recordUatScenarioAction.bind(null, organizationId, uatId)
  const { open, setOpen, state, pending, submit } = useActionDialog(boundAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Add scenario result
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a pilot checklist scenario</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-3">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="area">Area</Label>
            <Select name="area" defaultValue={SCENARIO_AREAS[0]}>
              <SelectTrigger id="area" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCENARIO_AREAS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="scenario">Scenario</Label>
            <Input id="scenario" name="scenario" placeholder="e.g. Patient registration" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="passed">Result</Label>
            <Select name="passed" defaultValue="unknown">
              <SelectTrigger id="passed" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">Passed</SelectItem>
                <SelectItem value="false">Failed</SelectItem>
                <SelectItem value="unknown">Not yet run</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" rows={2} />
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

export function CompleteUatDialog({ organizationId, uatId }: { organizationId: string; uatId: string }) {
  const boundAction = completePilotUatAction.bind(null, organizationId, uatId)
  const { open, setOpen, state, pending, submit } = useActionDialog(boundAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Complete / sign off</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete this UAT cycle</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-3">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="result">Result</Label>
            <Select name="result" defaultValue="passed">
              <SelectTrigger id="result" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="passed">Passed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="in_progress">Still in progress</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="blockers">Blockers</Label>
            <Textarea id="blockers" name="blockers" rows={2} placeholder="Anything that failed or blocked this cycle" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" rows={2} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="signOff" /> Sign off this cycle as reviewed and accepted
          </label>
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
