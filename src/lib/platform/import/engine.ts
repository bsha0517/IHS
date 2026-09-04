import "server-only"
import { createHash } from "node:crypto"
import { db } from "@/lib/db"
import { log } from "@/lib/platform/logger"
import { auditFromSession } from "@/lib/platform/audit"
import { parseCsv, CsvParseError, MAX_FILE_SIZE_BYTES } from "@/lib/platform/import/csv"
import type { DryRunSummary, ImportContext, ImporterDefinition, ParsedRow } from "@/lib/platform/import/types"
import type { SessionContext } from "@/lib/auth/session"

/**
 * P4.6's reusable import engine — the "Template → Upload → Parse →
 * Normalize → Dry Run → Validate → Duplicate/Conflict Analysis → Preview →
 * Explicit Commit → Result Report → Audit Trail" workflow (§2), implemented
 * once, driven by an `ImporterDefinition<T>` per entity type (§10).
 *
 * Deliberately never persists the uploaded file (§13 Option A — parse in
 * request memory only). `runCommit` requires the SAME file content to be
 * resubmitted, and verifies its SHA-256 against the hash `runDryRun` stored
 * on the ImportJob (§38's own "commit token / validation freshness") before
 * touching a single domain row, and always re-runs full validation from
 * that resubmitted content — never trusting a client-held row
 * classification from the earlier dry-run response (§38's own explicit
 * instruction).
 */

const PREVIEW_ROW_LIMIT = 50 // P4.6 §57 — never render/store the full row set as a "preview"
const MAX_STORED_ERRORS = 1000 // bounds a pathological all-rows-invalid file from writing 10,000 error rows
const COMMIT_BATCH_SIZE = 200 // P4.6 §39/§69 — one transaction per batch, not one 10,000-row transaction

export class ImportValidationError extends Error {}

function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function assertFileSize(fileText: string) {
  const bytes = Buffer.byteLength(fileText, "utf8")
  if (bytes > MAX_FILE_SIZE_BYTES) {
    throw new ImportValidationError(`File is ${(bytes / (1024 * 1024)).toFixed(1)} MB, which exceeds the ${(MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)} MB limit.`)
  }
}

async function validateAllRows<T>(
  definition: ImporterDefinition<T>,
  fileText: string,
  ctx: ImportContext
): Promise<{ rows: ParsedRow<T>[]; headerError?: string }> {
  let parsed
  try {
    parsed = parseCsv(fileText)
  } catch (e) {
    if (e instanceof CsvParseError) return { rows: [], headerError: e.message }
    throw e
  }

  const missing = definition.requiredHeaders.filter((h) => !parsed.headers.includes(h))
  if (missing.length > 0) {
    return { rows: [], headerError: `Missing required column(s): ${missing.join(", ")}.` }
  }

  const rows: ParsedRow<T>[] = []
  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNumber = i + 2 // header is row 1
    const { normalized, issues } = await definition.parseRow(parsed.rows[i], rowNumber, ctx)
    rows.push({ rowNumber, normalized: issues.length === 0 ? normalized : null, issues, duplicate: false })
  }

  await definition.detectDuplicates(rows, ctx)
  return { rows }
}

function summarize<T>(rows: ParsedRow<T>[]): { validRows: number; invalidRows: number; duplicateRows: number } {
  let validRows = 0,
    invalidRows = 0,
    duplicateRows = 0
  for (const r of rows) {
    if (r.issues.length > 0) invalidRows++
    else if (r.duplicate) duplicateRows++
    else validRows++
  }
  return { validRows, invalidRows, duplicateRows }
}

function buildPreview<T>(rows: ParsedRow<T>[]): DryRunSummary["preview"] {
  return rows.slice(0, PREVIEW_ROW_LIMIT).map((r) => ({
    rowNumber: r.rowNumber,
    status: r.issues.length > 0 ? "invalid" : r.duplicate ? "duplicate" : "valid",
    summary: r.normalized ? summarizeNormalized(r.normalized) : "(could not parse)",
    issues: r.issues,
  }))
}

