import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowLeft, CalendarClock } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getAppointment } from "@/lib/domains/appointments/service"
import { listProviders } from "@/lib/domains/providers/service"
import { loadOrNotFound } from "@/lib/platform/not-found"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { DetailHeader } from "@/components/ui/page-header"
import { formatDateTime, formatWaitingMinutes } from "@/lib/utils/dates"
import { APPOINTMENT_STATUS_LABEL } from "@/lib/utils/appointment-status"
import { AppointmentStatusActions } from "@/app/(dashboard)/appointments/status-actions"

/**
 * P3.1 §8/§14/§18: previously there was no per-appointment detail view at
 * all — "View Appointment History" (§8's own named quick action) and the
 * reschedule chain (§14: "Original appointment → Rescheduled → New
 * appointment") had nowhere to render, even though the underlying data
 * (`AppointmentStatusHistory`, `rescheduledFrom`/`rescheduledTo`) already
 * existed and was already fetched by `getAppointment` — just never shown
 * anywhere. This page is read-plus-act (the same status actions every
 * other list already offers), not a new workflow.
 *
 * Targeted backlog closure, item 4: a not-found/wrong-branch id now
 * resolves to the app's existing, already-correctly-worded not-found
 * boundary (`loadOrNotFound`) instead of the fully generic "Something went
 * wrong" error boundary every `[id]` page previously fell through to.
 */
export default async function AppointmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "appointment.view")) redirect("/dashboard")

  const { id } = await params
  const appointment = await loadOrNotFound(() => getAppointment(session, id))
  const providers = await listProviders(session)

  const canCheckin = can(session, "appointment.checkin")
  const canCancel = can(session, "appointment.cancel")
  const canReschedule = can(session, "appointment.reschedule")
  const canStartEncounter = can(session, "encounter.create")

  const providerOptions = providers.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName }))
  const rescheduledTo = appointment.rescheduledTo[0]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href="/appointments">
            <ArrowLeft /> Back to appointments
          </Link>
        </Button>
        <DetailHeader
          module="appointments"
          title={appointment.appointmentNumber}
          meta={
            <>
              <Link href={`/patients/${appointment.patientId}`} className="hover:underline">
                {appointment.patient.firstName} {appointment.patient.lastName}
              </Link>{" "}
              ({appointment.patient.mrn}) · {appointment.provider.firstName} {appointment.provider.lastName}
            </>
          }
          badge={
            <StatusBadge
              status={appointment.status}
              label={`${APPOINTMENT_STATUS_LABEL[appointment.status]}${appointment.queueEntry ? ` · ${appointment.queueEntry.tokenNumber}` : ""}`}
            />
          }
        />
      </div>

      {(appointment.rescheduledFrom || rescheduledTo) && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex flex-wrap items-center gap-2 pt-6 text-sm">
            <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
            {appointment.rescheduledFrom && (
              <span>
                Rescheduled from{" "}
                <Link href={`/appointments/${appointment.rescheduledFrom.id}`} className="font-medium hover:underline">
                  {appointment.rescheduledFrom.appointmentNumber}
                </Link>{" "}
                (originally {formatDateTime(appointment.rescheduledFrom.startTime)}).
              </span>
            )}
            {rescheduledTo && (
              <span>
                This appointment was rescheduled — see{" "}
                <Link href={`/appointments/${rescheduledTo.id}`} className="font-medium hover:underline">
                  {rescheduledTo.appointmentNumber}
                </Link>{" "}
                for the new time.
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Appointment details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1.5 text-sm">
            <Row label="Date/time" value={`${formatDateTime(appointment.startTime)} – ${formatDateTime(appointment.endTime)}`} />
            <Row label="Branch" value={appointment.branch?.name ?? "—"} />
            <Row label="Service" value={appointment.service?.name ?? "—"} />
            <Row label="Room" value={appointment.room?.name ?? "—"} />
            <Row label="Department" value={appointment.department?.name ?? "—"} />
            <Row label="Booking source" value={appointment.bookingSource.replace("_", " ")} />
            <Row label="Notes" value={appointment.notes ?? "—"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Queue</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1.5 text-sm">
            {appointment.queueEntry ? (
              <>
                <Row label="Token" value={appointment.queueEntry.tokenNumber} />
                <Row label="Arrived" value={appointment.queueEntry.arrivedAt ? formatDateTime(appointment.queueEntry.arrivedAt) : "—"} />
                <Row label="Checked in" value={appointment.queueEntry.checkedInAt ? formatDateTime(appointment.queueEntry.checkedInAt) : "—"} />
                <Row
                  label="Waited before being called"
                  value={
                    appointment.queueEntry.checkedInAt
                      ? formatWaitingMinutes(appointment.queueEntry.checkedInAt, appointment.queueEntry.calledAt ?? undefined)
                      : "—"
                  }
                />
                <Row label="Called" value={appointment.queueEntry.calledAt ? formatDateTime(appointment.queueEntry.calledAt) : "—"} />
                <Row
                  label="Consultation"
                  value={
                    appointment.queueEntry.consultationStartAt
                      ? `${formatDateTime(appointment.queueEntry.consultationStartAt)}${appointment.queueEntry.consultationEndAt ? ` – ${formatDateTime(appointment.queueEntry.consultationEndAt)}` : " (in progress)"}`
                      : "—"
                  }
                />
              </>
            ) : (
              <p className="text-muted-foreground">This appointment has not been checked in yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <AppointmentStatusActions
            appointmentId={appointment.id}
            status={appointment.status}
            startTime={appointment.startTime}
            canCheckin={canCheckin}
            canCancel={canCancel}
            canReschedule={canReschedule}
            canStartEncounter={canStartEncounter}
            encounterId={appointment.encounter?.id}
            branchId={appointment.branchId}
            departmentId={appointment.departmentId}
            patientId={appointment.patientId}
            providerId={appointment.providerId}
            providers={providerOptions}
            showHistoryLink={false}
          />
        </CardContent>
      </Card>

      {/* P3.1 §18: the existing status-history records, not a new/duplicate history table. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent>
          {appointment.statusHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">No history recorded yet.</p>
          ) : (
            <ol className="grid gap-3">
              {appointment.statusHistory.map((h) => (
                <li key={h.id} className="flex items-start gap-3 text-sm">
                  <div className="mt-1 size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                  <div>
                    <p>
                      {h.fromStatus ? (
                        <>
                          {APPOINTMENT_STATUS_LABEL[h.fromStatus]} → <span className="font-medium">{APPOINTMENT_STATUS_LABEL[h.toStatus]}</span>
                        </>
                      ) : (
                        <span className="font-medium">{APPOINTMENT_STATUS_LABEL[h.toStatus]}</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(h.changedAt)} · {h.changedByUser ? `${h.changedByUser.firstName} ${h.changedByUser.lastName}` : "System"}
                      {h.reason ? ` · ${h.reason}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
