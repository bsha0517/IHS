"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createProduct, updateProduct } from "@/lib/domains/inventory/products"
import { recordAdjustment } from "@/lib/domains/inventory/stock"
import { createTransfer, completeTransfer, cancelTransfer } from "@/lib/domains/inventory/transfers"
import { productSchema, stockAdjustmentSchema, stockTransferSchema } from "@/lib/domains/inventory/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readProductForm(formData: FormData) {
  return productSchema.safeParse({
    sku: formData.get("sku"),
    barcode: formData.get("barcode"),
    name: formData.get("name"),
    category: formData.get("category"),
    brand: formData.get("brand"),
    unit: formData.get("unit"),
    purchaseCost: formData.get("purchaseCost"),
    sellingPrice: formData.get("sellingPrice"),
    reorderLevel: formData.get("reorderLevel") || 0,
    minimumStock: formData.get("minimumStock") || 0,
    maximumStock: formData.get("maximumStock"),
  })
}

export async function createProductAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readProductForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createProduct(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create product." }
  }
  revalidatePath("/inventory")
  revalidatePath("/services")
  return { success: true }
}

export async function updateProductAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const productId = String(formData.get("productId") ?? "")
  const parsed = readProductForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateProduct(session, productId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update product." }
  }
  revalidatePath("/inventory")
  return { success: true }
}

export async function recordAdjustmentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = stockAdjustmentSchema.safeParse({
    branchId: formData.get("branchId"),
    productId: formData.get("productId"),
    batchId: formData.get("batchId"),
    direction: formData.get("direction"),
    quantity: formData.get("quantity"),
    transactionType: formData.get("transactionType") || "adjustment",
    reason: formData.get("reason"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await recordAdjustment(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record adjustment." }
  }
  revalidatePath("/inventory")
  return { success: true }
}

export async function createTransferAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = stockTransferSchema.safeParse({
    fromBranchId: formData.get("fromBranchId"),
    toBranchId: formData.get("toBranchId"),
    productId: formData.get("productId"),
    batchId: formData.get("batchId"),
    quantity: formData.get("quantity"),
    notes: formData.get("notes"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createTransfer(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create transfer." }
  }
  revalidatePath("/inventory")
  return { success: true }
}

export async function completeTransferAction(transferId: string) {
  const session = await requireSession()
  await completeTransfer(session, transferId)
  revalidatePath("/inventory")
}

export async function cancelTransferAction(transferId: string, reason: string) {
  const session = await requireSession()
  await cancelTransfer(session, transferId, reason)
  revalidatePath("/inventory")
}
