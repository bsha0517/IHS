import Link from "next/link"
import { redirect } from "next/navigation"
import { UserPlus } from "lucide-react"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listAppointments } from "@/lib/domains/appointments/service"
import { listBranches } from "@/lib/domains/identity/org-structure"
import { listProviders } from "@/lib/domains/providers/service"
import { listServices } from "@/lib/domains/services/service"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatTime } from "@/lib/utils/dates"
import { NewAppointmentDialog } from "@/app/(dashboard)/appointments/new-appointment-dialog"
import { AppointmentStatusActions } from "@/app/(dashboard)/appointments/status-actions"

const ACTIVE_STATUSES = ["scheduled", "confirmed", "arrived", "checked_in", "waiting", "in_consultation"] as const

export default async function ReceptionPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "appointment.checkin")) redirect("/dashboard")

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)

  const [branches, providers, services] = await Promise.all([
    listBranches(session),
    listProviders(session),
    listServices(session),
  ])

  const branchId = session.activeBranchId ?? branches[0]?.id
  const appointments = branchId
    ? await listAppointments(session, {
        branchId,
        from: today,
        to: tomorrow,
        statuses: [...ACTIVE_STATUSES],
      })
    : []

  const waiting = appointments.filter((a) => a.status === "waiting")
  const arrivals = appointments.filter((a) => ["scheduled", "confirmed", "arrived", "checked_in"].includes(a.status))
  const canStartEncounter = can(session, "encounter.create")

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reception</h1>
          <p className="text-sm text-muted-foreground">{branches.find((b) => b.id === branchId)?.name ?? "No branch"} — today</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/patients/new">
              <UserPlus /> Register patient
            </Link>
          </Button>
          {can(session, "appointment.create") && (
            <NewAppointmentDialog
              branches={branches}
              providers={providerOptions}
              services={serviceOptions}
              defaultBranchId={branchId}
            />
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Waiting</CardTitle>
            <CardDescription>{waiting.length} patient(s) in the queue</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {waiting.length === 0 && <p className="text-sm text-muted-foreground">No one waiting.</p>}
            {waiting.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <div>
                  <Badge variant="outline" className="mr-2">
                    {a.queueEntry?.tokenNumber}
                  </Badge>
                  {a.patient.firstName} {a.patient.lastName}
                  <span className="ml-2 text-muted-foreground">→ {a.provider.firstName} {a.provider.lastName}</span>
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
            {arrivals.length === 0 && <p className="text-sm text-muted-foreground">Nothing pending.</p>}
            {arrivals.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>
                  {formatTime(a.startTime)} — {a.patient.firstName} {a.patient.lastName}
                </span>
                <Badge variant="outline">{a.status.replace("_", " ")}</Badge>
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
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No appointments today.
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
                    <Badge variant="outline">
                      {a.status.replace("_", " ")}
                      {a.queueEntry ? ` · ${a.queueEntry.tokenNumber}` : ""}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <AppointmentStatusActions
                      appointmentId={a.id}
                      status={a.status}
                      canCheckin
                      canCancel={can(session, "appointment.cancel")}
                      canStartEncounter={canStartEncounter}
                      encounterId={a.encounter?.id}
                      branchId={a.branchId}
                      departmentId={a.departmentId}
                      patientId={a.patientId}
                      providerId={a.providerId}
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
