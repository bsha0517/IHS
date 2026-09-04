import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listUsers } from "@/lib/domains/identity/users"
import { listRoles } from "@/lib/domains/identity/roles"
import { listBranches } from "@/lib/domains/identity/org-structure"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { NewUserDialog } from "@/app/(dashboard)/admin/users/new-user-dialog"
import { StatusToggle } from "@/app/(dashboard)/admin/users/status-toggle"
import { EditUserDialog } from "@/app/(dashboard)/admin/users/edit-user-dialog"

export default async function UsersPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "users.manage")) {
    redirect("/dashboard")
  }

  const [users, roles, branches] = await Promise.all([
    listUsers(session),
    listRoles(session),
    listBranches(session),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Staff accounts, roles, and branch access."
        primaryAction={<NewUserDialog roles={roles} branches={branches} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>All users</CardTitle>
          <CardDescription>{users.length} user(s)</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Branch access</TableHead>
                <TableHead>Linked employee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    {user.firstName} {user.lastName}
                  </TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map((r) => (
                        <Badge key={r.roleId} variant="secondary">
                          {r.role.name}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                      {user.branchAccess.map((a) => a.branch.name).join(", ") || "—"}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {user.employeeProfile ? `${user.employeeProfile.firstName} ${user.employeeProfile.lastName}` : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        user.status === "active" ? "default" : user.status === "locked" ? "destructive" : "secondary"
                      }
                    >
                      {user.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "Never"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <EditUserDialog user={user} roles={roles} branches={branches} isSelf={user.id === session.user.id} />
                      <StatusToggle userId={user.id} status={user.status} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
