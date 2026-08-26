"use client"

import Link from "next/link"
import { useActionState, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  confirmAppointmentAction,
  markArrivedAction,
  checkInAction,
  callPatientAction,
  completeConsultationAction,
  cancelAppointmentAction,
  markNoShowAction,
} from "@/app/(dashboard)/appointments/actions"
import { startEncounterAction, type ActionState } from "@/app/(dashboard)/encounters/actions"
import type { $Enums } from "@/generated/prisma/client"

type Status = $Enums.AppointmentStatus

const initialState: ActionState = {}

function StartEncounterForm({
  appointmentId,
  branchId,
  departmentId,
  patientId,
  providerId,
}: {
  appointmentId: string
  branchId: string
  departmentId: string | null
  patientId: string
  providerId: string
}) {
  const [state, formAction, pending] = useActionState(startEncounterAction, initialState)
  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="branchId" value={branchId} />
      {departmentId && <input type="hidden" name="departmentId" value={departmentId} />}
      <input type="hidden" name="patientId" value={patientId} />
      <input type="hidden" name="providerId" value={providerId} />
      <input type="hidden" name="encounterType" value="consultation" />
      <Button size="sm" type="submit" disabled={pending}>
        {pending ? "Starting..." : "Start encounter"}
      </Button>
      {state.error && <p className="mt-1 text-xs text-destructive">{state.error}</p>}
    </form>
  )
}

export function AppointmentStatusActions({
  appointmentId,
  status,
  canCheckin,
  canCancel,
  canStartEncounter,
  encounterId,
  branchId,
  departmentId = null,
  patientId,
  providerId,
}: {
  appointmentId: string
  status: Status
  canCheckin: boolean
  canCancel: boolean
  canStartEncounter?: boolean
  encounterId?: string | null
  branchId?: string
  departmentId?: string | null
  patientId?: string
  providerId?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [reason, setReason] = useState("")

  function run(fn: () => Promise<void>) {
    startTransition(async () => {
      await fn()
      router.refresh()
    })
  }

  const buttons: React.ReactNode[] = []

  if (canCheckin && status === "scheduled") {
    buttons.push(
      <Button key="confirm" size="sm" variant="outline" disabled={pending} onClick={() => run(() => confirmAppointmentAction(appointmentId))}>
        Confirm
      </Button>
    )
  }
  if (canCheckin && (status === "scheduled" || status === "confirmed")) {
    buttons.push(
      <Button key="arrived" size="sm" variant="outline" disabled={pending} onClick={() => run(() => markArrivedAction(appointmentId))}>
        Mark arrived
      </Button>
    )
  }
  if (canCheckin && (status === "scheduled" || status === "confirmed" || status === "arrived")) {
    buttons.push(
      <Button key="checkin" size="sm" disabled={pending} onClick={() => run(() => checkInAction(appointmentId))}>
        Check in
      </Button>
    )
  }
  if (encounterId) {
    buttons.push(
      <Button key="open-encounter" size="sm" variant="outline" asChild>
        <Link href={`/encounters/${encounterId}`}>Open encounter</Link>
      </Button>
    )
  } else if (canStartEncounter && branchId && patientId && providerId && (status === "waiting" || status === "in_consultation")) {
    buttons.push(
      <StartEncounterForm
        key="start-encounter"
        appointmentId={appointmentId}
        branchId={branchId}
        departmentId={departmentId}
        patientId={patientId}
        providerId={providerId}
      />
    )
  }
  if (canCheckin && status === "waiting") {
    buttons.push(
      <Button key="call" size="sm" variant="outline" disabled={pending} onClick={() => run(() => callPatientAction(appointmentId))}>
        Call patient
      </Button>
    )
  }
  if (canCheckin && status === "in_consultation" && !encounterId) {
    buttons.push(
      <Button key="complete" size="sm" variant="outline" disabled={pending} onClick={() => run(() => completeConsultationAction(appointmentId))}>
        Complete
      </Button>
    )
  }
  if (canCancel && (status === "scheduled" || status === "confirmed")) {
    buttons.push(
      <Button key="noshow" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => markNoShowAction(appointmentId))}>
        No-show
      </Button>
    )
  }
  if (canCancel && ["scheduled", "confirmed", "arrived", "checked_in", "waiting"].includes(status)) {
    buttons.push(
      <Button key="cancel" size="sm" variant="ghost" disabled={pending} onClick={() => setCancelOpen(true)}>
        Cancel
      </Button>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {buttons}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel appointment</DialogTitle>
          </DialogHeader>
          <Input placeholder="Reason for cancellation" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={pending || !reason.trim()}
              onClick={() => {
                setCancelOpen(false)
                run(() => cancelAppointmentAction(appointmentId, reason))
              }}
            >
              Cancel appointment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
