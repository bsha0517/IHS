# P5.5-Z ZATCA E-Invoicing Sandbox Integration

## Scope

A production-quality, provider-agnostic `EInvoiceProvider` adapter (mirroring the existing
`CommunicationAdapter` pattern) with a real `ZatcaEInvoiceProvider` implementation, for a
prospective Saudi customer requiring electronic invoicing under ZATCA's e-invoicing mandate.
Scoped to **Simplified Tax Invoices** (B2C, ZATCA InvoiceTypeCode 388, KSA-2 subtype "02"),
submitted via the **Reporting API** — the minimum viable type that maps cleanly onto this
codebase's existing `Invoice`/`Patient` schema without requiring new buyer-side tax-identity
fields (see the gap analysis below). Standard Tax Invoices (B2B, Clearance API) are explicitly
**not implemented**.

This document does not invent any ZATCA-specific technical detail. Every business rule, XML
element path, QR field, and API behavior cited below traces to one of three official ZATCA
documents, fetched and read directly this phase:

1. **Electronic Invoice XML Implementation Standard** (v1.2, 19 May 2023) — UBL structure,
   invoice type codes, business rules (BR-KSA-*), hash-chain procedure.
2. **Electronic Invoice Security Features Implementation Standards** (v1.2, 19 May 2023) —
   CSR/CSID onboarding, XAdES cryptographic stamp structure, QR code TLV encoding, Basic
   Authentication format.
3. **Developer Portal Manual** (Integration Sandbox) — sandbox registration, the
   Compliance CSID → Compliance Invoice → Production CSID → Reporting/Clearance API flow,
   confirmed request/response shapes for the Reporting and Clearance APIs.
4. **E-Invoice Data Dictionary** (XLSX, v.F) — the authoritative business-term-to-XPath
   mapping used for every element in `xml-mapper.ts`.

Where a detail could not be confirmed from these sources (e.g. the Sandbox's literal base
hostname), this is stated explicitly as a gap below — never guessed.

## Phase 1 — Existing / Requires Mapping / Missing

Grounded in a full read of the relevant billing/accounting/platform source (invoices.ts,
posting-service.ts, sequences.ts, outbox.ts, idempotency.ts, settings.ts, audit.ts,
communications/adapters, event-handlers.ts) before any new code was written.

### EXISTING (reused as-is)

- **Outbox pattern** (`src/lib/platform/outbox.ts`) — `registerOutboxHandler` supports
  multiple handlers per event type. A second `"InvoiceIssued"` handler was added
  (`event-handlers.ts`), additive to the existing posting/commission handler, not a
  replacement.
- **`Setting` model** (`src/lib/platform/settings.ts`) — the ZATCA seller profile
  (non-secret business data: VAT number, national address) is stored under the key
  `zatca.sellerProfile`, the same precedent as `pharmacy_enabled`.
- **`nextNumber()` sequence generator** (`src/lib/platform/sequences.ts`) — a new
  `SequenceType` literal `"ICV"` was added for the Invoice Counter Value (KSA-16),
  reusing the existing atomic-UPDATE-then-create concurrency guarantee.
- **`CommunicationAdapter` pattern** (`src/lib/domains/communications/adapters/`) — the
  direct architectural precedent for `EInvoiceProvider`: a real provider makes a real call
  and honestly reports the result; a `Null*` provider honestly reports it made no attempt.
- **RBAC** (`prisma/seed.ts`, `system-roles.ts`) — three new permissions
  (`einvoicing.configure`, `einvoicing.view`, `einvoicing.submit`) granted to the
  **Accountant** role (already holds `invoice.view`/`payment.view`/`account_mapping.manage`).
  `Organization Administrator` already holds `ALL`.
- **Audit** (`src/lib/platform/audit.ts`) — `writeAuditLog` is called for every real
  submission attempt and every seller-profile change.
- **Env-var credential convention** (`DEPLOYMENT.md`, `.env.example`) — no generic
  secret-storage table exists anywhere in this codebase; ZATCA credentials follow the same
  plain `process.env.*` convention as every other integration.

### REQUIRES MAPPING (built this phase)

- **`Invoice` → ZATCA Simplified Tax Invoice**: `invoiceNumber` → BT-1, `issuedAt` →
  IssueDate/IssueTime (KSA-25), `subtotal`/`taxAmount`/`totalAmount` →
  `LegalMonetaryTotal`. A new dedicated table, `EInvoiceSubmission` (one row per Invoice,
  `onDelete: Cascade` from Invoice), holds the ZATCA-specific identity (UUID, ICV, hash
  chain, XML, QR, lifecycle status) that has no home on `Invoice` itself.
- **`TaxRule.rate` → ZATCA VAT category code (S/Z/E/O)**: see MISSING below — this is a
  simplification, not a full mapping.
- **`Patient` → ZATCA buyer**: name-only (`cac:PartyLegalEntity/cbc:RegistrationName`).
  Simplified Tax Invoices do not require buyer tax identification (BR-KSA rules mark buyer
  VAT/address fields Optional/Conditional, not Mandatory, for this document subtype) — the
  one reason this document type maps cleanly onto `Patient` without a schema change.

