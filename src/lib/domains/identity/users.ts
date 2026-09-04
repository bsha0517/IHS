import "server-only"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { hashPassword } from "@/lib/auth/password"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { revokeAllUserSessions } from "@/lib/auth/session"
import type { SessionContext } from "@/lib/auth/session"
import type { CreateUserInput, UpdateUserInput } from "@/lib/domains/identity/schemas"

/** The permission that marks a user as an "administrator" for last-admin-safety purposes (P3.12 §51) — the same code `users.manage` this whole file gates on. */
const ADMIN_PERMISSION = "users.manage"

/**
 * P3.12 §44/§46: `createUser`/`updateUser` previously wrote every submitted
 * roleId straight into `user_role` with no check that the role even
 * belonged to the caller's own organization — a `users.manage` holder in
 * one org could grant a user in their org a Role row id borrowed/guessed
 * from ANY other organization, a real cross-org privilege-escalation path.
 * Roles have no self-describing "this belongs to your org" signal once
 * you're just holding a bare id, so this is checked explicitly, once, up
 * front — friendlier than letting a bad id surface as a raw Prisma FK
 * error (§50) and the only way to give an honest "not found in this org"
 * failure rather than a silent no-op.
 */
async function assertRolesInOrganization(organizationId: string, roleIds: string[]): Promise<void> {
  if (roleIds.length === 0) return
  const found = await db.role.findMany({ where: { id: { in: roleIds }, organizationId }, select: { id: true } })
  if (found.length !== roleIds.length) {
    throw new Error("One or more selected roles do not exist in this organization.")
  }
}

/** Same cross-org protection as `assertRolesInOrganization`, for branch access grants (P3.12 §47). */
async function assertBranchesInOrganization(organizationId: string, branchIds: string[]): Promise<void> {
  if (branchIds.length === 0) return
  const found = await db.branch.findMany({ where: { id: { in: branchIds }, organizationId }, select: { id: true } })
  if (found.length !== branchIds.length) {
    throw new Error("One or more selected branches do not exist in this organization.")
  }
}

/** Whether any of the given role ids grants `users.manage` — used both to detect the target user's current admin standing and to check a proposed new role set (P3.12 §51). */
async function anyRoleGrantsAdmin(roleIds: string[]): Promise<boolean> {
  if (roleIds.length === 0) return false
  const grantingRoles = await db.role.findMany({
    where: { id: { in: roleIds }, permissions: { some: { permission: { code: ADMIN_PERMISSION } } } },
    select: { id: true },
  })
  return grantingRoles.length > 0
}

/**
 * P3.12 §51: the organization's active-and-admin-capable headcount besides
 * `excludeUserId` — used to refuse an update that would leave zero active
 * `users.manage` holders (an org that has locked itself out of its own
 * Admin/Settings/Users screens has no supported recovery path in this
 * codebase, e.g. no platform-operator override).
 */
async function countOtherActiveAdmins(organizationId: string, excludeUserId: string): Promise<number> {
  return db.user.count({
    where: {
      organizationId,
      id: { not: excludeUserId },
      status: "active",
      roles: { some: { role: { permissions: { some: { permission: { code: ADMIN_PERMISSION } } } } } },
    },
  })
}

/** P3.12 §10: "linked employee/provider where applicable" — a User row's own linked Employee is a real, if minor, disclosure worth showing next to roles/branch access on the Users list, not only from the Employee side (P3.10/P3.12 §14). */
const USER_INCLUDE = {
  roles: { include: { role: true } },
  branchAccess: { include: { branch: true } },
  employeeProfile: { select: { id: true, firstName: true, lastName: true } },
} as const

export async function listUsers(session: SessionContext) {
  assertCan(session, "users.manage")
  return db.user.findMany({
    where: { organizationId: session.user.organizationId },
    include: USER_INCLUDE,
    orderBy: { createdAt: "desc" },
  })
}

export async function getUser(session: SessionContext, userId: string) {
  assertCan(session, "users.manage")
  return db.user.findFirstOrThrow({
    where: { id: userId, organizationId: session.user.organizationId },
    include: USER_INCLUDE,
  })
}

