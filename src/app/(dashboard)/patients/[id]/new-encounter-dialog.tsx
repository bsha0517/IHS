"use client"

import { useActionState, useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { startEncounterAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import type { Episode } from "@/generated/prisma/client"

const initialState: ActionState = {}

const ENCOUNTER_TYPES = [
  "consultation",
  "follow_up",
  "procedure",
  "therapy",
  "emergency_walk_in",
  "diagnostic",
  "teleconsultation",
] as const

export function NewStandaloneEncounterDialog({
  patientId,
  episodes,
  branches,
  providers,
}: {
  patientId: string
  episodes: Episode[]
  branches: { id: string; name: string }[]
  providers: { id: string; firstName: string; lastName: string }[]
}) {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(startEncounterAction, initialState)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus /> New encounter (walk-in)
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New standalone encounter</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="patientId" value={patientId} />
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="branchId">Branch</Label>
            <Select name="branchId" required>
              <SelectTrigger id="branchId" className="w-full">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="providerId">Provider</Label>
            <Select name="providerId" required>
              <SelectTrigger id="providerId" className="w-full">
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.firstName} {p.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="encounterType">Encounter type</Label>
            <Select name="encounterType" defaultValue="consultation">
              <SelectTrigger id="encounterType" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCOUNTER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {episodes.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="episodeId">Episode (optional)</Label>
              <Select name="episodeId">
                <SelectTrigger id="episodeId" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {episodes.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Starting..." : "Start encounter"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
