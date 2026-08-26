import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getKpiTrends } from "@/lib/domains/analytics/kpis"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

function BarChart({ points, format = (v: number) => v.toFixed(0) }: { points: { label: string; value: number }[]; format?: (v: number) => string }) {
  const max = Math.max(...points.map((p) => p.value), 1)
  return (
    <div className="flex h-48 items-end gap-3">
      {points.map((p) => (
        <div key={p.label} className="flex flex-1 flex-col items-center gap-1">
          <div className="text-xs font-medium">{format(p.value)}</div>
          <div className="w-full rounded-t-sm bg-primary" style={{ height: `${Math.max((p.value / max) * 140, p.value > 0 ? 4 : 0)}px` }} />
          <div className="text-xs text-muted-foreground">{p.label}</div>
        </div>
      ))}
    </div>
  )
}

export default async function AnalyticsPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "reports.export")) redirect("/dashboard")

  const trend = await getKpiTrends(session, 6)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">spec.md §65 — trailing 6-month KPI trends, computed live from the same tables Reports and Dashboards use.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Revenue</CardTitle>
            <CardDescription>Invoiced total per month</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart points={trend.map((t) => ({ label: t.monthLabel, value: t.revenue }))} format={(v) => v.toFixed(0)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Collections</CardTitle>
            <CardDescription>Payments received per month</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart points={trend.map((t) => ({ label: t.monthLabel, value: t.collections }))} format={(v) => v.toFixed(0)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New Patients</CardTitle>
            <CardDescription>Registrations per month</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart points={trend.map((t) => ({ label: t.monthLabel, value: t.newPatients }))} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appointments</CardTitle>
            <CardDescription>Total booked per month</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart points={trend.map((t) => ({ label: t.monthLabel, value: t.appointments }))} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Completed Appointments</CardTitle>
            <CardDescription>Per month</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart points={trend.map((t) => ({ label: t.monthLabel, value: t.completedAppointments }))} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>No-Shows</CardTitle>
            <CardDescription>Per month</CardDescription>
          </CardHeader>
          <CardContent>
            <BarChart points={trend.map((t) => ({ label: t.monthLabel, value: t.noShows }))} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
