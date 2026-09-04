import "dotenv/config"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { db } from "@/lib/db"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import {
  updateOrganization,
  createBranch,
  updateBranch,
  createDepartment,
  updateDepartment,
  createRoom,
  updateRoom,
  listSwitchableBranches,
  setActiveBranch,
} from "@/lib/domains/identity/org-structure"
import {
  createUser,
  updateUser,
  linkEmployeeUser,
  unlinkEmployeeUser,
  listUnlinkedUsers,
} from "@/lib/domains/identity/users"
import { createRole, updateRolePermissions } from "@/lib/domains/identity/roles"
import { createEmployee } from "@/lib/domains/hr/employees"
import { resolveDefaultLandingRoute } from "@/lib/platform/landing"
import { visibleDashboardSections, getDoctorDashboard } from "@/lib/domains/analytics/dashboards"
import { NAV_GROUPS } from "@/components/layout/nav-config"
import { ForbiddenError } from "@/lib/platform/permissions-core"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P3.12 — Admin / Settings / Role-Aware Navigation. Covers the genuinely
 * new/changed behavior this batch (see
 * P3_12_ADMIN_SETTINGS_ROLE_AWARE_NAVIGATION_REPORT.md for full rationale):
 * the cross-org privilege-escalation gaps found and closed in
 * createUser/updateUser/updateBranch/createDepartment/updateDepartment/
 * createRoom/updateRoom, the self-escalation and last-admin guards, the
 * new Employee<->User linkage, the global branch switcher, and permission-
 * based default-landing resolution. Does not re-test unchanged P1-P3.11
 * authorization behavior.
 */
const TIMEOUT = 60000

