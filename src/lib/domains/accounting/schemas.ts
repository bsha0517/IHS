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

// P3.9 §9-10: this used to list only 16 of the real 22 PostingIntent enum
// values (prisma/schema.prisma) — missing cogs, inventory_write_off,
// inventory_adjustment_gain, goods_received_not_invoiced, recoverable_tax,
// and fixed_asset. Since this array is what `accountMappingSchema` (and,
// via a separately-duplicated local copy, the Account Mappings UI) accepts,
// those 6 intents could never be configured or corrected through the
// product at all — an org whose seeded default for one of them ever needed
// changing (or was missing at a branch level) had no path but direct DB
// access, guaranteeing a permanent outbox dead-letter for every goods
// receipt/inventory write-off/COGS posting/asset acquisition/taxed supplier
// invoice in the meantime. Single source of truth now — this file's own
// array IS the Prisma enum's full value list; the UI imports this rather
// than keeping its own copy.
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
  "cogs",
  "inventory_write_off",
  "inventory_adjustment_gain",
  "goods_received_not_invoiced",
  "recoverable_tax",
  "fixed_asset",
] as const

/** P3.9 §9: friendly labels for the Account Mappings UI — `replace(/_/g," ")` alone still reads as a raw identifier for several of these (e.g. "goods received not invoiced", "cogs"). Every key here is a real PostingIntent value; postingIntents.length === Object.keys(POSTING_INTENT_LABELS).length is asserted by a test so a newly-added enum value can't silently ship without a label. */
export const POSTING_INTENT_LABELS: Record<(typeof postingIntents)[number], string> = {
  cash: "Cash",
  card: "Card",
  bank: "Bank Transfer",
  online: "Online Payment",
  insurance: "Insurance",
  credit: "Credit (Patient Account)",
  other: "Other Tender",
  accounts_receivable: "Accounts Receivable",
  revenue: "Revenue",
  tax_payable: "Tax Payable",
  unearned_revenue: "Unearned Revenue",
  inventory_asset: "Inventory Asset",
  accounts_payable: "Accounts Payable",
  expense_default: "Expense (Default)",
  salary_expense: "Salary Expense",
  payroll_payable: "Payroll Payable",
  cogs: "Cost of Goods Sold",
  inventory_write_off: "Inventory Write-off",
  inventory_adjustment_gain: "Inventory Adjustment Gain",
  goods_received_not_invoiced: "Goods Received Not Invoiced",
  recoverable_tax: "Recoverable Tax",
  fixed_asset: "Fixed Asset",
}

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
