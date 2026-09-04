import "server-only"

// P4.7 §33: was this file's own weaker writer (quoting only, no
// formula-injection escaping — the exact gap BACKLOG.md flagged during
// P4.6). Re-exported unchanged from the one shared writer now used by every
// CSV this app generates; behavior (headers/rows joined with CRLF, no
// trailing terminator, Date -> ISO 8601) is identical to before except every
// cell is now also formula-injection-safe — csv.test.ts's existing
// assertions all still hold.
export { toCsv } from "@/lib/platform/csv"
