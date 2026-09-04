# Reporting & Exports

How clinic operators and management get operational and financial visibility
into Avant HIS, and how a clinic exports its own data — P4.7's own
deliverable.

## Overview

`/reports` is the central reporting workspace — twelve categories, one
shared date/branch/provider filter bar, one CSV export mechanism. It builds
on P4.6's own established discipline: reuse real domain functions, never
invent a second source of truth, and keep tenant/branch isolation
non-negotiable.

**Data portability** (structured exports of the org's own operational data —
Patient Master, General Ledger, Trial Balance, Collections, Refunds, Stock
Movement, and the two audit exports) lives at `/api/reports/export/data/[type]`,
a separate small route from the twelve report categories — see
[`docs/DATA_EXPORT_DICTIONARY.md`](DATA_EXPORT_DICTIONARY.md) for the full
field-by-field reference.

## Report Categories

| Category | Covers |
|---|---|
| Practice | Appointments, no-shows, waiting times, provider/room utilization, patient visits |
| Clinical | Encounter volume, diagnosis trends, orders, follow-ups, prescriptions |
| Financial | Revenue, collections, AR/AP aging, income statement, balance sheet, cash flow |
| Billing / Revenue | Charges, claims, rejections, Invoice/Collections/Refund Reports |
| Inventory | Stock on hand, valuation, low stock, expiry, reconciliation |
| HR | Attendance, leave, payroll runs, commission |
| Assets | Register, maintenance, calibration, costs |
| Daily Operations | One day's operational snapshot (§8) |
| Patients | Patient Registration Report (§9) |
| Lab | Lab orders by status, turnaround time (§13) |
| Radiology | Radiology orders by status, turnaround time (§14) |
| Import History | P4.6 ImportJobs, reshaped as a filterable/exportable report (§29) |

## Permissions

Every category is gated on the **domain permission** that already governs
that data — never a new `report.view_everything`:

| Category | View permission |
|---|---|
| Practice, Daily Operations | `appointment.view` |
| Patients | `patient.view` |
| Clinical, Lab, Radiology | `encounter.view` (Lab/Radiology also accept the operational `lab_result.*`/`imaging_*` permissions, so Laboratory/Radiology Technicians — who never hold `encounter.view` — can see their own category) |
| Financial | `accounting.view` |
| Billing / Revenue | `invoice.view` OR `claim.create` |
| Inventory | `inventory.view` |
| HR | `payroll.view` |
| Assets | `inventory.view` |
| Import History | `data_import.manage` |

**Exporting** any category additionally requires `reports.export` — an
existing permission (P0-era) held only by management-tier roles (Super
Admin, Organization Administrator, Clinic Manager, Accountant, HR Manager).
An Inventory Manager, for example, can *view* the Inventory tab
(`inventory.view`) but cannot export it — a deliberate, pre-existing
two-tier split this phase reused rather than redesigned.

**Data-portability exports** (`/api/reports/export/data/[type]`) additionally
require the export's own domain permission (`patient.view` for Patient
Master, `accounting.view` for GL/Trial Balance, etc.) — see the Data
Dictionary for the full table. The two audit exports (`audit-log`,
`clinical-access-log`) are gated on `audit.review` alone (already the
tightest permission in the catalog — Super Admin/Org Admin only) rather than
also requiring `reports.export`, since requiring both would add nothing
(no role holds both `reports.export` and `audit.review` without already
being Super Admin/Org Admin) while being one more thing to keep in sync.

## Date / Timezone Semantics (§44/§45)

**The Date Range Rule, fixed this phase**: `from` is the inclusive
*beginning* of the selected local calendar date; `to` is the inclusive *end*
of it — never its beginning. Before this phase, an explicit `?to=2026-09-30`
resolved to `2026-09-30T00:00:00` (midnight at the *start* of that day),
silently excluding virtually all of that day's real activity from every
report and export. Fixed centrally in `defaultReportFilters`
(`src/lib/domains/analytics/schemas.ts`), using the shared
`startOfLocalDay`/`endOfLocalDay`/`parseLocalDateParam` helpers now in
`src/lib/utils/dates.ts` — every report/export in this app resolves `to`
through the same function, so a `from`/`to` date range means exactly what it
says everywhere, not a different rule per report. The inventory ledger
page's own date filter had a related but different bug (UTC-`Z`-suffixed
boundaries, shifting by the server's timezone offset rather than dropping a
day outright) — fixed the same way, same shared helpers.

