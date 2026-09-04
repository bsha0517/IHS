import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { Prisma } from "@/generated/prisma/client"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import { getAuthorizedBranchScope, narrowBranchFilter, assertBranchAccess } from "@/lib/platform/branch-scope"
import { resolvePage, paginationSkipTake, totalPages } from "@/lib/platform/pagination"
import type { SessionContext } from "@/lib/auth/session"
import type { EmployeeInput, EmployeeDocumentInput } from "@/lib/domains/hr/schemas"

// P3.10 §9: `user` was missing from every list/get query, so the UI had no
// way to show whether an Employee is actually linked to a system login —
// the only such linkage (Employee.userId, @unique) was invisible everywhere
// except via direct DB access. Selected narrowly (id/email/status), not a
// full User row — payroll.view holders already see this employee's salary,
// so a linked login's own email/status is not a bigger disclosure.
const EMPLOYEE_INCLUDE = {
  branch: true,
  department: true,
  manager: true,
  providerProfile: true,
  user: { select: { id: true, email: true, status: true } },
} as const
const EMPLOYEE_LIST_PAGE_SIZE = 50

/**
 * P2 §8: was fully unbounded (no `take` at all). Real server-side pagination now.
 * P3.10 §7: added the operational filters the page never actually offered —
 * a free-text `search` across number/name/designation, plus `departmentId` —
 * alongside the branch/status filters the function already accepted but the
 * page never wired to a form.
 */
export async function listEmployees(
  session: SessionContext,
  filters: { branchId?: string; departmentId?: string; status?: string; search?: string; page?: number } = {}
) {
  assertCan(session, "payroll.view")
  const scope = getAuthorizedBranchScope(session)
  const page = resolvePage(filters.page)
  const search = filters.search?.trim()
  const where: Prisma.EmployeeWhereInput = {
    organizationId: session.user.organizationId,
    branchId: narrowBranchFilter(scope, filters.branchId),
    departmentId: filters.departmentId || undefined,
    status: (filters.status || undefined) as never,
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" } },
            { lastName: { contains: search, mode: "insensitive" } },
            { employeeNumber: { contains: search, mode: "insensitive" } },
            { designation: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  }
  const [employees, total] = await Promise.all([
    db.employee.findMany({
      where,
      include: EMPLOYEE_INCLUDE,
      orderBy: { firstName: "asc" },
      ...paginationSkipTake(page, EMPLOYEE_LIST_PAGE_SIZE),
    }),
    db.employee.count({ where }),
  ])
  return { employees, total, page, pageSize: EMPLOYEE_LIST_PAGE_SIZE, totalPages: totalPages(total, EMPLOYEE_LIST_PAGE_SIZE) }
}

/**
 * P2 §8: the daily attendance roster (`attendance/page.tsx`) and the leave
 * request/balance pickers (`leave/page.tsx`) both need *every* active
 * employee, not a page of them — a roster that silently drops staff past
 * row 50 or a picker that can't select someone past it would be a real
 * regression, not a performance win. Deliberately kept as its own
 * unbounded query rather than routed through `listEmployees`'s pagination:
 * organizational headcount is a bounded set (an org has however many
 * active staff it has, not a growing historical log), the actual concern
 * P2.md §8 names, unlike `listEmployees`'s own no-status-filter default
 * use (the full, potentially years-of-turnover Employees directory page),
 * which does need real pagination and gets it above.
 */
export async function listActiveEmployeeRoster(session: SessionContext, filters: { branchId?: string } = {}) {
  assertCan(session, "payroll.view")
  const scope = getAuthorizedBranchScope(session)
  return db.employee.findMany({
    where: { organizationId: session.user.organizationId, branchId: narrowBranchFilter(scope, filters.branchId), status: "active" },
    include: EMPLOYEE_INCLUDE,
    orderBy: { firstName: "asc" },
  })
}

/** Names only, for assignment pickers (e.g. Assets) — deliberately not gated on `payroll.view`, since a name-only directory isn't sensitive HR data the way salary/leave/attendance records are. */
export async function listEmployeeDirectory(session: SessionContext) {
  return db.employee.findMany({
    where: { organizationId: session.user.organizationId, status: { not: "terminated" } },
    select: { id: true, firstName: true, lastName: true },
    orderBy: { firstName: "asc" },
  })
}

export async function getEmployee(session: SessionContext, id: string) {
  assertCan(session, "payroll.view")
  const employee = await db.employee.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { ...EMPLOYEE_INCLUDE, documents: { orderBy: { expiryDate: "asc" } } },
  })
  assertBranchAccess(getAuthorizedBranchScope(session), employee.branchId)
  return employee
}

