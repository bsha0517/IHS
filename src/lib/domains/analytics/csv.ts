import "server-only"

/** RFC 4180-ish CSV serialization — quotes any field containing a comma, quote, or newline. */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = value instanceof Date ? value.toISOString() : String(value)
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(",")]
  for (const row of rows) lines.push(row.map(csvField).join(","))
  return lines.join("\r\n")
}
