import { create } from "xmlbuilder2"
import type { ZatcaSellerProfile } from "@/lib/domains/einvoicing/config"

/**
 * UBL 2.1 XML generation for a ZATCA Simplified Tax Invoice (InvoiceTypeCode
 * 388, KSA-2 subtype "02" — B2C). Standard Tax Invoices (B2B, subtype "01",
 * submitted via the Clearance API) are NOT implemented — the buyer VAT
 * registration number and full national address they require have no home
 * anywhere in this codebase's schema today (Patient has no VAT/CR fields;
 * there is no general "Customer" concept distinct from Patient/Payor — see
 * docs/P5_5_Z_ZATCA_SANDBOX.md's gap analysis). Simplified Tax Invoices do
 * not require buyer tax identification, which is why this is the type
 * implemented against the existing Patient/Invoice schema without any
 * change to patient master data.
 *
 * Every element path below is taken directly from the official ZATCA
 * "E-Invoice Data Dictionary" (20230519, vF) — see the business-term-ID
 * comment on each field. Namespace URIs are the standard, publicly-published
 * OASIS UBL 2.1 namespace identifiers (not ZATCA-specific), consistent with
 * the XML Implementation Standard's own statement that its schema is "UBL
 * Invoice 2.1... with the target namespace
 * urn:oasis:names:specification:ubl:schema:xsd:Invoice-2".
 *
 * NOT independently validated against ZATCA's own XSD/schematron (that
 * requires the official SDK, which was inaccessible this session — see the
 * sandbox doc's gap list). Do not treat the output as submission-ready
 * without running it through the Fatoora SDK's own validator first.
 */

export type XmlSellerAddress = ZatcaSellerProfile

export type XmlInvoiceLine = {
  id: string
  description: string
  quantity: number
  unitPrice: string
  lineNetAmount: string
  taxPercent: string
  taxAmount: string
  taxCategoryCode: "S" | "Z" | "E" | "O"
}

export type XmlInvoiceInput = {
  invoiceNumber: string
  uuid: string
  icv: number
  issueDate: string // YYYY-MM-DD
  issueTime: string // HH:mm:ss
  invoiceTypeName: string // KSA-2, 7-char e.g. "0200000"
  previousInvoiceHash: string
  seller: XmlSellerAddress
  buyerName: string | null
  lines: XmlInvoiceLine[]
  lineExtensionAmount: string
  taxExclusiveAmount: string
  taxInclusiveAmount: string
  taxAmount: string
  payableAmount: string
}

const NS = {
  xmlns: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  "xmlns:cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  "xmlns:cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  "xmlns:ext": "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
}

/**
 * Builds the full XML including placeholder empty UBLExtensions/QR/Signature
 * blocks (present so hash-chain.ts's stripHashExclusions can remove them by
 * the exact shape the spec's own procedure names) — QR and Signature content
 * is filled in by a second pass (fillQrAndSignature) once the hash is known,
 * since the hash itself must be computed on the XML with those blocks empty.
 */
