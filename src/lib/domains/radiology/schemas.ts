import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const imagingServiceSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  bodyPart: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  price: z.coerce.number().min(0).max(9999999),
  turnaroundHours: z.preprocess(emptyToNull, z.coerce.number().int().min(0).max(8760).nullable().optional()),
})
export type ImagingServiceInput = z.infer<typeof imagingServiceSchema>

export const assignImagingServiceSchema = z.object({
  imagingServiceId: z.uuid(),
})
export type AssignImagingServiceInput = z.infer<typeof assignImagingServiceSchema>

export const scheduleImagingSchema = z.object({
  scheduledAt: z.coerce.date(),
  roomId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
})
export type ScheduleImagingInput = z.infer<typeof scheduleImagingSchema>

export const writeReportSchema = z.object({
  reportText: z.string().min(1).max(5000),
  impression: z.preprocess(emptyToNull, z.string().max(2000).nullable().optional()),
})
export type WriteReportInput = z.infer<typeof writeReportSchema>

// Targeted backlog closure, item 7: a correction to an already-verified
// report. `reason` is required (unlike Lab's own optional amendment
// `notes`) — the task's own explicit requirement for radiology specifically.
export const amendReportSchema = z.object({
  reportText: z.string().min(1).max(5000),
  impression: z.preprocess(emptyToNull, z.string().max(2000).nullable().optional()),
  reason: z.string().min(1).max(500),
})
export type AmendReportInput = z.infer<typeof amendReportSchema>
