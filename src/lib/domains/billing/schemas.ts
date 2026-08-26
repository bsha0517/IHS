import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const chargeSourceTypes = [
  "consultation",
  "procedure",
  "lab",
  "imaging",
  "pharmacy",
  "product",
  "package",
  "other",
] as const

export const adHocChargeSchema = z.object({
  patientId: z.uuid(),
  branchId: z.uuid(),
  encounterId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  serviceId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  providerId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  sourceType: z.enum(chargeSourceTypes),
  description: z.string().min(1).max(300),
  quantity: z.coerce.number().int().min(1).max(9999).default(1),
  unitPrice: z.coerce.number().min(0).max(9999999),
})
export type AdHocChargeInput = z.infer<typeof adHocChargeSchema>

export const generateInvoiceSchema = z.object({
  patientId: z.uuid(),
  branchId: z.uuid(),
  providerId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  chargeIds: z.array(z.uuid()).min(1, "Select at least one charge"),
  discountAmount: z.coerce.number().min(0).max(9999999).default(0),
  // Insurance path (spec.md §38, Phase 11) — optional; omitted entirely for
  // the self-pay path, which is the vast majority of invoices and requires
  // zero payor configuration.
  patientCoverageId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
})
export type GenerateInvoiceInput = z.infer<typeof generateInvoiceSchema>

export const paymentMethods = ["cash", "card", "bank", "online", "insurance", "credit", "other"] as const

export const tenderSchema = z.object({
  method: z.enum(paymentMethods),
  amount: z.coerce.number().positive().max(9999999),
  reference: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
})

export const recordPaymentSchema = z.object({
  invoiceId: z.uuid(),
  cashierSessionId: z.uuid(),
  tenders: z.array(tenderSchema).min(1, "Add at least one tender"),
})
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>

export const requestRefundSchema = z.object({
  invoiceId: z.uuid(),
  paymentId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  method: z.enum(paymentMethods),
  amount: z.coerce.number().positive().max(9999999),
  reason: z.string().min(1).max(500),
})
export type RequestRefundInput = z.infer<typeof requestRefundSchema>

export const openCashierSessionSchema = z.object({
  branchId: z.uuid(),
  openingCash: z.coerce.number().min(0).max(9999999),
})
export type OpenCashierSessionInput = z.infer<typeof openCashierSessionSchema>

export const cashMovementSchema = z.object({
  direction: z.enum(["in", "out"]),
  amount: z.coerce.number().positive().max(9999999),
  reason: z.string().min(1).max(300),
})
export type CashMovementInput = z.infer<typeof cashMovementSchema>

export const closeCashierSessionSchema = z.object({
  actualCash: z.coerce.number().min(0).max(9999999),
  notes: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
})
export type CloseCashierSessionInput = z.infer<typeof closeCashierSessionSchema>
