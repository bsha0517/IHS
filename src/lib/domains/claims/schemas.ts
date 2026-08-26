import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const payorTypes = ["self_pay", "insurance_company", "corporate", "government", "other"] as const

export const payorSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  payorType: z.enum(payorTypes),
  contactName: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  contactPhone: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
  contactEmail: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  address: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type PayorInput = z.infer<typeof payorSchema>

export const insurancePlanSchema = z.object({
  payorId: z.uuid(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
})
export type InsurancePlanInput = z.infer<typeof insurancePlanSchema>

export const policySchema = z.object({
  insurancePlanId: z.uuid(),
  policyNumber: z.string().min(1).max(100),
  groupNumber: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
})
export type PolicyInput = z.infer<typeof policySchema>

export const patientCoverageSchema = z.object({
  policyId: z.uuid(),
  memberId: z.string().min(1).max(100),
  relationshipToSubscriber: z.string().min(1).max(50).default("self"),
  startDate: z.coerce.date(),
  endDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  copayAmount: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
  copayPercent: z.preprocess(emptyToNull, z.coerce.number().min(0).max(100).nullable().optional()),
  deductibleAmount: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
  annualLimitAmount: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
  isPrimary: z.coerce.boolean().default(true),
  notes: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
})
export type PatientCoverageInput = z.infer<typeof patientCoverageSchema>

export const requestAuthorizationSchema = z.object({
  patientCoverageId: z.uuid(),
  encounterId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  notes: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
})
export type RequestAuthorizationInput = z.infer<typeof requestAuthorizationSchema>

export const decideAuthorizationSchema = z.object({
  authNumber: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  validFrom: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  validUntil: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  notes: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
})
export type DecideAuthorizationInput = z.infer<typeof decideAuthorizationSchema>

const claimItemLineSchema = z.object({
  invoiceLineId: z.uuid(),
  diagnosisId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  procedureCode: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
})

export const createClaimSchema = z.object({
  invoiceId: z.uuid(),
  patientCoverageId: z.uuid(),
  items: z.array(claimItemLineSchema).min(1, "Select at least one invoice line"),
})
export type CreateClaimInput = z.infer<typeof createClaimSchema>

const claimItemAdjudicationSchema = z.object({
  claimItemId: z.uuid(),
  approvedAmount: z.coerce.number().min(0).max(9999999),
  denialReason: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})

export const adjudicateClaimSchema = z.object({
  items: z.array(claimItemAdjudicationSchema).min(1),
  rejectionReason: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type AdjudicateClaimInput = z.infer<typeof adjudicateClaimSchema>

export const recordRemittanceSchema = z.object({
  amount: z.coerce.number().positive().max(9999999),
  reference: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
})
export type RecordRemittanceInput = z.infer<typeof recordRemittanceSchema>
