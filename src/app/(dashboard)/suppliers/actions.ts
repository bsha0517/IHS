"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createSupplier, updateSupplier } from "@/lib/domains/procurement/suppliers"
import { supplierSchema } from "@/lib/domains/procurement/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readForm(formData: FormData) {
  return supplierSchema.safeParse({
    code: formData.get("code"),
    companyName: formData.get("companyName"),
    contactName: formData.get("contactName"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    address: formData.get("address"),
    taxNumber: formData.get("taxNumber"),
    paymentTerms: formData.get("paymentTerms"),
    bankDetails: formData.get("bankDetails"),
  })
}

export async function createSupplierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createSupplier(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create supplier." }
  }
  revalidatePath("/suppliers")
  return { success: true }
}

export async function updateSupplierAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const supplierId = String(formData.get("supplierId") ?? "")
  const parsed = readForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateSupplier(session, supplierId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update supplier." }
  }
  revalidatePath("/suppliers")
  return { success: true }
}
