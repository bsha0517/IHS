# P4.6 — Data Import / Clinic Onboarding / Initial Setup Report

**Date:** 2026-09-03
**Scope:** Can a completely fresh Avant HIS organization be configured and populated safely enough that a clinic can begin operating without a developer manually editing the database?

---

## 1. Executive Summary

Before this phase, a fresh Avant HIS organization had **no supported path to commercial go-live**: every entity (branches, staff, providers, services, products, suppliers, accounting mappings) had to be created one row at a time through its own screen, there was no single place to see what setup was still missing, and opening inventory had **no path at all** — not even a manual one — short of a developer inserting `StockLedgerEntry` rows directly.

P4.6 delivers two capabilities, kept deliberately distinct:

1. **Clinic Onboarding** — a `/admin/onboarding` workspace that derives a live, server-side readiness checklist from the organization's actual configuration and deep-links to the existing screens that fix each gap. No configuration UI is duplicated.
2. **Data Migration / Bulk Import** — a single reusable CSV import architecture (Template → Upload → Parse → Normalize → Dry Run → Validate → Duplicate Analysis → Preview → Explicit Commit → Result Report → Audit Trail) implemented for all eight in-scope entities: **Patients, Services, Products, Suppliers, Medications, Employees, Providers, and Opening Inventory** — none deferred.

The central rule — **bad imports must fail before mutating production data** — is enforced structurally: dry run creates zero domain rows, commit re-validates from scratch against a re-submitted, hash-verified file, and a failed batch stops the import with an exact failure point and no silent partial success.

One real, production-affecting bug was found and fixed during this phase's own live browser verification (see §19) — the integration test suite could not have caught it, since it lives entirely in client-side React state. It is fixed and re-verified end-to-end.

**Can P4.6 be closed? YES** — see §25.

---

## 2. Scope Boundary

**In scope:** tracing existing fresh-org setup; a derived (non-flag) onboarding readiness model; the onboarding workspace; a reusable CSV import engine; the eight named importers; `ImportJob`/`ImportJobError` schema; a narrow `data_import.manage` permission; a fresh-clinic smoke test; representative performance measurement; documentation and this report.

**Explicitly out of scope, and not attempted:**
- Auditing every module of the application, or another whole-project audit.
- Regulatory/compliance integrations, ETL, or data-warehouse functionality.
- Bulk import of historical clinical encounters, accounting journals, claims, payroll, or file attachments.
- Adding Redis or any new infrastructure dependency.
- Redesigning authorization or multi-tenancy.
- Organization *creation* (multi-tenant signup/provisioning) — treated as a precondition established by deployment, not part of "configuring an already-provisioned organization."
- Starting P4.7 (Reporting/Export/Data Portability), P4.8 (Release/Migration/Upgrade Safety), P4.9 (Commercial Readiness Acceptance), any regulatory phase, another backlog cleanup, or another whole-project audit.
- Any compliance/certification/accreditation claim (DHA/NABIDH/ZATCA/HIPAA/JCI-style or otherwise). The workspace uses **"Operational setup ready"** language only.

---

## 3. Existing Fresh-Clinic Setup — Traced Before Building Anything

Every entity below already had a real, working, permission-checked domain function and screen. Onboarding's job was to tie them together, not rebuild them:

| Step | Existing mechanism | Screen |
|---|---|---|
| Organization | `updateOrganization` | `/admin/settings` |
| Branches | `createBranch`/`updateBranch` | `/admin/settings` |
| Departments / Rooms | `createDepartment`/`createRoom` | `/admin/settings` |
| Users / Roles / Branch access | `createUser`/`updateUser` (role + branch access in one call) | `/admin/users`, `/admin/roles` |
| Providers | `createProvider` | `/providers` |
| Employees | `createEmployee` | `/employees` |
| Provider/User/Employee links | `linkEmployeeUser`/`unlinkEmployeeUser` (P3.12) — a separate, deliberate step | `/employees/[id]` |
| Services | `createService` | `/services` |
| Products | `createProduct` | `/inventory` |
| Medications | `createMedication` (creates Product + Medication in one transaction) | `/pharmacy` |
| Suppliers | `createSupplier` | `/suppliers` |
| Account mappings | `setMapping`/`listMappings` | `/accounting` |
| Opening inventory | **No existing path of any kind** | — |

