/**
 * ZATCA QR code TLV encoding (Security Features Implementation Standards
 * v1.2, "4.1 Structure of the QR code", Table 3: QR Code content TLV field
 * definitions). Tags 1-5 and 6 are implemented here (available without a
 * real ZATCA-issued signing certificate). Tags 7-9 (ECDSA signature of the
 * hash, the public key extracted from the signing private key, and ZATCA's
 * own CA signature over the cryptographic stamp) require a real Compliance/
 * Production CSID private key this build does not have — see
 * buildPartialQrTlv's doc comment.
 *
 * Encoding rule from the spec: "Tag: the tag value... stored in one byte...
 * Length: the length of the byte array resulted from the UTF8 encoding of
 * the field value... stored in one byte... Value: the byte array resulting
 * from the UTF8 encoding of the field value" (tags 1-5); for tag 6, "Length:
 * length of hash (SHA256) is 32 bytes; Value: the byte array constituting
 * the value of the field" — i.e. tag 6's value is the raw 32 SHA256 bytes,
 * not the base64 string used elsewhere for BT-KSA storage.
 */
export type QrTlvFields = {
  sellerName: string
  vatRegistrationNumber: string
  /** ISO 8601, e.g. "2026-09-25T12:13:57Z" (spec's own example format). */
  invoiceTimestamp: string
  invoiceTotalWithVat: string
  vatTotal: string
  /** Raw 32-byte SHA256 digest of the XML invoice (decode computeInvoiceHash's base64 output to get this). */
  invoiceHashBytes: Buffer
}

function tlv(tag: number, value: Buffer): Buffer {
  if (value.length > 255) throw new Error(`QR TLV tag ${tag} value exceeds the 1-byte length field (255 bytes)`)
  return Buffer.concat([Buffer.from([tag]), Buffer.from([value.length]), value])
}

/**
 * Builds tags 1-6 only. The resulting base64 string is NOT a complete,
 * submission-ready ZATCA QR code — BR-KSA-27 (cryptographic stamp) requires
 * tags 7-9 for every invoice on which a stamp is mandatory (all Simplified
 * Tax Invoices and their notes). Callers must check hasSigningKey() (env.ts)
 * before treating this as ready to print/submit, and this codebase does not
 * fabricate tags 7-9 without a real private key.
 */
export function buildPartialQrTlv(fields: QrTlvFields): string {
  const parts = [
    tlv(1, Buffer.from(fields.sellerName, "utf8")),
    tlv(2, Buffer.from(fields.vatRegistrationNumber, "utf8")),
    tlv(3, Buffer.from(fields.invoiceTimestamp, "utf8")),
    tlv(4, Buffer.from(fields.invoiceTotalWithVat, "utf8")),
    tlv(5, Buffer.from(fields.vatTotal, "utf8")),
    tlv(6, fields.invoiceHashBytes),
  ]
  const combined = Buffer.concat(parts)
  if (combined.length > 700) {
    throw new Error("QR TLV payload exceeds the 700-character base64 limit specified by ZATCA")
  }
  return combined.toString("base64")
}

/**
 * Full 9-tag QR requires the EC private key from the taxpayer's real
 * Compliance/Production CSID to produce tag 7 (ECDSA signature of the
 * invoice hash) and tag 9 (ZATCA CA's signature over the cryptographic
 * stamp, only obtainable from ZATCA itself during onboarding) — see env.ts's
 * hasSigningKey(). This function intentionally throws rather than emitting a
 * QR code that looks complete but silently omits mandatory tags — the same
 * "never fake API integrations" discipline as communications adapters.
 */
export function buildFullQrTlv(): never {
  throw new Error(
    "Full 9-tag QR generation (tags 7-9) requires a real ZATCA-issued Compliance/Production CSID private key. " +
      "Configure ZATCA_PRIVATE_KEY_PEM once sandbox credentials are available — see docs/P5_5_Z_ZATCA_SANDBOX.md."
  )
}
