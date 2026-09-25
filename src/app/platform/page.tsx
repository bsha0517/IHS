import Link from "next/link"
import { getPlatformDashboardMetrics, getPlatformRecentActivity } from "@/lib/domains/commercial/organizations"
import { PageHeader } from "@/components/ui/page-header"
import { MetricCard } from "@/components/ui/metric-card"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { formatDateTime } from "@/lib/utils/dates"
import { PlatformPageShell } from "@/components/layout/platform-page-shell"

/**
 * P5.1 §20/§45: kept minimal by design — no revenue/MRR analytics (V1
 * commercial billing is manual — see getPlatformDashboardMetrics's own doc
 * comment for exactly what "readiness attention" approximates and why).
 * P5.2 §5/§14 adds support-ticket counts and a cross-org activity feed —
 * still operational/commercial metadata only, never patient or clinical
 * data (see getPlatformRecentActivity's own doc comment).
 */
export default async function PlatformDashboardPage() {
  const [metrics, activity] = await Promise.all([getPlatformDashboardMetrics(), getPlatformRecentActivity()])

  return (
    <PlatformPageShell>
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform Dashboard"
        module="platform"
        description="Commercial operations overview — organization/customer metadata only, never patient or clinical data."
        primaryAction={
          <Button asChild size="sm">
            <Link href="/platform/provision">Provision Clinic</Link>
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Organizations" value={metrics.totalOrganizations} />
        <MetricCard label="Active Clinics" value={metrics.activeClinics} tone="success" />
        <MetricCard label="Onboarding" value={metrics.onboarding} />
        <MetricCard label="Suspended" value={metrics.suspended} tone={metrics.suspended > 0 ? "destructive" : "neutral"} />
        <MetricCard label="Trials Expiring (14d)" value={metrics.trialsExpiring} tone={metrics.trialsExpiring > 0 ? "warning" : "neutral"} />
        <MetricCard label="Readiness Attention" value={metrics.readinessAttention} tone={metrics.readinessAttention > 0 ? "warning" : "neutral"} />
        <MetricCard label="Open Support Tickets" value={metrics.openTickets} tone={metrics.openTickets > 0 ? "warning" : "neutral"} />
        <MetricCard label="Unassigned Tickets" value={metrics.unassignedTickets} tone={metrics.unassignedTickets > 0 ? "destructive" : "neutral"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick links</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          <Button asChild variant="outline" size="sm">
            <Link href="/platform/organizations">Organization list</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/platform/plans">Commercial plans</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/platform/tickets">Support tickets</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1.5 text-sm">
          {activity.length === 0 && <EmptyState title="No platform-driven changes recorded yet" className="border-none" />}
          {activity.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1.5 last:border-none">
              <span>
                <Link href={`/platform/organizations/${a.organization.id}`} className="font-medium hover:underline">
                  {a.organization.displayName}
                </Link>{" "}
                <span className="font-mono text-xs text-muted-foreground">{a.action}</span>
              </span>
              <span className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
    </PlatformPageShell>
  )
}