function summarizeNormalized(value: unknown): string {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    const parts = ["name", "firstName", "lastName", "code", "sku", "companyName"]
      .map((k) => obj[k])
      .filter((v): v is string => typeof v === "string" && v.length > 0)
    if (parts.length > 0) return parts.join(" ")
  }
  return "row"
}

export async function runDryRun<T>(
  session: SessionContext,
  definition: ImporterDefinition<T>,
  input: { fileText: string; fileName: string; branchId?: string | null }
): Promise<{ jobId: string; summary: DryRunSummary }> {
  assertFileSize(input.fileText)
  const ctx: ImportContext = { session, organizationId: session.user.organizationId, branchId: input.branchId }
  const contentHash = hashContent(input.fileText)

  const { rows, headerError } = await validateAllRows(definition, input.fileText, ctx)

  if (headerError) {
    const job = await db.importJob.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId ?? null,
        type: definition.type,
        templateVersion: definition.templateVersion,
        status: "failed",
        fileName: input.fileName,
        contentHash,
        totalRows: 0,
        summary: { headerError },
        startedBy: session.user.id,
      },
    })
    log({ level: "warn", event: "import.dry_run.header_error", domain: "import", operation: "runDryRun", organizationId: session.user.organizationId, entityId: job.id, reference: definition.type, error: headerError })
    return {
      jobId: job.id,
      summary: { type: definition.type, templateVersion: definition.templateVersion, fileName: input.fileName, totalRows: 0, validRows: 0, invalidRows: 0, duplicateRows: 0, preview: [] },
    }
  }

  const counts = summarize(rows)
  const preview = buildPreview(rows)

  const job = await db.$transaction(async (tx) => {
    const created = await tx.importJob.create({
      data: {
        organizationId: session.user.organizationId,
        branchId: input.branchId ?? null,
        type: definition.type,
        templateVersion: definition.templateVersion,
        status: "validated",
        fileName: input.fileName,
        contentHash,
        totalRows: rows.length,
        validRows: counts.validRows,
        invalidRows: counts.invalidRows,
        duplicateRows: counts.duplicateRows,
        summary: { preview },
        startedBy: session.user.id,
      },
    })

    const invalidRows = rows.filter((r) => r.issues.length > 0).slice(0, MAX_STORED_ERRORS)
    if (invalidRows.length > 0) {
      await tx.importJobError.createMany({
        data: invalidRows.flatMap((r) => r.issues.map((issue) => ({ jobId: created.id, rowNumber: r.rowNumber, field: issue.field ?? null, errorCode: issue.code, message: issue.message }))),
      })
    }

    return created
  })

  log({ level: "info", event: "import.dry_run.completed", domain: "import", operation: "runDryRun", organizationId: session.user.organizationId, entityId: job.id, reference: definition.type })

  return {
    jobId: job.id,
    summary: { type: definition.type, templateVersion: definition.templateVersion, fileName: input.fileName, totalRows: rows.length, ...counts, preview },
  }
}

export type CommitResult = {
  status: "completed" | "failed"
  importedRows: number
  skippedRows: number
  invalidRows: number
  duplicateRows: number
  failedAtBatch?: number
  totalBatches?: number
}

