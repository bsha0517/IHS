"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useActionDialog } from "@/hooks/use-action-dialog"
import {
  requestAuthorizationAction,
  approveAuthorizationAction,
  denyAuthorizationAction,
  type ActionState,
} from "@/app/(dashboard)/claims/actions"

const initialState: ActionState = {}

export function RequestAuthorizationDialog({
  patientId,
  coverages,
}: {
  patientId: string
  coverages: { id: string; label: string }[]
}) {
  const { open, setOpen, state, pending, submit } = useActionDialog(requestAuthorizationAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="size-3.5" /> Request authorization
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Request prior authorization</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="patientId" value={patientId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="patientCoverageId">Coverage</Label>
            <Select name="patientCoverageId" required>
              <SelectTrigger id="patientCoverageId" className="w-full">
                <SelectValue placeholder="Select coverage" />
              </SelectTrigger>
              <SelectContent>
                {coverages.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" placeholder="What's being requested" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DecideAuthorizationDialog({
  authorizationId,
  patientId,
  decision,
}: {
  authorizationId: string
  patientId: string
  decision: "approve" | "deny"
}) {
  const action = decision === "approve" ? approveAuthorizationAction : denyAuthorizationAction
  const { open, setOpen, state, pending, submit } = useActionDialog(action, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={decision === "approve" ? "default" : "outline"}>
          {decision === "approve" ? "Approve" : "Deny"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{decision === "approve" ? "Approve authorization" : "Deny authorization"}</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-4">
          <input type="hidden" name="authorizationId" value={authorizationId} />
          <input type="hidden" name="patientId" value={patientId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {decision === "approve" && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="authNumber">Authorization number</Label>
                <Input id="authNumber" name="authNumber" required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="validFrom">Valid from</Label>
                  <Input id="validFrom" name="validFrom" type="date" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="validUntil">Valid until</Label>
                  <Input id="validUntil" name="validUntil" type="date" />
                </div>
              </div>
            </>
          )}
          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : decision === "approve" ? "Approve" : "Deny"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