A fresh clinic becomes operational (register a patient, book, consult, bill, dispense, receive payment, post accounting) once it has an active Branch, a Provider, a Service, and the core billing mappings (AR, Revenue, a tender account). Pharmacy-specific requirements only apply when `pharmacy_enabled` is actually on.

### Problems found while tracing

1. **No bulk-import path existed for any entity** — operationally unworkable for a clinic migrating hundreds/thousands of records without direct database access.
2. **No single "is this clinic ready to operate" view existed** — gaps were only discovered when an actual operational action failed at runtime.
3. **Opening inventory had no supported path of any kind**, manual or otherwise.

Full detail: [docs/CLINIC_ONBOARDING.md](docs/CLINIC_ONBOARDING.md).

---

## 4. Onboarding Architecture

```
src/lib/platform/import/     csv.ts · types.ts · engine.ts · parsers.ts   — one reusable engine
src/lib/domains/onboarding/  readiness.ts · imports/{registry,patients,services,products,
                              suppliers,medications,employees,providers,opening-inventory}.ts
src/app/(dashboard)/admin/onboarding/  page.tsx · import-dialog.tsx · cancel-button.tsx · actions.ts
src/app/api/onboarding/      template/[type]/route.ts · errors/[jobId]/route.ts
```

Every importer implements one shape, `ImporterDefinition<T>` (`requiredHeaders`, `optionalHeaders`, `parseRow`, `detectDuplicates`, `commitBatch`) — not a bespoke parser per entity.

**No persistent file storage (§13):** the uploaded CSV is never written to disk or the database. It's parsed in request memory for the dry run; the browser resubmits the *same* file on Commit, and the server re-parses, re-validates, and confirms its SHA-256 hash still matches the dry-run's recorded `ImportJob.contentHash` before touching a single domain row. This is Option A from §13 — no file ever sits at rest to secure, expire, or leak.

---

## 5. Onboarding Readiness Model

`getOnboardingStatus(session)` derives every item live from the organization's actual current configuration — **nothing is a stored flag**:

| Area | Item | Required? |
|---|---|---|
| Organization | Identity (legal/display name, currency, timezone) | Always |
| Structure | ≥1 active Branch | Always |
| Staff | An active administrator | Always |
| Staff | ≥1 operational (non-admin) user | Always |
| Clinical | ≥1 Provider | Always |
| Clinical | ≥1 active Service | Always |
| Billing | AR + Revenue + ≥1 tender account mapped | Always |
| Inventory | Products/Medications exist | Only if `pharmacy_enabled` |
| Inventory | Inventory Asset + COGS mapped | Only if `pharmacy_enabled` |
| Inventory | Opening stock recorded | Never (optional) |
| Patients | ≥1 patient on file | Never (optional) |
| Migration | ≥1 import committed | Never (optional, informational) |

`operationallyReady` is true only once every **required** item is complete. Status values are the plain set specified: Not Started / In Progress / Ready / Optional / Attention Required — no gamification, no scores, no badges.

---

## 6. Onboarding Workspace

`/admin/onboarding`, gated by the new `data_import.manage` permission, three sections:

1. **Readiness Review** — the live checklist above; each row deep-links to the existing screen that fixes it. No configuration UI is duplicated.
2. **Data Import** — one card per import type (Template download + Import button opening the shared dialog).
3. **Import History** — the last 20 `ImportJob`s (type, file, status, actor, timing, row counts); a not-yet-committed job can be cancelled here.

