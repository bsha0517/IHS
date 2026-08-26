import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const serviceSchema = z.object({
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  departmentId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  description: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
  durationMinutes: z.coerce.number().int().min(1).max(600),
  price: z.coerce.number().min(0),
  billable: z.coerce.boolean().default(true),
  isActive: z.coerce.boolean().default(true),
  requiredRoomType: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
  providerIds: z.array(z.uuid()).default([]),
})
export type ServiceInput = z.infer<typeof serviceSchema>
