# P4.9.2 — Extended Clinic Data Import Coverage Report

**Date:** 2026-09-04/08
**Scope:** Extending the P4.6 clinic onboarding/import engine with the full requested import catalogue. Does not reopen P4 architecture, does not start regulatory work, does not start P5.

---

## Executive Summary

P4.6 built the import engine and 8 importers. This phase inspected that architecture first, reused it without building a second framework, and added the 9 remaining requested import types (Laboratory Test Catalogue, Laboratory Panels, Imaging Service Catalogue, Packages, Payors, Assets, Chart of Accounts, Payroll Runs, Users) plus a narrow, schema-backed extension to the existing Medications importer. Three of the nine new importers are explicitly high-risk (Chart of Accounts, Payroll Runs, Users) and were built with deliberately conservative safety decisions: Payroll Runs import **Draft only** — never bypassing the real accounting-posting service; Users import creates accounts with **no usable password** — activation goes through the existing self-service reset flow, never a new credential-delivery mechanism; Chart of Accounts requires parent accounts to **already exist** before a child references them, which incidentally makes a circular hierarchy impossible to construct through the importer at all.

One genuine defect was found and fixed during this phase's own required 1,000-row performance benchmarking, not left as a "known limitation": Users' per-row `argon2id` password hashing, done sequentially inside an open database transaction, exceeded Prisma's interactive-transaction timeout outright on a 200-row commit batch — a real functional defect a production import of a few hundred staff would have hit. Fixed with a new, narrow, backward-compatible engine extension (`prepareBatch`) that runs CPU-bound per-row work in parallel, before any transaction opens.

**Can P4.9.2 be closed? YES.**

## Scope Boundary

