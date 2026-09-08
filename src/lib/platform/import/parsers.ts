import "server-only"
import type { RowIssue } from "@/lib/platform/import/types"

/** Shared field-level parsing helpers every importer uses — one place for
 * P4.6's own date/enum/number/email rules (§51/§54/§55) rather than each
 * importer reinventing them slightly differently. Each returns `{value,
 * error}` — never throws — so a row's `parseRow` can collect every issue
 * on that row in one pass instead of stopping at the first. */

export function trimOrNull(raw: string | undefined): string | null {
  const t = raw?.trim()
  return t ? t : null
}

export function requiredString(raw: string | undefined, field: string, maxLength = 200): { value: string | null; error: RowIssue | null } {
  const v = raw?.trim() ?? ""
  if (!v) return { value: null, error: { field, code: "REQUIRED_FIELD", message: `${field} is required.` } }
  if (v.length > maxLength) return { value: null, error: { field, code: "TOO_LONG", message: `${field} must be ${maxLength} characters or fewer.` } }
  return { value: v, error: null }
}

export function optionalString(raw: string | undefined, field: string, maxLength = 500): { value: string | null; error: RowIssue | null } {
  const v = trimOrNull(raw)
  if (v === null) return { value: null, error: null }
  if (v.length > maxLength) return { value: null, error: { field, code: "TOO_LONG", message: `${field} must be ${maxLength} characters or fewer.` } }
  return { value: v, error: null }
}

/** P4.6 §51 — only the unambiguous ISO calendar-date format is accepted; anything else (including a locale-ambiguous DD/MM vs MM/DD) is rejected outright rather than guessed. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export function requiredDate(raw: string | undefined, field: string): { value: Date | null; error: RowIssue | null } {
  const v = raw?.trim() ?? ""
  if (!v) return { value: null, error: { field, code: "REQUIRED_FIELD", message: `${field} is required.` } }
  if (!DATE_RE.test(v)) return { value: null, error: { field, code: "INVALID_DATE", message: `${field}: invalid date. Expected YYYY-MM-DD.` } }
  // P4.6 §52 — a calendar date (DOB, hire date, expiry) must never shift
  // across a timezone boundary. Constructed at UTC noon specifically so no
  // timezone conversion anywhere in the app can push it to the adjacent day.
  const [y, m, d] = v.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { value: null, error: { field, code: "INVALID_DATE", message: `${field}: "${v}" is not a real calendar date.` } }
  }
  return { value: date, error: null }
}

export function optionalDate(raw: string | undefined, field: string): { value: Date | null; error: RowIssue | null } {
  const v = raw?.trim() ?? ""
  if (!v) return { value: null, error: null }
  return requiredDate(v, field)
}

export function requiredNumber(raw: string | undefined, field: string, opts: { min?: number; max?: number; integer?: boolean } = {}): { value: number | null; error: RowIssue | null } {
  const v = raw?.trim() ?? ""
  if (!v) return { value: null, error: { field, code: "REQUIRED_FIELD", message: `${field} is required.` } }
  const n = Number(v)
  if (!Number.isFinite(n)) return { value: null, error: { field, code: "INVALID_NUMBER", message: `${field}: "${v}" is not a valid number.` } }
  if (opts.integer && !Number.isInteger(n)) return { value: null, error: { field, code: "INVALID_NUMBER", message: `${field} must be a whole number.` } }
  if (opts.min != null && n < opts.min) return { value: null, error: { field, code: "INVALID_NUMBER", message: `${field} must be at least ${opts.min}.` } }
  if (opts.max != null && n > opts.max) return { value: null, error: { field, code: "INVALID_NUMBER", message: `${field} must be at most ${opts.max}.` } }
  return { value: n, error: null }
}

export function optionalNumber(raw: string | undefined, field: string, opts: { min?: number; max?: number; integer?: boolean } = {}): { value: number | null; error: RowIssue | null } {
  const v = raw?.trim() ?? ""
  if (!v) return { value: null, error: null }
  return requiredNumber(v, field, opts)
}

export function requiredEnum<T extends string>(raw: string | undefined, field: string, allowed: readonly T[]): { value: T | null; error: RowIssue | null } {
  const v = raw?.trim().toLowerCase() ?? ""
  if (!v) return { value: null, error: { field, code: "REQUIRED_FIELD", message: `${field} is required.` } }
  const match = allowed.find((a) => a.toLowerCase() === v)
  if (!match) return { value: null, error: { field, code: "INVALID_ENUM", message: `${field}: "${raw}" is not one of: ${allowed.join(", ")}.` } }
  return { value: match, error: null }
}

export function optionalEmail(raw: string | undefined, field: string): { value: string | null; error: RowIssue | null } {
  const v = raw?.trim().toLowerCase() ?? ""
  if (!v) return { value: null, error: null }
  // P4.6 §54 — same trim+lowercase this app already applies elsewhere (auth/service.ts's own login normalization); a conservative, not-overly-strict shape check.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { value: null, error: { field, code: "INVALID_EMAIL", message: `${field}: "${raw}" is not a valid email address.` } }
  return { value: v, error: null }
}

/** P4.6 §53 — conservative: preserve the original value verbatim (trimmed), no country-assumption normalization. */
export function optionalPhone(raw: string | undefined, field: string, maxLength = 30): { value: string | null; error: RowIssue | null } {
  return optionalString(raw, field, maxLength)
}

/** P4.9.2 — accepts true/false/yes/no/1/0 case-insensitively; blank uses `defaultValue`. Anything else is INVALID_ENUM rather than guessed (same "never cast arbitrary strings" discipline as `requiredEnum`). */
const TRUE_VALUES = new Set(["true", "yes", "1"])
const FALSE_VALUES = new Set(["false", "no", "0"])
export function optionalBoolean(raw: string | undefined, field: string, defaultValue: boolean): { value: boolean | null; error: RowIssue | null } {
  const v = raw?.trim().toLowerCase() ?? ""
  if (!v) return { value: defaultValue, error: null }
  if (TRUE_VALUES.has(v)) return { value: true, error: null }
  if (FALSE_VALUES.has(v)) return { value: false, error: null }
  return { value: null, error: { field, code: "INVALID_ENUM", message: `${field}: "${raw}" is not one of: true, false, yes, no, 1, 0.` } }
}
