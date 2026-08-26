import Link from "next/link"
import { CalendarDays, Users, Wallet, ListOrdered, Stethoscope, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getCurrentSession } from "@/lib/auth/session"
import { getOrganization } from "@/lib/domains/identity/org-structure"
import {
  getManagementDashboard,
  getReceptionDashboard,
  getDoctorDashboard,
  getFinanceDashboard,
  visibleDashboardSections,
} from "@/lib/domains/analytics/dashboards"
import { formatTime } from "@/lib/utils/dates"

function Tile({ label, value, icon: Icon }: { label: string; value: string | number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardDescription>{label}</CardDescription>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}

/**
 * The cross-module pass Phase 1's placeholder (see git history / PROJECT_STATUS.md)
 * explicitly deferred to Phase 13. Every tile below is computed live from
 * persisted rows — spec.md §92 "never fake dashboard statistics" — and each
 * section only renders for a user whose permissions (or, for the Doctor
 * section, linked Provider record) actually qualify them to see it, matching
 * spec.md §8's "role-aware dashboards."
 */
export default async function DashboardPage() {
  const session = await getCurrentSession()
  if (!session) {
    return null
  }

  const organization = await getOrganization(session).catch(() => null)
  const sections = visibleDashboardSections(session)

  const [management, reception, doctor, finance] = await Promise.all([
    sections.management ? getManagementDashboard(session) : Promise.resolve(null),
    sections.reception ? getReceptionDashboard(session) : Promise.resolve(null),
    getDoctorDashboard(session),
    sections.finance ? getFinanceDashboard(session) : Promise.resolve(null),
  ])

  const hasAnySection = management || reception || doctor || finance

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {session.user.firstName}</h1>
        <p className="text-sm text-muted-foreground">{organization?.displayName ?? "Avant Health Clinic"}</p>
      </div>

      {!hasAnySection && (
        <Card>
          <CardHeader>
            <CardTitle>No dashboard configured for your role</CardTitle>
            <CardDescription>spec.md §8 names Management, Reception, Doctor, and Finance dashboards — your role doesn&apos;t map to any of them.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Use the sidebar to get to your day-to-day work directly.
          </CardContent>
        </Card>
      )}

      {management && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Management</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Today's Appointments" value={management.todaysAppointments} icon={CalendarDays} />
            <Tile label="Patients Waiting" value={management.waiting} icon={ListOrdered} />
            <Tile label="New Patients" value={management.newPatients} icon={Users} />
            <Tile label="No-Shows Today" value={management.noShows} icon={AlertTriangle} />
            <Tile label="Revenue Today" value={management.revenue.toFixed(2)} icon={Wallet} />
            <Tile label="Collections Today" value={management.collections.toFixed(2)} icon={Wallet} />
            <Tile label="Outstanding Receivables" value={management.outstandingReceivables.toFixed(2)} icon={Wallet} />
            <Tile label="Expenses Today" value={management.expenses.toFixed(2)} icon={Wallet} />
            <Tile label="Low Stock Products" value={management.lowStockCount} icon={AlertTriangle} />
            <Tile label="Near-Expiry Batches" value={management.expiringStockCount} icon={AlertTriangle} />
            <Tile label="Assets Needing Maintenance" value={management.assetsRequiringMaintenance} icon={AlertTriangle} />
            <Tile label="Employees Present / Absent" value={`${management.employeesPresent} / ${management.employeesAbsent}`} icon={Users} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader><CardTitle className="text-base">Top Services (MTD)</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {management.topServices.length === 0 && <p className="text-muted-foreground">No charges this month.</p>}
                {management.topServices.map((s) => (
                  <div key={s.serviceName} className="flex justify-between"><span>{s.serviceName}</span><span className="font-medium">{s.amount.toFixed(2)}</span></div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Doctor Revenue (MTD)</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {management.doctorRevenue.length === 0 && <p className="text-muted-foreground">No charges this month.</p>}
                {management.doctorRevenue.map((d) => (
                  <div key={d.providerName} className="flex justify-between"><span>{d.providerName}</span><span className="font-medium">{d.amount.toFixed(2)}</span></div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Branch Performance (MTD)</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {management.branchPerformance.length === 0 && <p className="text-muted-foreground">No invoices this month.</p>}
                {management.branchPerformance.map((b) => (
                  <div key={b.branchName} className="flex justify-between"><span>{b.branchName}</span><span className="font-medium">{b.amount.toFixed(2)}</span></div>
                ))}
              </CardContent>
            </Card>
          </div>
        </section>
      )}

      {reception && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Reception</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Tile label="Today's Appointments" value={reception.todaysAppointments.length} icon={CalendarDays} />
            <Tile label="Arrivals" value={reception.arrivals} icon={Users} />
            <Tile label="Waiting" value={reception.waiting} icon={ListOrdered} />
            <Tile label="Upcoming" value={reception.upcoming} icon={CalendarDays} />
            <Tile label="No-Shows" value={reception.noShows} icon={AlertTriangle} />
          </div>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Today&apos;s Appointments</CardTitle>
              <div className="flex gap-2">
                <Link href="/patients" className="text-sm text-primary underline-offset-4 hover:underline">Quick registration</Link>
                <Link href="/appointments" className="text-sm text-primary underline-offset-4 hover:underline">Quick booking</Link>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {reception.todaysAppointments.length === 0 && <p className="text-muted-foreground">No appointments today.</p>}
              {reception.todaysAppointments.slice(0, 10).map((a) => (
                <div key={a.id} className="flex items-center justify-between border-b pb-1 last:border-0">
                  <span>{formatTime(a.startTime)} — {a.patient.firstName} {a.patient.lastName} ({a.provider.firstName} {a.provider.lastName})</span>
                  <Badge variant="outline">{a.status.replace("_", " ")}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      {doctor && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Your Day</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Today's Schedule" value={doctor.todaysSchedule.length} icon={CalendarDays} />
            <Tile label="Waiting Patients" value={doctor.waitingPatients} icon={ListOrdered} />
            <Tile label="Pending Clinical Tasks" value={doctor.pendingClinicalTasks} icon={Stethoscope} />
            <Tile label="Open Follow-ups" value={doctor.followUps.length} icon={AlertTriangle} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Today&apos;s Schedule</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {doctor.todaysSchedule.length === 0 && <p className="text-muted-foreground">No appointments today.</p>}
                {doctor.todaysSchedule.map((a) => (
                  <div key={a.id} className="flex justify-between border-b pb-1 last:border-0">
                    <span>{formatTime(a.startTime)} — {a.patient.firstName} {a.patient.lastName}</span>
                    <span className="text-muted-foreground">{a.service?.name ?? "—"}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Recent Patients</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {doctor.recentPatients.length === 0 && <p className="text-muted-foreground">No recent patients.</p>}
                {doctor.recentPatients.map((p) => (
                  <div key={p.id}>{p.firstName} {p.lastName}</div>
                ))}
              </CardContent>
            </Card>
          </div>
          {doctor.currentEncounter && (
            <Card>
              <CardHeader><CardTitle className="text-base">Current Encounter</CardTitle></CardHeader>
              <CardContent className="text-sm">
                <Link href={`/encounters/${doctor.currentEncounter.id}`} className="text-primary underline-offset-4 hover:underline">
                  {doctor.currentEncounter.patient.firstName} {doctor.currentEncounter.patient.lastName} — {doctor.currentEncounter.status}
                </Link>
              </CardContent>
            </Card>
          )}
        </section>
      )}

      {finance && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Finance (Month to Date)</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <Tile label="Revenue" value={finance.revenue.toFixed(2)} icon={Wallet} />
            <Tile label="Collections" value={finance.collections.toFixed(2)} icon={Wallet} />
            <Tile label="Receivables" value={finance.receivables.toFixed(2)} icon={Wallet} />
            <Tile label="Payables" value={finance.payables.toFixed(2)} icon={Wallet} />
            <Tile label="Expenses" value={finance.expenses.toFixed(2)} icon={Wallet} />
            <Tile label="Cash Position" value={finance.cashPosition.toFixed(2)} icon={Wallet} />
          </div>
        </section>
      )}
    </div>
  )
}
