import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const commChannels = ["sms", "whatsapp", "email"] as const

export const commTemplateSchema = z.object({
  key: z.string().min(1).max(100),
  channel: z.enum(commChannels),
  name: z.string().min(1).max(200),
  subject: z.preprocess(emptyToNull, z.string().max(200).nullable().optional()),
  body: z.string().min(1).max(2000),
})
export type CommTemplateInput = z.infer<typeof commTemplateSchema>

export const sendTemplateMessageSchema = z.object({
  patientId: z.uuid(),
  templateKey: z.string().min(1),
  referenceType: z.preprocess(emptyToNull, z.string().max(50).nullable().optional()),
  referenceId: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
})
export type SendTemplateMessageInput = z.infer<typeof sendTemplateMessageSchema>
