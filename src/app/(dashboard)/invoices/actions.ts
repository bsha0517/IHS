"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { assertModuleEnabled } from "@/lib/platform/entitlements"
import { voidInvoice } from "@/lib/domains/billing/invoices"
import { requestRefund, authorizeRefund, rejectRefund, completeRefund } from "@/lib/domains/billing/refunds"
import { requestRefundSchema } from "@/lib/domains/billing/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  await assertModuleEnabled(session.user.organizationId, "pos_billing")
  return session
}

export async function voidInvoiceAction(invoiceId: string, reason: string): Promise<ActionState> {
  try {
    const session = await requireSession()
    await voidInvoice(session, invoiceId, reason)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to void invoice." }
  }
  revalidatePath(`/invoices/${invoiceId}`)
  revalidatePath("/invoices")
  return { success: true }
}

export async function requestRefundAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
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
    const session = await requireSession()
    await requestRefund(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to request refund." }
  }
  revalidatePath(`/invoices/${invoiceId}`)
  return { success: true }
}

export async function authorizeRefundAction(invoiceId: string, refundId: string): Promise<ActionState> {
  try {
    const session = await requireSession()
    await authorizeRefund(session, refundId)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to authorize refund." }
  }
  revalidatePath(`/invoices/${invoiceId}`)
  return { success: true }
}

export async function rejectRefundAction(invoiceId: string, refundId: string, reason: string): Promise<ActionState> {
  try {
    const session = await requireSession()
    await rejectRefund(session, refundId, reason)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reject refund." }
  }
  revalidatePath(`/invoices/${invoiceId}`)
  return { success: true }
}

export async function completeRefundAction(invoiceId: string, refundId: string, cashierSessionId?: string): Promise<ActionState> {
  try {
    const session = await requireSession()
    await completeRefund(session, refundId, cashierSessionId)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to complete refund." }
  }
  revalidatePath(`/invoices/${invoiceId}`)
  return { success: true }
}