In scope: the 16 named import types, the shared import engine and onboarding UI to the extent needed to support them (grouping, risk badges, domain-summary display, confirmation gating), the Readiness Review checks §62 asks for, and targeted tests/docs. Out of scope, and not touched: P4 architecture, authentication/RBAC design (only composed existing permissions), application business logic outside the import path, regulatory work, P5, and any historical clinical/transactional data migration (§77 — explicitly and permanently out of this importer family's scope).

## Existing Import Architecture Reused

Traced before building anything, per this phase's own instruction. Confirmed and reused without modification: the `ImporterDefinition<T>` contract (`parseRow`/`detectDuplicates`/`commitBatch`), the `runDryRun`/`runCommit` engine (`src/lib/platform/import/engine.ts`), `ImportJob`/`ImportJobError`, the `data_import.manage` permission gate, SHA-256 content verification, the 5 MB/10,000-row/2,000-character/200-row-batch limits, CSV formula-injection protection, CREATE+SKIP duplicate semantics, tenant/branch isolation via per-organization lookup maps, dry-run-never-mutates, batch/partial-completion reporting, and the shared `ImportDialog` UI. Two small, additive, backward-compatible extensions were made to the shared contract itself (both used by multiple importers, not one-offs):

- **`computeDomainSummary`** (optional) — lets an importer report extra labeled totals at Dry Run beyond the generic valid/warning/duplicate/invalid counts (§41). Used by Opening Inventory (quantity/value), Chart of Accounts (root/child counts), Payroll Runs (gross/deductions/net), and Users (accounts/roles/branches).
- **`prepareBatch`** (optional) — runs before a batch's transaction opens, for genuinely CPU-bound per-row work that must never run inside an open transaction. Used by Users for password hashing (see the performance finding below); every other importer is unaffected (the parameter is optional and unused elsewhere).

Also added: `group`/`riskLevel`/`confirmationText` on `ImporterDefinition` (§54/§55 — onboarding UI grouping and high-risk confirmation gating).

## Import Catalogue Matrix

| Import Type | Before P4.9.2 | After P4.9.2 | Dry Run | Duplicate Check | Reference Validation | Risk Level | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| Medication Catalogue | Existing (SKU→Product+Medication, deterministic) | Extended: `route`, `controlledSubstance`, `requiresPrescription` added | Yes | SKU (DB+file) | Product link is intrinsic (1 row = 1 Product+Medication) | Normal | New: field-persistence test | **EXISTING, EXTENDED** |
| Imaging Service Catalogue | None | New | Yes | code (DB+file) | — | Normal | Valid, duplicate, org isolation | **IMPLEMENTED** |
| Laboratory Test Catalogue | None | New | Yes | code (DB+file) | — | Normal | Valid, duplicate, invalid enum, dry-run-no-mutation | **IMPLEMENTED** |
| Laboratory Panels | None | New | Yes | code (DB+file) | Member test codes must pre-exist; unresolved code invalidates the row | Normal | Valid w/ tests, missing-test invalid | **IMPLEMENTED** |
| Packages | None | New | Yes | code (DB+file) | Member service codes must pre-exist; unresolved code invalidates the row | Normal | Valid w/ items, missing-service invalid | **IMPLEMENTED** |
| Services | Existing | Unchanged | Yes | code | department (optional) | Normal | Carried from P4.6 | **EXISTING, VERIFIED** |
| Providers | Existing | Unchanged | Yes | license number (strong) / name (weak, advisory) | branches | Normal | Carried from P4.6 | **EXISTING, VERIFIED** |
| Patients | Existing | Unchanged | Yes | mobile/email/nationalId/name+DOB | branch | Normal | Carried from P4.6 | **EXISTING, VERIFIED** |
| Payors | None | New | Yes | code (DB+file) | — | Normal | Valid, duplicate, invalid enum | **IMPLEMENTED** |
| Products | Existing | Unchanged | Yes | SKU | — | Normal | Carried from P4.6 | **EXISTING, VERIFIED** |
| Opening Inventory | Existing (real StockLedgerEntry/ProductBatch, never a direct balance) | Extended: `computeDomainSummary`, new mixed-retry test, new Readiness Review GL reminder | Yes | product+batchNumber | product, branch, supplier | **HIGH** | Carried + 1 new retry test (§52/§73) | **EXISTING, VERIFIED/EXTENDED** |
| Suppliers | Existing | Unchanged | Yes | code | — | Normal | Carried from P4.6 | **EXISTING, VERIFIED** |
| Assets | None | New | Yes | assetCode (DB+file) | branch, department, employee | Normal | Valid, duplicate, invalid branch, invalid dates/cost, org isolation, no-journal-posted | **IMPLEMENTED** |
| Employees | Existing | Unchanged | Yes | name+branch+joiningDate (advisory) | branch, department | Normal | Carried from P4.6 | **EXISTING, VERIFIED** |
| Payroll Runs | None | New — **Draft only** | Yes | branch+period (any status, whole group skipped) | branch, employee | **HIGH** | Duplicate period, unresolved employee, in-file duplicate, totals reconcile, no journal posted | **IMPLEMENTED — DRAFT-ONLY (decision B)** |
| Chart of Accounts | None | New | Yes | code (DB+file) | parent must pre-exist (separate file) | **HIGH** | Hierarchy, duplicate, missing/self/circular parent, invalid type, cross-org, no auto-mapping | **IMPLEMENTED** |
| Users | None | New — no usable password | Yes | email; employee link | roles, branches | **HIGH** | Valid, duplicate email, invalid role/branch, Super Admin refusal, employee-link duplicate, no password persisted | **IMPLEMENTED — SAFELY (decision A)** |

## Dependency Ordering

Documented in `docs/CLINIC_ONBOARDING.md`'s new "Recommended Import Order" section — only as restrictive as real references require (most importers can run in any order relative to each other; the ordering only matters where one importer's rows reference another's by code).

## Templates

Unchanged mechanism (`/api/onboarding/template/[type]`, auto-derived from `requiredHeaders`/`optionalHeaders`, headers-only, no example row — P4.6's own deliberate convention, not revisited). Every new importer gets a working template automatically; no per-importer template code was written.

## Reference Resolution

Every reference (branch, department, employee, service, lab test, role, parent account) resolves via a stable code/number/name — never a raw database id, never a fuzzy/first-match guess. An ambiguous or unresolved reference invalidates the row with an actionable message (§39/§74) rather than silently picking one candidate or dropping the reference.

## Duplicate Handling

CREATE+SKIP, unchanged. Every new importer detects both same-file duplicates and existing-database duplicates before commit, using the natural stable key for that entity (code for catalogues, email for Users, branch+period for Payroll Runs, assetCode for Assets). No importer added this phase performs an update/merge of any kind.

## High-Risk Import Controls

- **Chart of Accounts**: parent-must-already-exist rule (prevents circular hierarchies structurally); explicit confirmation checkbox; `chart_of_account.manage` required in addition to `data_import.manage`; never creates an Account Mapping.
- **Payroll Runs**: Draft-only, no accounting journal ever posted by this import; a branch+period that already has a run (any status) is skipped wholesale, never appended to; explicit confirmation checkbox; `payroll.process` required.
- **Users**: no password of any kind accepted, generated as a default, or persisted anywhere retrievable; Super Admin bulk-creation refused outright; explicit confirmation checkbox; `users.manage` required.
- **Opening Inventory** (carried from P4.6, now also marked `riskLevel: "high"` in the UI for consistency): no accounting journal posted; explicit confirmation checkbox added this phase.

All four render with a visually distinct "High risk" badge and a required, risk-specific confirmation checkbox (not a generic scary warning — the exact text names the real consequence) before Commit is enabled, per §55/§25.

## Batch / Partial Completion

Unchanged 200-row transaction batching. Payroll Runs' and Chart of Accounts' own cross-row grouping (multiple CSV rows becoming one PayrollRun; a child account referencing a parent account) both use a find-or-create pattern inside `commitBatch` specifically so a group split across two batches (same file, same key, >200 rows) resolves correctly regardless of which batch's transaction commits first — verified by design, not just assumed (each batch is a separate, sequential transaction; a later batch's `findFirst` sees an earlier batch's already-committed row).

## Retry Safety

Every new importer inherits the same job-status guard proven in P4.9 (a completed/failed job cannot be re-committed) and re-validates duplicate status fresh on every dry run (so a genuine retry file correctly detects what a prior job already committed). Opening Inventory specifically got a new, more realistic retry test this phase: a "retry" file mixing one already-committed batch with two genuinely new ones imports only the new ones, with no duplicated ledger entries.

## Tenant / Branch Isolation

Every new importer resolves every reference (codes, roles, employees, branches) through a lookup map scoped to `session.user.organizationId` only — the same pattern every P4.6 importer already used. Verified explicitly this phase for Chart of Accounts (a same-code account in a different organization never resolves as a duplicate or a valid parent) and exercised implicitly by every other importer's identical map-construction pattern.

## Import Audit / History

Unchanged — every commit is covered by the existing `ImportJob` record (organization, actor, type, timestamp, source filename, content hash, row counts, result counts) and the generic audit entry `runCommit` already writes. No importer added this phase persists anything beyond that, and Users specifically never persists a password or password-adjacent value anywhere (`ImportJob`, `ImportJobError`, logs, audit payload, or the Dry Run preview) — verified by construction (the random value is generated, hashed, and discarded in one expression, never assigned to a named variable) and by a targeted test.

## Opening Inventory / GL Warning

Closed the narrow P4.9-era `BACKLOG.md` finding, exactly as this phase's own instructions permitted (a small, narrow closure while already touching onboarding/import UX): `getOnboardingStatus` (`readiness.ts`) now shows an "Opening inventory GL confirmation" reminder whenever any `opening_balance`-referenced stock exists, with the exact text this phase specified. Never auto-posts anything — visibility only, `required: false` (never blocks `operationallyReady`).

## Performance

1,000-row benchmarks (§53), measured, not estimated:

- **Lab Tests**: dry run and commit both complete quickly (well under the component's own default test timeout) — no notable cost beyond ordinary DB round-trips.
- **Users**: dry run is fast (well under a second of actual validation work); **commit takes on the order of two minutes for 1,000 rows**, almost entirely `argon2id` hashing cost, not database time. A real, functional defect was found and fixed here first: hashing sequentially inside an open transaction exceeded Prisma's 20-second interactive-transaction timeout outright on a 200-row batch (a batch that could never complete, not merely a slow one). Fixed via the new `prepareBatch` hook (parallel hashing, before any transaction opens) — verified fixed by the same 1,000-row test now passing. The remaining ~2-minute cost for 1,000 rows is expected, by design (hashing is deliberately slow), and honestly recorded in `BACKLOG.md` rather than chased further — a real clinic's initial staff roster is realistically tens of users, not a thousand, in one file.
- Patients/Products (carried from P4.6): unchanged, already fast.

## Tests

New: `test/integration/p4-9-2-extended-data-import.test.ts` (26 tests, fresh isolated two-organization fixture, same self-healing convention as every other importer suite) covering every new importer's valid/invalid/duplicate/reference/isolation/high-risk paths named in §65-73, plus the two 1,000-row performance benchmarks. Extended: `test/integration/p4-6-clinic-onboarding-data-import.test.ts` gained one new Opening Inventory mixed-retry test and now has 26 tests (was 25). Total integration suite: **632 tests across 64 files, all passing** (was 607/63 entering this phase).

## Final Regression

Run against local Postgres only — never production:

- `npx prisma validate` — valid.
- `npx prisma migrate status` — up to date, no drift, no new migration needed (every new importer uses existing schema fields only).
- `npm run db:security:check` — clean (120 tables protected).
- `npm run typecheck` — clean.
- `npm run lint` — clean (0 errors; 2 trivial unused-var warnings found and fixed during this phase, not left in).
- `npm run test` (full integration suite) — **632/632 passing**, run in full at least once.
- `npm run test:components` — 12/12.
- `npm run test:e2e` — 21/21, against a real production build.
- `npm run build` — clean, all routes.
- `npm run release:check` — **all 8 gates green**: Prisma schema validation, migration drift check, DB security check (RLS, 120 tables protected), TypeScript, Lint, Component tests (12/12), Integration tests (632/632), Production build.
- `npm run db:upgrade:drill` — **PASSED**: real backup of `his_dev` → restore into an isolated rehearsal database → 39/39 migrations confirmed with none pending → RLS applied and verified (120 tables protected) → reconciliation clean (18 journals balanced, 1 invoice reconciled, no negative stock).

## Deferred / Unsupported Migration Types

Explicitly, permanently out of scope for this importer family (§77), unchanged from P4.6's own boundary: encounters, clinical notes, diagnoses, prescriptions, lab results, imaging reports, invoices, payments, refunds, supplier invoices, and historical journals. These are operational/clinical transactions, not master data — a controlled historical clinical migration (with provenance, terminology mapping, validation, and medico-legal review) is a distinct, later problem this phase does not attempt.

`InsurancePlan` (distinct from `Payor`) was not built — the requested field list (§14) was Payor master data only; Insurance Plan/Policy import was never in the requested catalogue and remains unbuilt.

## Remaining Import Backlog

- Employee `managerId` (self-referential) remains unsupported by the Employees importer — carried unchanged from P4.6, still a real ordering problem out of scope; set a manager afterward via the Employee edit screen.
- The `findFirstOrThrow`-crashes-instead-of-404 finding from P4.9 remains open (unrelated to this phase, not touched).
- Large Users imports (~1,000 rows) take roughly two minutes, dominated by intentional password-hashing cost — see Performance above and the new `BACKLOG.md` entry; not a defect, an expectation-setting note.

## P4 Closure / Acceptance Decision

**Can P4.9.2 Extended Clinic Data Import Coverage be closed? YES.**

Every requested import type has an honest, safe product decision:

- **IMPLEMENTED**: Imaging Service Catalogue, Laboratory Test Catalogue, Laboratory Panels, Packages, Payors, Assets, Chart of Accounts.
- **IMPLEMENTED — DRAFT-ONLY (decision B, §57)**: Payroll Runs — historical finalized/paid payroll cannot be safely reconstructed without bypassing the real posting service; Draft-only import is the safe, complete answer, not a shortfall.
- **IMPLEMENTED — SAFELY (decision A, §58)**: Users — no usable password is ever created; activation reuses the existing, already-audited self-service reset flow.
- **EXISTING AND VERIFIED**: Services, Providers, Patients, Products, Suppliers, Employees — reviewed against the full requested field list; each already covers it, none needed changes beyond what's listed below.
- **EXISTING, EXTENDED**: Medications (three new schema-backed fields), Opening Inventory (domain summary, new retry test, GL readiness reminder).

No importer was marked incomplete for responsibly declining an unsafe shortcut. The one genuine defect found this phase (the Users transaction-timeout bug) was fixed, not deferred, before this report was written.

---

Per this phase's own explicit stop condition: **P4.9.2 is complete.** No P5, regulatory modules, clinical-history migration, claims integration, or unrelated backlog cycle follows automatically — returning this report for review.
