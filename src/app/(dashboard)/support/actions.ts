"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createSupportTicketFromClinic, addSupportTicketNoteFromClinic } from "@/lib/domains/commercial/support-tickets"
import { createClinicSupportTicketSchema, supportTicketNoteSchema } from "@/lib/domains/commercial/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  // Deliberately NOT gated on any module entitlement — support access is
  // never a commercially-gated capability (every clinic, on any plan, can
  // always reach Avant's own support team). RBAC alone (support_ticket.manage,
  // enforced inside the domain functions below) is the real gate here.
  return session
}

export async function createSupportTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = createClinicSupportTicketSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    category: formData.get("category"),
    priority: formData.get("priority"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await createSupportTicketFromClinic(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create ticket." }
  }
  revalidatePath("/support")
  return { success: true }
}

export async function addClinicNoteAction(ticketId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = supportTicketNoteSchema.safeParse({ body: formData.get("body") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    await addSupportTicketNoteFromClinic(session, ticketId, parsed.data.body)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add reply." }
  }
  revalidatePath(`/support/${ticketId}`)
  return { success: true }
}