Financial "as of" figures (Trial Balance, Balance Sheet) use `to` as the
as-of instant — now correctly *end* of the selected day rather than its
start, so a same-day balance genuinely includes that day's activity.

## Branch Scope

Every report/export reuses the existing `getAuthorizedBranchScope`/
`narrowBranchFilter` pair (`src/lib/platform/branch-scope.ts`, established
since P0): Super Admin is the one org-wide role; every other session's real
reach is exactly its `user_branch_access` rows. Requesting a branch outside
that scope throws `ForbiddenError`, never silently widens or narrows to
"whatever the caller can see."

## Executive / Daily Operations Reporting

The Daily Operations report (§8) is a single calendar day's operational
snapshot — appointments (scheduled/checked-in/completed/cancelled/no-show/
walk-in), encounters completed, and, where the caller holds the relevant
permission, billing, collections, pharmacy, lab, and imaging counts.
**Billing (invoiced amount) and Collections (cash received) are always
reported as two separate figures, never summed** — an invoice raised today
may be paid days later, and cash collected today may settle an older
invoice; conflating them would misstate both, per §8's own explicit warning.

## Patient / Appointment Reporting

**Patient Registration Report** (§9): MRN, name, DOB, gender, mobile,
branch, registration date — deliberately privacy-conscious, no clinical
fields, no national ID/passport/address (see Patient Master export below for
the fuller demographic shape).

**Appointment Report** (§10): extends the existing Practice report with a
row-level appointment listing (date/time, provider, service, branch, status,
source) alongside the pre-existing status/utilization breakdowns.

**Provider Activity**: the existing Practice report's Provider Utilization
table (appointments, booked/available minutes, utilization %) already
covers §11's ask; HR's own Commission-by-Provider section covers the
commission figure where the accounting/commission model supports it.

## Clinical Operations

Encounter volume, diagnosis trends (coded diagnoses, aggregated — never
patient-level detail on this general-management-facing report), orders by
type, follow-ups, and prescriptions count. Lab and Radiology got their own
categories (§13/§14) rather than folding fully into Clinical, since their
natural audience (Laboratory/Radiology Technician) doesn't hold
`encounter.view`.

**Lab / Radiology** (§13/§14): orders by status, plus turnaround time —
explicitly defined, not guessed: Lab's TAT is order→result-entry and
result-entry→verification (real `ClinicalOrder.orderedAt`/
`LabOrderTest.enteredAt`/`verifiedAt` timestamps); Radiology's is
order→perform and perform→report (`ImagingOrder.performedAt`/`reportedAt`).
Report-amendment history is excluded per §14's own instruction.

## Billing / Revenue

- **Invoice Report** (§15): invoice #, patient, branch, date, gross,
  discount, tax, net, paid, outstanding, status.
- **Collections Report** (§15): receipt #, date, patient/invoice, method,
  amount, cashier.
- **Refund Report** (§15): refund #, date, invoice, amount, reason, status,
  requested/authorized by.

## AR / AP Aging (§16/§21)

**AR Aging**: bucketed (Current/1–30/31–60/61–90/90+) from `Invoice.issuedAt`
— `Invoice` has no `dueDate` field, so this is honestly labeled
`basis: "issuedAt"` rather than implying a due-date basis the schema doesn't
have.

**AP Aging**: bucketed from `SupplierInvoice.dueDate`, which *is* modeled
but nullable. A supplier invoice with no due date recorded is excluded from
the buckets and reported separately as `undated`/`undatedAmount` — never
silently treated as current or given an invented due date.

## Inventory

Stock On Hand, Low Stock (existing `listLowStock`), Near-Expiry, Expired,
Fast/Slow Moving, and Valuation (batch-level specific-identification cost,
unchanged from P4.5/earlier) are all unchanged and reused. New this phase:

