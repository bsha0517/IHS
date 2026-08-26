import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const labResultTypes = ["numeric", "text"] as const

export const labTestSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  specimenType: z.string().min(1).max(100),
  resultType: z.enum(labResultTypes),
  unit: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
  referenceRangeLow: z.preprocess(emptyToNull, z.coerce.number().nullable().optional()),
  referenceRangeHigh: z.preprocess(emptyToNull, z.coerce.number().nullable().optional()),
  referenceRangeText: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  price: z.coerce.number().min(0).max(9999999),
  turnaroundHours: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(8760).nullable().optional()),
})
export type LabTestInput = z.infer<typeof labTestSchema>

export const labPanelSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  price: z.coerce.number().min(0).max(9999999),
  testIds: z.array(z.uuid()).min(1, "Add at least one test"),
})
export type LabPanelInput = z.infer<typeof labPanelSchema>

const assignTestLineSchema = z.object({
  kind: z.enum(["test", "panel"]),
  id: z.uuid(),
})

export const assignTestsSchema = z.object({
  specimenType: z.string().min(1).max(100),
  lines: z.array(assignTestLineSchema).min(1, "Select at least one test or panel"),
})
export type AssignTestsInput = z.infer<typeof assignTestsSchema>

export const collectSpecimenSchema = z.object({
  collectedAt: z.coerce.date().optional(),
})
export type CollectSpecimenInput = z.infer<typeof collectSpecimenSchema>

export const rejectSpecimenSchema = z.object({
  rejectionReason: z.string().min(1).max(300),
})
export type RejectSpecimenInput = z.infer<typeof rejectSpecimenSchema>

export const enterNumericResultSchema = z.object({
  numericValue: z.coerce.number(),
  notes: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type EnterNumericResultInput = z.infer<typeof enterNumericResultSchema>

export const enterTextResultSchema = z.object({
  textValue: z.string().min(1).max(2000),
  notes: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type EnterTextResultInput = z.infer<typeof enterTextResultSchema>