export function buildInvoiceXml(input: XmlInvoiceInput): string {
  const root = create({ version: "1.0", encoding: "UTF-8" }).ele("Invoice", NS)

  // Placeholder — no cryptographic extension content without a real CSID (see qr-code.ts).
  root.ele("ext:UBLExtensions").up()

  // BT-23 / BR-KSA-EN16931-01: fixed value for the Reporting API path.
  root.ele("cbc:ProfileID").txt("reporting:1.0").up()
  // BT-1
  root.ele("cbc:ID").txt(input.invoiceNumber).up()
  // KSA-1
  root.ele("cbc:UUID").txt(input.uuid).up()
  // BT-2 / BT-KSA-25
  root.ele("cbc:IssueDate").txt(input.issueDate).up()
  root.ele("cbc:IssueTime").txt(input.issueTime).up()
  // BT-3 / KSA-2
  root.ele("cbc:InvoiceTypeCode", { name: input.invoiceTypeName }).txt("388").up()
  // BT-22 note omitted (optional, 0..*)
  // BT-5 / BT-6 (BR-KSA-EN16931-02: TaxCurrencyCode must be SAR)
  root.ele("cbc:DocumentCurrencyCode").txt("SAR").up()
  root.ele("cbc:TaxCurrencyCode").txt("SAR").up()

  // KSA-16: Invoice Counter Value, via AdditionalDocumentReference/ID=ICV.
  root
    .ele("cac:AdditionalDocumentReference")
    .ele("cbc:ID").txt("ICV").up()
    .ele("cbc:UUID").txt(String(input.icv)).up()
    .up()

  // KSA-13: Previous Invoice Hash, via AdditionalDocumentReference/ID=PIH.
  root
    .ele("cac:AdditionalDocumentReference")
    .ele("cbc:ID").txt("PIH").up()
    .ele("cac:Attachment")
    .ele("cbc:EmbeddedDocumentBinaryObject", { mimeCode: "text/plain" }).txt(input.previousInvoiceHash).up()
    .up()
    .up()

  // KSA-14: QR code placeholder, via AdditionalDocumentReference/ID=QR — filled by fillQrAndSignature.
  root
    .ele("cac:AdditionalDocumentReference")
    .ele("cbc:ID").txt("QR").up()
    .ele("cac:Attachment")
    .ele("cbc:EmbeddedDocumentBinaryObject", { mimeCode: "text/plain" }).txt("").up()
    .up()
    .up()

  // BG-5: Seller (AccountingSupplierParty). BT-27/BT-29/BT-35/KSA-17/KSA-23/KSA-3/BT-37/BT-38/BT-39/BT-40, seller VAT.
  const supplierParty = root.ele("cac:AccountingSupplierParty").ele("cac:Party")
  supplierParty
    .ele("cac:PartyIdentification")
    .ele("cbc:ID", { schemeID: "CRN" }).txt(input.seller.vatRegistrationNumber).up()
    .up()
  const supplierAddress = supplierParty.ele("cac:PostalAddress")
  supplierAddress.ele("cbc:StreetName").txt(input.seller.streetName).up()
  supplierAddress.ele("cbc:BuildingNumber").txt(input.seller.buildingNumber).up()
  supplierAddress.ele("cbc:PlotIdentification").txt(input.seller.additionalNumber).up()
  supplierAddress.ele("cbc:CitySubdivisionName").txt(input.seller.district).up()
  supplierAddress.ele("cbc:CityName").txt(input.seller.city).up()
  supplierAddress.ele("cbc:PostalZone").txt(input.seller.postalCode).up()
  supplierAddress.ele("cac:Country").ele("cbc:IdentificationCode").txt(input.seller.countryCode).up().up()
  supplierAddress.up()
  const supplierTaxScheme = supplierParty.ele("cac:PartyTaxScheme")
  supplierTaxScheme.ele("cbc:CompanyID").txt(input.seller.vatRegistrationNumber).up()
  supplierTaxScheme.ele("cac:TaxScheme").ele("cbc:ID").txt("VAT").up().up()
  supplierTaxScheme.up()
  supplierParty.ele("cac:PartyLegalEntity").ele("cbc:RegistrationName").txt(input.seller.sellerName).up().up()
  supplierParty.up().up()

  // BG-7: Buyer (AccountingCustomerParty) — Simplified Tax Invoice: buyer identity is optional (BR-KSA rules mark buyer fields O/C, not M, for this document type). Name-only when known.
  if (input.buyerName) {
    root
      .ele("cac:AccountingCustomerParty")
      .ele("cac:Party")
      .ele("cac:PartyLegalEntity")
      .ele("cbc:RegistrationName").txt(input.buyerName).up()
      .up()
      .up()
      .up()
  }

  // BG-25: Invoice lines.
  for (const line of input.lines) {
    const invLine = root.ele("cac:InvoiceLine")
    invLine.ele("cbc:ID").txt(line.id).up()
    invLine.ele("cbc:InvoicedQuantity", { unitCode: "PCE" }).txt(String(line.quantity)).up()
    invLine.ele("cbc:LineExtensionAmount", { currencyID: "SAR" }).txt(line.lineNetAmount).up()
    const lineTax = invLine.ele("cac:TaxTotal")
    lineTax.ele("cbc:TaxAmount", { currencyID: "SAR" }).txt(line.taxAmount).up()
    lineTax.up()
    const item = invLine.ele("cac:Item")
    item.ele("cbc:Name").txt(line.description).up()
    const classifiedTax = item.ele("cac:ClassifiedTaxCategory")
    classifiedTax.ele("cbc:ID").txt(line.taxCategoryCode).up()
    classifiedTax.ele("cbc:Percent").txt(line.taxPercent).up()
    classifiedTax.ele("cac:TaxScheme").ele("cbc:ID").txt("VAT").up().up()
    classifiedTax.up()
    item.up()
    const price = invLine.ele("cac:Price")
    price.ele("cbc:PriceAmount", { currencyID: "SAR" }).txt(line.unitPrice).up()
    price.up()
    invLine.up()
  }

  // BG-22: document-level tax total and monetary total.
  const docTax = root.ele("cac:TaxTotal")
  docTax.ele("cbc:TaxAmount", { currencyID: "SAR" }).txt(input.taxAmount).up()
  const taxSubtotalsByRate = new Map<string, { taxable: number; tax: number; code: string; percent: string }>()
  for (const line of input.lines) {
    const key = `${line.taxCategoryCode}:${line.taxPercent}`
    const existing = taxSubtotalsByRate.get(key)
    const taxable = Number(line.lineNetAmount)
    const tax = Number(line.taxAmount)
    if (existing) {
      existing.taxable += taxable
      existing.tax += tax
    } else {
      taxSubtotalsByRate.set(key, { taxable, tax, code: line.taxCategoryCode, percent: line.taxPercent })
    }
  }
  for (const { taxable, tax, code, percent } of taxSubtotalsByRate.values()) {
    const subtotal = docTax.ele("cac:TaxSubtotal")
    subtotal.ele("cbc:TaxableAmount", { currencyID: "SAR" }).txt(taxable.toFixed(2)).up()
    subtotal.ele("cbc:TaxAmount", { currencyID: "SAR" }).txt(tax.toFixed(2)).up()
    const category = subtotal.ele("cac:TaxCategory")
    category.ele("cbc:ID").txt(code).up()
    category.ele("cbc:Percent").txt(percent).up()
    category.ele("cac:TaxScheme").ele("cbc:ID").txt("VAT").up().up()
    category.up()
    subtotal.up()
  }
  docTax.up()

  const monetaryTotal = root.ele("cac:LegalMonetaryTotal")
  monetaryTotal.ele("cbc:LineExtensionAmount", { currencyID: "SAR" }).txt(input.lineExtensionAmount).up()
  monetaryTotal.ele("cbc:TaxExclusiveAmount", { currencyID: "SAR" }).txt(input.taxExclusiveAmount).up()
  monetaryTotal.ele("cbc:TaxInclusiveAmount", { currencyID: "SAR" }).txt(input.taxInclusiveAmount).up()
  monetaryTotal.ele("cbc:PayableAmount", { currencyID: "SAR" }).txt(input.payableAmount).up()
  monetaryTotal.up()

  // Placeholder — no XAdES signature without a real CSID private key (see qr-code.ts).
  root.ele("cac:Signature").up()

  return root.end({ prettyPrint: false })
}

/** Replaces the empty QR placeholder's text content with the real base64 TLV string, after the hash (computed against the placeholder version) is known. String-based, same controlled-input reasoning as hash-chain.ts. */
export function fillQrCode(xml: string, qrBase64: string): string {
  return xml.replace(
    /(<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">)(<\/cbc:EmbeddedDocumentBinaryObject>)/,
    `$1${qrBase64}$2`
  )
}
