import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getEmployee } from "@/lib/domains/hr/employees"
import { listLeaveBalances } from "@/lib/domains/hr/leave"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DocumentDialog } from "@/app/(dashboard)/employees/[id]/document-dialog"

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession()
  if (!session || !can(session, "payroll.view")) redirect("/dashboard")

  const { id } = await params
  const canManage = can(session, "employee.manage")
  const employee = await getEmployee(session, id)
  const leaveBalances = await listLeaveBalances(session, id, new Date().getFullYear())

  const today = new Date()
  const expiringSoon = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {employee.firstName} {employee.lastName}
        </h1>
        <p className="text-sm text-muted-foreground">
          {employee.employeeNumber} · {employee.designation}
        </p>
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