- **Stock Movement export** (§17): the existing paginated ledger viewer
  (`listLedgerEntries`, already used by `/inventory`'s own ledger tab) now
  has an export-side counterpart returning the full matching set (date,
  product, batch, branch, transaction type, quantity, reference
  type/id, actor).
- **Inventory Reconciliation** (§19): negative stock, unvalued positive
  stock (a positive-balance batch with no real cost basis), and expired
  saleable stock (already-expired batches still showing a positive balance)
  — all detected directly from the stock ledger/batch data already fetched
  for the Inventory report, not a separate reconciliation engine.
- **Opening Inventory setup note** (§18): if any `StockLedgerEntry` with
  `referenceType: "opening_balance"` exists for the org, the Inventory
  report surfaces a plain-language prompt to confirm the corresponding
  General Ledger opening balance has been posted (see
  `docs/CLINIC_ONBOARDING.md`'s Accounting Setup section) — a visibility
  aid, not an automated reconciliation engine, and it never posts a journal
  itself.

## Procurement (§20) — a documented limitation, not a new report

`/purchasing` already lists Purchase Requests, Purchase Orders, and Supplier
Invoices with status and pagination. It does **not** currently offer
date/branch/supplier filters (§20's own suggested filter list). Building
those filters was judged a real, standalone UI addition to an existing
screen rather than a new report, and was not attempted in this phase — see
Remaining Reporting Backlog. AP Aging (above) already gives management the
one figure this section's own criterion (`payables aging usable`) most
directly needs.

## Finance / Accounting

Trial Balance, Income Statement, Balance Sheet, Cash Flow, and the Journal
List/detail viewer are all pre-existing (`accounting/reports.ts`) and
**unchanged** — reused as-is, per this whole engagement's "no business rule
implemented twice" discipline. New this phase:

- **General Ledger export** (§22/§23): one row per `journal_line` (the real
  atomic ledger unit), joined to its account and parent journal — journal #,
  date, account code/name, debit, credit, reference type/id, branch, memo.
- **Trial Balance export** (§24): CSV of the same `trialBalance()` computation
  the `/accounting` screen already renders, plus a TOTAL row. The exported
  total debit/credit always equals the displayed total (same computation,
  no re-derivation) — verified by test.

## HR / Payroll

Attendance, leave, and payroll-run summaries (already existing) reused
unchanged. Payroll stays gated on `payroll.view` — not exposed to ordinary
HR viewers, matching §27's own instruction; no jurisdiction-specific
(WPS/GOSI/EOBI) reporting was added, per §26.

## Assets

Register, maintenance, and calibration reports (already existing) reused
unchanged — no depreciation accounting was added (none is modeled).

## Import History (§29)

P4.6's `ImportJob` rows, reshaped as a real filterable/exportable report
(type, file, status, actor, started/completed, row counts) — the same
`/admin/onboarding` workspace still shows the last 20 inline for day-to-day
onboarding use; this is the same data for a longer look-back and export.
Gated on `data_import.manage`, matching P4.6's own permission.

## Audit / Access Export (§30)

`/admin/audit` and `/admin/clinical-access-log` (both pre-existing, P2-era)
each gained a CSV export button, sharing the page's own existing date/branch
filters. Both stay gated on `audit.review` alone — no operational role holds
it. Exports exclude the mutation payload (`oldValues`/`newValues`) and
`ip`/`userAgent` entirely; this is an activity trail for review, not a raw
table dump.

## Data Portability (§31/§48)

See [`docs/DATA_EXPORT_DICTIONARY.md`](DATA_EXPORT_DICTIONARY.md) for the
full list. Patient Master, General Ledger, Trial Balance, Collections,
Refunds, and Stock Movement exports are implemented. Bulk standalone exports
of Services/Products/Suppliers/Employees/Providers master data were judged
out of this phase's realistic scope (see Remaining Reporting Backlog) — the
existing list screens for each already show that data on-screen, and P4.6's
import templates already document each entity's exact field shape.

Clinical data portability (encounters, diagnoses, prescriptions, lab/imaging
results) was explicitly deferred per §49's own instruction — this phase
does not hold open for a FHIR-like export.

## Export Formats

CSV only (§32) — UTF-8, with an optional BOM (`toCsv(..., { bom: true })`,
`src/lib/platform/csv.ts`) on every report/data-portability export so Excel
reliably detects UTF-8 rather than guessing a legacy codepage, which is what
actually breaks non-Latin names (Arabic/Urdu) on open — verified with real
Arabic/Urdu text round-tripping correctly through the writer. No XLSX, no
PDF generation infrastructure was added; browser print (pre-existing for
invoices/payslips/lab and imaging reports) remains the printable-report
mechanism for anything commonly printed.

## CSV Formula-Injection Protection (§33)

Every value this app *generates* into a CSV — a report cell, a template
header, a dry-run/commit error report — is escaped if it begins with `=`,
`+`, `-`, or `@` (a leading `'` forces plain text in every common
spreadsheet application). This was previously split across two
implementations (P4.6's import writer had it; the pre-existing
`analytics/csv.ts` report-export writer did not — a real gap logged to
`BACKLOG.md` during P4.6). Both now re-export from the one shared
`src/lib/platform/csv.ts`. Export-time display safety only — never mutates
how a value is parsed or stored.

## Export Limits (§38/§39)

**50,000 rows** (`MAX_EXPORT_ROWS`, `src/lib/platform/reports.ts`) — a
defensible V1 limit, the spec's own suggested figure. Every row-level export
counts its matching rows *before* fetching them and throws
`ExportTooLargeError` (a clean 413 response with a friendly message naming
the actual count and asking to narrow filters) if the count exceeds the
limit — **never a silent truncation** to the first 50,000. Stock Movement
uses a smaller 5,000-row cap of its own, reflecting how much larger a
lifetime stock ledger can realistically get.

## Filter Consistency (§36)

The screen and its export always build their `where` clause from the same
`filters` object — verified directly by test (`getInvoiceReport`'s `total`
equals `exportInvoiceRows`' row count for identical filters). No export
silently widens to "everything" because the UI's own filtering happened to
be client-side only — there is no client-side-only filtering anywhere in
this reporting surface.

## Export Authorization (§37)

Every export route independently re-checks permissions server-side
(`can`/`assertCan`) — never assumes "the caller could see the report page,
therefore the export is authorized." Verified live: an unauthenticated
request to any export route is redirected to `/login` by the existing
staff-session proxy (`src/proxy.ts`, pre-existing since Phase 12) before
ever reaching the route handler — the route's own `if (!session)` check is
real defense-in-depth, not dead code, for any caller that isn't intercepted
by that layer.

## Sensitive Export Audit (§55)

`logSensitiveExport` (`src/lib/platform/reports.ts`) writes one `audit_log`
row per sensitive export — actor, organization, export type, the filters
used, and the row count. **Never the exported rows themselves.** Applied to:
financial-report CSV, HR/payroll-report CSV, Patient Registration Report
CSV, Import History CSV, Patient Master export, General Ledger export,
Trial Balance export, and both audit exports.

## Error Handling (§25/§52)

No report/export exposes a Prisma error, stack trace, raw SQL, or storage
internal. `ExportTooLargeError` becomes a clean 413 JSON error; every other
unexpected exception propagates to the app's existing global error boundary
(a generic "Something went wrong" page/response), never the raw error
message.

## Report Snapshot Semantics (§46/§47)

Stock On Hand is always *current* state; Stock Movement for a date range is
the real historical ledger movements in that range — never conflated.
Financial statements respect period logic (`asOf`) already established by
`accounting/reports.ts`. No historical "as it was on this date" balance is
claimed for anything this schema doesn't genuinely preserve point-in-time
history for (e.g. AR/AP aging is always computed from *current* outstanding
balances, not reconstructed as of a past date).

## Known Limitations

- **Procurement filtering** — see the Procurement section above.
- **Bulk standalone master-data exports** (Services/Products/Suppliers/
  Employees/Providers) were not built this phase — see Remaining Reporting
  Backlog in the P4.7 report.
- **No jurisdiction-specific payroll/regulatory reporting** — deliberately
  out of scope (§26), matching this codebase's existing jurisdiction-neutral
  approach.
- **No screen-side pagination retrofit** for the pre-existing aggregate
  report tabs (Practice/Clinical/Financial/etc.) — export-side row limits
  (§38/§39) were this phase's actual mandate; on-screen pagination for every
  report tab was judged a separate, larger UI project.

## Re-running Tests

```bash
npx prisma validate
npx prisma migrate status
npm run typecheck
npm run lint
npm run test            # full integration suite, against his_test only
npm run build
```

The reporting/export test suite lives in
`test/integration/p4-7-reporting-export-data-portability.test.ts` — a fresh,
isolated two-organization fixture (not the shared seeded one), re-runnable
any number of times without manual cleanup.
