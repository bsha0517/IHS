import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { ConsumptionTemplateInput } from "@/lib/domains/inventory/schemas"

/** Service consumption templates (spec.md §44) — "Wound Dressing consumes: Gauze x2, ...". */
export async function listServiceConsumption(session: SessionContext, serviceId: string) {
  assertCan(session, "service.view")
  return db.serviceProductConsumption.findMany({
    where: { serviceId, service: { organizationId: session.user.organizationId } },
    include: { product: true },
  })
}

/** All templates for the org in one query, grouped by service — avoids N+1 on the services list page. */
export async function listAllServiceConsumption(session: SessionContext) {
  assertCan(session, "service.view")
  const rows = await db.serviceProductConsumption.findMany({
    where: { service: { organizationId: session.user.organizationId } },
  })
  const byService = new Map<string, { productId: string; quantityPerUnit: number }[]>()
  for (const row of rows) {
    const list = byService.get(row.serviceId) ?? []
    list.push({ productId: row.productId, quantityPerUnit: Number(row.quantityPerUnit) })
    byService.set(row.serviceId, list)
  }
  return byService
}

/** Replaces the full template for a service in one transaction — simpler and safer than diffing individual lines. */
export async function setServiceConsumption(session: SessionContext, input: ConsumptionTemplateInput) {
  assertCan(session, "service.manage")

  await db.service.findFirstOrThrow({ where: { id: input.serviceId, organizationId: session.user.organizationId } })

  await db.$transaction(async (tx) => {
    await tx.serviceProductConsumption.deleteMany({ where: { serviceId: input.serviceId } })
    if (input.lines.length > 0) {
      await tx.serviceProductConsumption.createMany({
        data: input.lines.map((line) => ({
          serviceId: input.serviceId,
          productId: line.productId,
          quantityPerUnit: new Decimal(line.quantityPerUnit),
        })),
      })
    }
  })

  await auditFromSession(session, "update", "service_product_consumption", input.serviceId, {
    new: { lineCount: input.lines.length },
  })
}
