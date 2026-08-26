import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { ProviderInput, ProviderScheduleInput, ProviderLeaveBlockInput, LinkEmployeeInput } from "@/lib/domains/providers/schemas"

export async function listProviders(session: SessionContext) {
  assertCan(session, "provider.view")
  return db.provider.findMany({
    where: { organizationId: session.user.organizationId },
    include: { branches: { include: { branch: true } }, departments: { include: { department: true } } },
    orderBy: { firstName: "asc" },
  })
}

export async function getProvider(session: SessionContext, providerId: string) {
  assertCan(session, "provider.view")
  return db.provider.findFirstOrThrow({
    where: { id: providerId, organizationId: session.user.organizationId },
    include: {
      branches: { include: { branch: true } },
      departments: { include: { department: true } },
      services: { include: { service: true } },
      schedules: { orderBy: { dayOfWeek: "asc" } },
      leaveBlocks: { orderBy: { startAt: "desc" } },
      employee: true,
    },
  })
}

export async function createProvider(session: SessionContext, input: ProviderInput) {
  assertCan(session, "provider.manage")

  const provider = await db.$transaction(async (tx) => {
    const created = await tx.provider.create({
      data: {
        organizationId: session.user.organizationId,
        providerType: input.providerType,
        firstName: input.firstName,
        lastName: input.lastName,
        specialty: input.specialty ?? null,
        qualification: input.qualification ?? null,
        licenseNumber: input.licenseNumber ?? null,
        licenseAuthority: input.licenseAuthority ?? null,
        licenseExpiryDate: input.licenseExpiryDate ?? null,
        consultationFee: input.consultationFee,
        defaultAppointmentDurationMinutes: input.defaultAppointmentDurationMinutes,
        userId: input.userId ?? null,
      },
    })

    if (input.branchIds.length > 0) {
      await tx.providerBranch.createMany({ data: input.branchIds.map((branchId) => ({ providerId: created.id, branchId })) })
    }
    if (input.departmentIds.length > 0) {
      await tx.providerDepartment.createMany({
        data: input.departmentIds.map((departmentId) => ({ providerId: created.id, departmentId })),
      })
    }

    return created
  })

  await auditFromSession(session, "create", "provider", provider.id, {
    new: { firstName: provider.firstName, lastName: provider.lastName, providerType: provider.providerType },
  })

  return provider
}

export async function updateProvider(session: SessionContext, providerId: string, input: Partial<ProviderInput>) {
  assertCan(session, "provider.manage")
  const before = await db.provider.findFirstOrThrow({ where: { id: providerId, organizationId: session.user.organizationId } })

  const updated = await db.$transaction(async (tx) => {
    const provider = await tx.provider.update({
      where: { id: providerId },
      data: {
        providerType: input.providerType,
        firstName: input.firstName,
        lastName: input.lastName,
        specialty: input.specialty,
        qualification: input.qualification,
        licenseNumber: input.licenseNumber,
        licenseAuthority: input.licenseAuthority,
        licenseExpiryDate: input.licenseExpiryDate,
        consultationFee: input.consultationFee,
        defaultAppointmentDurationMinutes: input.defaultAppointmentDurationMinutes,
        userId: input.userId,
      },
    })

    if (input.branchIds) {
      await tx.providerBranch.deleteMany({ where: { providerId } })
      if (input.branchIds.length > 0) {
        await tx.providerBranch.createMany({ data: input.branchIds.map((branchId) => ({ providerId, branchId })) })
      }
    }
    if (input.departmentIds) {
      await tx.providerDepartment.deleteMany({ where: { providerId } })
      if (input.departmentIds.length > 0) {
        await tx.providerDepartment.createMany({ data: input.departmentIds.map((departmentId) => ({ providerId, departmentId })) })
      }
    }

    return provider
  })

  await auditFromSession(session, "update", "provider", providerId, { old: before, new: updated })
  return updated
}

/**
 * Links this Provider to an HR Employee record (spec.md §14 names "Employee"
 * as a Provider field) — separate from `updateProvider` since that requires
 * the full provider form payload and this is a single-field, HR-side action
 * (surfaced from the Provider detail page since Provider is the richer,
 * schedule/commission-bearing identity spec.md §14 attaches "Employee" to).
 * Enforced 1:1 by the schema's `@unique` on `Provider.employeeId`.
 */
export async function linkEmployee(session: SessionContext, providerId: string, input: LinkEmployeeInput) {
  assertCan(session, "provider.manage")
  const updated = await db.provider.update({ where: { id: providerId }, data: { employeeId: input.employeeId } })
  await auditFromSession(session, "update", "provider", providerId, { new: { employeeId: input.employeeId } })
  return updated
}

// ---------------------------------------------------------------------------
// Scheduling (spec.md §16)
// ---------------------------------------------------------------------------

export async function createProviderSchedule(session: SessionContext, providerId: string, input: ProviderScheduleInput) {
  assertCan(session, "provider.manage")
  const schedule = await db.providerSchedule.create({ data: { providerId, ...input } })
  await auditFromSession(session, "create", "provider_schedule", schedule.id, { new: input })
  return schedule
}

export async function deleteProviderSchedule(session: SessionContext, scheduleId: string) {
  assertCan(session, "provider.manage")
  const schedule = await db.providerSchedule.delete({ where: { id: scheduleId } })
  await auditFromSession(session, "delete", "provider_schedule", scheduleId, { old: schedule })
}

// Approved leave automatically blocks appointment availability (spec.md §16) —
// enforced by appointments.ts checking for an overlapping block at booking time.
export async function createProviderLeaveBlock(session: SessionContext, providerId: string, input: ProviderLeaveBlockInput) {
  assertCan(session, "provider.manage")
  if (input.endAt <= input.startAt) {
    throw new Error("Leave end time must be after the start time.")
  }
  const block = await db.providerLeaveBlock.create({
    data: { providerId, ...input, createdBy: session.user.id },
  })
  await auditFromSession(session, "create", "provider_leave_block", block.id, { new: input })
  return block
}

export async function deleteProviderLeaveBlock(session: SessionContext, blockId: string) {
  assertCan(session, "provider.manage")
  const block = await db.providerLeaveBlock.delete({ where: { id: blockId } })
  await auditFromSession(session, "delete", "provider_leave_block", blockId, { old: block })
}
