import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import { nextNumber } from "@/lib/platform/sequences"
import type { SessionContext } from "@/lib/auth/session"
import type { EmployeeInput, EmployeeDocumentInput } from "@/lib/domains/hr/schemas"

const EMPLOYEE_INCLUDE = { branch: true, department: true, manager: true, providerProfile: true } as const

export async function listEmployees(session: SessionContext, filters: { branchId?: string; status?: string } = {}) {
  assertCan(session, "payroll.view")
  return db.employee.findMany({
    where: { organizationId: session.user.organizationId, branchId: filters.branchId, status: filters.status as never },
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
  return db.employee.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
    include: { ...EMPLOYEE_INCLUDE, documents: { orderBy: { expiryDate: "asc" } } },
  })
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
  assertCan(session, "employee.manage", { branchId: input.branchId })

  const existing = await db.employee.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.employee.update({
    where: { id },
    data: {
      branchId: input.branchId,
      departmentId: input.departmentId ?? null,
      userId: input.userId ?? null,
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
  const updated = await db.employee.update({ where: { id }, data: { status } })
  await auditFromSession(session, "update", "employee", id, { old: { status: existing.status }, new: { status } })
  return updated
}

/** "Track expiry" (spec.md §49) — metadata only, no file storage (see the schema comment on EmployeeDocument for why). */
export async function addEmployeeDocument(session: SessionContext, employeeId: string, input: EmployeeDocumentInput) {
  assertCan(session, "employee.manage")
  const employee = await db.employee.findFirstOrThrow({ where: { id: employeeId, organizationId: session.user.organizationId } })

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
  const horizon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
  return db.employeeDocument.findMany({
    where: { organizationId: session.user.organizationId, expiryDate: { not: null, lte: horizon } },
    include: { employee: true },
    orderBy: { expiryDate: "asc" },
  })
}
