"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { voidInvoice } from "@/lib/domains/billing/invoices"
import { requestRefund, authorizeRefund, rejectRefund, completeRefund } from "@/lib/domains/billing/refunds"
import { requestRefundSchema } from "@/lib/domains/billing/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function voidInvoiceAction(invoiceId: string, reason: string) {
  const session = await requireSession()
  await voidInvoice(session, invoiceId, reason)
  revalidatePath(`/invoices/${invoiceId}`)
  revalidatePath("/invoices")
}

export async function requestRefundAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const invoiceId = String(formData.get("invoiceId") ?? "")
  const parsed = requestRefundSchema.safeParse({
    invoiceId,
    paymentId: formData.get("paymentId"),
    method: formData.get("method"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await requestRefund(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to request refund." }
  }
  revalidatePath(`/invoices/${invoiceId}`)
  return { success: true }
}

export async function authorizeRefundAction(invoiceId: string, refundId: string) {
  const session = await requireSession()
  await authorizeRefund(session, refundId)
  revalidatePath(`/invoices/${invoiceId}`)
}

export async function rejectRefundAction(invoiceId: string, refundId: string, reason: string) {
  const session = await requireSession()
  await rejectRefund(session, refundId, reason)
  revalidatePath(`/invoices/${invoiceId}`)
}

export async function completeRefundAction(invoiceId: string, refundId: string, cashierSessionId?: string) {
  const session = await requireSession()
  await completeRefund(session, refundId, cashierSessionId)
  revalidatePath(`/invoices/${invoiceId}`)
}