The app is never placed behind a fragile global "onboarding mode" — every screen stays usable throughout; readiness is advisory except where a real domain rule already blocks an action (e.g. billing already requires account mappings today, independent of this phase).

---

## 7. Import Architecture

**Dry run** (`runDryRun`): parses, validates every row, detects duplicates (one batched query, not N), creates an `ImportJob`, persists up to 1,000 `ImportJobError` rows, returns a bounded 50-row preview. **Creates no domain rows.**

**Commit** (`runCommit`): requires the *same* file content re-submitted; verifies organization ownership, job status, and content-hash freshness; **re-validates from scratch** (never trusts a client-held row classification); commits in transactional batches of 200 rows (§69 — bounded so no import needs a 20-minute transaction); on batch failure, marks the job `failed` with the exact `failedAtBatch`, and no later batch ever runs.

**Idempotent retry**: every importer's duplicate detection keys on a real, stable natural key already in the database (mobile/email/national-ID/name+DOB for patients, SKU, code, product+batch, etc.) — re-running the same corrected file after a partial failure detects and skips already-imported rows automatically. Verified directly by test (§17).

**Duplicate strategy**: CREATE + SKIP, never a silent upsert.

---

## 8. Database / Schema Changes

- `Patient.legacyMrn String?` (+ index) — an optional cross-reference to a legacy chart number. **Never used to derive or override the real MRN**, which is always generated by Avant's own sequence, exactly as the interactive registration flow does.
- `ImportJobStatus` enum: `uploaded / validated / ready / processing / completed / failed / cancelled`.
- `ImportJob` — organization/branch scope, `type` (plain `String`, matching the existing `OutboxEvent.eventType` precedent so a new import type never needs a migration), template version, status, file name, content hash, row-count summary fields, actor, timestamps.
- `ImportJobError` — job, row number, field, error code, message. Deliberately **no raw source-row values are ever stored**.
- New permission: `data_import.manage` (category `administration`), granted automatically to Super Admin and Organization Administrator only via the existing `PERMISSIONS.map(p => p.code)` seed mechanism — never to a branch-level operational role.

Migration: `prisma/migrations/20260902_p4_6_clinic_onboarding_data_import/` — hand-trimmed of the two pre-existing, unrelated drift items this whole engagement has consistently excluded since P4.2 (an `OutboxStatus` enum cleanup, a cosmetic `payroll_run` index rename). Applied to both `his_dev` and `his_test`.

---

## 9. Supported Import Types

All eight named in scope are implemented — **none deferred**.

| Type | Key fields | Duplicate signal | Notes |
|---|---|---|---|
| **Patients** | demographic/administrative only, `legacyMrn` optional | mobile / email / national ID / (name+DOB) | MRN always system-generated |
| **Services** | code, name, category, duration, price | code | — |
| **Products** | sku, name, category, unit, purchaseCost | SKU | never sets stock quantity |
| **Suppliers** | code, companyName, contact details | code | no invented tax/regulatory fields |
| **Medications** | sku, name, unit, purchaseCost, dosageForm | SKU | creates linked Product + Medication in one transaction, mirroring `createMedication` |
| **Employees** | name, designation, joiningDate, employmentType, branch | name+branch+joiningDate | master record only — never creates a login; `managerId` not supported (documented scope cut) |
| **Providers** | type, name, license, branches (`;`-separated) | license, or full name | master record only — never creates a login |
| **Opening Inventory** | sku, branchCode, batchNumber, quantity, unitCost, expiryDate | product+batchNumber | the one genuinely new capability — see §10 |

