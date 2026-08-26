import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { ServiceInput } from "@/lib/domains/services/schemas"

export async function listServices(session: SessionContext) {
  assertCan(session, "service.view")
  return db.service.findMany({
    where: { organizationId: session.user.organizationId },
    include: { department: true, providers: { include: { provider: true } } },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  })
}

export async function getService(session: SessionContext, serviceId: string) {
  assertCan(session, "service.view")
  return db.service.findFirstOrThrow({
    where: { id: serviceId, organizationId: session.user.organizationId },
    include: { department: true, providers: { include: { provider: true } } },
  })
}

export async function createService(session: SessionContext, input: ServiceInput) {
  assertCan(session, "service.manage")

  const service = await db.$transaction(async (tx) => {
    const created = await tx.service.create({
      data: {
        organizationId: session.user.organizationId,
        code: input.code,
        name: input.name,
        category: input.category,
        departmentId: input.departmentId ?? null,
        description: input.description ?? null,
        durationMinutes: input.durationMinutes,
        price: input.price,
        billable: input.billable,
        isActive: input.isActive,
        requiredRoomType: input.requiredRoomType ?? null,
      },
    })

    if (input.providerIds.length > 0) {
      await tx.serviceProvider.createMany({
        data: input.providerIds.map((providerId) => ({ serviceId: created.id, providerId })),
      })
    }

    return created
  })

  await auditFromSession(session, "create", "service", service.id, { new: { code: service.code, name: service.name } })
  return service
}

export async function updateService(session: SessionContext, serviceId: string, input: Partial<ServiceInput>) {
  assertCan(session, "service.manage")
  const before = await db.service.findFirstOrThrow({ where: { id: serviceId, organizationId: session.user.organizationId } })

  const updated = await db.$transaction(async (tx) => {
    const service = await tx.service.update({
      where: { id: serviceId },
      data: {
        code: input.code,
        name: input.name,
        category: input.category,
        departmentId: input.departmentId,
        description: input.description,
        durationMinutes: input.durationMinutes,
        price: input.price,
        billable: input.billable,
        isActive: input.isActive,
        requiredRoomType: input.requiredRoomType,
      },
    })

    if (input.providerIds) {
      await tx.serviceProvider.deleteMany({ where: { serviceId } })
      if (input.providerIds.length > 0) {
        await tx.serviceProvider.createMany({ data: input.providerIds.map((providerId) => ({ serviceId, providerId })) })
      }
    }

    return service
  })

  await auditFromSession(session, "update", "service", serviceId, { old: before, new: updated })
  return updated
}
