"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createTemplate, updateTemplate, deactivateTemplate } from "@/lib/domains/communications/templates"
import { sendTemplateMessage } from "@/lib/domains/communications/service"
import { commTemplateSchema } from "@/lib/domains/communications/schemas"
import { formatDate } from "@/lib/utils/dates"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readTemplateForm(formData: FormData) {
  return commTemplateSchema.safeParse({
    key: formData.get("key"),
    channel: formData.get("channel"),
    name: formData.get("name"),
    subject: formData.get("subject"),
    body: formData.get("body"),
  })
}

export async function createTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readTemplateForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createTemplate(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create template." }
  }
  revalidatePath("/communications")
  return { success: true }
}

export async function updateTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const id = String(formData.get("templateId") ?? "")
  const parsed = readTemplateForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await updateTemplate(session, id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update template." }
  }
  revalidatePath("/communications")
  return { success: true }
}

export async function deactivateTemplateAction(id: string) {
  const session = await requireSession()
  await deactivateTemplate(session, id)
  revalidatePath("/communications")
}

export async function sendReminderAction(
  patientId: string,
  patientName: string,
  appointmentId: string,
  providerName: string,
  appointmentDate: Date
) {
  const session = await requireSession()
  await sendTemplateMessage(session, {
    patientId,
    templateKey: "appointment_reminder",
    variables: {
      patientName,
      providerName,
      appointmentDate: formatDate(appointmentDate),
      appointmentTime: appointmentDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    },
    referenceType: "appointment",
    referenceId: appointmentId,
  })
  revalidatePath("/communications")
}

export async function sendPaymentReminderAction(
  patientId: string,
  patientName: string,
  invoiceId: string,
  invoiceNumber: string,
  outstandingAmount: number
) {
  const session = await requireSession()
  await sendTemplateMessage(session, {
    patientId,
    templateKey: "payment_reminder",
    variables: { patientName, invoiceNumber, outstandingAmount: outstandingAmount.toFixed(2) },
    referenceType: "invoice",
    referenceId: invoiceId,
  })
  revalidatePath("/communications")
}

export async function sendBirthdayGreetingAction(patientId: string, patientName: string) {
  const session = await requireSession()
  await sendTemplateMessage(session, {
    patientId,
    templateKey: "birthday",
    variables: { patientName },
    referenceType: "patient",
    referenceId: patientId,
  })
  revalidatePath("/communications")
}
