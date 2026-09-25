"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { assertModuleEnabled } from "@/lib/platform/entitlements"
import { createCommissionRule } from "@/lib/domains/payroll/commissions"
import { commissionRuleSchema } from "@/lib/domains/payroll/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  await assertModuleEnabled(session.user.organizationId, "hr")
  return session
}

export async function createCommissionRuleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let tiers: unknown
  try {
    tiers = JSON.parse(String(formData.get("tiers") ?? "[]"))
  } catch {
    return { error: "Invalid tier configuration." }
  }

  const parsed = commissionRuleSchema.safeParse({
    providerId: formData.get("providerId"),
    serviceId: formData.get("serviceId"),
    productId: formData.get("productId"),
    type: formData.get("type"),
    basis: formData.get("basis"),
    fixedAmount: formData.get("fixedAmount"),
    percentageRate: formData.get("percentageRate"),
    tiers,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await createCommissionRule(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create commission rule." }
  }
  revalidatePath("/commissions")
  return { success: true }
}
