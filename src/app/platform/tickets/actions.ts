"use server"

import { revalidatePath } from "next/cache"
import { createSupportTicket, updateSupportTicketStatus, assignSupportTicket, addSupportTicketNoteFromOperator } from "@/lib/domains/commercial/support-tickets"
import { createSupportTicketSchema, operatorSupportTicketNoteSchema } from "@/lib/domains/commercial/schemas"
import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import type { $Enums } from "@/generated/prisma/client"

export type ActionState = { error?: string; success?: boolean }
const ok: ActionState = { success: true }

function revalidate(ticketId?: string) {
  revalidatePath("/platform/tickets")
  if (ticketId) revalidatePath(`/platform/tickets/${ticketId}`)
}

export async function createSupportTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSupportTicketSchema.safeParse({
    organizationId: formData.get("organizationId"),
    title: formData.get("title"),
    description: formData.get("description"),
    category: formData.get("category"),
    priority: formData.get("priority"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const operator = await requirePlatformOperator()
    await createSupportTicket(operator.operator.id, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create ticket." }
  }
  revalidate()
  return ok
}

export async function updateSupportTicketStatusAction(ticketId: string, status: $Enums.SupportTicketStatus): Promise<ActionState> {
  try {
    const operator = await requirePlatformOperator()
    await updateSupportTicketStatus(ticketId, operator.operator.id, status)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update ticket status." }
  }
  revalidate(ticketId)
  return ok
}

export async function assignSupportTicketAction(ticketId: string, assignedOperatorId: string): Promise<ActionState> {
  try {
    const operator = await requirePlatformOperator()
    await assignSupportTicket(ticketId, operator.operator.id, assignedOperatorId || null)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to assign ticket." }
  }
  revalidate(ticketId)
  return ok
}

export async function addOperatorNoteAction(ticketId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = operatorSupportTicketNoteSchema.safeParse({ body: formData.get("body"), visibility: formData.get("visibility") })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  try {
    const operator = await requirePlatformOperator()
    await addSupportTicketNoteFromOperator(ticketId, operator.operator.id, parsed.data.body, parsed.data.visibility)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add note." }
  }
  revalidate(ticketId)
  return ok
}
