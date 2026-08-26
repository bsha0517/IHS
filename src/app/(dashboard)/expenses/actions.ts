"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createExpense } from "@/lib/domains/accounting/expenses"
import { expenseSchema } from "@/lib/domains/accounting/schemas"

export type ActionState = { error?: string; success?: boolean }

export async function createExpenseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await getCurrentSession()
  if (!session) return { error: "Not authenticated." }

  const parsed = expenseSchema.safeParse({
    branchId: formData.get("branchId"),
    expenseAccountId: formData.get("expenseAccountId"),
    description: formData.get("description"),
    amount: formData.get("amount"),
    paidVia: formData.get("paidVia"),
    expenseDate: formData.get("expenseDate"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createExpense(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to record expense." }
  }
  revalidatePath("/expenses")
  return { success: true }
}
