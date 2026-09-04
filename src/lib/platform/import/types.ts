import "server-only"
import type { Prisma } from "@/generated/prisma/client"
import type { SessionContext } from "@/lib/auth/session"

/** P4.6 §43's own stable error-code catalog — kept open (a plain string, not
 * an enum) since new importers may need a narrow, entity-specific code, but
 * every existing importer should reuse one of these where it genuinely fits. */
export const IMPORT_ERROR_CODES = [
  "REQUIRED_FIELD",
  "INVALID_DATE",
  "INVALID_NUMBER",
  "INVALID_ENUM",
  "INVALID_EMAIL",
  "TOO_LONG",
  "DUPLICATE",
  "DUPLICATE_IN_FILE",
  "UNKNOWN_BRANCH",
  "UNKNOWN_DEPARTMENT",
  "UNKNOWN_PRODUCT",
  "UNKNOWN_SUPPLIER",
  "UNKNOWN_PROVIDER",
  "UNKNOWN_REFERENCE",
  "INVALID_REFERENCE",
  "BUSINESS_RULE",
] as const
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number] | (string & {})

export type RowIssue = { field?: string; code: ImportErrorCode; message: string }

export type ParsedRow<T> = {
  rowNumber: number // 1-based, matching a spreadsheet's own row numbers (header = row 1, first data row = row 2)
  normalized: T | null // present only when issues is empty
  issues: RowIssue[]
  duplicate: boolean
  duplicateReason?: string
}

export type ImportContext = {
  session: SessionContext
  organizationId: string
  branchId?: string | null
}

/**
 * One reusable shape every entity importer implements (P4.6 §10's own "one
 * import type, one normalization/validation/duplicate/commit set" — not a
 * bespoke parser per entity). `commitBatch` receives only rows already
 * proven valid and non-duplicate; it owns exactly the entity's own create
 * logic (which existing domain primitive to call, in what order) and
 * nothing about parsing/validation/duplicate detection.
 */
export type ImporterDefinition<T> = {
  type: string
  templateVersion: string
  label: string
  requiredHeaders: string[]
  optionalHeaders: string[]
  helpText: string[]
  parseRow: (raw: Record<string, string>, rowNumber: number, ctx: ImportContext) => Promise<{ normalized: T | null; issues: RowIssue[] }>
  /** Mutates each row's `duplicate`/`duplicateReason` in place — batched (one query against existing data + in-file dedup), not per-row. */
  detectDuplicates: (rows: ParsedRow<T>[], ctx: ImportContext) => Promise<void>
  /** Commits one batch of already-valid, already-non-duplicate rows inside an open transaction. Returns how many were actually created (a row may still self-skip for a reason only knowable at commit time, e.g. a race). */
  commitBatch: (tx: Prisma.TransactionClient, rows: ParsedRow<T>[], ctx: ImportContext, jobId: string) => Promise<{ imported: number; skipped: number }>
}

export type DryRunSummary = {
  type: string
  templateVersion: string
  fileName: string
  totalRows: number
  validRows: number
  invalidRows: number
  duplicateRows: number
  /** First ~50 rows only (P4.6 §57) — never the full set. */
  preview: { rowNumber: number; status: "valid" | "invalid" | "duplicate"; summary: string; issues: RowIssue[] }[]
}
