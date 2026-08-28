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

/**
 * P1 §9: a narrow catalog projection for POS's "From product catalog"
 * picker, gated on `charge.create` (which Cashier already holds) rather
 * than `inventory.view` (which Cashier does not) — the same "narrow
 * bypass projection for a specific workflow, not the broader admin view"
 * precedent this codebase already uses for `listEmployeeDirectory()`
 * (name-only, gated on the assignment workflows that need it, not
 * `payroll.view`). Selling a product at POS needs its name/price, not
 * stock counts or cost data `inventory.view` protects.
 */
export async function listSellableProducts(session: SessionContext) {
  assertCan(session, "charge.create")
  const products = await db.product.findMany({
    where: { organizationId: session.user.organizationId, isActive: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
    select: { id: true, name: true, sellingPrice: true, purchaseCost: true, unit: true },
  })
  return products.map((p) => ({ id: p.id, name: p.name, price: Number(p.sellingPrice ?? p.purchaseCost), unit: p.unit }))
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
