import { describe, it, expect } from "vitest"
import { buildPartialQrTlv, buildFullQrTlv } from "@/lib/domains/einvoicing/qr-code"

describe("P5.5-Z: QR TLV encoding", () => {
  const fields = {
    sellerName: "Avant Demo Clinic KSA",
    vatRegistrationNumber: "300000000000003",
    invoiceTimestamp: "2026-09-25T12:00:00Z",
    invoiceTotalWithVat: "115.00",
    vatTotal: "15.00",
    invoiceHashBytes: Buffer.alloc(32, 7),
  }

  it("encodes tags 1-6 as Tag(1 byte)+Length(1 byte)+Value, per the spec's own TLV table", () => {
    const base64 = buildPartialQrTlv(fields)
    const bytes = Buffer.from(base64, "base64")

    let offset = 0
    const expected: [number, Buffer][] = [
      [1, Buffer.from(fields.sellerName, "utf8")],
      [2, Buffer.from(fields.vatRegistrationNumber, "utf8")],
      [3, Buffer.from(fields.invoiceTimestamp, "utf8")],
      [4, Buffer.from(fields.invoiceTotalWithVat, "utf8")],
      [5, Buffer.from(fields.vatTotal, "utf8")],
      [6, fields.invoiceHashBytes],
    ]
    for (const [tag, value] of expected) {
      expect(bytes[offset]).toBe(tag)
      expect(bytes[offset + 1]).toBe(value.length)
      expect(bytes.subarray(offset + 2, offset + 2 + value.length).equals(value)).toBe(true)
      offset += 2 + value.length
    }
    expect(offset).toBe(bytes.length)
  })

  it("tag 6 (hash) carries exactly 32 raw bytes, not a base64-encoded string", () => {
    const base64 = buildPartialQrTlv(fields)
    const bytes = Buffer.from(base64, "base64")
    // Locate tag 6 by walking the TLV stream (tags 1-5 all precede it).
    let offset = 0
    for (let i = 0; i < 5; i++) {
      offset += 2 + bytes[offset + 1]
    }
    expect(bytes[offset]).toBe(6)
    expect(bytes[offset + 1]).toBe(32)
  })

  it("throws rather than silently truncating when a field exceeds the 1-byte length limit (255 bytes)", () => {
    expect(() => buildPartialQrTlv({ ...fields, sellerName: "x".repeat(256) })).toThrow(/255 bytes/)
  })

  it("throws rather than emitting an over-length QR payload past ZATCA's 700-character base64 limit", () => {
    // Each field is individually capped at 255 bytes (the other test above),
    // so exceeding 700 combined requires several large fields at once, not
    // one field alone.
    expect(() =>
      buildPartialQrTlv({ ...fields, sellerName: "x".repeat(255), vatRegistrationNumber: "y".repeat(255), invoiceTimestamp: "z".repeat(255) })
    ).toThrow(/700/)
  })

  it("buildFullQrTlv (tags 7-9) refuses to fabricate a signature without a real ZATCA private key", () => {
    expect(() => buildFullQrTlv()).toThrow(/private key/)
  })
})
