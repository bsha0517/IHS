import { describe, it, expect } from "vitest"
import { buildInvoiceXml, fillQrCode, type XmlInvoiceInput } from "@/lib/domains/einvoicing/xml-mapper"
import { computeInvoiceHash, FIRST_INVOICE_PREVIOUS_HASH } from "@/lib/domains/einvoicing/hash-chain"
import { buildPartialQrTlv } from "@/lib/domains/einvoicing/qr-code"

const SELLER = {
  enabled: true,
  vatRegistrationNumber: "300000000000003",
  sellerName: "Avant Demo Clinic KSA",
  buildingNumber: "1234",
  streetName: "King Fahd Road",
  district: "Al Olaya",
  city: "Riyadh",
  postalCode: "12211",
  additionalNumber: "6789",
  countryCode: "SA",
}

function baseInput(): XmlInvoiceInput {
  return {
    invoiceNumber: "INV-000001",
    uuid: "3cf5ee18-ee25-44ea-a444-2d723a1b5f78",
    icv: 1,
    issueDate: "2026-09-25",
    issueTime: "12:00:00",
    invoiceTypeName: "0200000",
    previousInvoiceHash: FIRST_INVOICE_PREVIOUS_HASH,
    seller: SELLER,
    buyerName: "Test Patient",
    lines: [
      { id: "1", description: "Consultation", quantity: 1, unitPrice: "100.00", lineNetAmount: "100.00", taxPercent: "15", taxAmount: "15.00", taxCategoryCode: "S" as const },
    ],
    lineExtensionAmount: "100.00",
    taxExclusiveAmount: "100.00",
    taxInclusiveAmount: "115.00",
    taxAmount: "15.00",
    payableAmount: "115.00",
  }
}

describe("P5.5-Z: UBL XML mapper", () => {
  it("produces well-formed XML with the fixed invoice-type/profile values the spec requires", () => {
    const xml = buildInvoiceXml(baseInput())
    expect(xml).toContain('<cbc:ProfileID>reporting:1.0</cbc:ProfileID>')
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>')
    expect(xml).toContain("<cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>")
    expect(xml).toContain("<cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>")
  })

  it("escapes XML-special characters in free-text fields (seller/buyer names, descriptions)", () => {
    const input = baseInput()
    input.seller = { ...SELLER, sellerName: 'Al-Noor & Sons "Clinic" <KSA>' }
    input.buyerName = "O'Brien & <Co>"
    const xml = buildInvoiceXml(input)
    expect(xml).not.toContain("<Co>")
    expect(xml).toContain("&amp;")
    expect(xml).toContain("&lt;")
  })

  it("places ICV/PIH/QR each under their own AdditionalDocumentReference discriminated by cbc:ID, per the Data Dictionary's exact XPaths", () => {
    const xml = buildInvoiceXml(baseInput())
    expect(xml).toMatch(/<cac:AdditionalDocumentReference><cbc:ID>ICV<\/cbc:ID><cbc:UUID>1<\/cbc:UUID><\/cac:AdditionalDocumentReference>/)
    expect(xml).toContain(`<cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${FIRST_INVOICE_PREVIOUS_HASH}`)
    expect(xml).toContain('<cbc:ID>QR</cbc:ID>')
  })

  it("fillQrCode replaces only the empty QR placeholder, leaving PIH's real content untouched", () => {
    const xmlWithoutQr = buildInvoiceXml(baseInput())
    const hash = computeInvoiceHash(xmlWithoutQr)
    const qr = buildPartialQrTlv({
      sellerName: SELLER.sellerName,
      vatRegistrationNumber: SELLER.vatRegistrationNumber,
      invoiceTimestamp: "2026-09-25T12:00:00Z",
      invoiceTotalWithVat: "115.00",
      vatTotal: "15.00",
      invoiceHashBytes: Buffer.from(hash, "base64"),
    })
    const filled = fillQrCode(xmlWithoutQr, qr)
    expect(filled).toContain(qr)
    expect(filled).toContain(FIRST_INVOICE_PREVIOUS_HASH) // PIH block still intact
    // Only the QR block's binary object should have changed length-wise.
    expect(filled.length).toBe(xmlWithoutQr.length + qr.length)
  })

  it("computes VAT category totals per distinct rate/code pair (BG-23 TaxSubtotal grouping)", () => {
    const input = baseInput()
    input.lines = [
      { id: "1", description: "Standard-rated item", quantity: 1, unitPrice: "100.00", lineNetAmount: "100.00", taxPercent: "15", taxAmount: "15.00", taxCategoryCode: "S" as const },
      { id: "2", description: "Zero-rated item", quantity: 1, unitPrice: "50.00", lineNetAmount: "50.00", taxPercent: "0", taxAmount: "0.00", taxCategoryCode: "Z" as const },
    ]
    const xml = buildInvoiceXml(input)
    const subtotalCount = (xml.match(/<cac:TaxSubtotal>/g) ?? []).length
    expect(subtotalCount).toBe(2)
  })
})
