import { createHash } from "node:crypto"

/**
 * BR-KSA-25/26 (ZATCA XML Implementation Standard v1.2, sections 2470-2530 of
 * the extracted spec text): the fixed previous-invoice-hash used for the very
 * first invoice in an organization's chain. This is base64("0" hashed with
 * SHA256, hex-encoded) — NOT base64 of the raw SHA256 bytes (that's a
 * different, ZATCA-defined bootstrap literal, distinct from computeInvoiceHash
 * below). Verified against the spec by decoding: the base64-decoded value of
 * this constant equals the lowercase hex digest of SHA256("0")
 * ("5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9").
 * Do not "simplify" this to base64(sha256Bytes("0")) — that produces a
 * different, non-compliant string.
 */
export const FIRST_INVOICE_PREVIOUS_HASH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ=="

/**
 * Removes the three blocks the spec's own 6-step hash procedure requires
 * stripped before canonicalization (XML Implementation Standard, "The hash
 * shall be computed using the following method... 1. Remove the
 * <ext:UBLExtensions/> block 2. Remove the <cac:AdditionalDocumentReference/>
 * block where <cbc:ID/> = QR 3. Remove the <cac:Signature/> block"). Regex-
 * based rather than a general XML-aware removal because this function only
 * ever runs against XML this codebase's own xml-mapper.ts produced — its
 * exact tag shapes (no attributes on the wrapper elements, no nested
 * ext:UBLExtensions elsewhere) are a known, controlled input, not arbitrary
 * third-party XML.
 */
export function stripHashExclusions(xml: string): string {
  let result = xml
  result = result.replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/, "")
  result = result.replace(
    /<cac:AdditionalDocumentReference>(?:(?!<cac:AdditionalDocumentReference>)[\s\S])*?<cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/,
    ""
  )
  result = result.replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, "")
  return result
}

/**
 * Step 4-6 of the spec's hash procedure: canonicalize, SHA256, base64.
 *
 * KNOWN LIMITATION (documented in docs/P5_5_Z_ZATCA_SANDBOX.md): the spec
 * mandates canonicalization per the W3C C14N11 standard specifically. No
 * vetted, actively-maintained C14N11 implementation was available to depend
 * on this phase (the one published npm package for it is an unmaintained
 * 0.0.x release). Because xml-mapper.ts is the only producer of the XML this
 * function ever receives, and it already emits a deterministic serialization
 * (fixed attribute/element order, explicit UTF-8, LF-only line endings, no
 * comments or processing instructions, namespaces declared once at the root),
 * this function normalizes whitespace between tags and encodes as UTF-8
 * rather than re-implementing general C14N11. This produces a stable,
 * internally-consistent hash for this codebase's own chain, but has NOT been
 * cross-validated byte-for-byte against ZATCA's reference canonicalizer
 * (available only via the official Fatoora SDK, which was not accessible
 * this session — see the sandbox doc's gap list). Before any real sandbox or
 * production submission, run the generated XML through
 * `fatoora -generateHash -invoice <file>` and confirm the hash matches.
 */
export function computeInvoiceHash(fullXml: string): string {
  const canonical = stripHashExclusions(fullXml)
    .replace(/>\s+</g, "><")
    .trim()
  return createHash("sha256").update(canonical, "utf8").digest("base64")
}
