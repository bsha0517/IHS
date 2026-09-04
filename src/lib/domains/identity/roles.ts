import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
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

/** Permission is a global, non-org-scoped catalog — validating ids here is purely "does this id exist at all" (P3.12 §50's "assigning nonexistent role"-style friendly error, applied to permissions too), not a cross-org check. */
async function assertPermissionsExist(permissionIds: string[]): Promise<void> {
  if (permissionIds.length === 0) return
  const found = await db.permission.findMany({ where: { id: { in: permissionIds } }, select: { id: true } })
  if (found.length !== new Set(permissionIds).size) {
    throw new Error("One or more selected permissions do not exist.")
  }
}

export async function createRole(session: SessionContext, input: RoleInput) {
  assertCan(session, "users.manage")
  const permissionIds = Array.from(new Set(input.permissionIds))
  await assertPermissionsExist(permissionIds)

  let role: Awaited<ReturnType<typeof db.role.create>>
  try {
    role = await db.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: { organizationId: session.user.organizationId, name: input.name },
      })
      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: created.id, permissionId })),
        })
      }
      return created
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new Error("A role with this name already exists in this organization.")
    }
    throw e
  }

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

  const uniquePermissionIds = Array.from(new Set(permissionIds))
  await assertPermissionsExist(uniquePermissionIds)

  await db.$transaction([
    db.rolePermission.deleteMany({ where: { roleId } }),
    db.rolePermission.createMany({ data: uniquePermissionIds.map((permissionId) => ({ roleId, permissionId })) }),
  ])

  await auditFromSession(session, "update", "role", roleId, { new: { permissionIds: uniquePermissionIds } })
}