export async function createUser(session: SessionContext, input: CreateUserInput) {
  assertCan(session, "users.manage")

  // Dedupe first so a form double-submitting the same checkbox value can
  // never hit the underlying `@@unique([userId, roleId])`/`[userId, branchId]`
  // constraint as a raw Prisma error.
  const roleIds = Array.from(new Set(input.roleIds))
  const branchIds = Array.from(new Set(input.branchIds))
  await assertRolesInOrganization(session.user.organizationId, roleIds)
  await assertBranchesInOrganization(session.user.organizationId, branchIds)

  const passwordHash = await hashPassword(input.password)

  let user: Awaited<ReturnType<typeof db.user.create>>
  try {
    user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          // Never trust an organizationId from client input (P3.12 §11) — the
          // only organization a `users.manage` holder may create into is
          // their own session's.
          organizationId: session.user.organizationId,
          email: input.email.trim().toLowerCase(),
          username: input.username ?? null,
          firstName: input.firstName,
          lastName: input.lastName,
          passwordHash,
        },
      })

      if (roleIds.length > 0) {
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({ userId: created.id, roleId })),
        })
      }
      if (branchIds.length > 0) {
        await tx.userBranchAccess.createMany({
          data: branchIds.map((branchId) => ({ userId: created.id, branchId })),
        })
      }

      return created
    })
  } catch (e) {
    // P3.12 §50: `[organizationId, email]`/`[organizationId, username]` are
    // both real unique constraints — translate the raw Prisma violation
    // into an actionable message rather than leaking it to the Admin UI.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new Error("A user with this email or username already exists in this organization.")
    }
    throw e
  }

  await auditFromSession(session, "create", "user", user.id, {
    new: { email: user.email, firstName: user.firstName, lastName: user.lastName },
  })

  return user
}

export async function updateUser(session: SessionContext, userId: string, input: UpdateUserInput) {
  assertCan(session, "users.manage")
  const before = await db.user.findFirstOrThrow({
    where: { id: userId, organizationId: session.user.organizationId },
    include: { roles: { select: { roleId: true } } },
  })

  // P3.12 §28: the concrete, named self-escalation case — a user changing
  // their OWN role assignment (granting themselves a more powerful role,
  // or just as easily removing a role that was checking them). No
  // hierarchy/delegation model is invented here; the assignment is simply
  // frozen for the acting user's own account. Status (activate/deactivate)
  // is deliberately NOT blocked here — that's covered by the last-admin
  // check below, which is the actual risk (locking the org out), not a
  // blanket "can't touch your own row."
  if (userId === session.user.id && input.roleIds) {
    const currentRoleIds = before.roles.map((r) => r.roleId).sort()
    const nextRoleIds = [...new Set(input.roleIds)].sort()
    const unchanged =
      currentRoleIds.length === nextRoleIds.length && currentRoleIds.every((id, i) => id === nextRoleIds[i])
    if (!unchanged) {
      throw new Error("You cannot change your own role assignment. Ask another administrator to make this change.")
    }
  }

  const roleIds = input.roleIds ? Array.from(new Set(input.roleIds)) : undefined
  const branchIds = input.branchIds ? Array.from(new Set(input.branchIds)) : undefined
  if (roleIds) await assertRolesInOrganization(session.user.organizationId, roleIds)
  if (branchIds) await assertBranchesInOrganization(session.user.organizationId, branchIds)

  // P3.12 §51: last-admin safety. Only evaluated when this update would
  // actually remove the target's admin standing (a status change away from
  // active, or a role-set change that drops every `users.manage`-granting
  // role) — an update that leaves an already-non-admin user exactly as
  // non-admin as before never needs the extra count query.
  const wasAdmin = await anyRoleGrantsAdmin(before.roles.map((r) => r.roleId))
  if (wasAdmin) {
    const losingStatus = input.status !== undefined && input.status !== "active"
    const losingRole = roleIds !== undefined && !(await anyRoleGrantsAdmin(roleIds))
    if (losingStatus || losingRole) {
      const otherActiveAdmins = await countOtherActiveAdmins(session.user.organizationId, userId)
      if (otherActiveAdmins === 0) {
        throw new Error(
          "Cannot deactivate or remove administrator access from this user — they are the organization's last active administrator."
        )
      }
    }
  }

  let updated: Awaited<ReturnType<typeof db.user.update>>
  try {
    updated = await db.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          status: input.status,
        },
      })

      if (roleIds) {
        await tx.userRole.deleteMany({ where: { userId } })
        if (roleIds.length > 0) {
          await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ userId, roleId })) })
        }
      }
      if (branchIds) {
        await tx.userBranchAccess.deleteMany({ where: { userId } })
        if (branchIds.length > 0) {
          await tx.userBranchAccess.createMany({ data: branchIds.map((branchId) => ({ userId, branchId })) })
        }
      }

      return user
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new Error("A user with this email or username already exists in this organization.")
    }
    throw e
  }

  await auditFromSession(session, "update", "user", userId, { old: before, new: updated })

  // A deactivation/lock or a role/branch change should not leave a stale session
  // holding the old permission set — force re-authentication under the new grant.
  if (input.status === "inactive" || input.status === "locked" || roleIds || branchIds) {
    await revokeAllUserSessions(userId)
  }

  return updated
}

