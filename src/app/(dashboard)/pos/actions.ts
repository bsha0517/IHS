"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { createAdHocCharge, voidCharge } from "@/lib/domains/billing/charges"
import { generateInvoice } from "@/lib/domains/billing/invoices"
import { recordPayment } from "@/lib/domains/billing/payments"
import { openSession, closeSession, recordCashMovement } from "@/lib/domains/billing/cashier"
import {
  adHocChargeSchema,
  generateInvoiceSchema,
  recordPaymentSchema,
  openCashierSessionSchema,
  cashMovementSchema,
  closeCashierSessionSchema,
} from "@/lib/domains/billing/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function openCashierSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = openCashierSessionSchema.safeParse({
    branchId: formData.get("branchId"),
    openingCash: formData.get("openingCash"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await openSession(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to open register." }
  }
  revalidatePath("/pos")
  return { success: true }
}

export async function recordCashMovementAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const cashierSessionId = String(formData.get("cashierSessionId") ?? "")
  const parsed = cashMovementSchema.safeParse({
    direction: formData.get("direction"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await recordCashMovement(session, cashierSessionId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record cash movement." }
  }
  revalidatePath("/pos")
  return { success: true }
}

export async function closeCashierSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const cashierSessionId = String(formData.get("cashierSessionId") ?? "")
  const parsed = closeCashierSessionSchema.safeParse({
    actualCash: formData.get("actualCash"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  let closed
  try {
    closed = await closeSession(session, cashierSessionId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to close register." }
  }
  redirect(`/pos/sessions/${closed.id}`)
}

export async function createAdHocChargeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = adHocChargeSchema.safeParse({
    patientId: formData.get("patientId"),
    branchId: formData.get("branchId"),
    encounterId: formData.get("encounterId"),
    serviceId: formData.get("serviceId"),
    productId: formData.get("productId"),
    providerId: formData.get("providerId"),
    sourceType: formData.get("sourceType"),
    description: formData.get("description"),
    quantity: formData.get("quantity") || 1,
    unitPrice: formData.get("unitPrice"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  // P3.7 §45: the form generates this once per dialog-open and resubmits it
  // unchanged on any retry — see createAdHocCharge (billing/charges.ts).
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "") || undefined

  try {
    await createAdHocCharge(session, { ...parsed.data, idempotencyKey })
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add charge." }
  }
  revalidatePath("/pos")
  return { success: true }
}

export async function voidChargeAction(chargeId: string, reason: string): Promise<ActionState> {
  const session = await requireSession()
  try {
    await voidCharge(session, chargeId, reason)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to void charge." }
  }
  revalidatePath("/pos")
  return { success: true }
}

export async function generateInvoiceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const chargeIds = formData.getAll("chargeIds").map(String)
  const parsed = generateInvoiceSchema.safeParse({
    patientId: formData.get("patientId"),
    branchId: formData.get("branchId"),
    providerId: formData.get("providerId"),
    chargeIds,
    discountAmount: formData.get("discountAmount") || 0,
    patientCoverageId: formData.get("patientCoverageId"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  let invoice
  try {
    invoice = await generateInvoice(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to generate invoice." }
  }
  redirect(`/invoices/${invoice.id}`)
}

export async function recordPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const invoiceId = String(formData.get("invoiceId") ?? "")
  let rawTenders: unknown
  try {
    rawTenders = JSON.parse(String(formData.get("tenders") ?? "[]"))
  } catch {
    return { error: "Invalid tender list." }
  }
  const parsed = recordPaymentSchema.safeParse({
    invoiceId,
    cashierSessionId: formData.get("cashierSessionId"),
    tenders: rawTenders,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  // P1 §33: the form generates this once per open and resubmits it unchanged
  // on any retry — a double-click or network retry replays the original
  // payment instead of collecting the same tender twice.
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "") || undefined

  try {
    await recordPayment(session, { ...parsed.data, idempotencyKey })
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record payment." }
  }
  revalidatePath(`/invoices/${invoiceId}`)
  revalidatePath("/pos")
  return { success: true }
}
