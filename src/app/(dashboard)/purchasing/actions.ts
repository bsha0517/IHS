"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/auth/session"
import { createPurchaseRequest, approvePurchaseRequest, rejectPurchaseRequest } from "@/lib/domains/procurement/purchase-requests"
import { createPurchaseOrder, cancelPurchaseOrder } from "@/lib/domains/procurement/purchase-orders"
import { createGoodsReceipt } from "@/lib/domains/procurement/goods-receipts"
import { createSupplierInvoice, recordSupplierPayment } from "@/lib/domains/procurement/supplier-invoices"
import {
  purchaseRequestSchema,
  purchaseOrderSchema,
  goodsReceiptSchema,
  supplierInvoiceSchema,
  supplierPaymentSchema,
} from "@/lib/domains/procurement/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function createPurchaseRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  let rawLines: unknown
  try {
    rawLines = JSON.parse(String(formData.get("lines") ?? "[]"))
  } catch {
    return { error: "Invalid line list." }
  }
  const parsed = purchaseRequestSchema.safeParse({
    branchId: formData.get("branchId"),
    notes: formData.get("notes"),
    lines: rawLines,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createPurchaseRequest(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create purchase request." }
  }
  revalidatePath("/purchasing")
  return { success: true }
}

export async function approvePurchaseRequestAction(id: string): Promise<ActionState> {
  const session = await requireSession()
  try {
    await approvePurchaseRequest(session, id)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to approve purchase request." }
  }
  revalidatePath("/purchasing")
  return { success: true }
}

export async function rejectPurchaseRequestAction(id: string, reason: string): Promise<ActionState> {
  const session = await requireSession()
  try {
    await rejectPurchaseRequest(session, id, reason)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reject purchase request." }
  }
  revalidatePath("/purchasing")
  return { success: true }
}

export async function createPurchaseOrderAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  let rawLines: unknown
  try {
    rawLines = JSON.parse(String(formData.get("lines") ?? "[]"))
  } catch {
    return { error: "Invalid line list." }
  }
  const parsed = purchaseOrderSchema.safeParse({
    branchId: formData.get("branchId"),
    supplierId: formData.get("supplierId"),
    purchaseRequestId: formData.get("purchaseRequestId"),
    expectedDeliveryDate: formData.get("expectedDeliveryDate"),
    notes: formData.get("notes"),
    lines: rawLines,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  let po
  try {
    po = await createPurchaseOrder(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create purchase order." }
  }
  redirect(`/purchasing/orders/${po.id}`)
}

export async function cancelPurchaseOrderAction(id: string, reason: string): Promise<ActionState> {
  const session = await requireSession()
  try {
    await cancelPurchaseOrder(session, id, reason)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to cancel purchase order." }
  }
  revalidatePath(`/purchasing/orders/${id}`)
  revalidatePath("/purchasing")
  return { success: true }
}

export async function createGoodsReceiptAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const purchaseOrderId = String(formData.get("purchaseOrderId") ?? "")
  let rawLines: unknown
  try {
    rawLines = JSON.parse(String(formData.get("lines") ?? "[]"))
  } catch {
    return { error: "Invalid line list." }
  }
  const parsed = goodsReceiptSchema.safeParse({
    purchaseOrderId,
    notes: formData.get("notes"),
    lines: rawLines,
    allowOverReceipt: formData.get("allowOverReceipt") === "on" || formData.get("allowOverReceipt") === "true",
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  // P1 §33: the dialog generates this once per open and resubmits it
  // unchanged on any retry — see receive-dialog.tsx — so a double-click or
  // network retry replays the original receipt instead of creating a second one.
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "") || undefined

  try {
    await createGoodsReceipt(session, { ...parsed.data, idempotencyKey })
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record goods receipt." }
  }
  revalidatePath(`/purchasing/orders/${purchaseOrderId}`)
  revalidatePath("/inventory")
  return { success: true }
}

export async function createSupplierInvoiceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const purchaseOrderId = String(formData.get("purchaseOrderId") ?? "") || undefined
  const parsed = supplierInvoiceSchema.safeParse({
    supplierId: formData.get("supplierId"),
    branchId: formData.get("branchId"),
    purchaseOrderId,
    invoiceNumber: formData.get("invoiceNumber"),
    amount: formData.get("amount"),
    taxAmount: formData.get("taxAmount"),
    dueDate: formData.get("dueDate"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  // P3.8 §41: the dialog generates this once per open and resubmits it
  // unchanged on any retry — see supplier-invoice-dialog.tsx — so a
  // double-click or network retry replays the original invoice instead of
  // creating a second AP liability.
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "") || undefined

  try {
    await createSupplierInvoice(session, { ...parsed.data, idempotencyKey })
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record supplier invoice." }
  }
  revalidatePath("/purchasing")
  if (purchaseOrderId) revalidatePath(`/purchasing/orders/${purchaseOrderId}`)
  return { success: true }
}

export async function recordSupplierPaymentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = supplierPaymentSchema.safeParse({
    supplierInvoiceId: formData.get("supplierInvoiceId"),
    method: formData.get("method"),
    amount: formData.get("amount"),
    reference: formData.get("reference"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await recordSupplierPayment(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record payment." }
  }
  revalidatePath("/purchasing")
  return { success: true }
}
