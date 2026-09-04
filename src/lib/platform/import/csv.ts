import "server-only"

/**
 * P4.6 §15/§68 — a small, dependency-free CSV parser/writer, deliberately
 * not a third-party library: this only ever reads plain data into string
 * cells (never evaluates a formula, never interprets HTML, never executes
 * anything), which is the actual safety property §15/§71 ask for, and is
 * simpler to audit than pulling in a general-purpose CSV package for it.
 */

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB — P4.6 §68's own example limit
export const MAX_ROWS = 10_000 // P4.6 §68's own example limit, excluding the header row
export const MAX_FIELD_LENGTH = 2000 // generous for any legitimate address/notes field, bounds a pathological single-cell payload

export class CsvParseError extends Error {}

export type ParsedCsv = {
  headers: string[]
  /** Each row is header-name -> raw string value (already trimmed of surrounding quotes, NOT yet business-normalized). */
  rows: Record<string, string>[]
}

/**
 * Splits one CSV document into headers + rows. Rejects (does not silently
 * truncate/ignore) anything that would make later steps ambiguous: a
 * duplicate header, a row with the wrong column count, a field/row/file
 * over its limit. UTF-8 BOM is stripped if present (P4.6 §15's own "UTF-8
 * with BOM" requirement) — everything else is plain UTF-8 text.
 */
export function parseCsv(rawText: string): ParsedCsv {
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText
  const records = splitRecords(text)
  if (records.length === 0) throw new CsvParseError("The file is empty.")

  const headers = records[0]
  if (headers.length === 0 || headers.every((h) => h.trim() === "")) {
    throw new CsvParseError("The file has no header row.")
  }
  const seen = new Set<string>()
  for (const h of headers) {
    const key = h.trim()
    if (key === "") throw new CsvParseError("The header row has a blank column name.")
    if (seen.has(key.toLowerCase())) throw new CsvParseError(`Duplicate column header: "${key}".`)
    seen.add(key.toLowerCase())
  }

  const dataRecords = records.slice(1).filter((r) => !(r.length === 1 && r[0] === "")) // drop a single trailing blank line
  if (dataRecords.length > MAX_ROWS) {
    throw new CsvParseError(`This file has ${dataRecords.length} data rows, which exceeds the maximum of ${MAX_ROWS}. Split it into smaller files.`)
  }

  const rows: Record<string, string>[] = dataRecords.map((record, i) => {
    if (record.length !== headers.length) {
      throw new CsvParseError(`Row ${i + 2} has ${record.length} column(s), expected ${headers.length} (matching the header row).`)
    }
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => {
      const value = record[idx]
      if (value.length > MAX_FIELD_LENGTH) {
        throw new CsvParseError(`Row ${i + 2}, column "${h.trim()}": value is too long (max ${MAX_FIELD_LENGTH} characters).`)
      }
      row[h.trim()] = value
    })
    return row
  })

  return { headers: headers.map((h) => h.trim()), rows }
}

/** RFC4180-ish tokenizer: handles quoted fields, embedded commas/newlines inside quotes, and `""` as an escaped quote. */
function splitRecords(text: string): string[][] {
  const records: string[][] = []
  let field = ""
  let record: string[] = []
  let inQuotes = false
  let i = 0
  const push = () => {
    record.push(field)
    field = ""
  }
  const pushRecord = () => {
    push()
    records.push(record)
    record = []
  }
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += c
      i += 1
      continue
    }
    if (c === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (c === ",") {
      push()
      i += 1
      continue
    }
    if (c === "\r") {
      i += 1
      continue // normalize CRLF/CR to the following \n handling
    }
    if (c === "\n") {
      pushRecord()
      i += 1
      continue
    }
    field += c
    i += 1
  }
  // Final field/record if the file doesn't end with a newline.
  if (field !== "" || record.length > 0) pushRecord()
  return records
}

// P4.7: the writer half (escaping + `toCsv`) now lives in the one shared
// `platform/csv.ts` (also used by every report/data-portability export) —
// re-exported here unchanged so P4.6's own two callers (the template route,
// the dry-run/commit error-report route) don't need to change their import.
export { escapeCsvFormulaInjection } from "@/lib/platform/csv"
import { toCsv as toCsvShared } from "@/lib/platform/csv"

/** Renders rows back to CSV text, applying formula-injection escaping to every cell — used for templates and downloadable dry-run/error reports. Preserves this module's original trailing-CRLF shape. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return toCsvShared(headers, rows, { trailingNewline: true })
}
