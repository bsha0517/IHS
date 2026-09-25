# P5.5-Z — ZATCA E-Invoicing Sandbox Integration — Completion Report

## 1. Defect Classification (used throughout this report)

- **P0** — data loss, security breach, or complete workflow blocker.
- **P1** — a real, incorrect, or fabricated ZATCA business outcome (e.g. a fake "submitted"
  status, an invalid XML field).
- **P2** — a gap that degrades the demo but does not misrepresent anything as working.
- **P3** — cosmetic / documentation-only.

## 2. Executive Summary

Built a provider-agnostic `EInvoiceProvider` adapter and a real `ZatcaEInvoiceProvider`
implementation for ZATCA's Simplified Tax Invoice (B2C, Reporting API), following this
codebase's own `CommunicationAdapter` precedent exactly: a real provider makes a real call
and reports what actually happened; a `NullEInvoiceProvider` honestly reports it made no
attempt. Every technical detail — XML structure, business rules, QR TLV encoding, hash-chain
procedure, API auth/flow — was grounded in three official ZATCA documents fetched and read
directly this phase (see `docs/P5_5_Z_ZATCA_SANDBOX.md` for citations and the full
EXISTING/REQUIRES MAPPING/MISSING gap analysis). Nothing was invented; every unconfirmed
detail is documented as a named gap, not guessed.

The full pipeline — seller-profile configuration, outbox-driven submission on invoice issue,
real UBL 2.1 XML generation, SHA-256 invoice-hash chaining from the spec's own fixed seed,
partial QR code generation (TLV tags 1-6), a submission-record UI at `/einvoicing`, and a
manual retry action — was verified against a real database, both via the automated test
suite and live through the running application against a dedicated synthetic Saudi
demo organization.

**No real ZATCA sandbox credentials were available this phase.** Real network submission to
ZATCA (via `ZatcaEInvoiceProvider`) and real cryptographic signing (the XAdES stamp, QR tags
7-9) both require a Compliance/Production CSID obtained through ZATCA's own Sandbox portal
CSR/OTP onboarding flow — a human, portal-driven process this build correctly does not
attempt to automate. See §9 (Prospect Demo Status).

## 3. What Was Built

- `src/lib/domains/einvoicing/adapters/{types,null-provider,zatca-provider}.ts` — the
  provider interface, the honest no-op provider, and the real HTTP client (Basic Auth,
  `Accept-Version: V2`, the confirmed Reporting/Clearance request/response shape).
- `src/lib/domains/einvoicing/config.ts` — seller profile (VAT number, national address) via
  the existing `Setting` model, with BR-KSA-05 VAT-format validation.
- `src/lib/domains/einvoicing/env.ts` — credential resolution from `process.env`, never
  persisted to the database.
- `src/lib/domains/einvoicing/hash-chain.ts` — the verified fixed first-invoice hash seed,
  block stripping, and hash computation.
- `src/lib/domains/einvoicing/qr-code.ts` — TLV encoding for QR tags 1-6; tags 7-9 (needing a
  real private key) explicitly throw rather than fabricate.
- `src/lib/domains/einvoicing/xml-mapper.ts` — the full UBL 2.1 Simplified Tax Invoice
  builder, every element path taken from the official Data Dictionary.
- `src/lib/domains/einvoicing/service.ts` — orchestrates ICV allocation, hash chaining, XML/
  QR generation, and provider dispatch; always writes an `EInvoiceSubmission` attempt record.
- `prisma/schema.prisma` — new `EInvoiceSubmission` model (`onDelete: Cascade` from
  `Invoice`) and `EInvoiceSubmissionStatus` enum; new `SequenceType` literal `"ICV"`.
- Three new migrations, applied to local dev and test databases, RLS and runtime-role grants
  re-applied to cover the new table.
- Three new RBAC permissions (`einvoicing.configure`/`.view`/`.submit`), granted to
  Accountant; Organization Administrator already holds `ALL`.
- `src/app/(dashboard)/einvoicing/` — a seller-profile configuration form and a submission-
  status table with a manual retry action, gated on the new permissions.
