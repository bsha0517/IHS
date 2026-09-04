"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, ArrowLeft, CalendarDays } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { calculateAge, formatDateTime } from "@/lib/utils/dates"
import {
  completeEncounterAction,
  finalizeEncounterAction,
  cancelEncounterAction,
  markEncounterEnteredInErrorAction,
} from "@/app/(dashboard)/encounters/actions"
import type { Patient, PatientAllergy, PatientCondition, Provider, Encounter, Appointment, Service } from "@/generated/prisma/client"

type EncounterWithRelations = Encounter & {
  patient: Patient & { allergies: PatientAllergy[]; conditions: PatientCondition[] }
  provider: Provider
  appointment: (Appointment & { service: Service | null }) | null
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
  // P3.3 §23/§24/§33: these status-changing actions previously had no error
  // handling at all on the client side — a rejected transition (e.g. "This
  // encounter is already finalized") became an unhandled promise rejection,
  // surfacing only as the generic route-level "Something went wrong"
  // boundary instead of the specific, actionable message the domain layer
  // already throws.
  const [actionError, setActionError] = useState<string | null>(null)

  const alerts = [
    ...encounter.patient.allergies.filter((a) => a.isAlert).map((a) => `Allergy: ${a.allergen}`),
    ...encounter.patient.conditions.filter((c) => c.isAlert).map((c) => c.description),
  ]

  function run(fn: () => Promise<void>) {
    setActionError(null)
    startTransition(async () => {
      try {
        await fn()
        router.refresh()
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "That action couldn't be completed.")
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {/* P3.3 §29: the encounter workspace previously had no way back to the
          queue or out to the appointment it came from — a doctor could only
          leave via the browser back button or by opening Patient 360. */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Link href="/queue" className="flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline">
          <ArrowLeft className="size-3.5" /> Back to Queue
        </Link>
        {encounter.appointmentId && (
          <Link
            href={`/appointments/${encounter.appointmentId}`}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
          >
            <CalendarDays className="size-3.5" /> Appointment
          </Link>
        )}
      </div>

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {/* P4.7A.1 §7 — the encounter workspace's own Patient/Encounter Context
          Bar, in the same visual language as Patient 360's context bar
          (border-l-4 border-l-primary card): who, why they're here, which
          encounter, which provider, and its current status — all in one
          scan, before the doctor has to read a single section below. */}
      <Card className="border-l-4 border-l-primary">
      <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/patients/${encounter.patientId}`} className="text-xl font-semibold tracking-tight hover:underline">
              {encounter.patient.firstName} {encounter.patient.lastName}
            </Link>
            <Badge variant="outline" className="font-mono">{encounter.patient.mrn}</Badge>
            <span className="text-sm text-muted-foreground">
              {calculateAge(encounter.patient.dob)}y · {encounter.patient.gender}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {encounter.encounterNumber} · {encounter.encounterType.replace("_", " ")} with Dr. {encounter.provider.lastName} ·
            started {formatDateTime(encounter.startAt)}
          </p>
          {/* P3.4 §9/§16: "why is the patient here" — the appointment's own
              service and free-text notes (this schema has no separate
              `reason` field), shown as context only. Never copied into the
              doctor's chiefComplaint field — that stays a distinct,
              separately-authored clinical concept. */}
          {(encounter.appointment?.service || encounter.appointment?.notes) && (
            <p className="text-sm text-muted-foreground">
              {encounter.appointment.service && <>Booked for: {encounter.appointment.service.name}</>}
              {encounter.appointment.service && encounter.appointment.notes && " · "}
              {encounter.appointment.notes && <>Note: {encounter.appointment.notes}</>}
            </p>
          )}
          {alerts.length > 0 && (
            <div className="mt-1 flex flex-col gap-1 rounded-md border border-destructive-border bg-destructive-surface p-2">
              {alerts.map((alert, i) => (
                <span key={i} className="flex items-center gap-2 text-xs font-medium text-destructive">
                  <AlertTriangle className="size-3.5 shrink-0" /> {alert}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          <StatusBadge status={encounter.status} />
          <div className="flex flex-wrap items-center gap-2">
            {/* P3.4 §20/§23: previously shown to anyone with `encounter.create`
                — both Doctor and Nurse hold it, but only Doctor holds
                `encounter.finalize`. Before this batch that distinction never
                mattered in practice (only Doctor/Nurse could reach this page
                at all, and only Doctor's own queue linked into it) — now that
                a nurse legitimately opens this same workspace for
                pre-consultation vitals, "Complete encounter" needs to stay a
                physician-level action so a nurse can't prematurely lock the
                consultation (and flip the linked appointment to `completed`)
                before the doctor has even seen the patient. Reuses the same
                `canFinalize` prop already gating the Finalize button below,
                not a new permission. */}
            {encounter.status === "active" && canFinalize && (
              <Button size="sm" disabled={pending} onClick={() => run(() => completeEncounterAction(encounter.id))}>
                Complete encounter
              </Button>
            )}
            {encounter.status === "completed" && canFinalize && (
              <Button size="sm" disabled={pending} onClick={() => run(() => finalizeEncounterAction(encounter.id))}>
                Finalize encounter
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
    </div>
  )
}
