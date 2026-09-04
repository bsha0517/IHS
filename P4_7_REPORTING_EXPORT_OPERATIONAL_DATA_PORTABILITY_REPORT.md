# P4.7 — Reporting / Export / Operational Data Portability Report

**Date:** 2026-09-03
**Scope:** Can clinic management obtain the operational and financial information they need without developers querying the database? Can an authorized customer export their own operational data in standard formats, safely, filtered, traced, and reconciled?

---

## 1. Executive Summary

Before this phase, Avant HIS already had a real, working reporting foundation — seven report categories (`/reports`), a CSV export route, financial statements, dashboards — built across earlier phases. What it did not have: a **date-range bug that silently discarded almost an entire day's activity** whenever a user picked an explicit "To" date; **any CSV formula-injection protection on report exports** (a real gap already flagged in `BACKLOG.md` during P4.6); **any export row limit** (an unbounded CSV could, in principle, try to serialize an entire table); a Daily Operations view; row-level Invoice/Collections/Refund/Appointment/Patient reports; AR/AP aging; inventory reconciliation; a General Ledger or Trial Balance export; or a Patient Master data-portability export.

P4.7 fixed the date-range bug at its source, closed the CSV safety gaps, added export row limits with no silent truncation, and added five new report categories (Daily Operations, Patients, Lab, Radiology, Import History) plus significant row-level detail to three existing ones (Practice, Financial, Billing/Revenue, Inventory) — all built on the existing domain layer, never reimplementing a business rule. A second real production bug — a field-name collision that crashed the entire "Billing / Revenue" tab — was found and fixed during this phase's own live browser verification, exactly the class of bug P4.6 first identified as invisible to server-only integration tests.

**Can P4.7 be closed? YES** — see §26.

---

## 2. Scope Boundary

**In scope:** tracing the existing reporting architecture; reusing and extending it (not rewriting); a coherent Reports workspace; the eleven named reporting/export areas (§3–§30 of the phase spec); CSV data-portability exports; export safety (row limits, formula injection, tenant isolation, audit); documentation; this report.

**Explicitly out of scope, and not attempted:** a data warehouse, OLAP, Elasticsearch, Redis, Kafka, a reporting microservice, arbitrary/user-written SQL, external BI integrations, regulatory reporting (DHA/NABIDH/NPHIES/ZATCA/FBR), scheduled emailed reports, a custom report designer, dashboards for every conceivable metric, UI/UX visual redesign beyond functional clarity, P4.8, P4.9, another whole-project audit, another backlog cleanup.

---

## 3. Existing Reporting Architecture — Traced Before Changing Anything

| Area | Existing state |
|---|---|
| Report routes | `/reports` (7 categories, tab UI, shared date/branch/provider filter) |
| Report domain functions | `analytics/reports/{practice,clinical,financial,revenue-cycle,inventory,hr,assets}.ts` — real, live-computed, never cached |
| Financial reports | `accounting/reports.ts` — Trial Balance, Income Statement, Balance Sheet, Cash Flow, Journal List/detail — all correct, branch-scoped, already reused by `getFinancialReport` |
| Dashboards | `analytics/dashboards.ts` — Management/Reception/Doctor/Finance dashboards, correct `[start, end)` date-boundary pattern (unlike the report-side bug found — see §4) |
| CSV export | `analytics/csv.ts`'s `toCsv` + `/api/reports/export/route.ts` — worked, but **no formula-injection protection**, **no row limit** |
| Print/PDF | Browser-print pages already exist for invoices, payslips, prescriptions, lab/imaging reports — no PDF-generation infrastructure, and none was added |
| Date filtering | `defaultReportFilters` (`analytics/schemas.ts`) — **the `to` date-range bug**, see §4 |
| Branch filtering | `getAuthorizedBranchScope`/`narrowBranchFilter` (`platform/branch-scope.ts`) — correct, already the single source of truth, reused unchanged |
| Pagination | Journal List and Stock Ledger already properly paginated; most report-tab queries are unbounded but small (aggregate/status-grouped) |
| Report permissions | Domain-permission-gated (`canViewReportCategory`), `reports.export` as the export/management-rollup gate — a good existing pattern, extended not replaced |
| Reconciliation reports | None existed for inventory; financial statements were already internally consistent (shared `accountBalances` fetch) |
| Charts/metrics | `analytics/kpis.ts` — 6-month trailing KPI trend lines, plain CSS bars, reused unchanged |
| Current limitations found | See §4 |

