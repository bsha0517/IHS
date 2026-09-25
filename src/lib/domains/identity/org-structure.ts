import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { assertWithinBranchLimit } from "@/lib/domains/commercial/organizations"
import type { SessionContext } from "@/lib/auth/session"
import type { BranchInput, DepartmentInput, RoomInput, OrganizationInput } from "@/lib/domains/identity/schemas"

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export async function getOrganization(session: SessionContext) {
  assertCan(session, "settings.view")
  return db.organization.findUniqueOrThrow({ where: { id: session.user.organizationId } })
}

/**
 * P3.5/P3.6 §30: a minimal, permission-light read for clinical print views
 * (prescription/lab/radiology reports) — a clinic's own display name is not
 * sensitive settings data, and gating it behind `settings.view` (which
 * `getOrganization` above correctly requires for real Settings access) had
 * already been blocking prescription printing for every non-Clinic-Manager
 * role, including Doctor (confirmed via direct seed.ts cross-reference: only
 * Clinic Manager holds `settings.view`). Deliberately does NOT touch
 * `getOrganization`/`settings.view` itself — this is a new, narrower read
 * for exactly this one safe field, available to any authenticated session
 * in the organization (scoped by `session.user.organizationId` alone, the
 * same floor every other domain read uses).
 */
export async function getOrganizationIdentity(session: SessionContext) {
  return db.organization.findUniqueOrThrow({
    where: { id: session.user.organizationId },
    select: { displayName: true },
  })
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
  // P5.1 §17: centralized subscription branch-limit enforcement — a no-op
  // for the pre-P5.1 seed/bootstrap organization (no subscription at all).
  await assertWithinBranchLimit(session.user.organizationId)
  const branch = await db.branch.create({
    data: { ...input, organizationId: session.user.organizationId },
  })
  await auditFromSession(session, "create", "branch", branch.id, { new: branch })
  return branch
}

/**
 * P3.12 §45: `branch.manage` is an organization-wide administration
 * permission — only Super Admin/Organization Administrator hold it in
 * seed.ts, and `listBranches` already shows every branch in the org
 * unscoped for the same reason. Requiring the caller's OWN
 * `user_branch_access` to already include the target branch (the previous
 * `{ branchId }` option on `assertCan`) would force an org admin to first
 * self-grant branch access before they could edit a branch's own settings
 * — an invented branch-scoped semantic the RBAC model doesn't intend for
 * this permission (unlike operational writes such as `employee.manage`,
 * which genuinely are branch-scoped). What WAS a real gap: `findUniqueOrThrow`/
 * `update` below had no organization filter at all, so any org's
 * `branch.manage` holder could edit ANY other organization's branch by id
 * (P3.12 §44 cross-org tampering) — closed by scoping both to
 * `organizationId`.
 */
export async function updateBranch(
  session: SessionContext,
  branchId: string,
  input: Partial<BranchInput> & { status?: "active" | "inactive" }
) {
  assertCan(session, "branch.manage")
  const before = await db.branch.findFirstOrThrow({ where: { id: branchId, organizationId: session.user.organizationId } })
  // P5.1 §17/§65: reactivating a branch grows the active-branch count exactly
  // like creating one — same limit check, only when this update actually
  // transitions inactive -> active (an update that leaves it active, or
  // deactivates it, never needs to check).
  if (input.status === "active" && before.status !== "active") {
    await assertWithinBranchLimit(session.user.organizationId)
  }
  const updated = await db.branch.update({ where: { id: branchId }, data: input })
  await auditFromSession(session, "update", "branch", branchId, { old: before, new: updated })
  return updated
}

// ---------------------------------------------------------------------------
// Active branch (global branch switcher — P3.12 §18-21, resolves the P3.1
// backlog item). `Session.activeBranchId` already existed (set once at
// login, in auth/service.ts) and several pages already read it as their
// default branch (queue, reception, patients/new, appointments/new) — what
// was missing was any way to CHANGE it mid-session. This is a navigation
// preference only: every domain write/read still independently enforces
// its own branch scoping via `assertBranchAccess`/`narrowBranchFilter`, so
// persisting a branch here can never itself grant access to anything.
// ---------------------------------------------------------------------------

