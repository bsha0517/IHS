import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const patientSchema = z.object({
  registrationBranchId: z.uuid(),
  firstName: z.string().min(1, "First name is required").max(100),
  middleName: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  lastName: z.string().min(1, "Last name is required").max(100),
  dob: z.coerce.date(),
  gender: z.enum(["male", "female", "other", "unknown"]),
  nationality: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  mobile: z.string().min(5, "Mobile number is required").max(30),
  whatsapp: z.preprocess(emptyToNull, z.string().max(30).nullable().optional()),
  email: z.preprocess(emptyToNull, z.email().nullable().optional()),
  addressLine: z.preprocess(emptyToNull, z.string().max(300).nullable().optional()),
  city: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  country: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  nationalId: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
  passportNumber: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
  emergencyContactName: z.preprocess(emptyToNull, z.string().max(150).nullable().optional()),
  emergencyContactRelationship: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  emergencyContactPhone: z.preprocess(emptyToNull, z.string().max(30).nullable().optional()),
  preferredLanguage: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
  referralSource: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  preferredProviderId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
})
export type PatientInput = z.infer<typeof patientSchema>

/** P1 §24: the explicit ACTIVE/INACTIVE/DECEASED alternative to deleting a Patient (which P0 made Restrict). */
export const patientStatusSchema = z.object({
  status: z.enum(["active", "inactive", "deceased"]),
  reason: z.string().min(1, "A reason is required").max(500),
})
export type PatientStatusInput = z.infer<typeof patientStatusSchema>

export const allergySchema = z.object({
  allergen: z.string().min(1).max(200),
  reaction: z.preprocess(emptyToNull, z.string().max(300).nullable().optional()),
  severity: z.enum(["mild", "moderate", "severe"]),
  isAlert: z.coerce.boolean().default(false),
})
export type AllergyInput = z.infer<typeof allergySchema>

export const conditionSchema = z.object({
  category: z.enum(["chronic", "active", "previous", "surgical_history", "family_history", "medical_history"]),
  description: z.string().min(1).max(500),
  isAlert: z.coerce.boolean().default(false),
})
export type ConditionInput = z.infer<typeof conditionSchema>

export const medicationHistorySchema = z.object({
  medicationName: z.string().min(1).max(200),
  dose: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  status: z.enum(["current", "past"]).default("current"),
})
export type MedicationHistoryInput = z.infer<typeof medicationHistorySchema>
