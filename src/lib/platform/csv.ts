import "server-only"

/**
 * P4.7 §33/§34 — the one shared CSV-writer implementation for every place
 * this app *generates* a downloadable file: P4.6's import templates/error
 * reports (platform/import/csv.ts re-exports from here) and every P4.7
 * report/data-portability export (analytics/csv.ts re-exports from here
 * too). Before this phase, P4.6's import-side writer already had
 * formula-injection protection but analytics/csv.ts's report-export writer
 * did not — this promotes the one correct implementation instead of leaving
 * two, only one of which was safe (see BACKLOG.md's own "analytics/csv.ts
 * has no formula-injection protection" finding, logged during P4.6, closed
 * here).
 *
 * Formula-injection protection: a cell beginning with `=`, `+`, `-`, or `@`
 * is prefixed with a single quote, which every common spreadsheet
 * application treats as "force plain text" rather than a formula trigger.
 * This is purely export-time display safety — it never touches how a value
 * is parsed on import or stored in the database.
 */
export function escapeCsvFormulaInjection(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = value instanceof Date ? value.toISOString() : String(value)
  const safe = escapeCsvFormulaInjection(text)
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`
  return safe
}

/** Prepended when `bom: true` — makes Excel (Windows especially) reliably detect UTF-8 rather than guessing a legacy codepage, which is what actually breaks non-Latin text (Arabic/Urdu names, Unicode addresses) on open. Every other reader (LibreOffice, Google Sheets, Numbers, `Papa.parse`) already ignores or strips a leading BOM. */
const UTF8_BOM = "﻿"

/**
 * Renders rows to CSV text with formula-injection escaping on every cell.
 * `bom: true` for a file meant to be opened directly in Excel (most report
 * exports); `trailingNewline: true` preserves platform/import/csv.ts's
 * original template/error-report shape (a trailing CRLF after the last
 * row) for its own two existing callers.
 */
export function toCsv(headers: string[], rows: unknown[][], opts?: { bom?: boolean; trailingNewline?: boolean }): string {
  const lines = [headers.map(csvCell).join(",")]
  for (const row of rows) lines.push(row.map(csvCell).join(","))
  const body = lines.join("\r\n") + (opts?.trailingNewline ? "\r\n" : "")
  return (opts?.bom ? UTF8_BOM : "") + body
}