// ---------------------------------------------------------------------------
// Employee <-> User linkage (P3.12 §14 — resolves the P3.10 backlog item)
// ---------------------------------------------------------------------------

/**
 * Users in this organization not already linked to an Employee — the
 * candidate list for the "Link to existing user" picker on the Employee
 * detail page. Deliberately excludes the currently-linked user of the
 * employee being edited from being treated as "taken" — the caller adds it
 * back in when rendering (it's already a valid choice: re-selecting the
 * same link is a no-op, not a conflict).
 */
export async function listUnlinkedUsers(session: SessionContext) {
  assertCan(session, "users.manage")
  return db.user.findMany({
    where: { organizationId: session.user.organizationId, employeeProfile: null },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  })
}

/**
 * P3.12 §14: Admin-only. Same-organization on both sides, one User linked
 * to at most one Employee and vice versa (the schema's own `@unique` on
 * `Employee.userId` is the ultimate backstop; the explicit checks below
 * exist to give an honest, actionable error instead of a raw constraint
 * violation — P3.12 §50). No automatic User creation, no silent overwrite
 * of an existing different link — the caller must unlink first.
 */
export async function linkEmployeeUser(session: SessionContext, employeeId: string, userId: string) {
  assertCan(session, "users.manage")

  const [employee, user, conflictingEmployee] = await Promise.all([
    db.employee.findFirstOrThrow({ where: { id: employeeId, organizationId: session.user.organizationId } }),
    db.user.findFirstOrThrow({ where: { id: userId, organizationId: session.user.organizationId } }),
    db.employee.findFirst({ where: { userId, id: { not: employeeId } }, select: { id: true, firstName: true, lastName: true } }),
  ])

  if (employee.userId && employee.userId !== userId) {
    throw new Error("This employee is already linked to a different user. Unlink first.")
  }
  if (conflictingEmployee) {
    throw new Error(`This user is already linked to another employee (${conflictingEmployee.firstName} ${conflictingEmployee.lastName}).`)
  }

  const updated = await db.employee.update({ where: { id: employeeId }, data: { userId: user.id } })
  await auditFromSession(session, "update", "employee", employeeId, { old: { userId: employee.userId }, new: { userId: user.id } })
  return updated
}

export async function unlinkEmployeeUser(session: SessionContext, employeeId: string) {
  assertCan(session, "users.manage")
  const employee = await db.employee.findFirstOrThrow({ where: { id: employeeId, organizationId: session.user.organizationId } })
  const updated = await db.employee.update({ where: { id: employeeId }, data: { userId: null } })
  await auditFromSession(session, "update", "employee", employeeId, { old: { userId: employee.userId }, new: { userId: null } })
  return updated
}
