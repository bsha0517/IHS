import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const publicBookingSchema = z.object({
  branchId: z.uuid(),
  providerId: z.uuid(),
  serviceId: z.uuid(),
  startTime: z.coerce.date(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  dob: z.coerce.date(),
  gender: z.enum(["male", "female", "other"]),
  mobile: z.string().min(5).max(30),
  email: z.preprocess(emptyToNull, z.email().nullable().optional()),
  notes: z.preprocess(emptyToNull, z.string().max(500).nullable().optional()),
})
export type PublicBookingInput = z.infer<typeof publicBookingSchema>