export async function createEmployee(session: SessionContext, input: EmployeeInput) {
  assertCan(session, "employee.manage", { branchId: input.branchId })

  const employeeNumber = await nextNumber({ organizationId: session.user.organizationId, sequenceType: "EMP", prefix: "EMP" })
  const created = await db.employee.create({
    data: {
      organizationId: session.user.organizationId,
      branchId: input.branchId,
      departmentId: input.departmentId ?? null,
      userId: input.userId ?? null,
      employeeNumber,
      firstName: input.firstName,
      lastName: input.lastName,
      designation: input.designation,
      managerId: input.managerId ?? null,
      joiningDate: input.joiningDate,
      employmentType: input.employmentType,
      basicSalary: new Decimal(input.basicSalary),
      bankDetails: input.bankDetails ?? null,
    },
  })
  await auditFromSession(session, "create", "employee", created.id, {
    new: { employeeNumber: created.employeeNumber, firstName: created.firstName, lastName: created.lastName },
  })
  return created
}

export async function updateEmployee(session: SessionContext, id: string, input: EmployeeInput) {
  const existing = await db.employee.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  // P3.10 §50: `assertCan`'s branchId option only proves the caller may
  // write to the NEW branch being requested — it never checked the branch
  // the employee is ACTUALLY currently in. A branch-A-scoped HR user could
  // previously edit an employee who genuinely belongs to branch B merely by
  // submitting branchId=A in the form, since nothing here ever inspected
  // `existing.branchId`. Both ends of the move must now be authorized.
  assertCan(session, "employee.manage", { branchId: input.branchId })
  assertBranchAccess(getAuthorizedBranchScope(session), existing.branchId)

  const updated = await db.employee.update({
    where: { id },
    data: {
      branchId: input.branchId,
      departmentId: input.departmentId ?? null,
      // P3.10: the employee form never exposes a `userId` field (no user
      // picker exists in the UI — see this file's own doc note on why one
      // isn't being added here). `input.userId` was therefore always `null`
      // on every real submission, and this line was silently WIPING any
      // existing Employee<->User link (set only via direct DB/seed access)
      // on every routine "Edit employee" save — a genuine data-corruption
      // bug, not a hypothetical one. The link is preserved untouched here;
      // there is currently no supported path to change it after creation.
      firstName: input.firstName,
      lastName: input.lastName,
      designation: input.designation,
      managerId: input.managerId ?? null,
      joiningDate: input.joiningDate,
      employmentType: input.employmentType,
      basicSalary: new Decimal(input.basicSalary),
      bankDetails: input.bankDetails ?? null,
    },
  })
  await auditFromSession(session, "update", "employee", id, { old: existing, new: input })
  return updated
}

export async function updateEmployeeStatus(session: SessionContext, id: string, status: "active" | "on_leave" | "terminated") {
  assertCan(session, "employee.manage")
  const existing = await db.employee.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  assertBranchAccess(getAuthorizedBranchScope(session), existing.branchId)
  const updated = await db.employee.update({ where: { id }, data: { status } })
  await auditFromSession(session, "update", "employee", id, { old: { status: existing.status }, new: { status } })
  return updated
}

/** "Track expiry" (spec.md §49) — metadata only, no file storage (see the schema comment on EmployeeDocument for why). */
export async function addEmployeeDocument(session: SessionContext, employeeId: string, input: EmployeeDocumentInput) {
  assertCan(session, "employee.manage")
  const employee = await db.employee.findFirstOrThrow({ where: { id: employeeId, organizationId: session.user.organizationId } })
  assertBranchAccess(getAuthorizedBranchScope(session), employee.branchId)

  const created = await db.employeeDocument.create({
    data: {
      organizationId: session.user.organizationId,
      employeeId: employee.id,
      documentType: input.documentType,
      documentNumber: input.documentNumber ?? null,
      issueDate: input.issueDate ?? null,
      expiryDate: input.expiryDate ?? null,
      notes: input.notes ?? null,
    },
  })
  await auditFromSession(session, "create", "employee_document", created.id, {
    new: { employeeId: employee.id, documentType: created.documentType },
  })
  return created
}

/** Every employee document expiring within the next 90 days, computed live — never a stored flag (same discipline as Phase 5's near-expiry batch alert). */
export async function listExpiringDocuments(session: SessionContext) {
  assertCan(session, "payroll.view")
  const scope = getAuthorizedBranchScope(session)
  return db.employeeDocument.findMany({
    where: {
      organizationId: session.user.organizationId,
      expiryDate: { not: null, lte: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
      employee: { branchId: narrowBranchFilter(scope) },
    },
    include: { employee: true },
    orderBy: { expiryDate: "asc" },
  })
}