### MISSING (real gaps — not implemented, not fabricated)

- **No seller VAT/CR-number or national-address field exists on `Organization`** (confirmed
  by a full schema read) — this phase stores that data in `Setting` (`einvoicing/config.ts`)
  rather than adding new `Organization` columns, since it's genuinely ZATCA/Saudi-specific
  and a generic multi-country `Organization` model shouldn't carry it directly.
- **No buyer VAT/CR-number field exists on `Patient` or any "Customer" model** — this is why
  Standard Tax Invoices (B2B) are out of scope; adding it is a real schema decision for a
  later phase, not something to invent here.
- **No VAT-category classification on `TaxRule`** (`schema.prisma`) — only a rate. The
  mapping in `einvoicing/service.ts`'s `vatCategoryForRate()` treats `rate > 0` as Standard
  ("S") and `rate === 0` as Zero-rated ("Z"); it cannot distinguish genuinely
  Exempt or Out-of-scope supplies. Documented, not silently assumed correct.
- **No real cryptographic signing capability.** ZATCA requires a Compliance/Production CSID
  (an X.509 certificate + private key) issued through a live Sandbox account's CSR/OTP
  onboarding flow (Security Features doc §2.1/§5.3). This build has no such account or
  credentials, so:
  - QR tags 1-6 (seller name, VAT number, timestamp, totals, XML hash) are generated for
    real — see `qr-code.ts`'s `buildPartialQrTlv`.
  - QR tags 7-9 (ECDSA signature of the hash, the public key, ZATCA's own CA signature) and
    the XAdES cryptographic stamp (`cac:Signature`) are **not generated** —
    `qr-code.ts`'s `buildFullQrTlv()` throws rather than fabricating them.
  - `einvoicing/service.ts` never calls the real ZATCA provider unless
    `ZATCA_PRIVATE_KEY_PEM` is configured, even if production CSID/Secret are present —
    submitting an invoice ZATCA would reject anyway (BR-KSA-60 requires the stamp) achieves
    nothing and would be misleading to show as "submitted."
- **C14N11 canonicalization not independently validated against ZATCA's own reference
  implementation.** The spec's hash procedure requires W3C C14N11 canonicalization before
  hashing (XML Implementation Standard, "Remove UBLExtensions/QR/Signature → canonicalize
  via C14N11 → SHA256 → base64"). No actively-maintained C14N11 npm package was available
  to depend on this phase (the one published package is an unmaintained 0.0.x release).
  `hash-chain.ts`'s `computeInvoiceHash` normalizes whitespace on `xml-mapper.ts`'s own
  deterministic serialization instead of implementing general C14N11 — internally
  consistent for this codebase's own chain, but **not confirmed byte-identical** to what
  ZATCA's own canonicalizer would produce. Before any real sandbox submission, run the
  generated XML through the official Fatoora SDK's `fatoora -generateHash` and confirm the
  hash matches.
- **The ZATCA Integration Sandbox's literal base hostname and the Reporting API's exact
  endpoint path are not confirmed.** The Developer Portal Manual gives the Clearance API's
  path verbatim (`/invoices/clearance/single`) but never states the Reporting path in the
  same way — only that it exists, in the same "Invoices APIs" group. `zatca-provider.ts`
  infers `/invoices/reporting/single` by symmetry and makes it overridable via
  `ZATCA_REPORTING_PATH`. The Swagger/OpenAPI docs that would confirm this require a
  registered Sandbox account (sandbox.zatca.gov.sa) this session does not have.
- **The official SDK User Manual PDF** (hosted on a Mailchimp CDN linked from ZATCA's own
  site) returned "Access Denied" on three distinct access attempts this session (direct
  fetch, direct navigation, navigation via the referring page). The SDK itself (a
  downloadable zip via SharePoint) was not attempted. Neither blocks anything built this
  phase, but both would be the authoritative source for byte-exact XML validation and are
  worth another attempt with a real user session if the prospect engagement proceeds.
- **Single-tenant credential scope.** `ZatcaCredentials` (`einvoicing/env.ts`) reads one
  global set of env vars — this build supports exactly one ZATCA-enabled organization per
  deployment, matching the actual scope given (one prospective Saudi customer), not a
  general multi-tenant certificate-per-taxpayer design.

## Architecture

```
src/lib/domains/einvoicing/
  adapters/
    types.ts            EInvoiceProvider interface (mirrors CommunicationAdapter)
    null-provider.ts     NullEInvoiceProvider — honest "not_configured", never fakes success
    zatca-provider.ts    ZatcaEInvoiceProvider — real HTTP calls, Basic Auth, Accept-Version
  config.ts              Seller profile via Setting; VAT-number format validation (BR-KSA-05)
  env.ts                 Credential resolution from process.env — never persisted to the DB
  hash-chain.ts          FIRST_INVOICE_PREVIOUS_HASH constant; computeInvoiceHash
  qr-code.ts             TLV encoding (tags 1-6); buildFullQrTlv() throws (tags 7-9 gap)
  xml-mapper.ts          UBL 2.1 XML builder for the Simplified Tax Invoice
  service.ts             submitInvoiceToZatca() — orchestrates ICV/UUID/hash/QR/XML/submission
```

Wired into `src/lib/platform/event-handlers.ts` as a second `"InvoiceIssued"` outbox handler.
Every invoice issued anywhere in the system writes an `EInvoiceSubmission` attempt record —
`not_configured` if the org has no seller profile enabled, real XML/hash/QR generation
(but still `not_configured`) if enabled without full credentials, and a real submission
attempt only once `ZATCA_PRODUCTION_CSID`/`ZATCA_PRODUCTION_SECRET`/`ZATCA_PRIVATE_KEY_PEM`
are all present.

## QR Code (verified byte structure)

Table 3 of the Security Features Implementation Standard, tags 1-9:

| Tag | Field | Status this phase |
|---|---|---|
| 1 | Seller's name | Implemented |
| 2 | Seller VAT registration number | Implemented |
| 3 | Timestamp (ISO 8601) | Implemented |
| 4 | Invoice total (with VAT) | Implemented |
| 5 | VAT total | Implemented |
| 6 | Hash of XML invoice (32 raw bytes, not base64) | Implemented |
| 7 | ECDSA signature of the XML hash | **Not implemented — no private key** |
| 8 | ECDSA public key from the signing private key | **Not implemented — no private key** |
| 9 | ZATCA CA's signature over the cryptographic stamp | **Not implemented — requires a real CSID** |

## Hash Chain (verified)

- First invoice: `previousInvoiceHash` = the spec's fixed literal
  `NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==`
  — verified by direct computation to decode to the lowercase hex SHA256 digest of the
  character `"0"` (`5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9`),
  exactly as the spec states.
- Every subsequent invoice: `previousInvoiceHash` = the immediately prior submission's own
  `invoiceHash`, read from `EInvoiceSubmission` ordered by ICV.

## API Flow (Developer Portal Manual, confirmed)

1. **Onboarding**: EGS generates a CSR (PKCS#10, OpenSSL config per the Security doc's
   Table 1 Subject fields) → submits CSR + OTP to the **Compliance CSID API** → receives a
   test Compliance CSID + Secret + Request ID.
2. **Compliance checks**: the Compliance CSID/Secret authenticate calls to the
   **Compliance Invoice API** (sample invoices, until they pass compliance validation).
3. **Production CSID**: the compliance Request ID is submitted to the
   **Production CSID (Onboarding) API**, returning the real Production CSID + Secret.
4. **Submission**: every Reporting/Clearance call uses
   `Authorization: Basic base64(CSID:Secret)` + `Accept-Version: V2`.

Steps 1-3 require a real, registered ZATCA Sandbox account this session does not have —
`ZatcaEInvoiceProvider` is built to consume the CSID/Secret/private key once available
(`.env.example`), not to perform onboarding itself (onboarding is a human, portal-driven
process, not something a server integration can automate).

## Testing

- `src/lib/domains/einvoicing/hash-chain.test.ts` — fixed-seed verification, block
  stripping, hash determinism.
- `src/lib/domains/einvoicing/qr-code.test.ts` — TLV byte structure, length limits,
  `buildFullQrTlv()`'s refusal to fabricate a signature.
- `src/lib/domains/einvoicing/xml-mapper.test.ts` — XML structure, escaping, QR
  placeholder substitution, tax-subtotal grouping.
- `test/integration/p5-5-z-zatca-einvoicing.test.ts` — the full real pipeline against a
  real database: VAT-format validation, `not_configured` honesty with no ZATCA identity
  allocated, real XML/hash/QR generation once enabled, ICV increment + hash-chain linkage
  across two real invoices, a real `ZatcaEInvoiceProvider` HTTP call against an unreachable
  endpoint failing honestly (never fakes success), and manual retry.
- Demonstrated live against a dedicated synthetic Saudi demo organization
  (`scripts/demo-zatca-ksa-seed.ts`) through the real running app: patient → charge →
  POS "Create Invoice" → outbox → real UBL XML/hash/QR generated and visible at
  `/einvoicing`.

## Environment Variables

See `.env.example`'s "ZATCA e-invoicing" section and `DEPLOYMENT.md`. All optional; every
piece of this system degrades honestly (never fakes success) when unset.

## Not Implemented (explicit)

- Standard Tax Invoices / Clearance API (B2B) — needs buyer VAT/CR-number schema work.
- Real cryptographic signing (XAdES stamp, QR tags 7-9) — needs a real CSID private key.
- SDK-based validation of generated XML — the SDK was inaccessible this session.
- Multi-tenant ZATCA credentials (one certificate per organization).
- Credit/Debit notes, prepayment invoices, export/summary/self-billed/nominal/third-party
  invoice transaction flags (KSA-2 positions 3-7) — only the plain "02" simplified subtype
  is implemented.
- CSR generation tooling — onboarding is documented as a manual, portal-driven process.
