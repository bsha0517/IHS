import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const episodeSchema = z.object({
  branchId: z.uuid(),
  patientId: z.uuid(),
  episodeType: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  description: z.preprocess(emptyToNull, z.string().max(2000).nullable().optional()),
  startDate: z.coerce.date(),
  primaryProviderId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
})
export type EpisodeInput = z.infer<typeof episodeSchema>

export const encounterSchema = z.object({
  branchId: z.uuid(),
  departmentId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  patientId: z.uuid(),
  episodeId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  appointmentId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  providerId: z.uuid(),
  encounterType: z.enum([
    "consultation",
    "follow_up",
    "procedure",
    "therapy",
    "emergency_walk_in",
    "diagnostic",
    "teleconsultation",
  ]),
})
export type EncounterInput = z.infer<typeof encounterSchema>

export const vitalSignSchema = z.object({
  heightCm: z.preprocess(emptyToNull, z.coerce.number().min(0).max(300).nullable().optional()),
  weightKg: z.preprocess(emptyToNull, z.coerce.number().min(0).max(500).nullable().optional()),
  bloodPressureSystolic: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(300).nullable().optional()),
  bloodPressureDiastolic: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(200).nullable().optional()),
  pulseBpm: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(300).nullable().optional()),
  temperatureCelsius: z.preprocess(emptyToNull, z.coerce.number().min(25).max(45).nullable().optional()),
  oxygenSaturationPercent: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(100).nullable().optional()),
  respiratoryRatePerMin: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(100).nullable().optional()),
  bloodGlucoseMgDl: z.preprocess(emptyToNull, z.coerce.number().min(0).max(1000).nullable().optional()),
})
export type VitalSignInput = z.infer<typeof vitalSignSchema>

export const clinicalNoteSchema = z.object({
  noteType: z.enum(["consultation", "progress", "nursing", "procedure", "follow_up"]),
  chiefComplaint: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
  historyOfPresentIllness: z.preprocess(emptyToNull, z.string().max(4000).nullable().optional()),
  reviewOfSystems: z.preprocess(emptyToNull, z.string().max(4000).nullable().optional()),
  examinationFindings: z.preprocess(emptyToNull, z.string().max(4000).nullable().optional()),
  assessment: z.preprocess(emptyToNull, z.string().max(4000).nullable().optional()),
  treatmentPlan: z.preprocess(emptyToNull, z.string().max(4000).nullable().optional()),
  content: z.preprocess(emptyToNull, z.string().max(4000).nullable().optional()),
})
export type ClinicalNoteInput = z.infer<typeof clinicalNoteSchema>

export const diagnosisSchema = z.object({
  diagnosisCode: z.preprocess(emptyToNull, z.string().max(20).nullable().optional()),
  description: z.string().min(1).max(500),
  isPrimary: z.coerce.boolean().default(false),
})
export type DiagnosisInput = z.infer<typeof diagnosisSchema>

export const clinicalOrderSchema = z.object({
  orderType: z.enum(["lab", "imaging", "procedure", "referral", "other"]),
  priority: z.enum(["routine", "urgent", "stat"]).default("routine"),
  instructions: z.preprocess(emptyToNull, z.string().max(2000).nullable().optional()),
  // Type-specific fields — validated more precisely per-type in the service layer,
  // kept optional/loose here since only a subset applies to any given orderType.
  testName: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  specimenType: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  imagingType: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  bodyPart: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  procedureName: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  referralScope: z.preprocess(emptyToNull, z.enum(["internal", "external"]).nullable().optional()),
  referredToProviderId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  referredToExternal: z.preprocess(emptyToNull, z.string().max(300).nullable().optional()),
  reason: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
})
export type ClinicalOrderInput = z.infer<typeof clinicalOrderSchema>

export const prescriptionItemSchema = z.object({
  medicationName: z.string().min(1).max(200),
  genericName: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  strength: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  dose: z.string().min(1).max(100),
  frequency: z.string().min(1).max(100),
  route: z.string().min(1).max(50),
  durationDays: z.preprocess(emptyToNull, z.coerce.number().int().min(1).max(365).nullable().optional()),
  quantity: z.preprocess(emptyToNull, z.coerce.number().int().min(1).nullable().optional()),
  instructions: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type PrescriptionItemInput = z.infer<typeof prescriptionItemSchema>

export const prescriptionSchema = z.object({
  items: z.array(prescriptionItemSchema).min(1, "At least one medication is required"),
})
export type PrescriptionInput = z.infer<typeof prescriptionSchema>

export const followUpSchema = z.object({
  recommendedDate: z.coerce.date(),
  reason: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type FollowUpInput = z.infer<typeof followUpSchema>