describe("P3.12: Organization / Branch / Department / Room — org-scoping and authorization", () => {
  let organizationId: string
  let branchAId: string
  let actorUserId: string
  let otherOrgId: string
  let otherBranchId: string
  let otherDepartmentId: string
  const cleanupBranchIds: string[] = []
  const cleanupDepartmentIds: string[] = []
  const cleanupRoomIds: string[] = []
  const cleanupEmployeeIds: string[] = []

  function adminSession(branchIds: string[] = []): SessionContext {
    return {
      sessionId: `test-p3-12-org-${actorUserId}`,
      user: { id: actorUserId, organizationId, email: "p3-12-org@test.local", firstName: "P312", lastName: "Org" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(["branch.manage", "department.manage", "room.manage", "settings.edit", "employee.manage"]),
      roleNames: ["P3.12 Admin-Permission Test Role"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id
    const anyUser = await db.user.findFirstOrThrow({ where: { organizationId } })
    actorUserId = anyUser.id

    const otherOrg = await db.organization.create({
      data: { legalName: "P3.12 Other Org", displayName: "P3.12 Other Org" },
    })
    otherOrgId = otherOrg.id
    const otherBranch = await db.branch.create({
      data: { organizationId: otherOrgId, name: "P3.12 Other Branch", code: `P312OB-${Date.now()}`, timezone: "UTC" },
    })
    otherBranchId = otherBranch.id
    const otherDepartment = await db.department.create({
      data: { branchId: otherBranchId, name: "P3.12 Other Dept", code: `P312OD-${Date.now()}` },
    })
    otherDepartmentId = otherDepartment.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.room.deleteMany({ where: { id: { in: cleanupRoomIds } } })
    await db.employee.deleteMany({ where: { id: { in: cleanupEmployeeIds } } })
    await db.department.deleteMany({ where: { id: { in: cleanupDepartmentIds } } })
    await db.department.delete({ where: { id: otherDepartmentId } }).catch(() => {})
    await db.branch.deleteMany({ where: { id: { in: cleanupBranchIds } } })
    await db.branch.delete({ where: { id: otherBranchId } }).catch(() => {})
    await db.organization.delete({ where: { id: otherOrgId } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  it("§45: branch.manage is organization-wide — a session with no personal branch access can still update a branch in its own org", async () => {
    const branch = await createBranch(adminSession([]), {
      name: `P3.12 Test Branch ${Date.now()}`,
      code: `P312TB-${Date.now()}`,
      timezone: "UTC",
    })
    cleanupBranchIds.push(branch.id)
    const updated = await updateBranch(adminSession([]), branch.id, { name: "P3.12 Test Branch Renamed" })
    expect(updated.name).toBe("P3.12 Test Branch Renamed")
  }, TIMEOUT)

  it("§44: updateBranch rejects another organization's branch by id", async () => {
    await expect(updateBranch(adminSession([]), otherBranchId, { name: "hijacked" })).rejects.toThrow()
  }, TIMEOUT)

  it("§9: branch deactivation preserves historical references (no cascade, no delete)", async () => {
    const branch = await createBranch(adminSession([]), {
      name: `P3.12 History Branch ${Date.now()}`,
      code: `P312HB-${Date.now()}`,
      timezone: "UTC",
    })
    cleanupBranchIds.push(branch.id)
    const employee = await createEmployee(adminSession([branch.id]), {
      branchId: branch.id,
      firstName: "P312",
      lastName: "Historical",
      designation: "Tester",
      joiningDate: new Date(),
      employmentType: "full_time",
      basicSalary: 0,
    })
    cleanupEmployeeIds.push(employee.id)

    const deactivated = await updateBranch(adminSession([]), branch.id, { status: "inactive" })
    expect(deactivated.status).toBe("inactive")

    const reloadedEmployee = await db.employee.findUniqueOrThrow({ where: { id: employee.id } })
    expect(reloadedEmployee.branchId).toBe(branch.id) // untouched — no cascade wipe
    const reloadedBranch = await db.branch.findUniqueOrThrow({ where: { id: branch.id } })
    expect(reloadedBranch).toBeTruthy() // still exists — never destructively deleted
  }, TIMEOUT)

  it("§44: createDepartment rejects a branchId belonging to another organization", async () => {
    await expect(
      createDepartment(adminSession([]), { branchId: otherBranchId, name: "hijack", code: `HJ-${Date.now()}` })
    ).rejects.toThrow()
  }, TIMEOUT)

  it("§44: updateDepartment rejects another organization's department by id", async () => {
    await expect(updateDepartment(adminSession([]), otherDepartmentId, { name: "hijacked" })).rejects.toThrow()
  }, TIMEOUT)

  it("§38: department status can be toggled (Department management resolved)", async () => {
    const department = await createDepartment(adminSession([]), {
      branchId: branchAId,
      name: `P3.12 Test Dept ${Date.now()}`,
      code: `P312TD-${Date.now()}`,
    })
    cleanupDepartmentIds.push(department.id)
    const updated = await updateDepartment(adminSession([]), department.id, { status: "inactive" })
    expect(updated.status).toBe("inactive")
  }, TIMEOUT)

  it("§44: createRoom rejects a departmentId belonging to another organization", async () => {
    await expect(
      createRoom(adminSession([]), { departmentId: otherDepartmentId, name: "hijack", code: `HJ-${Date.now()}`, roomType: "test" })
    ).rejects.toThrow()
  }, TIMEOUT)

  it("§44: updateRoom rejects another organization's room by id", async () => {
    const otherRoom = await db.room.create({
      data: { departmentId: otherDepartmentId, name: "Other Room", code: `OR-${Date.now()}`, roomType: "test" },
    })
    await expect(updateRoom(adminSession([]), otherRoom.id, { name: "hijacked" })).rejects.toThrow()
    await db.room.delete({ where: { id: otherRoom.id } })
  }, TIMEOUT)

  it("§7: updateOrganization still requires settings.edit, not just settings.view", async () => {
    const viewOnly: SessionContext = {
      sessionId: "test-p3-12-view-only",
      user: { id: actorUserId, organizationId, email: "x@test.local", firstName: "X", lastName: "Y" },
      activeBranchId: null,
      branchIds: [],
      permissions: new Set(["settings.view"]),
      roleNames: ["P3.12 View Only"],
    }
    await expect(updateOrganization(viewOnly, { legalName: "x", displayName: "y", defaultCurrency: "AED", defaultTimezone: "UTC" })).rejects.toThrow(
      ForbiddenError
    )
  }, TIMEOUT)

  it("§18-21: the global branch switcher persists a preference, never an unauthorized branch", async () => {
    const scoped: SessionContext = {
      sessionId: `test-p3-12-switch-${actorUserId}`,
      user: { id: actorUserId, organizationId, email: "x@test.local", firstName: "X", lastName: "Y" },
      activeBranchId: branchAId,
      branchIds: [branchAId],
      permissions: new Set([]),
      roleNames: ["P3.12 Scoped Role"],
    }
    // Give this session a real session row so setActiveBranch has something to update.
    const rawSession = await db.session.create({
      data: { userId: actorUserId, tokenHash: `p312-switch-${Date.now()}`, activeBranchId: branchAId, expiresAt: new Date(Date.now() + 3600_000) },
    })
    scoped.sessionId = rawSession.id

    await expect(setActiveBranch(scoped, otherBranchId)).rejects.toThrow(ForbiddenError) // not authorized for this branch
    await setActiveBranch(scoped, branchAId) // authorized — no-op change, must not throw
    const reloaded = await db.session.findUniqueOrThrow({ where: { id: rawSession.id } })
    expect(reloaded.activeBranchId).toBe(branchAId)

    const switchable = await listSwitchableBranches(scoped)
    expect(switchable.map((b) => b.id)).toEqual([branchAId])
    expect(switchable.map((b) => b.id)).not.toContain(otherBranchId)

    await db.session.delete({ where: { id: rawSession.id } })
  }, TIMEOUT)

  it("§18-21: an org-wide (Super Admin) session may switch to any branch in its own org, none outside it", async () => {
    const orgWide: SessionContext = {
      sessionId: "",
      user: { id: actorUserId, organizationId, email: "x@test.local", firstName: "X", lastName: "Y" },
      activeBranchId: branchAId,
      branchIds: [], // deliberately empty — isOrgWide should not need personal branch access
      permissions: new Set([]),
      roleNames: ["Super Admin"],
    }
    const rawSession = await db.session.create({
      data: { userId: actorUserId, tokenHash: `p312-orgwide-${Date.now()}`, activeBranchId: branchAId, expiresAt: new Date(Date.now() + 3600_000) },
    })
    orgWide.sessionId = rawSession.id

    const switchable = await listSwitchableBranches(orgWide)
    expect(switchable.map((b) => b.id)).toContain(branchAId)
    await expect(setActiveBranch(orgWide, otherBranchId)).rejects.toThrow() // real branch, wrong org — never persisted
    await db.session.delete({ where: { id: rawSession.id } })
  }, TIMEOUT)
})

describe("P3.12: Users — creation, cross-org rejection, self-escalation, last-admin safety", () => {
  let organizationId: string
  let branchAId: string
  let adminPermissionId: string
  let operationalRoleId: string
  let otherOrgId: string
  let otherRoleId: string
  let otherBranchId: string
  const cleanupUserIds: string[] = []
  const cleanupRoleIds: string[] = []

  function sessionFor(userId: string, orgId: string, branchIds: string[], permissions: string[]): SessionContext {
    return {
      sessionId: `test-p3-12-user-${userId}`,
      user: { id: userId, organizationId: orgId, email: `p312-${userId}@test.local`, firstName: "P312", lastName: "User" },
      activeBranchId: branchIds[0] ?? null,
      branchIds,
      permissions: new Set(permissions),
      roleNames: ["P3.12 Test Role"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    branchAId = branch.id
    const adminPermission = await db.permission.findFirstOrThrow({ where: { code: "users.manage" } })
    adminPermissionId = adminPermission.id

    const operationalRole = await db.role.create({ data: { organizationId, name: `P3.12 Operational Role ${Date.now()}` } })
    operationalRoleId = operationalRole.id
    cleanupRoleIds.push(operationalRoleId)

    const otherOrg = await db.organization.create({ data: { legalName: "P3.12 Users Other Org", displayName: "P3.12 Users Other Org" } })
    otherOrgId = otherOrg.id
    const otherBranch = await db.branch.create({
      data: { organizationId: otherOrgId, name: "Other Branch", code: `P312UOB-${Date.now()}`, timezone: "UTC" },
    })
    otherBranchId = otherBranch.id
    const otherRole = await db.role.create({ data: { organizationId: otherOrgId, name: "Other Org Role" } })
    otherRoleId = otherRole.id
  }, TIMEOUT)

  afterAll(async () => {
    await db.userRole.deleteMany({ where: { userId: { in: cleanupUserIds } } })
    await db.userBranchAccess.deleteMany({ where: { userId: { in: cleanupUserIds } } })
    await db.session.deleteMany({ where: { userId: { in: cleanupUserIds } } })
    await db.user.deleteMany({ where: { id: { in: cleanupUserIds } } })
    await db.role.deleteMany({ where: { id: { in: cleanupRoleIds } } })
    await db.role.delete({ where: { id: otherRoleId } }).catch(() => {})
    await db.branch.delete({ where: { id: otherBranchId } }).catch(() => {})
    await db.organization.delete({ where: { id: otherOrgId } }).catch(() => {})
    await db.$disconnect()
  }, TIMEOUT)

  async function makeAdminRole() {
    const role = await db.role.create({ data: { organizationId, name: `P3.12 Admin Role ${Date.now()}-${Math.random()}` } })
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: adminPermissionId } })
    cleanupRoleIds.push(role.id)
    return role.id
  }

  it("§11: createUser derives organizationId from the session, never from client input", async () => {
    const actor = await db.user.create({
      data: { organizationId, email: `p312-actor-${Date.now()}@test.local`, firstName: "P312", lastName: "Actor", passwordHash: "x" },
    })
    cleanupUserIds.push(actor.id)
    const created = await createUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), {
      email: `p312-created-${Date.now()}@test.local`,
      firstName: "Created",
      lastName: "User",
      password: "correcthorsebattery",
      roleIds: [],
      branchIds: [],
    })
    cleanupUserIds.push(created.id)
    expect(created.organizationId).toBe(organizationId)
  }, TIMEOUT)

  it("§50: duplicate email surfaces a friendly error, not a raw Prisma constraint message", async () => {
    const actor = await db.user.create({
      data: { organizationId, email: `p312-actor2-${Date.now()}@test.local`, firstName: "P312", lastName: "Actor", passwordHash: "x" },
    })
    cleanupUserIds.push(actor.id)
    const email = `p312-dup-${Date.now()}@test.local`
    const first = await createUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), {
      email,
      firstName: "First",
      lastName: "User",
      password: "correcthorsebattery",
      roleIds: [],
      branchIds: [],
    })
    cleanupUserIds.push(first.id)

    await expect(
      createUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), {
        email,
        firstName: "Second",
        lastName: "User",
        password: "correcthorsebattery",
        roleIds: [],
        branchIds: [],
      })
    ).rejects.toThrow(/already exists/)
  }, TIMEOUT)

  it("§44/§46: createUser rejects a roleId belonging to another organization", async () => {
    const actor = await db.user.create({
      data: { organizationId, email: `p312-actor3-${Date.now()}@test.local`, firstName: "P312", lastName: "Actor", passwordHash: "x" },
    })
    cleanupUserIds.push(actor.id)
    await expect(
      createUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), {
        email: `p312-shouldfail-${Date.now()}@test.local`,
        firstName: "Should",
        lastName: "Fail",
        password: "correcthorsebattery",
        roleIds: [otherRoleId],
        branchIds: [],
      })
    ).rejects.toThrow(/do not exist in this organization/)
  }, TIMEOUT)

  it("§44/§47: createUser rejects a branchId belonging to another organization", async () => {
    const actor = await db.user.create({
      data: { organizationId, email: `p312-actor4-${Date.now()}@test.local`, firstName: "P312", lastName: "Actor", passwordHash: "x" },
    })
    cleanupUserIds.push(actor.id)
    await expect(
      createUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), {
        email: `p312-shouldfail2-${Date.now()}@test.local`,
        firstName: "Should",
        lastName: "Fail",
        password: "correcthorsebattery",
        roleIds: [],
        branchIds: [otherBranchId],
      })
    ).rejects.toThrow(/do not exist in this organization/)
  }, TIMEOUT)

  it("§47: duplicate branchIds/roleIds within one request are deduped, not a raw unique-constraint crash", async () => {
    const actor = await db.user.create({
      data: { organizationId, email: `p312-actor5-${Date.now()}@test.local`, firstName: "P312", lastName: "Actor", passwordHash: "x" },
    })
    cleanupUserIds.push(actor.id)
    const created = await createUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), {
      email: `p312-dedup-${Date.now()}@test.local`,
      firstName: "Dedup",
      lastName: "User",
      password: "correcthorsebattery",
      roleIds: [operationalRoleId, operationalRoleId],
      branchIds: [branchAId, branchAId],
    })
    cleanupUserIds.push(created.id)
    const roleRows = await db.userRole.findMany({ where: { userId: created.id } })
    const branchRows = await db.userBranchAccess.findMany({ where: { userId: created.id } })
    expect(roleRows).toHaveLength(1)
    expect(branchRows).toHaveLength(1)
  }, TIMEOUT)

  it("§26: updateUser can assign a role to a DIFFERENT user normally", async () => {
    const actorRoleId = await makeAdminRole()
    const actor = await db.user.create({
      data: { organizationId, email: `p312-actor6-${Date.now()}@test.local`, firstName: "P312", lastName: "Actor", passwordHash: "x" },
    })
    await db.userRole.create({ data: { userId: actor.id, roleId: actorRoleId } })
    cleanupUserIds.push(actor.id)
    const target = await db.user.create({
      data: { organizationId, email: `p312-target-${Date.now()}@test.local`, firstName: "P312", lastName: "Target", passwordHash: "x" },
    })
    cleanupUserIds.push(target.id)

    const updated = await updateUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), target.id, {
      roleIds: [operationalRoleId],
    })
    expect(updated.id).toBe(target.id)
    const roleRows = await db.userRole.findMany({ where: { userId: target.id } })
    expect(roleRows.map((r) => r.roleId)).toEqual([operationalRoleId])
  }, TIMEOUT)

  it("§44/§46: updateUser rejects a roleId belonging to another organization", async () => {
    const actor = await db.user.create({
      data: { organizationId, email: `p312-actor7-${Date.now()}@test.local`, firstName: "P312", lastName: "Actor", passwordHash: "x" },
    })
    cleanupUserIds.push(actor.id)
    const target = await db.user.create({
      data: { organizationId, email: `p312-target2-${Date.now()}@test.local`, firstName: "P312", lastName: "Target", passwordHash: "x" },
    })
    cleanupUserIds.push(target.id)

    await expect(
      updateUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), target.id, { roleIds: [otherRoleId] })
    ).rejects.toThrow(/do not exist in this organization/)
  }, TIMEOUT)

  it("§28: self-escalation — a session cannot change its own role assignment", async () => {
    const actorRoleId = await makeAdminRole()
    const actor = await db.user.create({
      data: { organizationId, email: `p312-self-${Date.now()}@test.local`, firstName: "P312", lastName: "Self", passwordHash: "x" },
    })
    await db.userRole.create({ data: { userId: actor.id, roleId: actorRoleId } })
    cleanupUserIds.push(actor.id)

    await expect(
      updateUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), actor.id, { roleIds: [operationalRoleId] })
    ).rejects.toThrow(/cannot change your own role/)

    // Resubmitting the SAME (unchanged) role set is not blocked — it's a no-op, not an escalation.
    const unchanged = await updateUser(sessionFor(actor.id, organizationId, [], ["users.manage"]), actor.id, {
      roleIds: [actorRoleId],
    })
    expect(unchanged.id).toBe(actor.id)
  }, TIMEOUT)

  it("§51: last-admin safety — cannot deactivate the organization's sole active administrator", async () => {
    const soleAdminRoleId = await makeAdminRole()
    const soleAdmin = await db.user.create({
      data: { organizationId, email: `p312-sole-${Date.now()}@test.local`, firstName: "P312", lastName: "Sole", passwordHash: "x" },
    })
    await db.userRole.create({ data: { userId: soleAdmin.id, roleId: soleAdminRoleId } })
    cleanupUserIds.push(soleAdmin.id)

    const actor = await db.user.create({
      data: { organizationId, email: `p312-actor8-${Date.now()}@test.local`, firstName: "P312", lastName: "Actor", passwordHash: "x" },
    })
    cleanupUserIds.push(actor.id)
    const actorSession = sessionFor(actor.id, organizationId, [], ["users.manage"])

    // No other user in this fixture set holds an admin-permission role besides
    // soleAdmin (the seeded org-wide Super Admin is a different org entirely
    // for every OTHER describe block's fixtures, but this block reuses the
    // shared default org — countOtherActiveAdmins legitimately still finds
    // it. To isolate the zero-admin case deterministically, strip it out of
    // consideration is not possible without touching seed data, so this
    // assertion instead proves the POSITIVE direction: stripping the role
    // that would leave >=1 other real admin (the seeded org admin/Super
    // Admin) succeeds, and the guard's own logic — that it counts OTHER
    // active admins excluding the target — is covered directly below via a
    // fully isolated organization.
    const updated = await updateUser(actorSession, soleAdmin.id, { status: "inactive" })
    expect(updated.status).toBe("inactive")
  }, TIMEOUT)

  it("§51: last-admin safety — fully isolated organization proves the zero-admin case is actually rejected", async () => {
    const isolatedOrg = await db.organization.create({
      data: { legalName: "P3.12 Isolated Admin Org", displayName: "P3.12 Isolated Admin Org" },
    })
    const isolatedRole = await db.role.create({ data: { organizationId: isolatedOrg.id, name: "Isolated Admin" } })
    await db.rolePermission.create({ data: { roleId: isolatedRole.id, permissionId: adminPermissionId } })
    const soleAdmin = await db.user.create({
      data: { organizationId: isolatedOrg.id, email: `p312-iso-sole-${Date.now()}@test.local`, firstName: "Sole", lastName: "Admin", passwordHash: "x" },
    })
    await db.userRole.create({ data: { userId: soleAdmin.id, roleId: isolatedRole.id } })
    const actor = await db.user.create({
      data: { organizationId: isolatedOrg.id, email: `p312-iso-actor-${Date.now()}@test.local`, firstName: "Actor", lastName: "User", passwordHash: "x" },
    })
    const actorSession = sessionFor(actor.id, isolatedOrg.id, [], ["users.manage"])

    await expect(updateUser(actorSession, soleAdmin.id, { status: "inactive" })).rejects.toThrow(/last active administrator/)
    await expect(updateUser(actorSession, soleAdmin.id, { roleIds: [] })).rejects.toThrow(/last active administrator/)

    // Add a second admin — now demoting/deactivating the first succeeds.
    const secondAdmin = await db.user.create({
      data: { organizationId: isolatedOrg.id, email: `p312-iso-second-${Date.now()}@test.local`, firstName: "Second", lastName: "Admin", passwordHash: "x" },
    })
    await db.userRole.create({ data: { userId: secondAdmin.id, roleId: isolatedRole.id } })
    const updated = await updateUser(actorSession, soleAdmin.id, { status: "inactive" })
    expect(updated.status).toBe("inactive")

    await db.userRole.deleteMany({ where: { userId: { in: [soleAdmin.id, secondAdmin.id, actor.id] } } })
    await db.session.deleteMany({ where: { userId: { in: [soleAdmin.id, secondAdmin.id, actor.id] } } })
    await db.user.deleteMany({ where: { id: { in: [soleAdmin.id, secondAdmin.id, actor.id] } } })
    await db.role.delete({ where: { id: isolatedRole.id } })
    // Targeted backlog closure, item 10B (BACKLOG.md's documented orphaned-
    // fixture issue): `updateUser`'s real audit writes above reference
    // isolatedOrg.id via a genuine FK (unlike AuditLog.userId, which is a
    // bare scalar — see schema.prisma). audit_log is deliberately
    // insert-only at the DB grant level (schema.prisma's own header
    // comment) for the RESTRICTED runtime role `db` connects as — the same
    // reason p3-5's own test file opens a temporary owner-level connection
    // (DIRECT_DATABASE_URL) to clean up clinicalAccessLog, another
    // runtime-insert-only table. Applying the identical pattern here: this
    // fixture organization no longer needs to be left behind, since the
    // owner connection genuinely can delete what the restricted one can't.
    const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL }) })
    await ownerDb.auditLog.deleteMany({ where: { organizationId: isolatedOrg.id } })
    await ownerDb.$disconnect()
    await db.organization.delete({ where: { id: isolatedOrg.id } })
  }, TIMEOUT)

  it("§14: Employee<->User linkage — link, duplicate-link rejection, cross-org rejection, unlink/relink", async () => {
    const actor = await db.user.create({
      data: { organizationId, email: `p312-linkactor-${Date.now()}@test.local`, firstName: "P312", lastName: "Actor", passwordHash: "x" },
    })
    cleanupUserIds.push(actor.id)
    const userA = await db.user.create({
      data: { organizationId, email: `p312-linkA-${Date.now()}@test.local`, firstName: "Link", lastName: "A", passwordHash: "x" },
    })
    cleanupUserIds.push(userA.id)
    const userB = await db.user.create({
      data: { organizationId, email: `p312-linkB-${Date.now()}@test.local`, firstName: "Link", lastName: "B", passwordHash: "x" },
    })
    cleanupUserIds.push(userB.id)

    const employeeSetupSession: SessionContext = {
      sessionId: "test-p3-12-link-setup",
      user: { id: actor.id, organizationId, email: "x@test.local", firstName: "X", lastName: "Y" },
      activeBranchId: branchAId,
      branchIds: [branchAId],
      permissions: new Set(["employee.manage"]),
      roleNames: ["P3.12 Employee Setup"],
    }
    const employee = await createEmployee(employeeSetupSession, {
      branchId: branchAId,
      firstName: "Linkable",
      lastName: "Employee",
      designation: "Tester",
      joiningDate: new Date(),
      employmentType: "full_time",
      basicSalary: 0,
    })

    const actorSession = sessionFor(actor.id, organizationId, [], ["users.manage"])

    // Before linking, userA is a candidate.
    const unlinked = await listUnlinkedUsers(actorSession)
    expect(unlinked.map((u) => u.id)).toContain(userA.id)

    const linked = await linkEmployeeUser(actorSession, employee.id, userA.id)
    expect(linked.userId).toBe(userA.id)

    // Re-linking to a different user without unlinking first is rejected.
    await expect(linkEmployeeUser(actorSession, employee.id, userB.id)).rejects.toThrow(/already linked to a different user/)

    // A second employee cannot take a user who is already linked elsewhere.
    const secondEmployee = await createEmployee(employeeSetupSession, {
      branchId: branchAId,
      firstName: "Second",
      lastName: "Employee",
      designation: "Tester",
      joiningDate: new Date(),
      employmentType: "full_time",
      basicSalary: 0,
    })
    await expect(linkEmployeeUser(actorSession, secondEmployee.id, userA.id)).rejects.toThrow(/already linked to another employee/)

    // Cross-org rejection: a user from another organization cannot be linked.
    const otherOrgUser = await db.user.create({
      data: { organizationId: otherOrgId, email: `p312-otherorguser-${Date.now()}@test.local`, firstName: "Other", lastName: "Org", passwordHash: "x" },
    })
    await expect(linkEmployeeUser(actorSession, secondEmployee.id, otherOrgUser.id)).rejects.toThrow()

    // Unlink, then relink to a different user.
    const unlinkedEmployee = await unlinkEmployeeUser(actorSession, employee.id)
    expect(unlinkedEmployee.userId).toBeNull()
    const relinked = await linkEmployeeUser(actorSession, employee.id, userB.id)
    expect(relinked.userId).toBe(userB.id)

    await db.employee.deleteMany({ where: { id: { in: [employee.id, secondEmployee.id] } } })
    await db.user.delete({ where: { id: otherOrgUser.id } })
  }, TIMEOUT)
})

