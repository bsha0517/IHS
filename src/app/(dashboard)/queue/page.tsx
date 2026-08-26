import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { db } from "@/lib/db"
import { listMyQueue, listBranchQueue } from "@/lib/domains/appointments/queue"
import { listBranches } from "@/lib/domains/identity/org-structure"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { formatTime } from "@/lib/utils/dates"
import { AppointmentStatusActions } from "@/app/(dashboard)/appointments/status-actions"

export default async function QueuePage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "appointment.view")) redirect("/dashboard")

  const isProvider = await db.provider.findUnique({ where: { userId: session.user.id } })
  const canCheckin = can(session, "appointment.checkin")

  const myQueue = isProvider ? await listMyQueue(session) : []

  const branches = canCheckin ? await listBranches(session) : []
  const branchId = session.activeBranchId ?? branches[0]?.id
  const branchQueue = canCheckin && branchId ? await listBranchQueue(session, branchId) : []

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Queue</h1>
        <p className="text-sm text-muted-foreground">Patients waiting or in consultation today.</p>
      </div>

      {isProvider && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">My Queue</CardTitle>
            <CardDescription>{myQueue.length} patient(s)</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {myQueue.length === 0 && <p className="text-sm text-muted-foreground">No patients waiting for you.</p>}
            {myQueue.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                <div className="flex items-center gap-3">
                  <Badge variant="outline">{a.queueEntry?.tokenNumber}</Badge>
                  <div>
                    <Link href={`/patients/${a.patientId}`} className="font-medium hover:underline">
                      {a.patient.firstName} {a.patient.lastName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      Checked in {a.queueEntry?.checkedInAt ? formatTime(a.queueEntry.checkedInAt) : "—"}
                    </p>
                  </div>
                </div>
                <AppointmentStatusActions
                  appointmentId={a.id}
                  status={a.status}
                  canCheckin
                  canCancel={false}
                  canStartEncounter={can(session, "encounter.create")}
                  encounterId={a.encounter?.id}
                  branchId={a.branchId}
                  departmentId={a.departmentId}
                  patientId={a.patientId}
                  providerId={isProvider?.id}
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
            <CardDescription>{branches.find((b) => b.id === branchId)?.name ?? "No branch"}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {branchQueue.length === 0 && <p className="text-sm text-muted-foreground">No one in the queue.</p>}
            {branchQueue.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                <div className="flex items-center gap-3">
                  <Badge variant="outline">{a.queueEntry?.tokenNumber}</Badge>
                  <div>
                    <Link href={`/patients/${a.patientId}`} className="font-medium hover:underline">
                      {a.patient.firstName} {a.patient.lastName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {a.provider.firstName} {a.provider.lastName} ·{" "}
                      {a.queueEntry?.checkedInAt ? formatTime(a.queueEntry.checkedInAt) : "—"}
                    </p>
                  </div>
                </div>
                <Badge variant={a.status === "in_consultation" ? "default" : "secondary"}>{a.status.replace("_", " ")}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!isProvider && !canCheckin && (
        <p className="text-sm text-muted-foreground">You don&apos;t have a queue to view.</p>
      )}
    </div>
  )
}
