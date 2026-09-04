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

/**
 * P2 §5: batch identification is no longer optional in either direction —
 * see recordAdjustment's own doc comment (stock.ts) for the full reasoning.
 * `batchId` is required for "out" (removes from one specific, real batch);
 * for "in" it's either `batchId` (add to an existing batch) or the
 * `newBatch*` fields (create one inline, in the same transaction as the
 * ledger write) — the two refinements below enforce exactly one of those
 * per direction before the input ever reaches the service layer.
 */
export const stockAdjustmentSchema = z
  .object({
    branchId: z.uuid(),
    productId: z.uuid(),
    batchId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
    direction: z.enum(["in", "out"]),
    quantity: z.coerce.number().positive().max(999999),
    transactionType: z.enum(["adjustment", "damage", "expiry", "return"]).default("adjustment"),
    reason: z.string().min(1).max(500),
    // P2 §5: an optional external document/reference number (e.g. a
    // physical count sheet or damage report id) — distinct from `reason`
    // (why), this is what ties the ledger entry back to a paper/external
    // record. Stored on StockLedgerEntry's existing referenceType/referenceId
    // polymorphic pointer (see that model's own doc comment in schema.prisma,
    // which already names "a manual adjustment with no other record" as a
    // valid use), not a new column.
    reference: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
    newBatchNumber: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
    newBatchExpiryDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
    newBatchManufacturingDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
    newBatchPurchaseCost: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
  })
  .refine((data) => data.direction !== "out" || !!data.batchId, {
    message: "Select the batch to remove stock from.",
    path: ["batchId"],
  })
  .refine((data) => data.direction !== "in" || !!data.batchId || !!data.newBatchNumber, {
    message: "Select an existing batch, or provide a new batch number to create one.",
    path: ["batchId"],
  })
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>

// P3.8 §20-25: `batchId` used to be optional — the UI never collected one,
// and the server has no automatic FEFO-style multi-batch allocation for
// transfers (unlike consumeStock), so a null batchId meant
// `completeTransfer`'s balance check matched almost no real ledger rows
// (every real StockLedgerEntry carries a real batchId) and every transfer of
// batch-tracked stock failed with "Only 0 units available". Mandatory now —
// the UI must ask for one real, non-expired, non-zero-balance source batch.
export const stockTransferSchema = z.object({
  fromBranchId: z.uuid(),
  toBranchId: z.uuid(),
  productId: z.uuid(),
  batchId: z.uuid(),
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
