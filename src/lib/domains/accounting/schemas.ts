import { z } from "zod"

const emptyToNull = (v: unknown) => (v === "" ? null : v)

export const accountTypes = ["asset", "liability", "equity", "revenue", "expense"] as const

export const chartOfAccountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  type: z.enum(accountTypes),
  parentAccountId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
})
export type ChartOfAccountInput = z.infer<typeof chartOfAccountSchema>

export const postingIntents = [
  "cash",
  "card",
  "bank",
  "online",
  "insurance",
  "credit",
  "other",
  "accounts_receivable",
  "revenue",
  "tax_payable",
  "unearned_revenue",
  "inventory_asset",
  "accounts_payable",
  "expense_default",
  "salary_expense",
  "payroll_payable",
] as const

export const accountMappingSchema = z.object({
  branchId: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
  intent: z.enum(postingIntents),
  accountId: z.uuid(),
})
export type AccountMappingInput = z.infer<typeof accountMappingSchema>

export const expenseSchema = z.object({
  branchId: z.uuid(),
  expenseAccountId: z.uuid(),
  description: z.string().min(1).max(300),
  amount: z.coerce.number().positive().max(9999999),
  paidVia: z.enum(["cash", "card", "bank", "online", "insurance", "credit", "other"]),
  expenseDate: z.coerce.date(),
})
export type ExpenseInput = z.infer<typeof expenseSchema>

export const manualJournalLineSchema = z.object({
  accountId: z.uuid(),
  debit: z.coerce.number().min(0).max(9999999).default(0),
  credit: z.coerce.number().min(0).max(9999999).default(0),
  description: z.preprocess(emptyToNull, z.string().max(300).nullable().optional()),
})

export const manualJournalSchema = z.object({
  branchId: z.uuid(),
  journalDate: z.coerce.date(),
  description: z.string().min(1).max(300),
  lines: z
    .array(manualJournalLineSchema)
    .min(2, "A journal needs at least two lines")
    .refine((lines) => lines.every((l) => (l.debit > 0) !== (l.credit > 0)), {
      message: "Each line must be either a debit or a credit, not both or neither",
    })
    .refine(
      (lines) => {
        const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0)
        const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0)
        return Math.abs(totalDebit - totalCredit) < 0.01
      },
      { message: "Total debits must equal total credits" }
    ),
})
export type ManualJournalInput = z.infer<typeof manualJournalSchema>
