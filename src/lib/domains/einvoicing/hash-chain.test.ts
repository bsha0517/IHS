import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import { FIRST_INVOICE_PREVIOUS_HASH, computeInvoiceHash, stripHashExclusions } from "@/lib/domains/einvoicing/hash-chain"

describe("P5.5-Z: hash-chain", () => {
  it("FIRST_INVOICE_PREVIOUS_HASH decodes to the lowercase hex SHA256 digest of the character '0' (the spec's exact literal)", () => {
    const decoded = Buffer.from(FIRST_INVOICE_PREVIOUS_HASH, "base64").toString("utf8")
    expect(decoded).toBe(createHash("sha256").update("0").digest("hex"))
  })

  it("stripHashExclusions removes UBLExtensions, the QR AdditionalDocumentReference, and Signature blocks", () => {
    const xml =
      "<Invoice><ext:UBLExtensions><x>1</x></ext:UBLExtensions>" +
      "<cbc:ID>INV-1</cbc:ID>" +
      "<cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><x>keep</x></cac:AdditionalDocumentReference>" +
      "<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><x>drop</x></cac:AdditionalDocumentReference>" +
      "<cac:Signature><x>sig</x></cac:Signature></Invoice>"
    const stripped = stripHashExclusions(xml)
    expect(stripped).not.toContain("ext:UBLExtensions")
    expect(stripped).not.toContain("QR</cbc:ID><x>drop</x>")
    expect(stripped).not.toContain("cac:Signature")
    expect(stripped).toContain("PIH</cbc:ID><x>keep</x>") // non-QR AdditionalDocumentReference must survive
    expect(stripped).toContain("<cbc:ID>INV-1</cbc:ID>")
  })

  it("computeInvoiceHash produces a base64 string decoding to exactly 32 bytes (SHA256)", () => {
    const xml = "<Invoice><cbc:ID>INV-1</cbc:ID></Invoice>"
    const hash = computeInvoiceHash(xml)
    expect(Buffer.from(hash, "base64").length).toBe(32)
  })

  it("computeInvoiceHash is deterministic for identical input and differs for different input", () => {
    const xmlA = "<Invoice><cbc:ID>INV-1</cbc:ID></Invoice>"
    const xmlB = "<Invoice><cbc:ID>INV-2</cbc:ID></Invoice>"
    expect(computeInvoiceHash(xmlA)).toBe(computeInvoiceHash(xmlA))
    expect(computeInvoiceHash(xmlA)).not.toBe(computeInvoiceHash(xmlB))
  })

  it("computeInvoiceHash ignores whitespace-only differences between tags (matches its own normalization)", () => {
    const xmlA = "<Invoice><cbc:ID>INV-1</cbc:ID></Invoice>"
    const xmlB = "<Invoice>\n  <cbc:ID>INV-1</cbc:ID>\n</Invoice>"
    expect(computeInvoiceHash(xmlA)).toBe(computeInvoiceHash(xmlB))
  })
})
