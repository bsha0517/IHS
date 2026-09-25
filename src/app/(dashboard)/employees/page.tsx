import Link from "next/link"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listEmployees, listEmployeeDirectory } from "@/lib/domains/hr/employees"
import { listAccessibleBranches } from "@/lib/domains/billing/cashier"
import { listDepartments } from "@/lib/domains/identity/org-structure"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { PageHeader } from "@/components/ui/page-header"
import { EmployeeDialog } from "@/app/(dashboard)/employees/employee-dialog"
import { EmployeeFilters } from "@/app/(dashboard)/employees/employee-filters"
import { PaginationControls } from "@/components/domain/pagination-controls"

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; branchId?: string; departmentId?: string; status?: string }>
}) {
  const session = await getCurrentSession()
  if (!session || !can(session, "payroll.view")) redirect("/dashboard")

  const canManage = can(session, "employee.manage")
  const sp = await searchParams

  const [{ employees, total, page, totalPages }, branches, departments, directory] = await Promise.all([
    listEmployees(session, {
      page: sp.page ? Number(sp.page) : undefined,
      search: sp.q,
      branchId: sp.branchId,
      departmentId: sp.departmentId,
      status: sp.status,
    }),
    listAccessibleBranches(session),
    listDepartments(session),
    // P2 §8: the manager picker needs every employee, not just the current
    // page — listEmployeeDirectory is the existing unbounded, name-only
    // query built for exactly this kind of assignment picker.
    listEmployeeDirectory(session),
  ])

  const branchOptions = branches.map((b) => ({ id: b.id, name: b.name }))
  const departmentOptions = departments.map((d) => ({ id: d.id, name: d.name }))
  const managerOptions = directory.map((e) => ({ id: e.id, firstName: e.firstName, lastName: e.lastName }))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Employees"
        module="hr"
        description={`${total} employee(s)`}
        primaryAction={canManage && <EmployeeDialog branches={branchOptions} departments={departmentOptions} managers={managerOptions} />}
      />

      <EmployeeFilters branches={branchOptions} departments={departmentOptions} sp={sp} />

      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Designation</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {employees.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No employees yet.
                  </TableCell>
                </TableRow>
              )}
              {employees.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">{e.employeeNumber}</TableCell>
                  <TableCell>
                    <Link href={`/employees/${e.id}`} className="hover:underline">
                      {e.firstName} {e.lastName}
                    </Link>
                  </TableCell>
                  <TableCell>{e.designation}</TableCell>
                  <TableCell>{e.branch.name}</TableCell>
                  <TableCell>{e.department?.name ?? "—"}</TableCell>
                  <TableCell className="capitalize">{e.employmentType.replace("_", " ")}</TableCell>
                  <TableCell>
                    <Badge variant={e.status === "active" ? "default" : e.status === "on_leave" ? "secondary" : "destructive"}>
                      {e.status.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {canManage && (
                      <EmployeeDialog
                        branches={branchOptions}
                        departments={departmentOptions}
                        managers={managerOptions}
                        existing={{
                          id: e.id,
                          branchId: e.branchId,
                          departmentId: e.departmentId,
                          firstName: e.firstName,
                          lastName: e.lastName,
                          designation: e.designation,
                          managerId: e.managerId,
                          joiningDate: e.joiningDate.toISOString().slice(0, 10),
                          employmentType: e.employmentType,
                          basicSalary: Number(e.basicSalary),
                          bankDetails: e.bankDetails,
                        }}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls page={page} totalPages={totalPages} total={total} basePath="/employees" searchParams={sp} />
        </CardContent>
      </Card>
    </div>
  )
}