**Existing reports were reused, not rewritten.** Every pre-existing report function's core query logic is unchanged; new fields were added alongside, and new categories were built as new files following the same established pattern.

---

## 4. Problems Found While Tracing

1. **The Date Range Rule was violated codebase-wide for report `to` dates.** `defaultReportFilters` parsed an explicit `?to=2026-09-30` as `2026-09-30T00:00:00` — midnight at the *start* of that day — then every report filtered `{ gte: from, lte: to }`. A user picking "From Sept 1 To Sept 30" got a report that silently stopped just after midnight on Sept 1, excluding virtually the entire range. This affected all seven pre-existing report categories, the CSV export route, and (via `asOf: filters.to`) the Balance Sheet's own "as of" figure. **Fixed** — see §14.
2. **No CSV formula-injection protection on report exports.** `analytics/csv.ts`'s `toCsv` quoted commas/newlines/quotes but never escaped a leading `=`/`+`/`-`/`@` — a real, previously-flagged gap (`BACKLOG.md`, logged during P4.6). **Fixed** — see §15.
3. **No export row limit of any kind.** `/api/reports/export` would attempt to serialize however many rows a query returned, with no cap and no controlled failure mode. **Fixed** — see §17.
4. **The inventory ledger page's own date filter had a related, independently-introduced bug** — a UTC-`Z`-suffixed end boundary and a raw (no time component) start boundary, both shifting the effective range by the server's timezone offset. **Fixed** alongside the main date bug, using the same new shared helper.

---

## 5. New Reports Implemented

| Report | File | Notes |
|---|---|---|
| Daily Operations | `analytics/reports/daily-operations.ts` | New category; one calendar day, billing vs. collections kept separate |
| Patient Registration | `analytics/reports/patients.ts` | New category; privacy-conscious (demographics only) |
| Appointment (row-level) | extends `practice.ts` | Added to the existing Practice category |
| Lab | extends `clinical.ts` | New category; explicit TAT definition |
| Radiology | extends `clinical.ts` | New category; explicit TAT definition |
| Invoice / Collections / Refund | extends `revenue-cycle.ts` | Added to the existing Billing/Revenue category |
| AR / AP Aging | extends `financial.ts` | Added to the existing Financial category |
| Inventory Reconciliation, Low Stock, Stock Movement export | extends `inventory.ts` | Added to the existing Inventory category |
| Import History | `analytics/reports/import-history.ts` | New category; P4.6's ImportJobs reshaped |
| General Ledger export, Trial Balance export, Patient Master export | `analytics/exports.ts` | New data-portability module |
| Audit Log / Clinical Access Log export | `api/reports/export/data/[type]/route.ts` | Added directly to those two pre-existing admin pages |

---

## 6. Reports Workspace

`/reports` was **improved, not replaced**: the same tab-based UI, the same shared filter bar, extended from 7 to **12 categories**, each now showing a one-line purpose (§6's own requirement) alongside its Export CSV button. No new navigation items were added elsewhere — Reports remains the one central directory.

---

## 7. Executive / Daily Operations

Executive visibility (revenue, collections, AR, refunds, appointments, encounters, pharmacy sales, inventory value) was already available via the Financial report and Management Dashboard — both reused unchanged. The new **Daily Operations report** (§8) gives a clinic manager the specific end-of-day view the spec asked for: appointments by outcome, encounters completed, invoices raised vs. payments collected vs. refunds issued (kept as three separate figures, never conflated), pharmacy dispenses, lab/imaging order and verification counts — all for one selected calendar day, gated per-section on the caller's actual permissions (a role without `invoice.view` simply doesn't see the billing section, rather than erroring).

---

## 8. Patient / Appointment

**Patient Registration Report** (§9): MRN, name, DOB, gender, mobile, branch, registration date — by design, no clinical fields, no national ID/passport/address.

