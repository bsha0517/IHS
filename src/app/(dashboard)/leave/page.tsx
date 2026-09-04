import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listLeaveRequests } from "@/lib/domains/hr/leave"
import { listActiveEmployeeRoster } from "@/lib/domains/hr/employees"
import { formatDate } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LeaveRequestDialog } from "@/app/(dashboard)/leave/leave-request-dialog"
import { LeaveRequestActions } from "@/app/(dashboard)/leave/leave-request-actions"
import { LeaveBalanceDialog } from "@/app/(dashboard)/leave/leave-balance-dialog"

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  requested: "outline",
  approved: "default",
  rejected: "destructive",
  cancelled: "secondary",
}

export default async function LeavePage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "payroll.view")) redirect("/dashboard")

  const canRequest = can(session, "leave.request")
  const canApprove = can(session, "leave.approve")
  const canManage = can(session, "employee.manage")

  const [requests, employees] = await Promise.all([listLeaveRequests(session), listActiveEmployeeRoster(session)])
  const employeeOptions = employees.map((e) => ({ id: e.id, firstName: e.firstName, lastName: e.lastName }))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Leave" />

      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          {canManage && <TabsTrigger value="balances">Balances</TabsTrigger>}
        </TabsList>

        <TabsContent value="requests" className="grid gap-4">
          {canRequest && (
            <div className="flex justify-end">
              <LeaveRequestDialog employees={employeeOptions} />
            </div>
          )}
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead>Days</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Decided by</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground">
                        No leave requests yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {requests.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        {r.employee.firstName} {r.employee.lastName}
                      </TableCell>
                      <TableCell className="capitalize">{r.leaveType}</TableCell>
                      <TableCell>
                        {formatDate(r.startDate)} – {formatDate(r.endDate)}
                      </TableCell>
                      <TableCell>{r.days}</TableCell>
                      <TableCell className="max-w-48 truncate" title={r.reason ?? undefined}>
                        {r.reason ?? "—"}
                      </TableCell>
                      <TableCell>{formatDate(r.requestedAt)}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                        {r.status === "rejected" && r.rejectionReason && (
                          <p className="mt-1 text-xs text-muted-foreground">{r.rejectionReason}</p>
                        )}
                      </TableCell>
                      <TableCell>{r.decidedByUser ? `${r.decidedByUser.firstName} ${r.decidedByUser.lastName}` : "—"}</TableCell>
                      <TableCell>{canApprove && r.status === "requested" && <LeaveRequestActions leaveRequestId={r.id} />}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {canManage && (
          <TabsContent value="balances" className="grid gap-4">
            <div className="flex justify-end">
              <LeaveBalanceDialog employees={employeeOptions} />
            </div>
            <p className="text-sm text-muted-foreground">Set a leave entitlement for an employee, then view their balance from the employee detail page.</p>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
