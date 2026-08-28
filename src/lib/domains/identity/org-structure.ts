import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, narrowBranchFilter } from "@/lib/platform/branch-scope"
import type { SessionContext } from "@/lib/auth/session"
import type { BranchInput, DepartmentInput, RoomInput, OrganizationInput } from "@/lib/domains/identity/schemas"

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export async function getOrganization(session: SessionContext) {
  assertCan(session, "settings.view")
  return db.organization.findUniqueOrThrow({ where: { id: session.user.organizationId } })
}

export async function updateOrganization(session: SessionContext, input: OrganizationInput) {
  assertCan(session, "settings.edit")
  const before = await db.organization.findUniqueOrThrow({ where: { id: session.user.organizationId } })
  const updated = await db.organization.update({
    where: { id: session.user.organizationId },
    data: input,
  })
  await auditFromSession(session, "update", "organization", updated.id, { old: before, new: updated })
  return updated
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

export async function listBranches(session: SessionContext) {
  assertCan(session, "branch.view")
  return db.branch.findMany({
    where: { organizationId: session.user.organizationId },
    orderBy: { name: "asc" },
  })
}

export async function createBranch(session: SessionContext, input: BranchInput) {
  assertCan(session, "branch.manage")
  const branch = await db.branch.create({
    data: { ...input, organizationId: session.user.organizationId },
  })
  await auditFromSession(session, "create", "branch", branch.id, { new: branch })
  return branch
}

export async function updateBranch(session: SessionContext, branchId: string, input: Partial<BranchInput>) {
  assertCan(session, "branch.manage", { branchId })
  const before = await db.branch.findUniqueOrThrow({ where: { id: branchId } })
  const updated = await db.branch.update({ where: { id: branchId }, data: input })
  await auditFromSession(session, "update", "branch", branchId, { old: before, new: updated })
  return updated
}

// ---------------------------------------------------------------------------
// Department
// ---------------------------------------------------------------------------

export async function listDepartments(session: SessionContext, branchId?: string) {
  assertCan(session, "department.view")
  const scope = getAuthorizedBranchScope(session)
  return db.department.findMany({
    where: {
      branch: { organizationId: session.user.organizationId },
      branchId: narrowBranchFilter(scope, branchId),
    },
    orderBy: { name: "asc" },
  })
}

export async function createDepartment(session: SessionContext, input: DepartmentInput) {
  assertCan(session, "department.manage", { branchId: input.branchId })
  const department = await db.department.create({ data: input })
  await auditFromSession(session, "create", "department", department.id, { new: department })
  return department
}

export async function updateDepartment(session: SessionContext, departmentId: string, input: Partial<DepartmentInput>) {
  assertCan(session, "department.manage")
  const before = await db.department.findUniqueOrThrow({ where: { id: departmentId } })
  const updated = await db.department.update({ where: { id: departmentId }, data: input })
  await auditFromSession(session, "update", "department", departmentId, { old: before, new: updated })
  return updated
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

export async function listRooms(session: SessionContext, departmentId?: string) {
  assertCan(session, "room.view")
  const scope = getAuthorizedBranchScope(session)
  return db.room.findMany({
    where: {
      department: {
        branch: { organizationId: session.user.organizationId },
        branchId: narrowBranchFilter(scope),
      },
      ...(departmentId ? { departmentId } : {}),
    },
    orderBy: { name: "asc" },
  })
}

export async function createRoom(session: SessionContext, input: RoomInput) {
  assertCan(session, "room.manage")
  const room = await db.room.create({ data: input })
  await auditFromSession(session, "create", "room", room.id, { new: room })
  return room
}

export async function updateRoom(session: SessionContext, roomId: string, input: Partial<RoomInput>) {
  assertCan(session, "room.manage")
  const before = await db.room.findUniqueOrThrow({ where: { id: roomId } })
  const updated = await db.room.update({ where: { id: roomId }, data: input })
  await auditFromSession(session, "update", "room", roomId, { old: before, new: updated })
  return updated
}
