/** Age is always calculated from DOB at read time, never stored (spec.md §9). */
export function calculateAge(dob: Date): number {
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const monthDiff = today.getMonth() - dob.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--
  }
  return age
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date)
}

export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date)
}

/**
 * Formats a Date as a local YYYY-MM-DD for use in URL query params. Never use
 * `date.toISOString().slice(0, 10)` for this — it converts to UTC first, which
 * silently shifts the date by a day whenever the server's local timezone isn't
 * UTC (e.g. a Dubai-hosted server at local midnight is still the previous day
 * in UTC). This stays in local-time components throughout, matching how the
 * param is parsed back with `new Date(\`${value}T00:00:00\`)`.
 */
export function toDateParam(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * P4.7 §44/§45 — the shared "Date Range Rule" pair every report/export date
 * filter should build on: `from` is the inclusive beginning of a local
 * calendar date, `to` is the inclusive end. Both are constructed from local
 * Date components (never a raw millisecond offset, never a trailing `Z`
 * that would reinterpret the boundary as UTC) — the same discipline
 * `toDateParam`'s own doc comment already establishes for this codebase, so
 * a "From 2026-09-01 To 2026-09-30" filter means exactly what it says
 * regardless of server timezone, and never silently shifts or drops a day.
 * Prefer these over ad hoc `` `${value}T00:00:00` ``/`` `${value}T23:59:59` ``
 * string concatenation at each call site.
 */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

export function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

/** Parses a `YYYY-MM-DD` query-param value as a *local* calendar date at the given time-of-day boundary — never `new Date(value)` directly, which treats a bare date string as UTC and can shift it a day in a non-UTC server timezone. Returns `undefined` for a missing/invalid value. */
export function parseLocalDateParam(value: string | undefined | null, boundary: "start" | "end"): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return undefined
  return boundary === "start" ? startOfLocalDay(parsed) : endOfLocalDay(parsed)
}

/**
 * P3.1 §17: a derived, server-rendered snapshot ("Waiting 8 min"), never a
 * client-side ticking timer and never a stored elapsed value — recomputed
 * from `since` (typically `QueueEntry.checkedInAt`) against `now` (defaults
 * to render time) on every request/action-triggered refresh, the same way
 * every other "as of now" figure in this app is computed. `until` lets a
 * caller measure a *closed* interval (e.g. how long someone waited before
 * being called) instead of an open-ended "still waiting" one.
 */
export function formatWaitingMinutes(since: Date, until: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((until.getTime() - since.getTime()) / 60_000))
  if (minutes < 1) return "Just now"
  return `${minutes} min`
}
