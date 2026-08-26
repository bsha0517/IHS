import { describe, it, expect } from "vitest"
import { toCsv } from "@/lib/domains/analytics/csv"

describe("toCsv", () => {
  it("joins headers and rows with commas and CRLF line endings", () => {
    expect(toCsv(["A", "B"], [["x", 1]])).toBe("A,B\r\nx,1")
  })

  it("quotes a field containing a comma", () => {
    expect(toCsv(["A"], [["a, b"]])).toBe('A\r\n"a, b"')
  })

  it("quotes and escapes a field containing a double quote", () => {
    expect(toCsv(["A"], [['say "hi"']])).toBe('A\r\n"say ""hi"""')
  })

  it("quotes a field containing a newline", () => {
    expect(toCsv(["A"], [["line1\nline2"]])).toBe('A\r\n"line1\nline2"')
  })

  it("renders null/undefined as an empty field, not the string 'null'/'undefined'", () => {
    expect(toCsv(["A", "B"], [[null, undefined]])).toBe("A,B\r\n,")
  })

  it("serializes a Date as ISO 8601", () => {
    const d = new Date("2026-01-15T10:00:00.000Z")
    expect(toCsv(["A"], [[d]])).toBe("A\r\n2026-01-15T10:00:00.000Z")
  })

  it("produces just the header row for an empty row set", () => {
    expect(toCsv(["A", "B"], [])).toBe("A,B")
  })
})