export async function runCommit<T>(
  session: SessionContext,
  definition: ImporterDefinition<T>,
  input: { jobId: string; fileText: string }
): Promise<CommitResult> {
  const job = await db.importJob.findFirst({ where: { id: input.jobId, organizationId: session.user.organizationId } })
  if (!job) throw new ImportValidationError("Import job not found or does not belong to your organization.")
  if (job.type !== definition.type) throw new ImportValidationError("Import job type mismatch.")
  // P4.6 §40 — idempotency: a double-submit/retry of an already-completed
  // (or currently-processing) job is rejected outright, not silently
  // re-applied.
  if (job.status === "completed") throw new ImportValidationError("This import has already been committed.")
  if (job.status === "processing") throw new ImportValidationError("This import is already being processed.")
  if (job.status === "cancelled") throw new ImportValidationError("This import was cancelled.")
  if (job.status === "failed") throw new ImportValidationError("This import failed validation and cannot be committed — fix the file and start a new dry run.")

  assertFileSize(input.fileText)
  const contentHash = hashContent(input.fileText)
  if (contentHash !== job.contentHash) {
    throw new ImportValidationError("The uploaded file has changed since it was validated — start a new dry run with this file before committing.")
  }

  await db.importJob.update({ where: { id: job.id }, data: { status: "processing" } })

  const ctx: ImportContext = { session, organizationId: session.user.organizationId, branchId: job.branchId }
  // Never trusts the dry run's stored summary for what to commit (P4.6
  // §38) — re-validates the resubmitted content from scratch.
  const { rows, headerError } = await validateAllRows(definition, input.fileText, ctx)
  if (headerError) {
    await db.importJob.update({ where: { id: job.id }, data: { status: "failed", completedAt: new Date() } })
    throw new ImportValidationError(`Re-validation failed: ${headerError}`)
  }

  const committable = rows.filter((r) => r.issues.length === 0 && !r.duplicate)
  const counts = summarize(rows)
  const batches: ParsedRow<T>[][] = []
  for (let i = 0; i < committable.length; i += COMMIT_BATCH_SIZE) batches.push(committable.slice(i, i + COMMIT_BATCH_SIZE))

  let imported = 0
  let skipped = 0
  let failedAtBatch: number | undefined
  for (let b = 0; b < batches.length; b++) {
    try {
      const result = await db.$transaction(
        (tx) => definition.commitBatch(tx, batches[b], ctx, job.id),
        { timeout: 20_000, maxWait: 10_000 }
      )
      imported += result.imported
      skipped += result.skipped
    } catch (e) {
      failedAtBatch = b + 1
      log({
        level: "error",
        event: "import.commit.batch_failed",
        domain: "import",
        operation: "runCommit",
        organizationId: session.user.organizationId,
        entityId: job.id,
        reference: definition.type,
        error: e,
      })
      break
    }
  }

  const status = failedAtBatch ? "failed" : "completed"
  await db.importJob.update({
    where: { id: job.id },
    data: { status, importedRows: imported, skippedRows: skipped + counts.duplicateRows, completedAt: new Date() },
  })

  await auditFromSession(session, "commit", "import_job", job.id, {
    new: { type: definition.type, fileName: job.fileName, importedRows: imported, skippedRows: skipped + counts.duplicateRows, status },
  })

  log({
    level: status === "completed" ? "info" : "warn",
    event: "import.commit.completed",
    domain: "import",
    operation: "runCommit",
    organizationId: session.user.organizationId,
    entityId: job.id,
    reference: definition.type,
  })

  return {
    status,
    importedRows: imported,
    skippedRows: skipped + counts.duplicateRows,
    invalidRows: counts.invalidRows,
    duplicateRows: counts.duplicateRows,
    failedAtBatch,
    totalBatches: batches.length,
  }
}

export async function cancelImportJob(session: SessionContext, jobId: string): Promise<void> {
  const job = await db.importJob.findFirst({ where: { id: jobId, organizationId: session.user.organizationId } })
  if (!job) throw new ImportValidationError("Import job not found or does not belong to your organization.")
  if (job.status === "completed" || job.status === "processing") {
    throw new ImportValidationError("This import can no longer be cancelled — it has already started committing.")
  }
  await db.importJob.update({ where: { id: jobId }, data: { status: "cancelled", completedAt: new Date() } })
  await auditFromSession(session, "cancel", "import_job", jobId, { new: { type: job.type, fileName: job.fileName } })
}
