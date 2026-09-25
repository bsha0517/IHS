import Link from "next/link"
import { redirect } from "next/navigation"
import { UserPlus } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listAppointments } from "@/lib/domains/appointments/service"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listProviders } from "@/lib/domains/providers/service"
import { listServices } from "@/lib/domains/services/service"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { WorkspaceHeader } from "@/components/ui/page-header"
import { EmptyState } from "@/components/ui/empty-state"
import { formatTime, formatWaitingMinutes } from "@/lib/utils/dates"
import { APPOINTMENT_STATUS_LABEL } from "@/lib/utils/appointment-status"
import { NewAppointmentDialog } from "@/app/(dashboard)/appointments/new-appointment-dialog"
import { AppointmentStatusActions } from "@/app/(dashboard)/appointments/status-actions"

// P3.1 §7: what's still "in flight" today — separate from the terminal
// statuses (completed/cancelled/no_show/rescheduled) counted alongside them
// in the real, non-fake summary row below.
const ACTIVE_STATUSES = ["scheduled", "confirmed", "arrived", "checked_in", "waiting", "in_consultation"] as const
// P3.1 §5: every status this section's own spec names, in display order.
const SUMMARY_STATUSES = [
  "scheduled",
  "confirmed",
  "arrived",
  "checked_in",
  "waiting",
  "in_consultation",
  "completed",
  "cancelled",
  "no_show",
] as const

export default async function ReceptionPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "appointment.checkin")) redirect("/dashboard")

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)

  // P3.3 §4: this page only ever needed the branches *this* user can
  // actually operate at (to populate the New Appointment dialog's branch
  // select and to default `branchId` below) — `listBranches` requires the
  // org-wide `branch.view` permission, which Receptionist doesn't hold in
  // the seeded role set, crashing this page for that role entirely.
  // `listAccessibleBranches` (billing/cashier.ts — already used for the
  // identical "which branches can this session act at" need at POS) has no
  // permission requirement beyond being an authenticated session with
  // `branchIds`, and returns the same shape.
  const [branches, providers, services] = await Promise.all([
    listAccessibleBranches(session),
    listProviders(session),
    listServices(session),
  ])

  const branchId = session.activeBranchId ?? branches[0]?.id
  // P3.1 §5: one unfiltered fetch of the whole day (not just the "active"
  // subset the old version fetched) — the real summary row below needs
  // completed/cancelled/no-show counts too, and deriving every view from
  // one array in memory is both simpler and cheaper than a second query.
  const allToday = branchId
    ? await listAppointments(session, { branchId, from: today, to: tomorrow })
    : []

  const waiting = allToday.filter((a) => a.status === "waiting")
  const arrivals = allToday.filter((a) => ["scheduled", "confirmed", "arrived", "checked_in"].includes(a.status))
  const appointments = allToday.filter((a) => (ACTIVE_STATUSES as readonly string[]).includes(a.status))
  const canStartEncounter = can(session, "encounter.create")
  const canReschedule = can(session, "appointment.reschedule")
  const canCancel = can(session, "appointment.cancel")
  const branchName = branches.find((b) => b.id === branchId)?.name ?? "No branch"

  // Prisma's Decimal fields can't cross the Server->Client boundary.
  const providerOptions = providers.map((p) => ({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    defaultAppointmentDurationMinutes: p.defaultAppointmentDurationMinutes,
  }))
  const serviceOptions = services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes }))

  return (
    <div className="flex flex-col gap-6">
      <WorkspaceHeader
        title="Reception"
        module="reception"
        meta={`${branchName} — today`}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/patients/new">
                <UserPlus /> Register patient
              </Link>
            </Button>
            {can(session, "appointment.create") && (
              <>
                <NewAppointmentDialog
                  branches={branches}
                  providers={providerOptions}
                  services={serviceOptions}
                  defaultBranchId={branchId}
                  walkIn
                />
                <NewAppointmentDialog
                  branches={branches}
                  providers={providerOptions}
                  services={serviceOptions}
                  defaultBranchId={branchId}
                />
              </>
            )}
          </>
        }
      />

      {/* P3.1 §5: real, persisted-data counts — not decorative analytics. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Today&apos;s activity</CardTitle>
          <CardDescription>{allToday.length} appointment(s) today at {branchName}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
            {SUMMARY_STATUSES.map((status) => (
              <div key={status} className="rounded-md border border-border p-2 text-center">
                <p className="text-lg font-semibold tabular-nums">{allToday.filter((a) => a.status === status).length}</p>
                <p className="text-xs text-muted-foreground">{APPOINTMENT_STATUS_LABEL[status]}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Waiting</CardTitle>
            <CardDescription>{waiting.length} patient(s) in the queue</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {waiting.length === 0 && <EmptyState title="No patients are currently waiting" />}
            {waiting.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{a.queueEntry?.tokenNumber}</Badge>
                    <Link href={`/patients/${a.patientId}`} className="font-medium hover:underline">
                      {a.patient.firstName} {a.patient.lastName}
                    </Link>
                    <span className="text-xs text-muted-foreground">{a.patient.mrn}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {a.provider.firstName} {a.provider.lastName}
                    {a.service ? ` · ${a.service.name}` : ""}
                    {a.room ? ` · Room ${a.room.name}` : ""}
                    {a.queueEntry?.checkedInAt && ` · Waiting ${formatWaitingMinutes(a.queueEntry.checkedInAt)}`}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Expected today</CardTitle>
            <CardDescription>{arrivals.length} appointment(s) not yet checked in</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {arrivals.length === 0 && <EmptyState title="Nothing pending" />}
            {arrivals.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>
                  {formatTime(a.startTime)} — {a.patient.firstName} {a.patient.lastName}
                </span>
                <StatusBadge status={a.status} label={APPOINTMENT_STATUS_LABEL[a.status]} />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today&apos;s schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {appointments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="p-0">
                    <EmptyState title="No appointments scheduled for this period" className="border-none" />
                  </TableCell>
                </TableRow>
              )}
              {appointments.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{formatTime(a.startTime)}</TableCell>
                  <TableCell>
                    <Link href={`/patients/${a.patientId}`} className="hover:underline">
                      {a.patient.firstName} {a.patient.lastName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {a.provider.firstName} {a.provider.lastName}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={a.status}
                      label={`${APPOINTMENT_STATUS_LABEL[a.status]}${a.queueEntry ? ` · ${a.queueEntry.tokenNumber}` : ""}`}
                    />
                  </TableCell>
                  <TableCell>
                    <AppointmentStatusActions
                      appointmentId={a.id}
                      status={a.status}
                      startTime={a.startTime}
                      canCheckin
                      canCancel={canCancel}
                      canReschedule={canReschedule}
                      canStartEncounter={canStartEncounter}
                      encounterId={a.encounter?.id}
                      branchId={a.branchId}
                      departmentId={a.departmentId}
                      patientId={a.patientId}
                      providerId={a.providerId}
                      providers={providerOptions}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
