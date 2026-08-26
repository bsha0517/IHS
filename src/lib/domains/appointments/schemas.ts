import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const bookAppointmentSchema = z.object({
  branchId: z.uuid(),
  patientId: z.uuid(),
  providerId: z.uuid(),
  serviceId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  departmentId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  roomId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  startTime: z.coerce.date(),
  durationMinutes: z.coerce.number().int().min(5).max(480),
  bookingSource: z.enum(["walk_in", "phone", "online", "staff"]).default("staff"),
  notes: z.preprocess(emptyToNull, z.string().max(1000).nullable().optional()),
})
export type BookAppointmentInput = z.infer<typeof bookAppointmentSchema>

export const rescheduleAppointmentSchema = z.object({
  startTime: z.coerce.date(),
  durationMinutes: z.coerce.number().int().min(5).max(480),
  providerId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  roomId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
})
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>
