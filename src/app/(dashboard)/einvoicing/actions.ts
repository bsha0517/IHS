"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { assertCan } from "@/lib/platform/permissions-core"
import { setZatcaSellerProfile, type ZatcaSellerProfile } from "@/lib/domains/einvoicing/config"
import { submitInvoiceToZatca } from "@/lib/domains/einvoicing/service"
import { db } from "@/lib/db"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

export async function saveZatcaSellerProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const profile: ZatcaSellerProfile = {
    enabled: formData.get("enabled") === "on",
    vatRegistrationNumber: String(formData.get("vatRegistrationNumber") ?? "").trim(),
    sellerName: String(formData.get("sellerName") ?? "").trim(),
    buildingNumber: String(formData.get("buildingNumber") ?? "").trim(),
    streetName: String(formData.get("streetName") ?? "").trim(),
    district: String(formData.get("district") ?? "").trim(),
    city: String(formData.get("city") ?? "").trim(),
    postalCode: String(formData.get("postalCode") ?? "").trim(),
    additionalNumber: String(formData.get("additionalNumber") ?? "").trim(),
    countryCode: String(formData.get("countryCode") ?? "SA").trim() || "SA",
  }

  try {
    await setZatcaSellerProfile(session, profile)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save ZATCA seller profile." }
  }
  revalidatePath("/einvoicing")
  return { success: true }
}

/** Re-runs the same submission path the InvoiceIssued outbox handler uses — see einvoicing/service.ts. */
export async function retryEInvoiceSubmissionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  assertCan(session, "einvoicing.submit")
  const invoiceId = String(formData.get("invoiceId") ?? "")
  const submission = await db.eInvoiceSubmission.findUnique({ where: { invoiceId } })
  if (!submission || submission.organizationId !== session.user.organizationId) {
    return { error: "Submission not found." }
  }

  try {
    await submitInvoiceToZatca(invoiceId)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Retry failed." }
  }
  revalidatePath("/einvoicing")
  return { success: true }
}
