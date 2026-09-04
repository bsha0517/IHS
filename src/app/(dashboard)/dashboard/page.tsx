import Link from "next/link"
import { CalendarDays, Users, Wallet, ListOrdered, Stethoscope, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MetricCard } from "@/components/ui/metric-card"
import { StatusBadge } from "@/components/ui/status-badge"
import { PageHeader, SectionHeader } from "@/components/ui/page-header"
import { EmptyState } from "@/components/ui/empty-state"
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
      <PageHeader title={`Welcome, ${session.user.firstName}`} description={organization?.displayName ?? "Avant Health Clinic"} />

      {!hasAnySection && (
        <EmptyState
          title="No dashboard configured for your role"
          description="Management, Reception, Doctor, and Finance dashboards exist — your role doesn't map to any of them. Use the sidebar to get to your day-to-day work directly."
        />
      )}

      {management && (
        <section className="flex flex-col gap-4">
          <SectionHeader title="Management" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Today's Appointments" value={management.todaysAppointments} icon={CalendarDays} />
            <MetricCard label="Patients Waiting" value={management.waiting} icon={ListOrdered} />
            <MetricCard label="New Patients" value={management.newPatients} icon={Users} />
            <MetricCard label="No-Shows Today" value={management.noShows} icon={AlertTriangle} tone={management.noShows > 0 ? "warning" : "neutral"} />
            <MetricCard label="Revenue Today" value={management.revenue.toFixed(2)} icon={Wallet} />
            <MetricCard label="Collections Today" value={management.collections.toFixed(2)} icon={Wallet} tone="success" />
            <MetricCard label="Outstanding Receivables" value={management.outstandingReceivables.toFixed(2)} icon={Wallet} tone={management.outstandingReceivables > 0 ? "warning" : "neutral"} />
            <MetricCard label="Expenses Today" value={management.expenses.toFixed(2)} icon={Wallet} />
            <MetricCard label="Low Stock Products" value={management.lowStockCount} icon={AlertTriangle} tone={management.lowStockCount > 0 ? "warning" : "neutral"} />
            <MetricCard label="Near-Expiry Batches" value={management.expiringStockCount} icon={AlertTriangle} tone={management.expiringStockCount > 0 ? "warning" : "neutral"} />
            <MetricCard label="Assets Needing Maintenance" value={management.assetsRequiringMaintenance} icon={AlertTriangle} tone={management.assetsRequiringMaintenance > 0 ? "warning" : "neutral"} />
            <MetricCard label="Employees Present / Absent" value={`${management.employeesPresent} / ${management.employeesAbsent}`} icon={Users} />
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
          <SectionHeader title="Reception" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard label="Today's Appointments" value={reception.todaysAppointments.length} icon={CalendarDays} />
            <MetricCard label="Arrivals" value={reception.arrivals} icon={Users} />
            <MetricCard label="Waiting" value={reception.waiting} icon={ListOrdered} tone={reception.waiting > 0 ? "warning" : "neutral"} />
            <MetricCard label="Upcoming" value={reception.upcoming} icon={CalendarDays} />
            <MetricCard label="No-Shows" value={reception.noShows} icon={AlertTriangle} tone={reception.noShows > 0 ? "warning" : "neutral"} />
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
              {reception.todaysAppointments.length === 0 && (
                <EmptyState title="No appointments today" description="Use Quick booking above to schedule one." />
              )}
              {reception.todaysAppointments.slice(0, 10).map((a) => (
                <div key={a.id} className="flex items-center justify-between border-b border-border py-1.5 last:border-0">
                  <span>{formatTime(a.startTime)} — {a.patient.firstName} {a.patient.lastName} ({a.provider.firstName} {a.provider.lastName})</span>
                  <StatusBadge status={a.status} />
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      {doctor && (
        <section className="flex flex-col gap-4">
          <SectionHeader title="Your Day" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Today's Schedule" value={doctor.todaysSchedule.length} icon={CalendarDays} />
            <MetricCard label="Waiting Patients" value={doctor.waitingPatients} icon={ListOrdered} tone={doctor.waitingPatients > 0 ? "warning" : "neutral"} />
            <MetricCard label="Pending Clinical Tasks" value={doctor.pendingClinicalTasks} icon={Stethoscope} />
            <MetricCard label="Open Follow-ups" value={doctor.followUps.length} icon={AlertTriangle} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Today&apos;s Schedule</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {doctor.todaysSchedule.length === 0 && <EmptyState title="No appointments today" />}
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
                {doctor.recentPatients.length === 0 && <EmptyState title="No recent patients" />}
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
          <SectionHeader title="Finance" description="Month to date" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <MetricCard label="Revenue" value={finance.revenue.toFixed(2)} icon={Wallet} />
            <MetricCard label="Collections" value={finance.collections.toFixed(2)} icon={Wallet} tone="success" />
            <MetricCard label="Receivables" value={finance.receivables.toFixed(2)} icon={Wallet} tone={finance.receivables > 0 ? "warning" : "neutral"} />
            <MetricCard label="Payables" value={finance.payables.toFixed(2)} icon={Wallet} tone={finance.payables > 0 ? "warning" : "neutral"} />
            <MetricCard label="Expenses" value={finance.expenses.toFixed(2)} icon={Wallet} />
            <MetricCard label="Cash Position" value={finance.cashPosition.toFixed(2)} icon={Wallet} />
          </div>
        </section>
      )}
    </div>
  )
}