/** Branches the signed-in user may switch their active-branch preference to — every org branch for an org-wide session (Super Admin), otherwise exactly their own `user_branch_access` rows. */
export async function listSwitchableBranches(session: SessionContext) {
  const scope = getAuthorizedBranchScope(session)
  return db.branch.findMany({
    where: {
      organizationId: session.user.organizationId,
      ...(scope.isOrgWide ? {} : { id: { in: scope.branchIds } }),
    },
    select: { id: true, name: true, status: true },
    orderBy: { name: "asc" },
  })
}

/**
 * Updates the CURRENT session row's `activeBranchId`. Never trusts the
 * requested branch merely because it was submitted — narrowed against the
 * same authorized set `listSwitchableBranches` offers, so a tampered
 * request for a branch outside that set fails here rather than silently
 * getting persisted (P3.12 §20's "never persist an unauthorized branch id").
 */
export async function setActiveBranch(session: SessionContext, branchId: string): Promise<void> {
  const scope = getAuthorizedBranchScope(session)
  if (scope.isOrgWide) {
    await db.branch.findFirstOrThrow({ where: { id: branchId, organizationId: session.user.organizationId } })
  } else {
    assertBranchAccess(scope, branchId)
  }
  await db.session.update({ where: { id: session.sessionId }, data: { activeBranchId: branchId } })
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

/**
 * P3.12 §45: `department.manage`, like `branch.manage`, is organization-wide
 * administration (Super Admin/Organization Administrator only) — no
 * branch-scoped `assertCan` option by design (see `updateBranch`'s note).
 * The real requirement is that the target branch belongs to the caller's
 * own organization; `Department` has no `organizationId` column of its
 * own, only `branchId`, so that's checked explicitly here rather than left
 * to a client-supplied id.
 */
export async function createDepartment(session: SessionContext, input: DepartmentInput) {
  assertCan(session, "department.manage")
  const branch = await db.branch.findFirstOrThrow({ where: { id: input.branchId, organizationId: session.user.organizationId } })
  const department = await db.department.create({ data: { ...input, branchId: branch.id } })
  await auditFromSession(session, "create", "department", department.id, { new: department })
  return department
}

export async function updateDepartment(
  session: SessionContext,
  departmentId: string,
  input: Partial<DepartmentInput> & { status?: "active" | "inactive" }
) {
  assertCan(session, "department.manage")
  // P3.12 §44: previously fetched/updated by bare id with NO organization
  // check at all — any org's `department.manage` holder could edit ANY
  // other organization's department by id. Closed by joining through the
  // owning Branch, the only place Department carries an organizationId.
  const before = await db.department.findFirstOrThrow({
    where: { id: departmentId, branch: { organizationId: session.user.organizationId } },
  })
  if (input.branchId && input.branchId !== before.branchId) {
    await db.branch.findFirstOrThrow({ where: { id: input.branchId, organizationId: session.user.organizationId } })
  }
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
  // P3.12 §44: previously created directly from a client-supplied
  // departmentId with no ownership check at all — closed by verifying the
  // department's branch belongs to the caller's organization.
  const department = await db.department.findFirstOrThrow({
    where: { id: input.departmentId, branch: { organizationId: session.user.organizationId } },
  })
  const room = await db.room.create({ data: { ...input, departmentId: department.id } })
  await auditFromSession(session, "create", "room", room.id, { new: room })
  return room
}

export async function updateRoom(session: SessionContext, roomId: string, input: Partial<RoomInput>) {
  assertCan(session, "room.manage")
  // P3.12 §44: same class of cross-org gap as Branch/Department above —
  // Room carries neither branchId nor organizationId directly, only
  // reachable via Department -> Branch.
  const before = await db.room.findFirstOrThrow({
    where: { id: roomId, department: { branch: { organizationId: session.user.organizationId } } },
  })
  if (input.departmentId && input.departmentId !== before.departmentId) {
    await db.department.findFirstOrThrow({
      where: { id: input.departmentId, branch: { organizationId: session.user.organizationId } },
    })
  }
  const updated = await db.room.update({ where: { id: roomId }, data: input })
  await auditFromSession(session, "update", "room", roomId, { old: before, new: updated })
  return updated
}