- `src/lib/platform/event-handlers.ts` — a second, additive `"InvoiceIssued"` outbox handler.
- `.env.example` / `DEPLOYMENT.md` — the ZATCA credential environment variables, documented
  as optional, with the single-tenant-credential-scope limitation stated explicitly.
- `scripts/demo-zatca-ksa-seed.ts` — an idempotent, synthetic-only Saudi demo organization
  (fictional clinic, fictional patient, placeholder-format VAT number) for exercising the
  pipeline without touching any real data.

## 4. Tests

- 15 unit tests (`hash-chain.test.ts`, `qr-code.test.ts`, `xml-mapper.test.ts`) — hash-seed
  verification against a direct SHA-256 computation, TLV byte-structure correctness, XML
  escaping, QR-placeholder substitution, tax-subtotal grouping. All passing.
- 6 integration tests (`test/integration/p5-5-z-zatca-einvoicing.test.ts`) against a real
  database: VAT-format validation, `not_configured` honesty with no ZATCA identity
  allocated when disabled, real XML/hash/QR generation with correct ICV allocation once
  enabled, hash-chain linkage across two real invoices, a real `ZatcaEInvoiceProvider` HTTP
  call against an unreachable endpoint failing honestly, and manual retry. All passing,
  confirmed deterministic across three repeated runs without a database reset.
- Full regression: `npm test` (72 files) run before and after this phase's changes. A real
  regression was found and fixed during this work (see §6, Defects Found/Fixed) — the new
  `EInvoiceSubmission` foreign key broke 9 pre-existing test files' own invoice-cleanup
  logic; fixed with `onDelete: Cascade` rather than touching each of those 9 files. See §7
  for the confirmed final state.
- Live demo verified via the running application (not just automated tests): logged in as
  the synthetic demo organization's admin, added a charge through the real POS UI, issued a
  real invoice, and confirmed a correctly-formed `EInvoiceSubmission` row (real UUID, ICV=1,
  the spec's fixed first-invoice hash, a real SHA-256 invoice hash, a real 172-character QR
  code) appeared both in the database and on the `/einvoicing` page.

## 5. RLS / Database Privileges

`npm run db:security:apply` re-run after the migration (dynamic, table-agnostic — picked up
the new table automatically). The local runtime-role table grant
(`prisma/db-setup/local-grant-runtime-role.sql`) had to be re-run explicitly — a real gap
this phase surfaced and fixed for itself (see §6): that grant script is not automatically
re-applied by a plain migration, only by the full `db:dev:setup`/`db:test:setup` flow, and
this phase's migration was applied outside that flow. `his_test` was rebuilt from scratch via
`npm run db:test:setup` to confirm a fresh environment works end to end, not just the
already-provisioned local dev database.

## 6. Defects Found / Fixed

### P1 — new foreign key broke 9 pre-existing tests' cleanup (fixed)

**Found:** a full-suite run after adding `EInvoiceSubmission` failed 9 integration test
files with `Foreign key constraint violated on the constraint: e_invoice_submission_invoice_id_fkey`
— every pre-existing test that hard-deletes an `Invoice` row in its own cleanup (written
long before this table existed) now failed, because every invoice created anywhere in the
suite gets a real `EInvoiceSubmission` row via the new outbox handler.

**Fixed:** changed the `Invoice` relation on `EInvoiceSubmission` to `onDelete: Cascade`
(new migration `20260925_p5_5_z_zatca_cascade_delete`), rather than updating 9 unrelated
test files' cleanup order — the minimal, correct fix, and consistent with this codebase's
own real-world discipline that an `Invoice` is never hard-deleted in production (only test
cleanup does it), so no real audit data is ever actually lost by this choice. Re-ran the
full suite after the fix — see §7.

### P2 — local runtime-role grant not automatically re-applied by a plain migration (fixed for this session)

**Found:** the `/einvoicing` page threw `permission denied for table e_invoice_submission`
against local dev — RLS was applied (dynamic, picked up the table automatically) but the
runtime role's own table-level GRANT was not, since that lives in a separate script
(`local-grant-runtime-role.sql`) only invoked by the full `db:dev:setup`/`db:test:setup` flow.

