import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const medicationSchema = z.object({
  sku: z.string().min(1).max(50),
  barcode: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100).default("Medication"),
  brand: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  unit: z.string().min(1).max(30),
  purchaseCost: z.coerce.number().min(0).max(9999999),
  sellingPrice: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
  reorderLevel: z.coerce.number().int().min(0).max(999999).default(0),
  minimumStock: z.coerce.number().int().min(0).max(999999).default(0),
  maximumStock: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(999999).nullable().optional()),
  genericName: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  strength: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  dosageForm: z.string().min(1).max(100),
  route: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
  controlledSubstance: z.coerce.boolean().default(false),
  requiresPrescription: z.coerce.boolean().default(true),
})
export type MedicationInput = z.infer<typeof medicationSchema>

export const createDispensingRecordSchema = z.object({
  prescriptionItemId: z.uuid(),
  medicationId: z.uuid(),
  quantityDispensed: z.coerce.number().int().positive().max(999999),
  // Targeted backlog closure, item 8: only meaningful (and only required)
  // when the selected medication doesn't obviously match what was
  // prescribed — see createDispensingRecord's own doc comment.
  substitutionConfirmed: z.boolean().optional(),
})
export type CreateDispensingRecordInput = z.infer<typeof createDispensingRecordSchema>

export const returnDispensingSchema = z.object({
  quantityReturned: z.coerce.number().int().positive().max(999999),
  reason: z.string().min(1).max(500),
})
export type ReturnDispensingInput = z.infer<typeof returnDispensingSchema>
