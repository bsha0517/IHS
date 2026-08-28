"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { calculateAge, formatDateTime } from "@/lib/utils/dates"
import {
  completeEncounterAction,
  finalizeEncounterAction,
  cancelEncounterAction,
  markEncounterEnteredInErrorAction,
} from "@/app/(dashboard)/encounters/actions"
import type { Patient, PatientAllergy, PatientCondition, Provider, Encounter } from "@/generated/prisma/client"

type EncounterWithRelations = Encounter & {
  patient: Patient & { allergies: PatientAllergy[]; conditions: PatientCondition[] }
  provider: Provider
}

export function EncounterHeader({
  encounter,
  canFinalize,
}: {
  encounter: EncounterWithRelations
  canFinalize: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [cancelMode, setCancelMode] = useState<"cancel" | "entered_in_error" | null>(null)
  const [reason, setReason] = useState("")

  const alerts = [
    ...encounter.patient.allergies.filter((a) => a.isAlert).map((a) => `Allergy: ${a.allergen}`),
    ...encounter.patient.conditions.filter((c) => c.isAlert).map((c) => c.description),
  ]

  function run(fn: () => Promise<void>) {
    startTransition(async () => {
      await fn()
      router.refresh()
    })
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/patients/${encounter.patientId}`} className="text-xl font-semibold tracking-tight hover:underline">
              {encounter.patient.firstName} {encounter.patient.lastName}
            </Link>
            <Badge variant="outline">{encounter.patient.mrn}</Badge>
            <span className="text-sm text-muted-foreground">
              {calculateAge(encounter.patient.dob)}y · {encounter.patient.gender}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {encounter.encounterNumber} · {encounter.encounterType.replace("_", " ")} with Dr. {encounter.provider.lastName} ·
            started {formatDateTime(encounter.startAt)}
          </p>
          {alerts.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2">
              {alerts.map((alert, i) => (
                <span key={i} className="flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
                  <AlertTriangle className="size-3.5" /> {alert}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={encounter.status === "finalized" ? "default" : "outline"} className="capitalize">
            {encounter.status}
          </Badge>
          {encounter.status === "active" && (
            <Button size="sm" disabled={pending} onClick={() => run(() => completeEncounterAction(encounter.id))}>
              Complete encounter
            </Button>
          )}
          {encounter.status === "completed" && canFinalize && (
            <Button size="sm" disabled={pending} onClick={() => run(() => finalizeEncounterAction(encounter.id))}>
              Finalize
            </Button>
          )}
          {["draft", "active"].includes(encounter.status) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setReason("")
                setCancelMode("cancel")
              }}
            >
              Cancel
            </Button>
          )}
          {canFinalize && !["cancelled", "entered_in_error"].includes(encounter.status) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setReason("")
                setCancelMode("entered_in_error")
              }}
            >
              Entered in error
            </Button>
          )}
        </div>
      </CardContent>

      <Dialog open={cancelMode !== null} onOpenChange={(open) => !open && setCancelMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{cancelMode === "entered_in_error" ? "Mark encounter entered in error" : "Cancel encounter"}</DialogTitle>
          </DialogHeader>
          <Input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelMode(null)}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={pending || !reason.trim()}
              onClick={() => {
                const mode = cancelMode
                setCancelMode(null)
                run(() => (mode === "entered_in_error" ? markEncounterEnteredInErrorAction(encounter.id, reason) : cancelEncounterAction(encounter.id, reason)))
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
