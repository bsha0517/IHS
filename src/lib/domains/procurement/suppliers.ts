import "server-only"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { SupplierInput } from "@/lib/domains/procurement/schemas"

export async function listSuppliers(session: SessionContext) {
  assertCan(session, "supplier.view")
  return db.supplier.findMany({
    where: { organizationId: session.user.organizationId },
    orderBy: { companyName: "asc" },
  })
}

export async function getSupplier(session: SessionContext, id: string) {
  assertCan(session, "supplier.view")
  return db.supplier.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
}

export async function createSupplier(session: SessionContext, input: SupplierInput) {
  assertCan(session, "supplier.manage")
  const created = await db.supplier.create({
    data: { organizationId: session.user.organizationId, ...input },
  })
  await auditFromSession(session, "create", "supplier", created.id, { new: { code: created.code, companyName: created.companyName } })
  return created
}

export async function updateSupplier(session: SessionContext, id: string, input: SupplierInput) {
  assertCan(session, "supplier.manage")
  const existing = await db.supplier.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.supplier.update({ where: { id }, data: input })
  await auditFromSession(session, "update", "supplier", id, { old: existing, new: input })
  return updated
}
