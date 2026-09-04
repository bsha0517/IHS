import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listMyQueue, listBranchQueue } from "@/lib/domains/appointments/queue"
import { getProviderForUser } from "@/lib/domains/providers/service"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { formatTime, formatWaitingMinutes, formatDateTime } from "@/lib/utils/dates"
import { APPOINTMENT_STATUS_LABEL } from "@/lib/utils/appointment-status"
import { AppointmentStatusActions, StartEncounterForm } from "@/app/(dashboard)/appointments/status-actions"
import { AlertTriangle } from "lucide-react"

export default async function QueuePage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "appointment.view")) redirect("/dashboard")

  const isProvider = await getProviderForUser(session.user.id)
  const canCheckin = can(session, "appointment.checkin")

  const myQueue = isProvider ? await listMyQueue(session) : []

  // P3.3 §4/§6: this is the exact same bug as reception/page.tsx and
  // appointments/page.tsx (see those pages' comments) — but here it's more
  // severe, since Doctor (this page's own primary user, via "My Queue")
  // has `appointment.checkin` and therefore `canCheckin` was true, meaning
  // this page called the org-wide-`branch.view`-gated `listBranches`
  // unconditionally and crashed for Doctor before My Queue ever rendered.
  // Confirmed by reading the seeded Doctor role permissions directly.
  const branches = canCheckin ? await listAccessibleBranches(session) : []
  const branchId = session.activeBranchId ?? branches[0]?.id
  const branchName = branches.find((b) => b.id === branchId)?.name
  const branchQueue = canCheckin && branchId ? await listBranchQueue(session, branchId) : []

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Queue"
        description={
          <>
            Patients waiting or in consultation today.
            {/* P3.1 §20: active branch context must be obvious, not implicit — spelled out here at the page level, not just inside the Branch Queue card below. */}
            {canCheckin && branchName && ` Viewing: ${branchName}.`}
          </>
        }
      />

      {isProvider && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">My Queue</CardTitle>
            <CardDescription>{myQueue.length} patient(s)</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {myQueue.length === 0 && <EmptyState title="No patients waiting" description="No patients are currently waiting for you." />}
            {myQueue.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
                <div className="flex items-center gap-3">
                  <Badge variant="outline">{a.queueEntry?.tokenNumber}</Badge>
                  <div>
                    <Link href={`/patients/${a.patientId}`} className="font-medium hover:underline">
                      {a.patient.firstName} {a.patient.lastName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {a.patient.mrn} · {formatTime(a.startTime)}
                      {a.service && ` · ${a.service.name}`}
                      {a.queueEntry?.checkedInAt && ` · Waiting ${formatWaitingMinutes(a.queueEntry.checkedInAt)}`}
                    </p>
                    {/* P3.4 §18/§19: the handoff signal — a nurse may have
                        already recorded vitals before the doctor opens the
                        encounter; this is real persisted data, never a
                        fabricated "ready" state. */}
                    <p className="text-xs text-muted-foreground">
                      {a.encounter?.vitalSigns[0]
                        ? `Vitals recorded ${formatDateTime(a.encounter.vitalSigns[0].recordedAt)}`
                        : "Vitals not recorded"}
                    </p>
                  </div>
                </div>
                <AppointmentStatusActions
                  appointmentId={a.id}
                  status={a.status}
                  startTime={a.startTime}
                  canCheckin
                  canCancel={false}
                  canStartEncounter={can(session, "encounter.create")}
                  encounterId={a.encounter?.id}
                  branchId={a.branchId}
                  departmentId={a.departmentId}
                  patientId={a.patientId}
                  providerId={isProvider?.id}
                  showHistoryLink={false}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {canCheckin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Branch Queue</CardTitle>
            {/* P3.4 §4/§5: doubles as the nurse/pre-consultation view — the
                same waiting/in-consultation list Receptionist already saw,
                now also carrying vitals-recorded/alert signals and an
                Open Pre-Consultation action for whoever holds
                encounter.create (Nurse and Doctor both already do). No
                second queue, no clinic-settings toggle — reception-only
                staff simply don't see the extra column/action, since they
                lack that permission. */}
            <CardDescription>{branchName ?? "No branch"}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {branchQueue.length === 0 && <EmptyState title="Queue is empty" description="No one is currently waiting or in consultation." />}
            {branchQueue.map((a) => {
              const hasAlert = a.patient.allergies.length > 0 || a.patient.conditions.length > 0
              const lastVitals = a.encounter?.vitalSigns[0]
              return (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">{a.queueEntry?.tokenNumber}</Badge>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <Link href={`/patients/${a.patientId}`} className="font-medium hover:underline">
                          {a.patient.firstName} {a.patient.lastName}
                        </Link>
                        {hasAlert && (
                          <span title="Has a flagged allergy or condition" className="flex items-center text-destructive">
                            <AlertTriangle className="size-3.5" />
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {a.patient.mrn} · {a.provider.firstName} {a.provider.lastName}
                        {a.service && ` · ${a.service.name}`}
                        {a.queueEntry?.checkedInAt && ` · Waiting ${formatWaitingMinutes(a.queueEntry.checkedInAt)}`}
                      </p>
                      {can(session, "vitals.record") && (
                        <p className="text-xs text-muted-foreground">
                          {lastVitals ? `Vitals recorded ${formatDateTime(lastVitals.recordedAt)}` : "Vitals not recorded"}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={a.status} label={APPOINTMENT_STATUS_LABEL[a.status]} />
                    {can(session, "encounter.create") &&
                      (a.encounter ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link href={`/encounters/${a.encounter.id}`}>Open encounter</Link>
                        </Button>
                      ) : (
                        (a.status === "waiting" || a.status === "in_consultation") && (
                          <StartEncounterForm
                            appointmentId={a.id}
                            branchId={a.branchId}
                            departmentId={a.departmentId}
                            patientId={a.patientId}
                            providerId={a.providerId}
                            label="Open Pre-Consultation"
                            pendingLabel="Opening..."
                          />
                        )
                      ))}
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {!isProvider && !canCheckin && (
        <p className="text-sm text-muted-foreground">You don&apos;t have a queue to view.</p>
      )}
    </div>
  )
}
