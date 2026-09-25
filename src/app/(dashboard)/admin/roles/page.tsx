import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { can } from "@/lib/platform/permissions-core"
import { listRoles, listPermissions } from "@/lib/domains/identity/roles"
import { RolePermissionEditor } from "@/app/(dashboard)/admin/roles/role-permission-editor"
import { NewRoleDialog } from "@/app/(dashboard)/admin/roles/new-role-dialog"
import { PageHeader } from "@/components/ui/page-header"

export default async function RolesPage() {
  const session = await getCurrentSession()
  if (!session || !can(session, "users.manage")) {
    redirect("/dashboard")
  }

  const [roles, permissions] = await Promise.all([listRoles(session), listPermissions()])

  const permissionsByCategory = Object.entries(
    permissions.reduce<Record<string, typeof permissions>>((acc, permission) => {
      ;(acc[permission.category] ??= []).push(permission)
      return acc
    }, {})
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Roles & Permissions"
        module="admin"
        description="System roles ship with a fixed baseline. Create a custom role to grant a different mix."
        primaryAction={<NewRoleDialog permissionsByCategory={permissionsByCategory} />}
      />

      <div className="grid gap-4">
        {roles.map((role) => (
          <RolePermissionEditor
            key={role.id}
            role={{
              id: role.id,
              name: role.name,
              isSystemRole: role.isSystemRole,
              permissionIds: new Set(role.permissions.map((rp) => rp.permissionId)),
            }}
            permissionsByCategory={permissionsByCategory}
          />
        ))}
      </div>
    </div>
  )
}
