import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const commissionTypes = ["fixed", "percentage", "tiered"] as const
export const commissionBases = ["gross_invoice", "net_invoice", "collected_revenue"] as const

const tierSchema = z.object({
  minAmount: z.coerce.number().min(0),
  maxAmount: z.coerce.number().min(0).nullable(),
  rate: z.coerce.number().min(0).max(1),
})

export const commissionRuleSchema = z
  .object({
    providerId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
    serviceId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
    productId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
    type: z.enum(commissionTypes),
    basis: z.enum(commissionBases),
    fixedAmount: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
    percentageRate: z.preprocess(emptyToNull, z.coerce.number().min(0).max(1).nullable().optional()),
    tiers: z.array(tierSchema).optional(),
  })
  .refine((v) => v.type !== "fixed" || v.fixedAmount != null, { message: "Fixed commissions need a fixed amount", path: ["fixedAmount"] })
  .refine((v) => v.type !== "percentage" || v.percentageRate != null, { message: "Percentage commissions need a rate", path: ["percentageRate"] })
  .refine((v) => v.type !== "tiered" || (v.tiers && v.tiers.length > 0), { message: "Tiered commissions need at least one tier", path: ["tiers"] })
export type CommissionRuleInput = z.infer<typeof commissionRuleSchema>

export const payrollRunSchema = z.object({
  branchId: z.uuid(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
})
export type PayrollRunInput = z.infer<typeof payrollRunSchema>

export const payrollLineSchema = z.object({
  allowances: z.coerce.number().min(0).max(9999999).default(0),
  overtime: z.coerce.number().min(0).max(9999999).default(0),
  bonus: z.coerce.number().min(0).max(9999999).default(0),
  advances: z.coerce.number().min(0).max(9999999).default(0),
  unpaidLeaveDeduction: z.coerce.number().min(0).max(9999999).default(0),
  otherDeductions: z.coerce.number().min(0).max(9999999).default(0),
})
export type PayrollLineInput = z.infer<typeof payrollLineSchema>

export const payrollPaidViaSchema = z.object({
  paidVia: z.enum(["cash", "card", "bank", "online", "insurance", "credit", "other"]),
})
