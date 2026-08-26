import "server-only"
import { Decimal } from "@prisma/client/runtime/client"
import { db } from "@/lib/db"
import { assertCan } from "@/lib/platform/permissions-core"
import { auditFromSession } from "@/lib/platform/audit"
import type { SessionContext } from "@/lib/auth/session"
import type { ProductInput } from "@/lib/domains/inventory/schemas"

export async function listProducts(session: SessionContext) {
  assertCan(session, "inventory.view")
  return db.product.findMany({
    where: { organizationId: session.user.organizationId },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  })
}

export async function getProduct(session: SessionContext, id: string) {
  assertCan(session, "inventory.view")
  return db.product.findFirstOrThrow({
    where: { id, organizationId: session.user.organizationId },
  })
}

export async function createProduct(session: SessionContext, input: ProductInput) {
  assertCan(session, "product.manage")

  const created = await db.product.create({
    data: {
      organizationId: session.user.organizationId,
      sku: input.sku,
      barcode: input.barcode ?? null,
      name: input.name,
      category: input.category,
      brand: input.brand ?? null,
      unit: input.unit,
      purchaseCost: new Decimal(input.purchaseCost),
      sellingPrice: input.sellingPrice != null ? new Decimal(input.sellingPrice) : null,
      reorderLevel: input.reorderLevel,
      minimumStock: input.minimumStock,
      maximumStock: input.maximumStock ?? null,
    },
  })
  await auditFromSession(session, "create", "product", created.id, { new: { sku: created.sku, name: created.name } })
  return created
}

export async function updateProduct(session: SessionContext, id: string, input: ProductInput) {
  assertCan(session, "product.manage")

  const existing = await db.product.findFirstOrThrow({ where: { id, organizationId: session.user.organizationId } })
  const updated = await db.product.update({
    where: { id },
    data: {
      sku: input.sku,
      barcode: input.barcode ?? null,
      name: input.name,
      category: input.category,
      brand: input.brand ?? null,
      unit: input.unit,
      purchaseCost: new Decimal(input.purchaseCost),
      sellingPrice: input.sellingPrice != null ? new Decimal(input.sellingPrice) : null,
      reorderLevel: input.reorderLevel,
      minimumStock: input.minimumStock,
      maximumStock: input.maximumStock ?? null,
    },
  })
  await auditFromSession(session, "update", "product", id, { old: existing, new: input })
  return updated
}
