"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { StatusBadge } from "@/components/ui/status-badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useActionDialog } from "@/hooks/use-action-dialog"
import { updateImplementationTrainingAction, type ActionState } from "@/app/platform/organizations/[id]/implementation/actions"
import type { $Enums } from "@/generated/prisma/client"

const STATUSES: $Enums.ImplementationTrainingStatus[] = ["not_scheduled", "scheduled", "completed", "not_applicable"]
const initialState: ActionState = {}

type TrainingRow = {
  id: string
  area: string
  label: string
  status: $Enums.ImplementationTrainingStatus
  scheduledAt: Date | null
  notes: string | null
}

/**
 * P5.8 §15-17: implementation training only — no LMS features (no
 * certificates, exams, quizzes, or courses). Only areas whose module is
 * currently enabled ever appear here at all — `listImplementationTraining`
 * never seeds a row for a disabled module's area.
 */
export function TrainingCard({ organizationId, training }: { organizationId: string; training: TrainingRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Training</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {training.length === 0 ? (
          <p className="text-sm text-muted-foreground">No applicable training areas for this organization&apos;s current modules.</p>
        ) : (
          training.map((t) => <TrainingRow key={t.id} organizationId={organizationId} training={t} />)
        )}
      </CardContent>
    </Card>
  )
}

function TrainingRow({ organizationId, training }: { organizationId: string; training: TrainingRow }) {
  const [open, setOpen] = useState(false)
  const boundAction = updateImplementationTrainingAction.bind(null, organizationId, training.id)
  const { state, pending, submit } = useActionDialog(boundAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
        <span>{training.label}</span>
        <div className="flex items-center gap-2">
          <StatusBadge status={training.status} />
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              Update
            </Button>
          </DialogTrigger>
        </div>
      </div>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{training.label} training</DialogTitle>
        </DialogHeader>
        <form action={submit} className="grid gap-3">
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="status">Status</Label>
            <Select name="status" defaultValue={training.status}>
              <SelectTrigger id="status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="scheduledAt">Scheduled date</Label>
            <Input id="scheduledAt" name="scheduledAt" type="date" defaultValue={training.scheduledAt ? new Date(training.scheduledAt).toISOString().slice(0, 10) : ""} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" defaultValue={training.notes ?? ""} rows={2} />
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
