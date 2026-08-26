import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const packageServiceLineSchema = z.object({
  serviceId: z.uuid(),
  sessionsAllocated: z.coerce.number().int().min(1).max(999),
})

export const packageSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
  price: z.coerce.number().min(0).max(9999999),
  discountAmount: z.coerce.number().min(0).max(9999999).default(0),
  validityDays: z.preprocess(emptyToNull, z.coerce.number().int().min(1).max(3650).nullable().optional()),
  services: z.array(packageServiceLineSchema).min(1, "Add at least one service"),
})
export type PackageInput = z.infer<typeof packageSchema>

export const purchasePackageSchema = z.object({
  patientId: z.uuid(),
  branchId: z.uuid(),
  packageId: z.uuid(),
  priceOverride: z.preprocess(emptyToNull, z.coerce.number().min(0).max(9999999).nullable().optional()),
})
export type PurchasePackageInput = z.infer<typeof purchasePackageSchema>

export const consumeSessionSchema = z.object({
  patientPackageId: z.uuid(),
  packageServiceId: z.uuid(),
  encounterId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  notes: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type ConsumeSessionInput = z.infer<typeof consumeSessionSchema>
