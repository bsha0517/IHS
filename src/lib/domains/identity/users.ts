import "server-only"
import { db } from "@/lib/db"
import { hashPassword } from "@/lib/auth/password"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { revokeAllUserSessions } from "@/lib/auth/session"
import type { SessionContext } from "@/lib/auth/session"
import type { CreateUserInput, UpdateUserInput } from "@/lib/domains/identity/schemas"

export async function listUsers(session: SessionContext) {
  assertCan(session, "users.manage")
  return db.user.findMany({
    where: { organizationId: session.user.organizationId },
    include: { roles: { include: { role: true } }, branchAccess: { include: { branch: true } } },
    orderBy: { createdAt: "desc" },
  })
}

export async function getUser(session: SessionContext, userId: string) {
  assertCan(session, "users.manage")
  return db.user.findFirstOrThrow({
    where: { id: userId, organizationId: session.user.organizationId },
    include: { roles: { include: { role: true } }, branchAccess: { include: { branch: true } } },
  })
}

export async function createUser(session: SessionContext, input: CreateUserInput) {
  assertCan(session, "users.manage")

  const passwordHash = await hashPassword(input.password)

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        organizationId: session.user.organizationId,
        email: input.email.trim().toLowerCase(),
        username: input.username ?? null,
        firstName: input.firstName,
        lastName: input.lastName,
        passwordHash,
      },
    })

    if (input.roleIds.length > 0) {
      await tx.userRole.createMany({
        data: input.roleIds.map((roleId) => ({ userId: created.id, roleId })),
      })
    }
    if (input.branchIds.length > 0) {
      await tx.userBranchAccess.createMany({
        data: input.branchIds.map((branchId) => ({ userId: created.id, branchId })),
      })
    }

    return created
  })

  await auditFromSession(session, "create", "user", user.id, {
    new: { email: user.email, firstName: user.firstName, lastName: user.lastName },
  })

  return user
}

export async function updateUser(session: SessionContext, userId: string, input: UpdateUserInput) {
  assertCan(session, "users.manage")
  const before = await db.user.findFirstOrThrow({ where: { id: userId, organizationId: session.user.organizationId } })

  const updated = await db.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        status: input.status,
      },
    })

    if (input.roleIds) {
      await tx.userRole.deleteMany({ where: { userId } })
      if (input.roleIds.length > 0) {
        await tx.userRole.createMany({ data: input.roleIds.map((roleId) => ({ userId, roleId })) })
      }
    }
    if (input.branchIds) {
      await tx.userBranchAccess.deleteMany({ where: { userId } })
      if (input.branchIds.length > 0) {
        await tx.userBranchAccess.createMany({ data: input.branchIds.map((branchId) => ({ userId, branchId })) })
      }
    }

    return user
  })

  await auditFromSession(session, "update", "user", userId, { old: before, new: updated })

  // A deactivation/lock or a role/branch change should not leave a stale session
  // holding the old permission set — force re-authentication under the new grant.
  if (input.status === "inactive" || input.status === "locked" || input.roleIds || input.branchIds) {
    await revokeAllUserSessions(userId)
  }

  return updated
}
