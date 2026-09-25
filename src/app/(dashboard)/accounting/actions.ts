"use server"

import { revalidatePath } from "next/cache"
import { getCurrentSession } from "@/lib/auth/session"
import { assertModuleEnabled } from "@/lib/platform/entitlements"
import { createAccount, updateAccount } from "@/lib/domains/accounting/chart-of-accounts"
import { setMapping } from "@/lib/domains/accounting/account-mappings"
import { createManualJournal, reverseJournal } from "@/lib/domains/accounting/journals"
import { closePeriod, reopenPeriod } from "@/lib/domains/accounting/periods"
import { getJournalTrace, REFERENCE_TYPE_LABELS } from "@/lib/domains/accounting/traceability"
import { retryAccountingException, sweepAccountingExceptions } from "@/lib/domains/accounting/exceptions"
import { chartOfAccountSchema, accountMappingSchema, manualJournalSchema } from "@/lib/domains/accounting/schemas"
import { formatDateTime } from "@/lib/utils/dates"

export type ActionState = { error?: string; success?: boolean }

async function requireSession() {
  const session = await getCurrentSession()
  if (!session) throw new Error("Not authenticated.")
  await assertModuleEnabled(session.user.organizationId, "finance")
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
  const parsed = readAccountForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await createAccount(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create account." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function updateAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const accountId = String(formData.get("accountId") ?? "")
  const parsed = readAccountForm(formData)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await updateAccount(session, accountId, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update account." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function setMappingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = accountMappingSchema.safeParse({
    branchId: formData.get("branchId"),
    intent: formData.get("intent"),
    accountId: formData.get("accountId"),
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." }

  try {
    const session = await requireSession()
    await setMapping(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save mapping." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function createManualJournalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
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
    const session = await requireSession()
    await createManualJournal(session, parsed.data)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to post journal." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function reverseJournalAction(journalId: string, reason: string): Promise<ActionState> {
  try {
    const session = await requireSession()
    await reverseJournal(session, journalId, reason)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reverse journal." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

/** P1 §31. `year`/`month` identify the calendar month (1-12); see periods.ts's own doc comment for why closing never accepts an override. */
export async function closePeriodAction(year: number, month: number, reason: string): Promise<ActionState> {
  try {
    const session = await requireSession()
    await closePeriod(session, { year, month, reason })
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to close period." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function reopenPeriodAction(periodId: string, reason: string): Promise<ActionState> {
  try {
    const session = await requireSession()
    await reopenPeriod(session, periodId, reason)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to reopen period." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function retryAccountingExceptionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const eventId = String(formData.get("eventId") ?? "")
  try {
    const session = await requireSession()
    await retryAccountingException(session, eventId)
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to retry." }
  }
  revalidatePath("/accounting")
  return { success: true }
}

export async function sweepAccountingExceptionsAction(): Promise<ActionState & { recovered?: number; processed?: number }> {
  try {
    const session = await requireSession()
    const result = await sweepAccountingExceptions(session)
    revalidatePath("/accounting")
    return { success: true, ...result }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to sweep." }
  }
}

/**
 * P2 §6: Business Transaction → Journal → Journal Lines → Source Reference,
 * fetched only when a journal's detail dialog is actually opened (see
 * JournalDetailDialog) — not embedded in the journals list's own initial
 * page load, which would turn every page view into N extra source-lookup
 * queries for rows nobody inspects.
 */
export async function getJournalTraceAction(journalId: string) {
  const session = await requireSession()
  const { source, related } = await getJournalTrace(session, journalId)
  return {
    source,
    related: related.map((r) => ({
      ...r,
      journalDate: formatDateTime(r.journalDate),
      referenceTypeLabel: REFERENCE_TYPE_LABELS[r.referenceType] ?? r.referenceType.replace(/_/g, " "),
    })),
  }
}
