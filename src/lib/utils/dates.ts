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
