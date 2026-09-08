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
/**
 * P4.9.2 §54/§55 — the onboarding UI groups importers logically rather than
 * listing 16+ in one flat grid; these are exactly the groups §54 names.
 */
export const IMPORTER_GROUPS = ["Clinical Catalogues", "Operations", "Commercial", "Finance", "Inventory", "Patients"] as const
export type ImporterGroup = (typeof IMPORTER_GROUPS)[number]

export type ImporterDefinition<T> = {
  type: string
  templateVersion: string
  label: string
  requiredHeaders: string[]
  optionalHeaders: string[]
  helpText: string[]
  /** P4.9.2 §54 — which section of the onboarding page this importer's card renders under. */
  group: ImporterGroup
  /**
   * P4.9.2 §55 — set only on the importers that genuinely warrant it
   * (Opening Inventory, Payroll Runs, Chart of Accounts, Users): visually
   * distinguishes them and (paired with `confirmationText`) requires an
   * explicit acknowledgement before Commit is enabled, not just Dry Run.
   */
  riskLevel?: "high"
  /** Required when `riskLevel` is set — the exact checkbox label the operator must tick before committing (§25: explain the actual risk, not a generic scary warning). */
  confirmationText?: string
  parseRow: (raw: Record<string, string>, rowNumber: number, ctx: ImportContext) => Promise<{ normalized: T | null; issues: RowIssue[] }>
  /** Mutates each row's `duplicate`/`duplicateReason` in place — batched (one query against existing data + in-file dedup), not per-row. */
  detectDuplicates: (rows: ParsedRow<T>[], ctx: ImportContext) => Promise<void>
  /** Commits one batch of already-valid, already-non-duplicate rows inside an open transaction. Returns how many were actually created (a row may still self-skip for a reason only knowable at commit time, e.g. a race). `prepared` is whatever `prepareBatch` (below) returned for this same batch, keyed by `rowNumber` — undefined for importers that don't define one. */
  commitBatch: (tx: Prisma.TransactionClient, rows: ParsedRow<T>[], ctx: ImportContext, jobId: string, prepared?: Map<number, unknown>) => Promise<{ imported: number; skipped: number }>
  /**
   * P4.9.2 — optional, additive: runs BEFORE the batch's transaction opens,
   * for genuinely CPU-bound per-row work that must never run inside an open
   * DB transaction, where doing so risks exceeding the transaction's own
   * timeout for a large-but-realistic batch. The one real case this closes:
   * Users' per-row `argon2id` password hashing (deliberately slow — that is
   * the whole point of the algorithm) was timing out a 200-row commit
   * transaction outright at the default interactive-transaction timeout,
   * found via this phase's own 1,000-row performance test, not
   * theoretical. Hashing happens here, in parallel, before any row's
   * transaction opens; `commitBatch` then just reads the precomputed
   * result — the transaction itself does no CPU-bound work, only DB calls.
   */
  prepareBatch?: (rows: ParsedRow<T>[], ctx: ImportContext) => Promise<Map<number, unknown>>
  /**
   * P4.9.2 §41 — optional, additive: for importers where the generic
   * total/valid/warning/duplicate/invalid counts alone don't convey the
   * real domain impact (Opening Inventory's total stock value, Payroll's
   * gross/net, Chart of Accounts' root/child account counts, Users' role
   * breakdown), this computes a short, ordered list of extra labeled
   * figures shown in the Dry Run review step. Computed only over rows that
   * would actually commit (valid, non-duplicate) — a duplicate/invalid
   * row's numbers were never going to be imported.
   */
  computeDomainSummary?: (rows: ParsedRow<T>[]) => { label: string; value: string }[]
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
  /** P4.9.2 §41 — present only when the importer defines `computeDomainSummary`. */
  domainSummary?: { label: string; value: string }[]
}
