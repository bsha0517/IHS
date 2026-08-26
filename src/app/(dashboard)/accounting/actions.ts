"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { createAccount, updateAccount } from "@/lib/domains/accounting/chart-of-accounts"
import { setMapping } from "@/lib/domains/accounting/account-mappings"
import { createManualJournal } from "@/lib/domains/accounting/journals"
import { chartOfAccountSchema, accountMappingSchema, manualJournalSchema } from "@/lib/domains/accounting/schemas"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  return session
}

function readAccountForm(formData: FormData) {
  return chartOfAccountSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
    type: formData.get("type"),
    parentAccountId: formData.get("parentAccountId"),
  })
}

export async function createAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = readAccountForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createAccount(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create account." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function updateAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const accountId = String(formData.get("accountId") ?? "")
  const parsed = readAccountForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await updateAccount(session, accountId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update account." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function setMappingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = accountMappingSchema.safeParse({
    branchId: formData.get("branchId"),
    intent: formData.get("intent"),
    accountId: formData.get("accountId"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await setMapping(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save mapping." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function createManualJournalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()

  let lines: unknown
  try {
    lines = JSON.parse(String(formData.get("lines") ?? "[]"))
  } catch {
    return { error: "Invalid journal lines." }
  }

  const parsed = manualJournalSchema.safeParse({
    branchId: formData.get("branchId"),
    journalDate: formData.get("journalDate"),
    description: formData.get("description"),
    lines,
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    await createManualJournal(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to post journal." }
  }
  revalidatePath("/accounting")
  return { success: true }
}
