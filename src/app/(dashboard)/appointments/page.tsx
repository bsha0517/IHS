import Link from "next/link"
import { redirect } from "next/navigation"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listAppointments } from "@/lib/domains/appointments/service"
import { listBranches } from "@/lib/domains/identity/org-structure"
import { listProviders } from "@/lib/domains/providers/service"
import { listServices } from "@/lib/domains/services/service"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatTime, toDateParam } from "@/lib/utils/dates"
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

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  scheduled: "outline",
  confirmed: "outline",
  arrived: "secondary",
  checked_in: "secondary",
  waiting: "secondary",
  in_consultation: "default",
  completed: "default",
  cancelled: "destructive",
  rescheduled: "destructive",
  no_show: "destructive",
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

  const [appointments, branches, providers, services] = await Promise.all([
    listAppointments(session, { from: day, to: nextDay, providerId: providerId || undefined }),
    listBranches(session),
    listProviders(session),
    listServices(session),
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Appointments</h1>
          <p className="text-sm text-muted-foreground">
            {day.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          {can(session, "appointment.create") && (
            <NewAppointmentDialog
              branches={branches}
              providers={providerOptions}
              services={serviceOptions}
              defaultBranchId={session.activeBranchId}
            />
          )}
        </div>
      </div>

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
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No appointments for this day.
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
                    <Badge variant={STATUS_VARIANT[a.status] ?? "outline"}>
                      {a.status.replace("_", " ")}
                      {a.queueEntry ? ` · ${a.queueEntry.tokenNumber}` : ""}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <AppointmentStatusActions
                      appointmentId={a.id}
                      status={a.status}
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