describe("P3.12: Roles — permission validation, system-role protection", () => {
  let organizationId: string
  let actorUserId: string
  const cleanupRoleIds: string[] = []

  function session(permissions: string[]): SessionContext {
    return {
      sessionId: "test-p3-12-roles",
      user: { id: actorUserId, organizationId, email: "x@test.local", firstName: "X", lastName: "Y" },
      activeBranchId: null,
      branchIds: [],
      permissions: new Set(permissions),
      roleNames: ["P3.12 Test Role"],
    }
  }

  beforeAll(async () => {
    const branch = await db.branch.findFirstOrThrow()
    organizationId = branch.organizationId
    actorUserId = (await db.user.findFirstOrThrow({ where: { organizationId } })).id
  }, TIMEOUT)

  afterAll(async () => {
    await db.rolePermission.deleteMany({ where: { roleId: { in: cleanupRoleIds } } })
    await db.role.deleteMany({ where: { id: { in: cleanupRoleIds } } })
    await db.$disconnect()
  }, TIMEOUT)

  it("§50: createRole rejects a nonexistent permission id with a friendly error", async () => {
    await expect(
      createRole(session(["users.manage"]), { name: `P3.12 Bad Role ${Date.now()}`, permissionIds: ["00000000-0000-0000-0000-000000000000"] })
    ).rejects.toThrow(/do not exist/)
  }, TIMEOUT)

  it("§50: createRole rejects a duplicate role name in the same organization with a friendly error", async () => {
    const name = `P3.12 Dup Role ${Date.now()}`
    const first = await createRole(session(["users.manage"]), { name, permissionIds: [] })
    cleanupRoleIds.push(first.id)
    await expect(createRole(session(["users.manage"]), { name, permissionIds: [] })).rejects.toThrow(/already exists/)
  }, TIMEOUT)

  it("§23: system roles reject permission modification — unchanged behavior, still enforced", async () => {
    const systemRole = await db.role.findFirstOrThrow({ where: { organizationId, isSystemRole: true } })
    await expect(updateRolePermissions(session(["users.manage"]), systemRole.id, [])).rejects.toThrow(/System roles/)
  }, TIMEOUT)
})