**Appointment Report** (§10): the existing Practice report's status/utilization breakdowns, now joined by a row-level listing (date/time, provider, service, branch, status, source) with counts by status already present.

---

## 9. Clinical Operations, Lab, Radiology

**Clinical** (§12): encounter volume, diagnosis trends (aggregated, coded diagnoses only), orders by type, follow-ups, and — new — prescriptions count and lab/imaging verification cross-references.

**Lab** (§13) and **Radiology** (§14): orders by status, plus an *explicitly defined* turnaround time (order→result-entry and result-entry→verification for Lab; order→perform and perform→report for Radiology), computed only from real, already-written timestamps (`ClinicalOrder.orderedAt`, `LabOrderTest.enteredAt`/`verifiedAt`, `ImagingOrder.performedAt`/`reportedAt`) — never a fabricated stage. Report-amendment history excluded per §14's own instruction.

---

## 10. Billing / Revenue

Extends the existing Revenue Cycle report (Charges/Claims/Rejections, unchanged) with three new row-level reports (§15): **Invoice Report** (gross/discount/tax/net/paid/outstanding/status), **Collections Report** (receipt/date/patient-invoice/method/amount/cashier), **Refund Report** (refund #/date/invoice/amount/reason/status/actors).

---

## 11. AR / AP Aging

**AR Aging** (§16): bucketed (Current/1–30/31–60/61–90/90+) from `Invoice.issuedAt` — Invoice has no `dueDate` field, so the basis is reported honestly as `"issuedAt"`, never implied as due-date-based, per §16's own explicit instruction against inventing a due date.

**AP Aging** (§21): bucketed from `SupplierInvoice.dueDate`, which the schema *does* model (unlike Invoice) but leaves nullable — an undated row is excluded from the buckets and reported separately as `undated`/`undatedAmount`, never guessed into a bucket.

---

## 12. Inventory

Stock On Hand, Near-Expiry, Expired, Valuation, Fast/Slow Moving were already correct and reused unchanged (batch-level specific-identification cost, matching real COGS postings). New: **Low Stock** (existing `listLowStock`, now surfaced as a report section), a **Stock Movement export** (the existing paginated ledger viewer's export-side counterpart), and an **Inventory Reconciliation** section (§19) detecting negative stock, unvalued positive stock, and expired-but-still-positive-balance batches — all computed from data the Inventory report already fetches, not a separate engine.

**Opening Inventory Portability** (§18): if any `StockLedgerEntry` with `referenceType: "opening_balance"` exists, the report now surfaces a plain-language prompt ("confirm the corresponding GL opening balance has been posted") — a visibility aid, never an automated posting, and it never changes P4.6's own accounting design.

---

## 13. Procurement / Payables

`/purchasing` already lists Purchase Requests, Purchase Orders, and Supplier Invoices with status and pagination — judged "usable within existing architecture" per acceptance criterion #11. It does **not** currently support date/branch/supplier filtering (§20's own suggested filter list); this is a real, honestly-documented gap (logged to `BACKLOG.md`, §24 below), not silently claimed as met. AP Aging (§11 above) covers the one aggregate figure management most needs from this area today.

---

## 14. Finance / Accounting

Trial Balance, Income Statement, Balance Sheet, Cash Flow, and the Journal List/detail viewer are **entirely unchanged** — reused exactly as built in earlier phases. New: a **General Ledger export** (one row per `journal_line`, the real atomic ledger unit — journal #, date, account code/name, debit, credit, reference type/id, branch, memo) and a **Trial Balance export** (CSV of the exact same `trialBalance()` computation the `/accounting` screen renders, plus a TOTAL row — verified by test to equal the screen's own totals exactly).

**The date-range fix** (§4/§16 above) is itself a financial-correctness fix: before it, a same-day Balance Sheet "as of" figure and every date-ranged financial aggregate silently excluded most of the requested day.

---

## 15. HR / Payroll, Assets

HR (attendance, leave, payroll-run summaries, commission) and Assets (register, maintenance, calibration, costs) reports are **unchanged**, reused as-is. Payroll stays gated on `payroll.view` alone — not exposed to ordinary HR viewers. No jurisdiction-specific (WPS/GOSI/EOBI) reporting was added.

---

## 16. Import History

P4.6's `ImportJob` rows, now available as a real filterable/exportable report (type, file, actor, status, row counts) — the same `/admin/onboarding` workspace still shows the last 20 inline; this is the same data for a longer look-back. Gated on `data_import.manage`, matching P4.6's own permission — patient rows from import errors are never exposed (unchanged, `ImportJobError` never stored source values in the first place).

---

## 17. Export Architecture

Two routes:
- `GET /api/reports/export?category=...` — the twelve report categories, sharing the workspace's own from/to/branch/provider filters.
- `GET /api/reports/export/data/{type}` — the six data-portability exports (§20 below) plus the two audit exports, filtered by from/to/branch.

Every export independently re-checks permissions server-side (`can`/`assertCan`) — never assumes page access implies export authorization (§37). CSV generation goes through the one shared, formula-injection-safe writer (`platform/csv.ts`), with a UTF-8 BOM on report/data-portability exports for reliable Excel compatibility.

---

## 18. CSV Safety

`escapeCsvFormulaInjection`/`toCsv` were **promoted from P4.6's import-writer to one shared module**, `src/lib/platform/csv.ts` — closing the exact gap `BACKLOG.md` flagged during P4.6 (report exports had no formula-injection protection; the import-side writer did). Both `platform/import/csv.ts` and `analytics/csv.ts` now re-export from this one implementation. Verified by test: a cell beginning with `=`/`+`/`-`/`@` is prefixed with `'`; Arabic/Urdu text round-trips through the writer unescaped and correctly encoded, with the UTF-8 BOM confirmed present in the raw response bytes (via a live browser fetch reading the ArrayBuffer directly — `EF BB BF`, the exact UTF-8 BOM sequence).

---

## 19. Export Limits

**50,000 rows** (`MAX_EXPORT_ROWS`, `src/lib/platform/reports.ts`) — the spec's own suggested figure, a defensible V1 limit. Every row-level export counts matching rows *before* fetching them and throws a clean, explained `ExportTooLargeError` (413, "narrow your filters") if exceeded — **never a silent truncation**. Stock Movement uses its own smaller 5,000-row cap, reflecting how much larger a lifetime stock ledger can realistically get. Verified by unit test and by code inspection of every new export function's `assertExportRowLimit` call site.

---

## 20. Permissions / Tenant Isolation

Every report/export reuses the existing domain-permission model (§53's own preference over a new `reports.view_everything`) — see `docs/REPORTING_AND_EXPORTS.md`'s full permission table. Tenant isolation reuses `getAuthorizedBranchScope`/`narrowBranchFilter` unchanged (established since P0) — `organizationId` is always derived from the session, never trusted from a query param. **Verified by test**: an org-B session's Patient Registration/GL exports never contain org-A's rows; an org-B session requesting org-A's own branch ID is rejected with `ForbiddenError`, not silently ignored; a branch-B-scoped session sees zero of branch A's appointments while a session with branch-A access sees them correctly.

---

## 21. Sensitive Export Audit

`logSensitiveExport` (`src/lib/platform/reports.ts`) writes one `audit_log` row per sensitive export (actor, organization, export type, filters, row count — **never the exported rows themselves**), applied to: the financial-report, HR/payroll-report, Patient Registration, and Import History category CSVs, plus the Patient Master, General Ledger, Trial Balance, audit-log, and clinical-access-log data-portability exports.

---

## 22. Data Portability

Implemented: Patient Master, General Ledger, Trial Balance, Collections, Refunds, Stock Movement, Audit Log, Clinical Access Log — see `docs/DATA_EXPORT_DICTIONARY.md` for the full field-by-field reference. Patient Master is demographics-only (no national ID/passport/auth data — verified by test that the exported row shape excludes these fields entirely). Bulk standalone exports of Services/Products/Suppliers/Employees/Providers master data were judged out of this phase's realistic scope — see §24. Clinical data portability (encounters, diagnoses, prescriptions, results) stays explicitly deferred per §49's own instruction; this phase does not hold open for it.

---

## 23. Date / Timezone Semantics

Fixed centrally: `endOfLocalDay`/`startOfLocalDay`/`parseLocalDateParam` now live in `src/lib/utils/dates.ts` as the one shared implementation every date-range boundary in the reporting surface uses — `from` is the inclusive start, `to` is the inclusive end, of the selected local calendar date, constructed from local Date components (never a raw millisecond offset or a UTC-`Z` suffix, both of which shift boundaries across a non-UTC server timezone). Verified by test that an explicit same-day `from=to=today` filter genuinely includes activity registered anywhere in that day.

---

## 24. Reconciliation Validation

Verified by test (`test/integration/p4-7-reporting-export-data-portability.test.ts`):
- **General Ledger export**: total debit = total credit across all exported rows.
- **Trial Balance export**: exported total debit/credit exactly matches `trialBalance()`'s own computed totals; `isBalanced` is true.
- **AR Aging**: an invoice issued 40 days ago lands in the 31–60 bucket, not `current`.
- **AP Aging**: a supplier invoice with no due date is reported as `undated`, never guessed into a bucket.
- **Inventory reconciliation**: a deliberately-constructed zero-cost positive-balance batch is flagged `unvaluedPositiveStock`; a deliberately-constructed negative ledger balance is flagged `negativeStock`.

---

## 25. Export Performance (§67)

Measured locally against `his_test` (local PostgreSQL), most recent clean run:

| Export | Rows | Time |
|---|---|---|
| Patient Master | 1,005 | 42ms |
| Patient Master | 10,005 | 301ms |
| Stock Movement | 1,000 | 55ms |

Both scale comfortably within any realistic clinic-scale export, well under the 50,000-row limit.

---

## 26. Browser Verification

Verified live against a real running dev server (`his_dev`, local Postgres), logged in as the seeded Super Admin:

1. **Reports workspace**: all 12 tabs render correctly with real data — Practice (row-level appointments), Clinical (new Prescriptions/Lab/Imaging KPIs), Financial (AR/AP aging tables, GL/TB export buttons), Billing/Revenue (Invoice/Collections/Refund reports), Inventory (Low Stock, Reconciliation section, Opening Inventory note logic), HR, Assets, Daily Operations (billing vs. collections correctly separated), Patients (Patient Master export button), Lab, Radiology, Import History (showing P4.6's own real historical import jobs).
2. **Daily Operations filter**: renders a real one-day snapshot with correct zero-state for a day with no activity.
3. **Invoice report filter + export**: verified via the Billing/Revenue tab and a direct authenticated fetch.
4. **Stock report filter + export**: Inventory tab + Stock Movement export link verified present and correctly wired.
5. **Financial report export**: General Ledger and Trial Balance exports fetched directly — confirmed correct `Content-Type`, `Content-Disposition` filename, `Cache-Control: no-store`, real balanced GL rows, and a Trial Balance TOTAL row matching debit=credit exactly (737.80 = 737.80 on the real dev dataset).
6. **Patient export**: Patient Master export fetched — correct header row, correctly empty (no patients in the dev seed).
7. **Import History report**: verified rendering the real ImportJob rows created during P4.6's own browser verification session.
8. **Authorization**: verified live via `curl` (no session cookie) that an unauthenticated request to a new export route receives a real 307 redirect to `/login` from the existing, pre-established `src/proxy.ts` staff-session gate — confirming the new routes inherit the same authentication protection as every other route, and that each route's own explicit `if (!session)` check is real defense-in-depth. Role-based 403 (an authenticated session lacking a specific permission) was verified via the integration test suite's `ForbiddenError` assertions rather than a second live login, given the seeded dev environment's only readily available login is Super Admin.

**A real production bug was found and fixed during this verification.** Clicking the "Billing / Revenue" tab crashed the entire page with `TypeError: report.collections.toFixed is not a function`. Root cause: `loadReport()`'s `revenue-cycle` case merged `getRevenueCycleReport`'s result (which already has a `collections` field — a number) with `getCollectionsReport`'s result under the *same* key `collections` (an object), silently overwriting the number. An explicit `as RevenueCycleReportShape` type assertion at the render call site (a pre-existing, necessary pattern for this page's category-union return type) meant TypeScript did not catch the mismatch either. Fixed by renaming the merged fields to `invoiceReport`/`collectionsReport`/`refundReport`; re-verified live afterward — the tab now renders correctly with all three new row-level reports and both export links. Logged as an addendum to the existing "no component-level test harness" `BACKLOG.md` finding from P4.6, since this is the same class of gap (a bug invisible to the 583-test server-only integration suite, caught only by real rendering).

The dev server was stopped afterward; no stray process left running.

---

## 27. Schema / Migration Changes

**None.** No Prisma schema changes, no new migration — every new report/export was built entirely from existing tables and relations, per §72's own "prefer no new schema" instruction.

---

## 28. Files Changed

**New shared infrastructure**: `src/lib/platform/csv.ts`, `src/lib/platform/reports.ts`

**New report/export domain files**: `src/lib/domains/analytics/reports/{daily-operations,patients,import-history}.ts`, `src/lib/domains/analytics/exports.ts`

**Extended report domain files**: `src/lib/domains/analytics/reports/{practice,clinical,financial,revenue-cycle,inventory,index}.ts`, `src/lib/domains/analytics/schemas.ts`, `src/lib/domains/analytics/csv.ts` (now a re-export), `src/lib/platform/import/csv.ts` (now a re-export)

**Date utilities**: `src/lib/utils/dates.ts` (new `startOfLocalDay`/`endOfLocalDay`/`parseLocalDateParam`)

**App/UI**: `src/app/(dashboard)/reports/page.tsx` (12-category rewrite), `src/app/(dashboard)/inventory/page.tsx` (date-filter fix), `src/app/(dashboard)/admin/audit/page.tsx`, `src/app/(dashboard)/admin/clinical-access-log/page.tsx` (export buttons)

**API routes**: `src/app/api/reports/export/route.ts` (rewritten for 12 categories + limits + audit), `src/app/api/reports/export/data/[type]/route.ts` (new)

**Tests**: `test/integration/p4-7-reporting-export-data-portability.test.ts` (new), `test/integration/lab-order-state-integrity.test.ts` (unrelated flake fix, carried in from the prior turn — see §29)

**Docs**: `docs/REPORTING_AND_EXPORTS.md`, `docs/DATA_EXPORT_DICTIONARY.md`, `BACKLOG.md` (two new findings + one addendum), this report

---

## 29. Tests Added / Updated

`test/integration/p4-7-reporting-export-data-portability.test.ts` — a fresh, isolated two-organization fixture (not the shared seed), 20 tests covering: the date-range fix, CSV formula-injection + Unicode/BOM, export row limits (no silent truncation), AR/AP aging bucketing, inventory movement/reconciliation, GL/Trial Balance reconciliation, Patient Master field exclusions, screen/export filter consistency, a fresh-org Daily-Operations acceptance workflow (Patient → Appointment → Check-in → Encounter → Charge → Invoice → Payment → Refund), cross-organization isolation, cross-branch isolation, permission gating, and representative export performance. **20/20 passing**, confirmed repeatable across two consecutive full-suite runs.

---

## 30. Regression Status

All run against `his_test` (local PostgreSQL) — no Supabase, no production:

| Check | Result |
|---|---|
| `npx prisma validate` | ✅ Schema valid |
| `npx prisma migrate status` | ✅ Up to date (39 migrations — unchanged) |
| `npm run typecheck` | ✅ Clean |
| `npm run lint` | ✅ Clean |
| `npm run test` (run 1) | ✅ 61/61 files, 583/583 tests |
| `npm run test` (run 2) | ✅ 61/61 files, 583/583 tests — confirmed repeatable |
| `npm run build` | ✅ Compiled successfully, all routes generated including `/api/reports/export/data/[type]` |

The previously-documented `lab-order-state-integrity.test.ts` intermittent (a test-query ambiguity, fixed in the prior conversation turn per the user's own explicit request, unrelated to P4.7's own scope) did not reappear in either full-suite run.

---

## 31. P4.6 Reservations — Carried Forward, Not Redesigned

- **A. Batched import partial completion**: unchanged; Import History report/export surfaces exactly the recorded row counts per job, including partial-completion states, without claiming imports are universally all-or-nothing.
- **B. Opening Inventory vs. GL**: unchanged; §12/§18 above adds a *visibility* prompt only — no automatic journal posting was added in this phase.
- **C. Employee/Provider duplicate matching**: unchanged, still advisory.
- **D. Import provenance**: unchanged; Import History reports the ImportJob's own recorded counts, not an overstated per-row FK claim.
- **E. Browser testing**: reaffirmed this phase — see §26's own found-and-fixed bug.

None of these were reopened or redesigned.

---

## 32. Remaining Reporting / Portability Backlog

1. **Procurement filtering** (§13/§24) — `/purchasing` has no date/branch/supplier filter; logged to `BACKLOG.md`.
2. **Bulk standalone master-data exports** (Services, Products, Suppliers, Employees, Providers) were not built — the existing list screens and P4.6's import templates already document each entity's field shape; a future phase could reuse the same `toCsv`/row-limit pattern cheaply if this becomes a real customer need.
3. **No screen-side pagination retrofit** for the pre-existing aggregate report tabs — export-side row limits were this phase's actual mandate.
4. **Clinical data portability** (encounters, diagnoses, prescriptions, lab/imaging results) remains explicitly deferred, per §49.
5. The `BACKLOG.md` addendum on the "no component-level test harness" finding (§26) — still open, a standalone future decision.

None of these block commercial use of the reporting/export surface delivered this phase.

---

## 33. Acceptance Criteria

1. ✅ Current report architecture traced before any change — §3.
2. ✅ Working reports reused, not rewritten unnecessarily — §3, §14, §15.
3. ✅ Reports workspace provides coherent navigation — §6, 12 categories.
4. ✅ Daily Operations reporting exists — §7.
5. ✅ Patient registration reporting exists — §8.
6. ✅ Appointment reporting exists — §8.
7. ✅ Billing/invoice reporting exists — §10.
8. ✅ Collections reporting exists — §10.
9. ✅ Refund reporting exists — §10.
10. ✅ Inventory stock/movement reporting exists — §12.
11. ✅ Procurement/payables reporting usable within existing architecture — §13 (with an honestly-documented filter gap).
12. ✅ Existing financial statements remain correct — §14, unchanged formulas, date-fix only improves correctness.
13. ✅ Key financial reports can be exported — §14, GL + Trial Balance.
14. ✅ Patient Master export exists — §22.
15. ✅ Core operational exports use CSV — §17.
16. ✅ Screen/export filters are server-side and consistent — §20, verified by test.
17. ✅ Exports respect organization/branch isolation — §20, verified by test.
18. ✅ Sensitive exports are permission-gated — §21.
19. ✅ CSV formula injection is prevented — §18, verified by test.
20. ✅ Unicode works — §18, verified with real Arabic/Urdu text + BOM.
21. ✅ Export row limits exist — §19.
22. ✅ No silent export truncation — §19.
23. ✅ Decimal-safe financial math remains intact — no float-accumulation was introduced; all money math stays on `Decimal`/`Number()`-at-final-boundary, matching pre-existing convention.
24. ✅ Report date/timezone semantics are consistent — §23.
25. ✅ Report/export errors do not expose internals — `ExportTooLargeError` → clean 413; every other exception → the existing global error boundary.
26. ✅ Representative browser verification performed — §26, including a real bug found and fixed.
27. ✅ Data-export documentation exists — `docs/REPORTING_AND_EXPORTS.md`, `docs/DATA_EXPORT_DICTIONARY.md`.
28. ✅ Full regression remains acceptably clean — §30.
29. ✅ P4.6 reservations remain tracked — §31.
30. ✅ P4.8 has NOT started.

All 30 criteria met.

---

## 34. Acceptance Decision

**Can P4.7 be closed? YES.**

All required reporting and export capabilities are implemented, tested (20 new tests, 100% passing, confirmed repeatable), documented, and verified live in a real browser — including finding and fixing one genuine production bug during that verification, on top of the critical date-range and CSV-safety fixes applied to the pre-existing reporting surface. The full regression suite (schema, types, lint, 583 integration tests run twice, production build) is clean. No blockers remain. Remaining items (§32) are deliberate, documented, non-blocking scope cuts.

Per this phase's own explicit instruction: **UI/UX visual redesign, P4.8, P4.9, regulatory architecture, another audit, and another backlog cleanup are NOT started.** This report is returned for review.
