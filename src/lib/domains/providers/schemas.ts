import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const providerSchema = z.object({
  providerType: z.enum(["doctor", "dentist", "physiotherapist", "nurse", "therapist", "other"]),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  specialty: z.preprocess(emptyToNull, z.string().max(150).nullable().optional()),
  qualification: z.preprocess(emptyToNull, z.string().max(150).nullable().optional()),
  licenseNumber: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  licenseAuthority: z.preprocess(emptyToNull, z.string().max(150).nullable().optional()),
  licenseExpiryDate: z.preprocess(emptyToNull, z.coerce.date().nullable().optional()),
  consultationFee: z.coerce.number().min(0),
  defaultAppointmentDurationMinutes: z.coerce.number().int().min(5).max(480),
  branchIds: z.array(z.uuid()).default([]),
  departmentIds: z.array(z.uuid()).default([]),
  userId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
})
export type ProviderInput = z.infer<typeof providerSchema>

export const providerScheduleSchema = z.object({
  branchId: z.uuid(),
  departmentId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  roomId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
  slotDurationMinutes: z.coerce.number().int().min(5).max(240).default(30),
})
export type ProviderScheduleInput = z.infer<typeof providerScheduleSchema>

export const providerLeaveBlockSchema = z.object({
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  reason: z.preprocess(emptyToNull, z.string().max(300).nullable().optional()),
})
export type ProviderLeaveBlockInput = z.infer<typeof providerLeaveBlockSchema>

export const linkEmployeeSchema = z.object({
  employeeId: z.preprocess(emptyToNull, z.uuid().nullable()),
})
export type LinkEmployeeInput = z.infer<typeof linkEmployeeSchema>
