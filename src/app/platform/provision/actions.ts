"use server"

import { requirePlatformOperator } from "@/lib/platform/operator-guard"
import { provisionClinic } from "@/lib/domains/commercial/provisioning"
import { provisionClinicSchema } from "@/lib/domains/commercial/schemas"

export type ProvisionState = {
  error?: string
  success?: {
    organizationId: string
    customerCode: string
    adminEmail: string
    activationToken: string
  }
}

export async function provisionClinicAction(_prev: ProvisionState, formData: FormData): Promise<ProvisionState> {
  const operator = await requirePlatformOperator()

  const raw = Object.fromEntries(formData.entries())
  const moduleKeys = formData.getAll("moduleKeys").map(String)

  const parsed = provisionClinicSchema.safeParse({
    ...raw,
    legalBusinessName: raw.legalBusinessName || null,
    primaryContactName: raw.primaryContactName || null,
    // z.email() rejects an empty string even under .optional().nullable() —
    // a blank optional contact-email field must become null, not "", or a
    // platform operator who simply leaves it blank (the natural thing to do
    // for an optional field) gets a confusing "Invalid email address" error
    // blocking the entire provisioning form.
    primaryContactEmail: raw.primaryContactEmail || null,
    primaryContactPhone: raw.primaryContactPhone || null,
    billingContactName: raw.billingContactName || null,
    billingContactEmail: raw.billingContactEmail || null,
    implementationOwner: raw.implementationOwner || null,
    internalNotes: raw.internalNotes || null,
    agreedUserLimit: raw.agreedUserLimit || null,
    agreedBranchLimit: raw.agreedBranchLimit || null,
    agreedAmount: raw.agreedAmount || null,
    trialEndsAt: raw.trialEndsAt || null,
    billingCycle: raw.billingCycle || null,
    subscriptionNotes: raw.subscriptionNotes || null,
    branchAddress: raw.branchAddress || null,
    branchPhone: raw.branchPhone || null,
    moduleKeys: moduleKeys.length > 0 ? moduleKeys : undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }

  try {
    const result = await provisionClinic(operator, parsed.data)
    return {
      success: {
        organizationId: result.organizationId,
        customerCode: result.customerCode,
        adminEmail: parsed.data.adminEmail,
        activationToken: result.activationToken,
      },
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Provisioning failed." }
  }
}
