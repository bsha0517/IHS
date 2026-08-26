import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { RoleInput } from "@/lib/domains/identity/schemas"

export async function listRoles(session: SessionContext) {
  assertCan(session, "users.manage")
  return db.role.findMany({
    where: { organizationId: session.user.organizationId },
    include: { permissions: { include: { permission: true } } },
    orderBy: { name: "asc" },
  })
}

export async function listPermissions() {
  return db.permission.findMany({ orderBy: [{ category: "asc" }, { code: "asc" }] })
}

export async function createRole(session: SessionContext, input: RoleInput) {
  assertCan(session, "users.manage")

  const role = await db.$transaction(async (tx) => {
    const created = await tx.role.create({
      data: { organizationId: session.user.organizationId, name: input.name },
    })
    if (input.permissionIds.length > 0) {
      await tx.rolePermission.createMany({
        data: input.permissionIds.map((permissionId) => ({ roleId: created.id, permissionId })),
      })
    }
    return created
  })

  await auditFromSession(session, "create", "role", role.id, { new: { name: role.name } })
  return role
}

export async function updateRolePermissions(session: SessionContext, roleId: string, permissionIds: string[]) {
  assertCan(session, "users.manage")
  const role = await db.role.findFirstOrThrow({ where: { id: roleId, organizationId: session.user.organizationId } })

  if (role.isSystemRole) {
    // System roles (the spec.md §7 default set) keep a stable baseline permission
    // shape; orgs extend access via additional custom roles rather than mutating
    // the defaults out from under the seeded expectations documented in SECURITY.md.
    throw new Error("System roles cannot have their permissions modified. Create a custom role instead.")
  }

  await db.$transaction([
    db.rolePermission.deleteMany({ where: { roleId } }),
    db.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId, permissionId })) }),
  ])

  await auditFromSession(session, "update", "role", roleId, { new: { permissionIds } })
}
