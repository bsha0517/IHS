import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getHrWorkspaceSummary } from "@/lib/domains/hr/workspace"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { PageHeader } from "@/components/ui/page-header"

const PAYROLL_STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  review: "secondary",
  approved: "secondary",
  paid: "default",
}

/**
 * P3.10 §45: "Review the HR landing page... active employees, today's
 * attendance, pending leave requests, payroll status/current period,
 * upcoming leave" — no such page previously existed at all; Employees/
 * Attendance/Leave/Payroll were four separate top-level pages with nothing
 * tying them together operationally (unlike Accounting, which already had
 * one central page P3.9's Overview tab could attach to). Deliberately
 * counts and short lists only — no charts, no date-range picker, no
 * exec-level workforce analytics (that's analytics/reports/hr.ts's job,
 * gated on `reports.export`, a different permission for a different
 * audience).
 */
export default async function HrWorkspacePage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "payroll.view")) redirect("/dashboard")

  const summary = await getHrWorkspaceSummary(session)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="HR Workspace" module="hr" description="Today's operational snapshot." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/employees">
          <Card className="transition-colors hover:bg-muted/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Active employees</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{summary.activeEmployeeCount}</CardContent>
          </Card>
        </Link>
        <Link href="/attendance">
          <Card className="transition-colors hover:bg-muted/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Checked in today</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">
              {summary.checkedInToday}
              <span className="ml-1 text-sm font-normal text-muted-foreground">/ {summary.activeEmployeeCount}</span>
              {summary.notCheckedInToday > 0 && (
                <p className="text-xs font-normal text-muted-foreground">{summary.notCheckedInToday} not checked in yet</p>
              )}
            </CardContent>
          </Card>
        </Link>
        <Link href="/leave">
          <Card className="transition-colors hover:bg-muted/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Pending leave requests</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{summary.pendingLeave.count}</CardContent>
          </Card>
        </Link>
        <Link href="/payroll">
          <Card className="transition-colors hover:bg-muted/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Current payroll run</CardTitle>
            </CardHeader>
            <CardContent>
              {summary.latestPayrollRun ? (
                <div className="flex items-center gap-2">
                  <Badge variant={PAYROLL_STATUS_VARIANT[summary.latestPayrollRun.status] ?? "outline"}>{summary.latestPayrollRun.status}</Badge>
                  <span className="text-xs text-muted-foreground">{summary.latestPayrollRun.branch.name}</span>
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">No runs yet</span>
              )}
            </CardContent>
          </Card>
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending leave requests</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {summary.pendingLeave.items.length === 0 && <p className="text-sm text-muted-foreground">Nothing awaiting approval.</p>}
            {summary.pendingLeave.items.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>
                  {r.employee.firstName} {r.employee.lastName}
                  <span className="ml-2 capitalize text-muted-foreground">{r.leaveType}</span>
                </span>
                <span className="text-muted-foreground">
                  {formatDate(r.startDate)} – {formatDate(r.endDate)}
                </span>
              </div>
            ))}
            {summary.pendingLeave.count > summary.pendingLeave.items.length && (
              <Link href="/leave" className="text-xs text-muted-foreground hover:underline">
                View all {summary.pendingLeave.count} pending requests →
              </Link>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upcoming approved leave (next 7 days)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {summary.upcomingLeave.length === 0 && <p className="text-sm text-muted-foreground">No approved leave starting soon.</p>}
            {summary.upcomingLeave.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>
                  {r.employee.firstName} {r.employee.lastName}
                  <span className="ml-2 capitalize text-muted-foreground">{r.leaveType}</span>
                </span>
                <span className="text-muted-foreground">
                  {formatDate(r.startDate)} – {formatDate(r.endDate)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
