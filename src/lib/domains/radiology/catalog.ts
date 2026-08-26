import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { ImagingServiceInput } from "@/lib/domains/radiology/schemas"

export async function listImagingServices(session: SessionContext) {
  assertCan(session, "imaging_order.perform")
  return db.imagingService.findMany({
    where: { organizationId: session.user.organizationId, isActive: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  })
}

export async function createImagingService(session: SessionContext, input: ImagingServiceInput) {
  assertCan(session, "imaging_service.manage")
  const created = await db.imagingService.create({
    data: {
      organizationId: session.user.organizationId,
      code: input.code,
      name: input.name,
      category: input.category,
      bodyPart: input.bodyPart ?? null,
      price: new Decimal(input.price),
      turnaroundHours: input.turnaroundHours ?? null,
    },
  })
  await auditFromSession(session, "create", "imaging_service", created.id, { new: { code: created.code, name: created.name } })
  return created
}

export async function updateImagingService(session: SessionContext, id: string, input: ImagingServiceInput) {
  assertCan(session, "imaging_service.manage")
  const existing = await db.imagingService.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.imagingService.update({
    where: { id },
    data: {
      code: input.code,
      name: input.name,
      category: input.category,
      bodyPart: input.bodyPart ?? null,
      price: new Decimal(input.price),
      turnaroundHours: input.turnaroundHours ?? null,
    },
  })
  await auditFromSession(session, "update", "imaging_service", id, { old: existing, new: input })
  return updated
}

export async function deactivateImagingService(session: SessionContext, id: string) {
  assertCan(session, "imaging_service.manage")
  const updated = await db.imagingService.update({ where: { id }, data: { isActive: false } })
  await auditFromSession(session, "update", "imaging_service", id, { new: { isActive: false } })
  return updated
}
