import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getEmployee } from "@/lib/domains/hr/employees"
import { listLeaveBalances } from "@/lib/domains/hr/leave"
import { listAttendance } from "@/lib/domains/hr/attendance"
import { listPayrollLinesForEmployee } from "@/lib/domains/payroll/payroll"
import { listUnlinkedUsers } from "@/lib/domains/identity/users"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DocumentDialog } from "@/app/(dashboard)/employees/[id]/document-dialog"
import { EmployeeStatusDialog } from "@/app/(dashboard)/employees/[id]/status-dialog"
import { UserLinkDialog, UnlinkUserButton } from "@/app/(dashboard)/employees/[id]/user-link-dialog"

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "payroll.view")) redirect("/dashboard")

  const { id } = await params
  const canManage = can(session, "employee.manage")
  const canManageUsers = can(session, "users.manage")
  const employee = await getEmployee(session, id)
  const today = new Date()
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)
  const [leaveBalances, recentAttendance, payrollLines, unlinkedUsers] = await Promise.all([
    listLeaveBalances(session, id, today.getFullYear()),
    listAttendance(session, { employeeId: id, from: thirtyDaysAgo, to: today }),
    listPayrollLinesForEmployee(session, id),
    // P3.12 §14: only fetched for an Admin who could actually act on it —
    // matches the dashboard's own "don't fetch behind a permission the
    // role doesn't hold" discipline (P3.12 §57).
    canManageUsers ? listUnlinkedUsers(session) : Promise.resolve([]),
  ])
  const attendanceCounts = recentAttendance.reduce<Record<string, number>>((counts, r) => {
    counts[r.status] = (counts[r.status] ?? 0) + 1
    return counts
  }, {})

  const expiringSoon = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {employee.firstName} {employee.lastName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {employee.employeeNumber} · {employee.designation}
          </p>
        </div>
        {canManage && <EmployeeStatusDialog employeeId={employee.id} currentStatus={employee.status} />}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1.5 text-sm">
            <Row label="Branch" value={employee.branch.name} />
            <Row label="Department" value={employee.department?.name} />
            <Row label="Manager" value={employee.manager ? `${employee.manager.firstName} ${employee.manager.lastName}` : null} />
            <Row label="Employment type" value={employee.employmentType.replace("_", " ")} />
            <Row label="Joining date" value={formatDate(employee.joiningDate)} />
            <Row label="Basic salary" value={Number(employee.basicSalary).toFixed(2)} />
            <Row label="Provider profile" value={employee.providerProfile ? "Linked" : "Not linked"} />
            {/* P3.10 §9: the only place in the app this Employee<->User link was ever shown — every other view has been silent about whether an employee has a system login at all. P3.12 §14: now also where it can be changed, Admin-only. */}
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">System login</span>
              <span className="text-right">
                {employee.user ? `${employee.user.email} (${employee.user.status})` : "Not linked"}
              </span>
            </div>
            {canManageUsers && (
              <div className="flex justify-end gap-2">
                {employee.user ? (
                  <UnlinkUserButton employeeId={employee.id} />
                ) : (
                  <UserLinkDialog employeeId={employee.id} unlinkedUsers={unlinkedUsers} />
                )}
              </div>
            )}
            <Row label="Status" value={employee.status.replace("_", " ")} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Leave balances ({today.getFullYear()})</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {leaveBalances.length === 0 && <p className="text-sm text-muted-foreground">No leave balances configured for this year.</p>}
            {leaveBalances.map((b) => (
              <div key={b.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span className="capitalize">{b.leaveType}</span>
                <span>
                  {b.remainingDays} / {b.allocatedDays} remaining
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Attendance (last 30 days)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {recentAttendance.length === 0 && <p className="text-sm text-muted-foreground">No attendance recorded in this window.</p>}
            {Object.entries(attendanceCounts).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span className="capitalize">{status.replace("_", " ")}</span>
                <span>{count} day(s)</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payroll / payslips</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {payrollLines.length === 0 && <p className="text-sm text-muted-foreground">This employee has not been included in a payroll run yet.</p>}
            {payrollLines.map((l) => (
              <div key={l.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>
                  {formatDate(l.payrollRun.periodStart)} – {formatDate(l.payrollRun.periodEnd)}
                  <span className="ml-2 capitalize text-muted-foreground">{l.payrollRun.status}</span>
                </span>
                <div className="flex items-center gap-3">
                  <span>{Number(l.netSalary).toFixed(2)}</span>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/payslips/${l.id}/print`} target="_blank">
                      Payslip
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="sm:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Documents</CardTitle>
            {canManage && <DocumentDialog employeeId={employee.id} />}
          </CardHeader>
          <CardContent className="grid gap-2">
            {employee.documents.length === 0 && <p className="text-sm text-muted-foreground">No documents on file.</p>}
            {employee.documents.map((doc) => {
              const isExpiring = doc.expiryDate && doc.expiryDate <= expiringSoon
              const isExpired = doc.expiryDate && doc.expiryDate < today
              return (
                <div key={doc.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                  <div>
                    <span className="capitalize">{doc.documentType.replace(/_/g, " ")}</span>
                    {doc.documentNumber && <span className="text-muted-foreground"> — {doc.documentNumber}</span>}
                    {doc.expiryDate && <span className="text-muted-foreground"> · expires {formatDate(doc.expiryDate)}</span>}
                  </div>
                  {isExpired && <Badge variant="destructive">Expired</Badge>}
                  {!isExpired && isExpiring && <Badge variant="secondary">Expiring soon</Badge>}
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right capitalize">{value || "—"}</span>
    </div>
  )
}