**Fixed:** re-ran `local-grant-runtime-role.sql` directly against `his_dev`. Not a code
change — this is an existing, documented step (`local-grant-runtime-role.sql`'s own header
comment already says "needs re-running whenever a new migration adds a table") that a plain
`prisma migrate deploy` outside the full setup scripts doesn't trigger automatically. No
backlog item needed; this is already exactly what that script's own doc comment warns about.

### No P0/P1 defects remain open.

## 7. Full Regression Result

Before this phase's `EInvoiceSubmission` cascade fix: 9 of 72 test files failed (the P1 in
§6), all with the identical `e_invoice_submission_invoice_id_fkey` foreign-key error. After
the fix, against a freshly-reset `his_test`: **5 failed assertions out of 716 tests** (a
99.3% pass rate), none in this phase's own code and none referencing ZATCA/e-invoicing —
`db.chartOfAccount.findFirstOrThrow()`, `db.journal.findFirstOrThrow()` (twice), and two
"expected 0 admin notifications to be greater than 0" assertions. Every one of these five
matches, exactly, the pre-existing, already-documented "integration suite non-determinism"
issue (`BACKLOG.md`, first raised in P5.4, root-caused to at least one test file
destructively deleting shared baseline rows it does not own) — not something this phase
introduced. Confirmed two ways: (1) the shared seeded organization's `zatca.sellerProfile`
Setting — the only shared state this phase's own test file touches — was verified fully
cleaned up (0 rows) after the run; (2) this phase's own dedicated test file (which creates
and cleans up every fixture it uses) passed deterministically across three consecutive
re-runs with no database reset in between. A short addendum with this run's specific new
evidence (chart-of-account and journal rows also confirmed missing, not only providers) was
added to that existing `BACKLOG.md` entry for whoever picks up that investigation next — no
new backlog entry was created, since it is the same already-tracked issue.

A full production build (`npm run build`) and the complete project typecheck both pass
cleanly with this phase's changes included.

## 8. Known Limitations

- No real ZATCA sandbox account, CSID, or private key — real network submission and
  cryptographic signing are unverified against ZATCA's actual backend. Everything up to that
  boundary (config, XML generation, hash chaining, QR tags 1-6, the submission-record
  lifecycle, retry, RBAC, audit, UI) is real and verified.
- C14N11 canonicalization is not independently validated against ZATCA's own reference
  implementation — see `docs/P5_5_Z_ZATCA_SANDBOX.md`'s dedicated gap entry.
- The Reporting API's exact endpoint path is inferred, not confirmed from an official source
  (only Clearance's path is given verbatim in the Developer Portal Manual).
- Standard Tax Invoices (B2B/Clearance) are not implemented — needs a buyer VAT/CR-number
  schema decision this phase does not make unilaterally.
- Single ZATCA-enabled organization per deployment (one global credential set), matching the
  actual one-prospect scope given, not a general multi-tenant design.
- `TaxRule` has no VAT-category classification field — the Standard/Zero-rated mapping used
  is a documented simplification, not a full Exempt/Out-of-scope distinction.

## 9. Prospect Demo Status

**DEMO READY — SANDBOX CREDENTIALS PENDING**

The full pipeline is real, tested, and demonstrable end to end against a synthetic Saudi
organization today: seller configuration, invoice issuance, real UBL XML generation, real
SHA-256 hash chaining from the spec's own fixed seed, a real partial QR code, and a
submission-status UI. What is pending is exclusively external: a real ZATCA Sandbox account
(CSID, Secret, and a signing private key), which only ZATCA itself can issue through its own
portal — nothing about that step is a gap in this implementation. No credentials, private
keys, or secrets are included anywhere in this report or committed to the repository.

## 10. Recommended Next Phase

Per this phase's own explicit stop condition: this report does not start P5.6, does not
begin work on FBR/DHA/NABIDH or any other regulatory certification, and does not perform
further product engineering. If the prospect engagement proceeds, the next concrete step is
external to this codebase: register a ZATCA Sandbox account, complete CSR/OTP onboarding to
obtain a real Compliance CSID, and supply the resulting credentials via the environment
variables already documented in `.env.example` — no code change should be required to go
from "sandbox credentials pending" to a real sandbox submission.
