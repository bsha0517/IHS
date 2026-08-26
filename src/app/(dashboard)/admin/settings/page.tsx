import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { getOrganization, listBranches, listDepartments, listRooms } from "@/lib/domains/identity/org-structure"
import { isPharmacyEnabled, isPortalClinicalReleaseEnabled } from "@/lib/platform/settings"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { OrgForm } from "@/app/(dashboard)/admin/settings/org-form"
import { BranchDialog, DepartmentDialog, RoomDialog } from "@/app/(dashboard)/admin/settings/structure-dialogs"
import { PharmacyToggle } from "@/app/(dashboard)/admin/settings/pharmacy-toggle"
import { PortalReleaseToggle } from "@/app/(dashboard)/admin/settings/portal-release-toggle"

export default async function SettingsPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "settings.view")) {
    redirect("/dashboard")
  }

  const [organization, branches, departments, rooms, pharmacyEnabled, portalReleaseEnabled] = await Promise.all([
    getOrganization(session),
    listBranches(session),
    listDepartments(session),
    listRooms(session),
    isPharmacyEnabled(session.user.organizationId),
    isPortalClinicalReleaseEnabled(session.user.organizationId),
  ])
  const canEditSettings = can(session, "settings.edit")

  const branchById = new Map(branches.map((b) => [b.id, b]))
  const departmentById = new Map(departments.map((d) => [d.id, d]))

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Organization, branches, departments, and rooms.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>Legal identity, default currency, and timezone.</CardDescription>
        </CardHeader>
        <CardContent>
          <OrgForm organization={organization} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Modules</CardTitle>
          <CardDescription>Enable or disable optional modules for this organization.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Pharmacy</p>
              <p className="text-sm text-muted-foreground">
                When disabled, prescription dispensing is blocked for clinics that do not operate a pharmacy.
              </p>
            </div>
            <PharmacyToggle enabled={pharmacyEnabled} canEdit={canEditSettings} />
          </div>
          <div className="mt-3 flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Patient Portal — Clinical Data Release</p>
              <p className="text-sm text-muted-foreground">
                When disabled, the patient portal never shows prescriptions, lab results, or imaging results, regardless of
                verification status (spec.md §57&apos;s configurable release rule; defaults off).
              </p>
            </div>
            <PortalReleaseToggle enabled={portalReleaseEnabled} canEdit={canEditSettings} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Branches</CardTitle>
            <CardDescription>Physical locations under this organization.</CardDescription>
          </div>
          <BranchDialog />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {branches.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No branches yet.
                  </TableCell>
                </TableRow>
              )}
              {branches.map((branch) => (
                <TableRow key={branch.id}>
                  <TableCell className="font-medium">{branch.name}</TableCell>
                  <TableCell>{branch.code}</TableCell>
                  <TableCell>{branch.timezone}</TableCell>
                  <TableCell>
                    <Badge variant={branch.status === "active" ? "default" : "secondary"}>{branch.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Departments</CardTitle>
            <CardDescription>Clinical/operational departments within each branch.</CardDescription>
          </div>
          <DepartmentDialog branches={branches} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {departments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No departments yet.
                  </TableCell>
                </TableRow>
              )}
              {departments.map((department) => (
                <TableRow key={department.id}>
                  <TableCell className="font-medium">{department.name}</TableCell>
                  <TableCell>{department.code}</TableCell>
                  <TableCell>{branchById.get(department.branchId)?.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={department.status === "active" ? "default" : "secondary"}>
                      {department.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Rooms</CardTitle>
            <CardDescription>Bookable rooms within each department.</CardDescription>
          </div>
          <RoomDialog departments={departments} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rooms.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No rooms yet.
                  </TableCell>
                </TableRow>
              )}
              {rooms.map((room) => (
                <TableRow key={room.id}>
                  <TableCell className="font-medium">{room.name}</TableCell>
                  <TableCell>{room.code}</TableCell>
                  <TableCell>{room.roomType}</TableCell>
                  <TableCell>{departmentById.get(room.departmentId)?.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={room.status === "available" ? "default" : "secondary"}>{room.status}</Badge>
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
