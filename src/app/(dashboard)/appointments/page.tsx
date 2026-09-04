import Link from "next/link"
import { redirect } from "next/navigation"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listAppointments } from "@/lib/domains/appointments/service"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listProviders } from "@/lib/domains/providers/service"
import { listServices } from "@/lib/domains/services/service"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { Button } from "@/components/ui/button"
import { WorkspaceHeader } from "@/components/ui/page-header"
import { EmptyState } from "@/components/ui/empty-state"
import { formatTime, toDateParam } from "@/lib/utils/dates"
import { APPOINTMENT_STATUS_LABEL } from "@/lib/utils/appointment-status"
import { NewAppointmentDialog } from "@/app/(dashboard)/appointments/new-appointment-dialog"
import { AppointmentStatusActions } from "@/app/(dashboard)/appointments/status-actions"

function parseDateParam(value: string | undefined): Date {
  if (value) {
    const parsed = new Date(`${value}T00:00:00`)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today
}

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; providerId?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "appointment.view")) redirect("/dashboard")

  const { date: dateParam, providerId } = await searchParams
  const day = parseDateParam(dateParam)
  const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000)
  const prevDayStr = toDateParam(new Date(day.getTime() - 24 * 60 * 60 * 1000))
  const nextDayStr = toDateParam(nextDay)

  // P3.3 §4: same fix as reception/page.tsx — this page only needs the
  // branches this session can operate at (for the New Appointment dialog's
  // branch select), not the org-wide `branch.view` permission `listBranches`
  // requires and Receptionist lacks. See that page's comment for the full
  // reasoning.
  //
  // Targeted backlog closure, item 3: `listServices` was previously called
  // unconditionally, requiring `service.view` — a permission Doctor (and
  // any other appointment.view-only role) doesn't hold, crashing this whole
  // page with a `ForbiddenError` for that role (BACKLOG.md, confirmed still
  // reproducible by inspection before this fix). The service catalog is
  // only ever actually used by `NewAppointmentDialog` below, which is
  // itself only rendered for `appointment.create` holders — Doctor holds
  // neither `appointment.create` nor `service.view` in the seeded role, so
  // it never needed this fetch. Gating it on the same permission the
  // dialog's own render check already uses (rather than granting
  // `service.view` to Doctor, which the current product design gives no
  // reason to do) fixes the crash without widening any permission.
  const canCreateAppointment = can(session, "appointment.create")
  const [appointments, branches, providers, services] = await Promise.all([
    listAppointments(session, { from: day, to: nextDay, providerId: providerId || undefined }),
    listAccessibleBranches(session),
    listProviders(session),
    canCreateAppointment ? listServices(session) : Promise.resolve([]),
  ])

  const canCheckin = can(session, "appointment.checkin")
  const canCancel = can(session, "appointment.cancel")
  const canReschedule = can(session, "appointment.reschedule")
  const canStartEncounter = can(session, "encounter.create")

  // Prisma's Decimal fields (consultationFee/price) can't cross the
  // Server->Client boundary — pass plain-field subsets to the client dialog.
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
        title="Appointments"
        meta={day.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        actions={
          <>
            <Button variant="outline" size="icon-sm" asChild>
              <Link href={`/appointments?date=${prevDayStr}${providerId ? `&providerId=${providerId}` : ""}`}>
                <ChevronLeft className="size-4" />
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/appointments${providerId ? `?providerId=${providerId}` : ""}`}>Today</Link>
            </Button>
            <Button variant="outline" size="icon-sm" asChild>
              <Link href={`/appointments?date=${nextDayStr}${providerId ? `&providerId=${providerId}` : ""}`}>
                <ChevronRight className="size-4" />
              </Link>
            </Button>
            {canCreateAppointment && (
              <NewAppointmentDialog
                branches={branches}
                providers={providerOptions}
                services={serviceOptions}
                defaultBranchId={session.activeBranchId}
              />
            )}
          </>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Link href={`/appointments?date=${toDateParam(day)}`}>
          <Badge variant={!providerId ? "default" : "outline"} className="cursor-pointer">
            All providers
          </Badge>
        </Link>
        {providers.map((p) => (
          <Link key={p.id} href={`/appointments?date=${toDateParam(day)}&providerId=${p.id}`}>
            <Badge variant={providerId === p.id ? "default" : "outline"} className="cursor-pointer">
              {p.firstName} {p.lastName}
            </Badge>
          </Link>
        ))}
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {appointments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="p-0">
                    <EmptyState title="No appointments for this day" className="border-none" />
                  </TableCell>
                </TableRow>
              )}
              {appointments.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    {formatTime(a.startTime)}–{formatTime(a.endTime)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{a.appointmentNumber}</TableCell>
                  <TableCell>
                    <Link href={`/patients/${a.patientId}`} className="hover:underline">
                      {a.patient.firstName} {a.patient.lastName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {a.provider.firstName} {a.provider.lastName}
                  </TableCell>
                  <TableCell>{a.service?.name ?? "—"}</TableCell>
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
                      canCheckin={canCheckin}
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
