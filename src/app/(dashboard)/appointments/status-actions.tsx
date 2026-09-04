"use client"

import Link from "next/link"
import { History } from "lucide-react"
import { useActionState, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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
import { RescheduleDialog } from "@/app/(dashboard)/appointments/reschedule-dialog"
import type { $Enums } from "@/generated/prisma/client"

type Status = $Enums.AppointmentStatus

const initialState: ActionState = {}

/**
 * P3.4 §8/§20: reused as-is by the nurse/pre-consultation queue card, not
 * duplicated — it's the exact same `startEncounterAction` call (same
 * idempotent-start behavior, same unique `Encounter.appointmentId` guard),
 * only the button label differs by call site. `providerId` is always the
 * appointment's own assigned provider (the physician of record), never the
 * signed-in nurse's identity — `Encounter.providerId` represents who the
 * consultation is with, not who is currently acting on the record; the
 * nurse's own identity is separately attributed via `VitalSign.recordedBy`.
 */
export function StartEncounterForm({
  appointmentId,
  branchId,
  departmentId,
  patientId,
  providerId,
  label = "Start encounter",
  pendingLabel = "Starting...",
}: {
  appointmentId: string
  branchId: string
  departmentId: string | null
  patientId: string
  providerId: string
  label?: string
  pendingLabel?: string
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
        {pending ? pendingLabel : label}
      </Button>
      {state.error && <p className="mt-1 text-xs text-destructive">{state.error}</p>}
    </form>
  )
}

export function AppointmentStatusActions({
  appointmentId,
  status,
  startTime,
  canCheckin,
  canCancel,
  canReschedule = false,
  canStartEncounter,
  encounterId,
  branchId,
  departmentId = null,
  patientId,
  providerId,
  providers = [],
  showHistoryLink = true,
}: {
  appointmentId: string
  status: Status
  /** P3.1 §16: gates No-show's visibility to appointments whose scheduled time has actually passed. */
  startTime?: Date
  canCheckin: boolean
  canCancel: boolean
  canReschedule?: boolean
  canStartEncounter?: boolean
  encounterId?: string | null
  branchId?: string
  departmentId?: string | null
  patientId?: string
  providerId?: string
  providers?: { id: string; firstName: string; lastName: string }[]
  /** Some call sites (e.g. a provider's own queue) already sit one click from a fuller history view — set false there to avoid a redundant link. */
  showHistoryLink?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [noShowOpen, setNoShowOpen] = useState(false)
  // Captured once at mount (a lazy initializer, not a direct render-time
  // call) rather than read fresh on every render — this component
  // remounts/refreshes via router.refresh() after every status-changing
  // action anyway, so "now" here only ever needs to be as fresh as the
  // page's own last load, the same snapshot-not-ticking discipline as
  // formatWaitingMinutes.
  const [now] = useState(() => Date.now())

  function run(fn: () => Promise<void>) {
    startTransition(async () => {
      await fn()
      router.refresh()
    })
  }

  const scheduledTimePassed = !startTime || startTime.getTime() <= now

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
  if (canReschedule && (status === "scheduled" || status === "confirmed")) {
    buttons.push(
      <RescheduleDialog key="reschedule" appointmentId={appointmentId} branchId={branchId} providers={providers} defaultProviderId={providerId} />
    )
  }
  // P3.1 §16: only offered once the scheduled time has actually passed — a
  // receptionist shouldn't be able to no-show an appointment that's still
  // hours away. Server-side validation (the same status-transition guard
  // every other action here goes through) remains authoritative regardless;
  // this is a UI-level guide, not a new business rule.
  if (canCancel && (status === "scheduled" || status === "confirmed") && scheduledTimePassed) {
    buttons.push(
      <Button key="noshow" size="sm" variant="ghost" disabled={pending} onClick={() => setNoShowOpen(true)}>
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
  if (showHistoryLink) {
    buttons.push(
      <Button key="history" size="sm" variant="ghost" asChild aria-label="View appointment history">
        <Link href={`/appointments/${appointmentId}`}>
          <History /> History
        </Link>
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
            <DialogDescription>
              This cancels the appointment and keeps it in history — it cannot be undone from here. A reason is required.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Reason for cancellation"
            aria-label="Reason for cancellation"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
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
                setReason("")
              }}
            >
              Cancel appointment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={noShowOpen} onOpenChange={setNoShowOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as no-show?</DialogTitle>
            <DialogDescription>
              The patient did not arrive for this appointment. This removes it from the active queue and cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoShowOpen(false)}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setNoShowOpen(false)
                run(() => markNoShowAction(appointmentId))
              }}
            >
              Mark no-show
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