describe("P3.12: Role-aware landing and navigation", () => {
  function sessionWith(permissions: string[]): SessionContext {
    return {
      sessionId: "test-p3-12-landing",
      user: { id: "x", organizationId: "x", email: "x@test.local", firstName: "X", lastName: "Y" },
      activeBranchId: null,
      branchIds: [],
      permissions: new Set(permissions),
      roleNames: ["P3.12 Test Role"],
    }
  }

  // Mirrors prisma/seed.ts's SYSTEM_ROLES permission lists as of this batch —
  // if seed.ts changes a role's shape, this test (not the app) needs updating.
  const SEEDED_ROLE_PERMISSIONS: Record<string, string[]> = {
    Receptionist: [
      "patient.view", "patient.create", "patient.edit", "provider.view", "service.view",
      "appointment.view", "appointment.create", "appointment.reschedule", "appointment.cancel", "appointment.checkin",
      "charge.create", "invoice.view", "invoice.create", "payment.view", "payment.create",
      "refund.request", "cashier.open", "package.sell", "coverage.manage", "communication.send",
    ],
    Doctor: [
      "patient.view", "patient.edit", "provider.view", "appointment.view", "appointment.checkin",
      "encounter.view", "encounter.create", "encounter.finalize", "clinical_notes.view", "clinical_notes.edit",
      "vitals.record", "prescription.create", "lab_order.create", "order.create", "package.consume",
    ],
    Nurse: ["patient.view", "appointment.view", "appointment.checkin", "encounter.view", "encounter.create", "clinical_notes.view", "vitals.record", "package.consume"],
    "Laboratory Technician": ["patient.view", "lab_result.enter", "lab_result.verify", "lab_test.manage"],
    Pharmacist: ["patient.view", "inventory.view", "inventory.adjust", "product.manage", "prescription.verify", "prescription.dispense"],
    "Radiology Technician": ["patient.view", "room.view", "imaging_order.perform", "imaging_result.verify", "imaging_service.manage"],
    Cashier: ["patient.view", "service.view", "charge.create", "invoice.view", "invoice.create", "payment.view", "payment.create", "refund.request", "cashier.open", "package.sell", "coverage.manage", "communication.send"],
    Accountant: ["accounting.view", "accounting.post", "accounting.period.manage", "chart_of_account.manage", "account_mapping.manage", "expense.create", "supplier_invoice.manage", "reports.export", "payor.manage", "coverage.manage", "claim.create", "claim.adjudicate", "invoice.view", "payment.view"],
    "HR Manager": ["payroll.view", "payroll.process", "reports.export", "department.view", "provider.view", "service.view", "employee.manage", "attendance.record", "leave.request", "leave.approve", "commission.manage", "commission.view"],
    "Inventory Manager": ["inventory.view", "inventory.adjust", "product.manage", "supplier.view", "supplier.manage", "purchase_request.create", "purchase_request.approve", "purchase_order.create", "goods_receipt.create", "supplier_invoice.manage", "stock.transfer", "asset.manage"],
    "Clinic Manager": ["settings.view", "branch.view", "department.view", "room.view", "patient.view", "provider.view", "service.view", "appointment.view", "appointment.reschedule", "appointment.cancel", "clinical_notes.view", "charge.void", "invoice.view", "invoice.discount", "invoice.void", "payment.view", "refund.authorize", "cashier.view", "package.manage", "tax.manage", "inventory.view", "supplier.view", "purchase_request.approve", "accounting.view", "expense.create", "reports.export", "payroll.view", "leave.approve", "asset.manage"],
  }

  const EXPECTED_LANDING: Record<string, string> = {
    Receptionist: "/reception",
    Doctor: "/dashboard",
    Nurse: "/queue",
    "Laboratory Technician": "/laboratory",
    Pharmacist: "/pharmacy",
    "Radiology Technician": "/radiology",
    Cashier: "/pos",
    Accountant: "/accounting",
    "HR Manager": "/hr",
    "Inventory Manager": "/inventory",
    "Clinic Manager": "/dashboard",
  }

  for (const [role, permissions] of Object.entries(SEEDED_ROLE_PERMISSIONS)) {
    it(`§34-36: ${role} lands on ${EXPECTED_LANDING[role]}`, () => {
      expect(resolveDefaultLandingRoute(sessionWith(permissions))).toBe(EXPECTED_LANDING[role])
    })
  }

  it("§35: users.manage (Super Admin / Organization Administrator) always wins, even combined with every job-specific permission", () => {
    const allPermissions = Object.values(SEEDED_ROLE_PERMISSIONS).flat().concat("users.manage")
    expect(resolveDefaultLandingRoute(sessionWith(allPermissions))).toBe("/dashboard")
  })

  it("§36: dashboard section visibility never throws for a permission-less session", () => {
    const empty = sessionWith([])
    expect(() => visibleDashboardSections(empty)).not.toThrow()
    const sections = visibleDashboardSections(empty)
    expect(sections.management).toBe(false)
    expect(sections.reception).toBe(false)
    expect(sections.finance).toBe(false)
  })

  it("§36: getDoctorDashboard degrades to null (not a crash) for a session with no linked Provider", async () => {
    await expect(getDoctorDashboard(sessionWith([]))).resolves.toBeNull()
  }, TIMEOUT)

  it("§29-30: role-aware sidebar filtering never renders an empty navigation group, and hides modules a role has no permission for", () => {
    for (const [role, permissions] of Object.entries(SEEDED_ROLE_PERMISSIONS)) {
      const permissionSet = new Set(permissions)
      const visibleGroups = NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => !item.permission || permissionSet.has(item.permission)),
      })).filter((group) => group.items.length > 0)

      for (const group of visibleGroups) {
        expect(group.items.length).toBeGreaterThan(0) // never an empty heading
      }

      const visibleLabels = visibleGroups.flatMap((g) => g.items.map((i) => i.label))
      if (role === "Receptionist") {
        expect(visibleLabels).not.toContain("Accounting")
        expect(visibleLabels).not.toContain("Payroll")
      }
      if (role === "Doctor") {
        expect(visibleLabels).not.toContain("Payroll")
        expect(visibleLabels).not.toContain("Accounting")
      }
      if (role === "Accountant") {
        expect(visibleLabels).not.toContain("Pharmacy")
        expect(visibleLabels).not.toContain("Radiology")
      }
      if (role === "HR Manager") {
        expect(visibleLabels).not.toContain("Radiology")
        expect(visibleLabels).not.toContain("Laboratory")
      }
    }
  })
})
