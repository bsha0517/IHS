import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const productSchema = z.object({
  sku: z.string().min(1).max(50),
  barcode: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  brand: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  unit: z.string().min(1).max(30),
  purchaseCost: z.coerce.number().min(0).max(9999999),
  sellingPrice: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
  reorderLevel: z.coerce.number().int().min(0).max(999999).default(0),
  minimumStock: z.coerce.number().int().min(0).max(999999).default(0),
  maximumStock: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(999999).nullable().optional()),
})
export type ProductInput = z.infer<typeof productSchema>

export const stockAdjustmentSchema = z.object({
  branchId: z.uuid(),
  productId: z.uuid(),
  batchId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  direction: z.enum(["in", "out"]),
  quantity: z.coerce.number().positive().max(999999),
  transactionType: z.enum(["adjustment", "damage", "expiry", "return"]).default("adjustment"),
  reason: z.string().min(1).max(500),
})
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>

export const stockTransferSchema = z.object({
  fromBranchId: z.uuid(),
  toBranchId: z.uuid(),
  productId: z.uuid(),
  batchId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  quantity: z.coerce.number().positive().max(999999),
  notes: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type StockTransferInput = z.infer<typeof stockTransferSchema>

export const consumptionLineSchema = z.object({
  productId: z.uuid(),
  quantityPerUnit: z.coerce.number().positive().max(999999),
})

export const consumptionTemplateSchema = z.object({
  serviceId: z.uuid(),
  lines: z.array(consumptionLineSchema),
})
export type ConsumptionTemplateInput = z.infer<typeof consumptionTemplateSchema>