Full per-entity field/validation detail: [docs/CLINIC_ONBOARDING.md § Supported Import Types](docs/CLINIC_ONBOARDING.md#supported-import-types).

---

## 10. Opening Inventory — Ledger Correctness

**Never sets a stock balance directly.** Every row becomes a real `ProductBatch` + a `purchase`-type `StockLedgerEntry`, through the exact same `receiveStock` primitive the goods-receipt flow already uses — this import *is* the ledger-domain architecture, not a bypass of it.

- `unitCost` is **required** — never defaults to zero.
- An already-expired `expiryDate` is **rejected outright**, never imported as available/FEFO-eligible stock.
- Every movement's `referenceType` is `"opening_balance"` and `referenceId` is the `ImportJob.id` — fully traceable.
- **Posts no accounting journal automatically.** `receiveStock`'s only existing caller (`createGoodsReceipt`) posts Dr Inventory / Cr GR/IR-clearing — semantically wrong for opening stock (no real AP obligation exists for pre-existing inventory). Inventing a new `PostingIntent` for this was judged out of scope (new accounting semantics, explicitly warned against). See §12.

---

## 11. CSV Templates

`GET /api/onboarding/template/{type}` returns the importer's own `requiredHeaders`/`optionalHeaders` as an empty CSV, named `<template-version>.csv` — generated from the real parser's own accepted headers, so a template can never drift from what the parser accepts. Deliberately no example data row (risk of accidental real-data import); field/format/duplicate rules are shown as help text in the dialog instead.

---

## 12. Accounting Readiness

Reuses the existing Chart of Accounts / Account Mapping screens entirely — no new mapping UI. Readiness requires AR, Revenue, and a tender account always; Inventory Asset + COGS only when pharmacy is enabled. No bulk historical journal import was built. For opening financial balances, the documentation recommends the **existing** manual-journal mechanism (`createManualJournal`) for one deliberate, reviewed entry (Dr Inventory Asset / Cr Opening Balance Equity) — not 10,000 auto-generated postings, and no new accounting semantics were invented.

---

## 13. Security / PHI Handling

- **Authorization**: `data_import.manage` gates every entry point (dry run, commit, template download, error report). Not folded into `users.manage`/`settings.edit`.
- **CSRF/origin**: all mutating paths are Next.js Server Actions, carrying this codebase's existing CSRF/origin protection.
- **Tenant isolation**: `organizationId` is always derived from the session, never from the CSV or client payload. Every reference resolves only against the caller's own organization's data — verified by a dedicated cross-organization test (§17).
- **File safety**: CSV only, `.csv` extension checked, plain-text parsing (no formula evaluation, no HTML/script execution). Size (5 MB), row (10,000), and field-length (2,000 char) limits enforced before row-level work begins. No path traversal, shell, or dynamic SQL anywhere in the parser.
- **No PHI in logs**: the structured `log()` shape is deliberately narrow (organizationId, ImportJob id, import type — no free-text/row-content field).
- **No PHI in error rows**: `ImportJobError` stores only row number, field, error code, and a safe message — never source-row values.
- **CSV formula-injection protection**: every value this app *generates* into a CSV (template header, error-report cell) is escaped if it begins with `=`, `+`, `-`, or `@`. Export-time display safety only — never mutates how an imported value is parsed or stored.

---

## 14. Import History / Audit Trail

Every commit writes one `ImportJob`-level audit log entry (not one per imported row — avoiding a redundant audit-event storm across thousands of rows while keeping full traceability: every created domain row can be traced back to its `ImportJob` via natural keys/reference fields). The Import History table surfaces the same data operationally; a downloadable CSV error report (`GET /api/onboarding/errors/[jobId]`) is available for any dry-run or commit with invalid rows.

---

## 15. Fresh-Clinic Smoke Workflow Test

A single, deliberately narrow end-to-end test (not another full P3.13): on a freshly onboarded organization (no shared seed), Patient → Appointment → Check-in → Encounter → Charge → Invoice → Payment → Accounting, confirming the organization set up entirely through onboarding + imports actually functions for real clinical/billing operations. Passes.

---

## 16. Representative Import Performance (§67)

Measured locally against `his_test` (local PostgreSQL), most recent clean run:

| Import | Rows | Dry run | Commit |
|---|---|---|---|
| Patients | 1,000 | 31ms | 11,331ms |
| Products | 1,000 | 24ms | 649ms |

Patients' commit is measurably slower because it calls the real MRN sequence generator per row — the same system-integrity guarantee (`nextNumber`) the interactive registration flow uses, not a bulk `createMany`. This is documented as a known limit (§24), not optimized in this phase (measurement, not optimization, was the requirement). Both are well within the realistic range for clinic-scale imports (hundreds to low thousands of rows); a very large single-file historical migration is better split using the existing 10,000-row-per-file limit as a natural chunk boundary.

---

## 17. Test Coverage

`test/integration/p4-6-clinic-onboarding-data-import.test.ts` — a genuinely fresh, isolated two-organization fixture (not the shared seed), proving:

- Readiness starts incomplete and becomes `operationallyReady` once real setup is done (branch, provider, service, mappings, users).
- Per entity (Patients/Services/Products/Suppliers/Medications/Employees/Providers/Opening Inventory): clean import, invalid field, invalid date, duplicate (in-file and against-DB), unknown reference, 50+ row batch, dry run creates nothing, commit creates the correct count, a repeated commit of the same file is idempotent (no duplicate rows), a safe error report (no raw row values).
- Opening Inventory specifically: correct batch/ledger/cost/branch/expiry; expired-stock rejection; no double-stock on a repeat commit; cross-org product rejection; negative/zero-quantity rejection; missing-cost rejection.
- Cross-organization isolation: an org's import can never resolve another org's branch/product/supplier reference.
- The fresh-clinic smoke workflow (§15).
- Representative performance measurement (§16).

**23/23 passing**, confirmed repeatable across two full consecutive full-suite runs with zero leftover state (see §20 for a real cleanup-robustness issue found and fixed along the way).

---

## 18. Files Changed

**Schema/migration**: `prisma/schema.prisma`, `prisma/migrations/20260902_p4_6_clinic_onboarding_data_import/`, `prisma/seed.ts` (new `data_import.manage` permission).

**Import engine**: `src/lib/platform/import/{csv,types,engine,parsers}.ts`

**Onboarding domain**: `src/lib/domains/onboarding/readiness.ts`, `src/lib/domains/onboarding/imports/{registry,patients,services,products,suppliers,medications,employees,providers,opening-inventory}.ts`

**App/UI**: `src/app/(dashboard)/admin/onboarding/{page,import-dialog,cancel-button,actions}.tsx|ts`, `src/app/api/onboarding/template/[type]/route.ts`, `src/app/api/onboarding/errors/[jobId]/route.ts`, `src/components/layout/nav-config.ts` (new "Onboarding" nav entry)

**Tests**: `test/integration/p4-6-clinic-onboarding-data-import.test.ts`

**Docs**: `docs/CLINIC_ONBOARDING.md`, `BACKLOG.md` (two new findings, §21), this report.

---

## 19. Browser Verification

Verified live against a real running dev server (`his_dev`, local Postgres), logged in as the seeded Super Admin:

- `/admin/onboarding` renders correctly against real live data: Readiness Review shows accurate, real-time-derived statuses; all 8 import cards render with correct template versions; Import History renders correctly.
- **A real end-to-end import was exercised through the actual UI**: attached a CSV to the Medications import dialog, ran Validate (dry run) — the Step 3 review table rendered both rows as `valid` — then Commit.

**A real bug was found and fixed at this exact step.** `ImportDialog`'s `handleCommit` originally read the selected file from `fileInputRef.current?.files?.[0]`, but the `<input type="file">` unmounts (its wrapping `<form>` is conditionally removed) once the dry-run summary renders — React resets the ref to `null` on unmount, so by the time Commit was clicked, the handler silently returned with **no request sent, no error shown, and no row imported**, even though the dry run had reported everything valid. Every server-side piece (server action, engine, importer) was correct throughout; the bug was entirely client-side React state management. The integration suite could not have caught this — it exercises server actions/engine functions directly, not real component/browser interaction.

**Fix**: capture the selected `File` into component state at dry-run time (`selectedFile`) instead of re-reading a ref to an element that will later unmount; `handleCommit` and `reset()` updated accordingly.

**Re-verified end-to-end after the fix**: attached a fresh CSV, ran dry run (2 valid rows), clicked Commit, confirmed the network request fired and returned `"Imported 2 row(s), skipped 0 duplicate/invalid row(s)."`; confirmed via a full page read that Readiness Review's "Products / Medications" item flipped to **Ready — 2 product(s), 2 medication(s)**, "Migration → Data imports completed" flipped to **Ready — 1 import(s) committed**, and Import History showed the job as `Completed`, `2/0/0/0`. The dev server was stopped afterward; no stray process left running.

This finding and the detection-gap it exposes (no component/browser-level test layer in this repo) is logged in `BACKLOG.md` for future consideration (§21).

---

## 20. A Real Test-Cleanup Robustness Issue Found and Fixed During Regression

While running the full regression suite, a first pass showed one unrelated pre-existing test (`journal-balance-trigger.test.ts`) failing with "no ChartOfAccount found" — traced to **8 orphaned P4.6 fixture organizations** left in `his_test` from earlier interrupted development runs of this same test file (Ctrl-C/timeouts during iteration, before `afterAll` could run). An unfiltered `findFirstOrThrow()` elsewhere in the suite picked one of these minimal, incomplete orgs instead of the shared seeded one.

Cleaned up manually, then hardened the test file itself against recurrence:

1. Factored the FK-safe deletion sequence into a shared `deleteOrgData(orgIds)` function.
2. Added a **self-healing `beforeAll` sweep** (`cleanupOrphanedFixtureOrgs`) that removes any pre-existing organization matching this suite's exact fixture legal names *before* creating this run's own fixtures — so a future interrupted run can no longer accumulate orphans indefinitely.
3. While applying this fix, two more genuine gaps in the original deletion order surfaced and were fixed: `clinical_access_log` (append-only for the runtime role, like `audit_log` — must delete through the owner connection) and `idempotency_key` (P4.6's own new commit-idempotency table) were both missing from the cleanup sequence, causing a real FK violation once the smoke test started generating rows in either table.

Confirmed clean: two full consecutive `npm run test` runs, 563/563 passing both times, verified zero leftover organizations in `his_test` after each.

---

## 21. New Findings Logged to BACKLOG.md (not fixed here, out of scope)

1. **`analytics/csv.ts`'s CSV export has no formula-injection protection**, unlike the new `platform/import/csv.ts`. Low-Medium severity, out of P4.6's scope (reporting/export belongs to P4.7).
2. **No component/browser-level test harness** — the detection gap that let §19's bug reach a live server. Medium severity, a real standalone decision for a future phase (not a quick addition here).

---

## 22. Regression Status

All run against `his_test` (local PostgreSQL) — no Supabase, no production, at any point:

| Check | Result |
|---|---|
| `npx prisma validate` | ✅ Schema valid |
| `npx prisma migrate status` | ✅ Database schema up to date (39 migrations) |
| `npm run typecheck` | ✅ Clean |
| `npm run lint` | ✅ Clean |
| `npm run test` (full suite, run 1) | ✅ 60/60 files, 563/563 tests |
| `npm run test` (full suite, run 2) | ✅ 60/60 files, 563/563 tests — confirmed repeatable, no flakiness, no leftover state |
| `npm run build` | ✅ Compiled successfully, all routes generated including `/admin/onboarding`, `/api/onboarding/template/[type]`, `/api/onboarding/errors/[jobId]` |

---

## 23. Remaining Onboarding Backlog (deliberate, documented scope cuts — not oversights)

- `managerId` is not supported by the Employees importer (self-referential ordering problem from arbitrary CSV row order — set manually afterward).
- Expired-stock write-off import path (an explicit "import historical write-off" feature) was judged genuinely separate from Opening Inventory and out of V1 scope.
- No production/staging-scale import benchmark exists yet — only local measurements (§16), consistent with P4.5's own documented staging-validation follow-up.
- No jurisdiction/country-specific onboarding (`CountryProfile`) — deliberately out of this phase, matching the whole codebase's current jurisdiction-neutral approach.
- The two BACKLOG.md findings in §21.

None of these block commercial go-live for a fresh clinic; all are documented, bounded, and intentional.

---

## 24. Acceptance Criteria

1. ✅ Existing fresh-org setup traced (17 questions) before any code was written — see §3.
2. ✅ Onboarding completeness is a server-side derived model, not stored flags — see §5.
3. ✅ `getOnboardingStatus(session)` implemented.
4. ✅ `/admin/onboarding` deep-links to existing screens; no CRUD UI duplicated.
5. ✅ Simple readiness states only — no gamification.
6. ✅ No fragile global "onboarding mode" — app stays usable throughout.
7. ✅ Reusable import architecture — one `ImporterDefinition<T>` shape, not bespoke per entity.
8. ✅ `ImportJob`/`ImportJobError` durable models per spec field lists.
9. ✅ No raw uploaded file or full source rows with PHI ever stored.
10. ✅ CSV only (UTF-8 + BOM), with file size/row/field-length/header-validation/no-duplicate-header limits; formula-injection-safe export.
11. ✅ All 8 named importers implemented (Patients, Services, Products, Suppliers, Opening Inventory, Employees, Providers, Medications) — none deferred; Users/passwords never bulk-imported.
12. ✅ Detailed per-entity field mapping/validation — see §9 and docs.
13. ✅ Patient MRN always system-generated; `legacyMrn` is a narrow, justified cross-reference field only.
14. ✅ Opening inventory goes through the real stock ledger (`receiveStock`); cost required; expired stock rejected; traceable via `referenceType`/`referenceId`.
15. ✅ No bulk historical journal import; onboarding lets admins configure mappings; readiness detects missing required mappings; opening balances via the existing manual-journal mechanism only.
16. ✅ Tenant isolation mandatory, verified by a dedicated cross-org test.
17. ✅ New narrow `data_import.manage` permission, granted only to genuine org-admin-level roles.
18. ✅ Dry run mandatory, creates no domain rows; commit requires a freshness/integrity token (content-hash re-verification); idempotent against double-submit/retry.
19. ✅ Batched, bounded transactions (200 rows/batch); exact failed-batch reporting; no silent partial success.
20. ✅ Friendly, stable error codes/messages — never raw Prisma/stack-trace text.
21. ✅ Downloadable dry-run/commit error report (CSV).
22. ✅ Full import audit trail (one `ImportJob`-level audit entry per commit).
23. ✅ Downloadable CSV templates, generated from the real parser's own accepted headers.
24. ✅ Strict date handling (`YYYY-MM-DD` only, UTC-noon parsing); conservative normalization; no unsafe `as never` casts.
25. ✅ Bounded preview (50 rows) — never all rows rendered/stored.
26. ✅ Import-history view; final Readiness Review uses "Operational setup ready" language only — no compliance/certification/accreditation claim of any kind.

All 26 criteria met.

---

## 25. Acceptance Decision

**Can P4.6 be closed? YES.**

All required capabilities are implemented, tested (23 new tests, 100% passing, confirmed repeatable), documented (`docs/CLINIC_ONBOARDING.md`), and verified live in a real browser — including finding and fixing one genuine production bug during that verification. The full regression suite (schema, types, lint, 563 integration tests run twice, production build) is clean. No blockers remain. Remaining items (§23) are deliberate, documented, non-blocking scope cuts.

Per this phase's own explicit instruction: **P4.7, P4.8, P4.9, any regulatory phase, another backlog cleanup, and another whole-project audit are NOT started.** This report is returned for review.
