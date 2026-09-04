import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listActiveEmployeeRoster } from "@/lib/domains/hr/employees"
import { listShifts, listAttendance } from "@/lib/domains/hr/attendance"
import { formatDate, formatTime } from "@/lib/utils/dates"
import { Card, CardContent } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CheckInButton, CheckOutButton } from "@/app/(dashboard)/attendance/roster-actions"
import { ShiftDialog } from "@/app/(dashboard)/attendance/shift-dialog"
import { AdjustAttendanceDialog } from "@/app/(dashboard)/attendance/adjust-dialog"

export default async function AttendancePage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "payroll.view")) redirect("/dashboard")

  const canRecord = can(session, "attendance.record")
  const canManage = can(session, "employee.manage")

  const [employees, shifts, todayRecords, recentHistory] = await Promise.all([
    listActiveEmployeeRoster(session),
    listShifts(session),
    listAttendance(session, { from: startOfToday(), to: endOfToday() }),
    listAttendance(session),
  ])

  const recordByEmployee = new Map(todayRecords.map((r) => [r.employeeId, r]))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Attendance" />

      <Tabs defaultValue="roster">
        <TabsList>
          <TabsTrigger value="roster">Today&apos;s Roster</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="shifts">Shifts</TabsTrigger>
        </TabsList>

        <TabsContent value="roster" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Check-in</TableHead>
                    <TableHead>Check-out</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {employees.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No active employees.
                      </TableCell>
                    </TableRow>
                  )}
                  {employees.map((e) => {
                    const record = recordByEmployee.get(e.id)
                    return (
                      <TableRow key={e.id}>
                        <TableCell>
                          {e.firstName} {e.lastName}
                        </TableCell>
                        <TableCell>{record?.checkInAt ? formatTime(record.checkInAt) : "—"}</TableCell>
                        <TableCell>{record?.checkOutAt ? formatTime(record.checkOutAt) : "—"}</TableCell>
                        <TableCell>
                          <Badge variant={record?.checkInAt ? "default" : "outline"}>{record ? record.status.replace("_", " ") : "not checked in"}</Badge>
                        </TableCell>
                        <TableCell>
                          {canRecord && !record?.checkInAt && <CheckInButton employeeId={e.id} branchId={e.branchId} shifts={shifts} />}
                          {canRecord && record?.checkInAt && !record.checkOutAt && <CheckOutButton attendanceRecordId={record.id} />}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="grid gap-4">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead>Shift</TableHead>
                    <TableHead>Check-in</TableHead>
                    <TableHead>Check-out</TableHead>
                    <TableHead>Working</TableHead>
                    <TableHead>Late</TableHead>
                    <TableHead>Overtime</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentHistory.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-muted-foreground">
                        No attendance history yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {recentHistory.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{formatDate(r.date)}</TableCell>
                      <TableCell>
                        {r.employee.firstName} {r.employee.lastName}
                      </TableCell>
                      <TableCell>{r.shift?.name ?? "—"}</TableCell>
                      <TableCell>{r.checkInAt ? formatTime(r.checkInAt) : "—"}</TableCell>
                      <TableCell>{r.checkOutAt ? formatTime(r.checkOutAt) : "—"}</TableCell>
                      <TableCell>{r.workingMinutes != null ? `${Math.floor(r.workingMinutes / 60)}h ${r.workingMinutes % 60}m` : "—"}</TableCell>
                      <TableCell>{r.lateMinutes > 0 ? `${r.lateMinutes}m` : "—"}</TableCell>
                      <TableCell>{r.overtimeMinutes > 0 ? `${r.overtimeMinutes}m` : "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.status.replace("_", " ")}</Badge>
                      </TableCell>
                      <TableCell>
                        {canManage && (
                          <AdjustAttendanceDialog
                            record={{
                              id: r.id,
                              employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
                              checkInAt: r.checkInAt ? r.checkInAt.toISOString() : null,
                              checkOutAt: r.checkOutAt ? r.checkOutAt.toISOString() : null,
                              breakMinutes: r.breakMinutes,
                              status: r.status,
                              notes: r.notes,
                            }}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="shifts" className="grid gap-4">
          {canManage && (
            <div className="flex justify-end">
              <ShiftDialog />
            </div>
          )}
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>End</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shifts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-muted-foreground">
                        No shifts configured.
                      </TableCell>
                    </TableRow>
                  )}
                  {shifts.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell>{s.startTime}</TableCell>
                      <TableCell>{s.endTime}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function startOfToday() {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

function endOfToday() {
  const d = new Date()
  d.setUTCHours(23, 59, 59, 999)
  return d
}
