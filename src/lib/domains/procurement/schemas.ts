import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const supplierSchema = z.object({
  code: z.string().min(1).max(50),
  companyName: z.string().min(1).max(200),
  contactName: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  phone: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
  email: z.preprocess(emptyToNull, z.email().max(200).nullable().optional()),
  address: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
  taxNumber: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  paymentTerms: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  bankDetails: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type SupplierInput = z.infer<typeof supplierSchema>

export const purchaseRequestLineSchema = z.object({
  productId: z.uuid(),
  quantity: z.coerce.number().int().positive().max(999999),
  notes: z.preprocess(emptyToNull, z.string().max(300).nullable().optional()),
})

export const purchaseRequestSchema = z.object({
  branchId: z.uuid(),
  notes: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
  lines: z.array(purchaseRequestLineSchema).min(1, "Add at least one product"),
})
export type PurchaseRequestInput = z.infer<typeof purchaseRequestSchema>

export const purchaseOrderLineSchema = z.object({
  productId: z.uuid(),
  quantity: z.coerce.number().int().positive().max(999999),
  unitCost: z.coerce.number().min(0).max(9999999),
})

export const purchaseOrderSchema = z.object({
  branchId: z.uuid(),
  supplierId: z.uuid(),
  purchaseRequestId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  expectedDeliveryDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  notes: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
  lines: z.array(purchaseOrderLineSchema).min(1, "Add at least one product"),
})
export type PurchaseOrderInput = z.infer<typeof purchaseOrderSchema>

export const goodsReceiptLineSchema = z.object({
  purchaseOrderLineId: z.uuid(),
  productId: z.uuid(),
  batchNumber: z.string().min(1).max(100),
  manufacturingDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  expiryDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  quantityReceived: z.coerce.number().int().positive().max(999999),
  unitCost: z.coerce.number().min(0).max(9999999),
})

export const goodsReceiptSchema = z.object({
  purchaseOrderId: z.uuid(),
  notes: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
  lines: z.array(goodsReceiptLineSchema).min(1, "Receive at least one line"),
  // P1 §16: "prevent over-receiving beyond PO quantity unless explicitly
  // authorized" — a receipt-level override (not persisted as its own
  // column; the existing audit-log entry for this receipt captures that it
  // happened) rather than a hard, unconditional block. Not per-line: the
  // whole receipt is one user decision made once in the dialog, not a
  // per-product judgment call.
  allowOverReceipt: z.coerce.boolean().optional().default(false),
})
export type GoodsReceiptInput = z.infer<typeof goodsReceiptSchema>

export const supplierInvoiceSchema = z.object({
  supplierId: z.uuid(),
  branchId: z.uuid(),
  purchaseOrderId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  invoiceNumber: z.string().min(1).max(100),
  amount: z.coerce.number().positive().max(9999999),
  // P1 §15: recoverable purchase tax (e.g. input VAT), manually entered —
  // see SupplierInvoice.taxAmount's doc comment (schema.prisma).
  taxAmount: z.coerce.number().min(0).max(9999999).optional().default(0),
  dueDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
})
export type SupplierInvoiceInput = z.infer<typeof supplierInvoiceSchema>

export const supplierPaymentSchema = z.object({
  supplierInvoiceId: z.uuid(),
  method: z.enum(["cash", "card", "bank", "online", "insurance", "credit", "other"]),
  amount: z.coerce.number().positive().max(9999999),
  reference: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
})
export type SupplierPaymentInput = z.infer<typeof supplierPaymentSchema>
