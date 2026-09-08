# Clinic Onboarding & Data Import

How a completely fresh Avant HIS organization gets configured and populated
without a developer touching the database directly — P4.6's own deliverable.

## Overview

Two distinct capabilities, deliberately not conflated into one giant upload
feature:

- **Clinic Onboarding** — setting up the clinic itself (branches, users,
  providers, services, products, accounting mappings, ...) through existing
  admin screens, with a checklist workspace tying them together.
- **Data Migration / Bulk Import** — safely importing existing master data
  (patients, products, suppliers, services, opening inventory, ...) from a
  CSV, through a mandatory dry-run-before-commit workflow.

The central rule: **bad imports must fail before mutating production data.**
Every import goes through Template → Upload → Parse → Normalize → Dry Run →
Validate → Duplicate/Conflict Analysis → Preview → Explicit Commit → Result
Report → Audit Trail. There is no silent partial import.

## Fresh Deployment vs. Clinic Onboarding

`npm run db:seed` (`prisma/seed.ts`) creates the **platform shell only**:
the permission catalog, the system role definitions, one default
Organization + Branch, and the initial Super Admin bootstrap account
(`admin@avant.local` locally; a freshly generated, one-time-shown password
in production — see `DEPLOYMENT.md`). This is deliberately the same
distinction P4.6 §75 asks for: **the seed is a platform bootstrap, never a
commercial onboarding workflow.** Everything a real clinic actually needs —
branches beyond the first, staff, providers, services, products, suppliers,
accounting mappings, opening stock, patient records — is configured through
the onboarding workspace and its imports, not by re-running or editing the
seed script.

Organization *creation itself* (multi-tenant signup/provisioning) is outside
this phase's scope — P4.6 treats an Organization's existence as a
precondition established by deployment/tenant provisioning, and focuses on
**configuring** an already-provisioned organization. This matches the
phase's own named scope (`organization/settings` to inspect, not
"organization creation").

## Existing Fresh-Clinic Setup (traced before building anything)

Every one of these already had a real, working admin-facing domain function
and screen before P4.6 — onboarding's job was to tie them together with a
readiness view and add the missing bulk-import path, not rebuild any of
them:

| Step | Existing mechanism |
|---|---|
| Organization | `updateOrganization` (`identity/org-structure.ts`) — `/admin/settings` |
| Branches | `createBranch`/`updateBranch` — `/admin/settings` |
| Departments | `createDepartment`/`updateDepartment` — `/admin/settings` |
| Rooms | `createRoom`/`updateRoom` — `/admin/settings` |
| Users | `createUser` (creates the user + role assignment + branch access in one call) — `/admin/users` |
| Roles / branch access | Same `createUser`/`updateUser` call; roles via `/admin/roles` |
| Providers | `createProvider` — `/providers` |
| Employees | `createEmployee` — `/employees` |
| Provider/User/Employee links | `linkEmployeeUser`/`unlinkEmployeeUser` (P3.12); a separate, deliberate Admin step — never automatic |
| Services | `createService` — `/services` |
| Products | `createProduct` — `/inventory` |
| Medications → Product | `createMedication` already creates both the Product and the Medication row in one transaction — no separate linking step needed |
| Suppliers | `createSupplier` — `/suppliers` |
| Account mappings | `setMapping`/`listMappings` — `/accounting` |
| Opening inventory | **No existing path** — this is what P4.6 adds (see below) |

**A fresh clinic becomes operational** (register a patient, book an
appointment, consult, bill, dispense, receive payment, post accounting) once
it has: an active Branch, at least one Provider, at least one Service, and
the core billing account mappings (Accounts Receivable, Revenue, and a
tender/payment account). Pharmacy/inventory-specific requirements (Products,
Medications, the Inventory Asset/COGS mappings) only apply when
pharmacy/inventory is actually enabled for that organization (the existing
`pharmacy_enabled` setting) — a clinic that doesn't dispense never needs
them.

### Problems found while tracing

- **No bulk-import path existed at all** for any entity — every one of the
  above had to be created one row at a time through its own screen. For a
  clinic migrating from an existing system with hundreds/thousands of
  patients, products, or suppliers, this was operationally unworkable
  without direct database access (which is exactly what this phase exists
  to remove the need for).
- **No single "is this clinic ready to operate" view existed.** An admin
  had no way to see, in one place, what was still missing before go-live —
  they'd only discover a gap (e.g. a missing account mapping) when an
  actual operational action failed.
- **Opening inventory had no supported path of any kind** — not even a
  manual one. The only way to represent existing stock on day one was
  either leaving it unrepresented (every product starts at zero, wrong) or
  a developer manually inserting `StockLedgerEntry` rows directly — exactly
  the kind of manual database edit this phase exists to eliminate.

## Onboarding Architecture

```
src/lib/platform/import/
  csv.ts       — dependency-free CSV parser/writer, safety limits, formula-injection-safe export
  types.ts     — ImporterDefinition<T>, ParsedRow<T>, shared error codes
  engine.ts    — runDryRun / runCommit / cancelImportJob (the one reusable orchestrator)
  parsers.ts   — shared field-level validators (date/number/enum/email/string)

src/lib/domains/onboarding/
  readiness.ts          — getOnboardingStatus(session)
  imports/
    registry.ts          — getImporter(session, type), getImporterCatalog(session)
    patients.ts, services.ts, products.ts, suppliers.ts,
    medications.ts, employees.ts, providers.ts, opening-inventory.ts

src/app/(dashboard)/admin/onboarding/
  page.tsx           — the workspace: readiness review + import cards + import history
  import-dialog.tsx  — the one reusable upload → dry-run → review → commit dialog
  cancel-button.tsx
  actions.ts         — dryRunImportAction / commitImportAction / cancelImportAction

src/app/api/onboarding/
  template/[type]/route.ts   — downloadable CSV template, generated from the importer's own headers
  errors/[jobId]/route.ts    — downloadable dry-run/commit error report
```

One reusable engine, one `ImporterDefinition<T>` shape per entity
(`parseRow`, `detectDuplicates`, `commitBatch`) — not a bespoke parser per
entity type.

### Why no persistent file storage (P4.6 §13)

The uploaded CSV is **never written to disk or the database**. It is parsed
entirely in request memory for the dry run; the browser then **resubmits
the same file** when the user clicks Commit. The server re-parses and
re-validates it from scratch and confirms its SHA-256 hash still matches
the one recorded at dry-run time (`ImportJob.contentHash`) before touching
a single domain row. This is Option A from the phase's own §13 — the
simplest, safest choice given this codebase had no generic object-storage
adapter to build on, and it means there is never a file at rest anywhere
to secure, expire, or leak.

## Onboarding Readiness Model

`getOnboardingStatus(session)` (`src/lib/domains/onboarding/readiness.ts`)
returns a list of `ReadinessItem`s, each with `area`, `label`, `status`
(`not_started` / `in_progress` / `ready` / `optional` / `attention_required`),
`required`, `completed`, `count`, `destination` (a real route to fix it),
and a human-readable `reason`. **Nothing is a stored flag** — every item is
derived live from the organization's actual configuration at call time:

| Area | Item | Required? |
|---|---|---|
| Organization | Identity (legal name, display name, currency, timezone, active) | Always |
| Structure | At least one active Branch | Always |
| Staff | An active user holding an administrator-granting role | Always |
| Staff | More than one active user (a real operational user beyond the bootstrap admin) | Always |
| Clinical | At least one Provider | Always |
| Clinical | At least one active Service | Always |
| Billing | Accounts Receivable + Revenue + at least one tender account mapped | Always |
| Inventory | Products/Medications exist | Only if `pharmacy_enabled` |
| Inventory | Inventory Asset + COGS account mapped | Only if `pharmacy_enabled` |
| Inventory | Opening stock recorded | Never required (stock can start at zero and be received operationally) |
| Patients | At least one patient on file | Never required |

`operationallyReady` is true only once every **required** item is complete
— optional items never block it. The workspace uses "Operational setup
ready" language only; it never claims compliance, certification, or
accreditation of any kind (P4.6 §60/§78).

## Onboarding Workspace

`/admin/onboarding` (permission: `data_import.manage`) — three sections:

1. **Readiness Review** — the live checklist above, each row deep-linking to
   the existing screen that fixes it (`/admin/settings`, `/providers`,
   `/services`, `/accounting`, ...). No configuration UI is duplicated here.
2. **Data Import** — one card per supported import type, each with a
   "Template" download and an "Import" button opening the shared dry-run →
   review → commit dialog.
3. **Import History** — the last 20 `ImportJob`s for this organization:
   type, file name, status, actor, timing, and row counts. A job that
   hasn't started committing yet can be cancelled from here.

## Import Architecture

Every importer implements the same shape (`ImporterDefinition<T>`,
`src/lib/platform/import/types.ts`):

- `requiredHeaders` / `optionalHeaders` — drives both validation and the
  downloadable template (generated from these, never hand-maintained
  separately, so a template can never drift from what the parser accepts).
- `parseRow(raw, rowNumber, ctx)` — normalizes and validates one row,
  returning either a normalized value or a list of field-level issues.
- `detectDuplicates(rows, ctx)` — one batched query against existing data
  plus in-file duplicate detection, not N queries.
- `commitBatch(tx, rows, ctx, jobId)` — creates the real domain rows for one
  batch of already-valid, already-non-duplicate rows, using the SAME
  existing domain primitives every interactive screen uses
  (`receiveStock`, `createMedication`'s own Product+Medication pairing,
  etc.) — never a parallel/bypass write path.

### Dry Run → Commit → Result

1. **Dry run** (`runDryRun`): parses the file, validates every row, detects
   duplicates, creates an `ImportJob` (status `validated` or `failed`),
   persists row-level `ImportJobError`s (capped at 1,000 stored rows —
   enough for genuine review, bounded against a pathological all-invalid
   file), and returns a summary + a preview of the first 50 rows. **Creates
   no domain/business rows.**
2. **Commit** (`runCommit`): requires the SAME file content to be
   resubmitted. Confirms: the job belongs to the caller's own organization,
   the job hasn't already been committed/cancelled/failed, and the
   resubmitted file's hash matches what was validated. **Re-runs full
   validation from scratch** — never trusts a client-held row
   classification from the dry-run response. Commits in batches of 200 rows
   per transaction (not one single multi-thousand-row transaction, and not
   a 20-minute timeout — see Import Limits below). If a batch fails, the
   job is marked `failed` with exactly how many rows were actually
   committed before the failure; no batch after that ever runs.
3. **Idempotent retry**: re-running the *same* corrected file after a
   partial failure is safe — every importer's duplicate detection is keyed
   on a real, stable natural key already in the database (MRN-adjacent
   mobile/email/national-ID/name+DOB for patients, SKU for products/
   medications, code for suppliers/services, product+batchNumber for
   opening inventory), so already-imported rows are detected as duplicates
   and skipped automatically, not re-created.

### Duplicate Strategy

Every importer uses **CREATE + SKIP** (never a silent upsert). A row that
matches an existing record, or an earlier row in the same file, is marked
`duplicate` and excluded from commit — reported, never merged.

| Import type | Duplicate signal(s) |
|---|---|
| Patients | mobile, email, national ID, or (name + date of birth) |
| Services | code |
| Products | SKU |
| Suppliers | code |
| Medications | SKU (of the linked Product) |
| Employees | (first name + last name + branch + joining date) — no stable code field exists on this model |
| Providers | license number, or full name if no license number given |
| Opening Inventory | (product + batch number) |

## Supported Import Types

All eight named in P4.6 §18 are implemented — none deferred. P4.9.2 (Extended
Clinic Data Import Coverage) added nine more — see "P4.9.2 — Extended Import
Catalogue" below for those, and
`P4_9_2_EXTENDED_CLINIC_DATA_IMPORT_REPORT.md`'s Import Catalogue Matrix for
the full before/after classification of every requested import type.

### Patients (§19-21)

Demographic/administrative fields only — no clinical-history field exists
or is accepted (`firstName`, `middleName`, `lastName`, `dob`, `gender`,
`mobile`, `email`, `nationalId`, `passportNumber`, `addressLine`, `city`,
`country`, `emergencyContactName`, `emergencyContactPhone`, `branchCode`,
`legacyMrn`). **MRN is always Avant's own system-generated sequence** — an
imported patient gets a real, new MRN exactly the way the interactive
registration flow does; system integrity of the internal sequence is never
overridden. `legacyMrn` (new, optional field — see Schema Changes) is kept
purely as a cross-reference to the old system's chart number, never used
for anything else and never unique-enforced.

### Services (§22)

`code`, `name`, `category`, `durationMinutes`, `price`, optional
`department`. Duplicate on `code`.

### Products (§23)

`sku`, `name`, `category`, `unit`, `purchaseCost`, optional `sellingPrice`/
`reorderLevel`. **Never sets a stock quantity** — `purchaseCost` becomes the
product's default cost basis; actual stock comes only through the Opening
Inventory import.

### Suppliers (§25)

`code`, `companyName`, optional `contactName`/`phone`/`email`/`address`/
`taxNumber`/`paymentTerms`. No invented tax/regulatory fields.

### Medications (§24)

One row creates BOTH the linked Product and the Medication row, in one
transaction — the same thing `createMedication` already does interactively.
No fuzzy Product matching of any kind; if a medication's SKU isn't already
unique in the file/database, the row is rejected, not guessed at.

### Employees (§26)

Master records only — **never creates a login.** `userId` always stays
null; linking a login remains the existing, separate Admin action
(Employee↔User linking, P3.12). `managerId` is **not supported** by this
import — resolving a self-referential manager relationship from arbitrary
CSV row order is a real ordering problem out of this V1's scope; set a
manager afterward through the existing Employee edit screen.

### Providers (§27)

Master records only — same "never creates a login" rule as Employees.
`branchCodes` accepts a `;`-separated list (a provider can work at multiple
branches). No DB-level uniqueness exists on license number in the current
schema, so it's used only as one of two duplicate-detection signals (with
full name), not as a hard constraint.

### Opening Inventory (§28-31) — the one genuinely new capability

**Never sets a stock balance directly.** Every row becomes a real
`ProductBatch` + a `purchase`-type `StockLedgerEntry`, through the exact
same `receiveStock` primitive the goods-receipt flow already uses
(`src/lib/domains/inventory/stock.ts`) — this import IS the ledger-domain
architecture, not a bypass of it.

- `unitCost` is **required** — a missing or blank cost fails validation for
  that row. No commercial stock is ever silently created at zero cost.
- `expiryDate` in the past is **rejected outright** — an already-expired
  batch never becomes available/FEFO-eligible inventory through this
  import. (A dedicated "import historical write-off stock" path was judged
  a genuinely separate feature, out of this V1's scope — see Remaining
  Onboarding Backlog.)
- Every movement's `StockLedgerEntry.referenceType` is `"opening_balance"`
  and `referenceId` is the `ImportJob.id` — fully traceable back to exactly
  which import produced it.
- **Deliberately posts no accounting journal.** See Accounting Setup below
  for the recommended manual step instead.
- Since P4.9.2, importing opening stock also adds a persistent Readiness
  Review reminder ("Opening inventory GL confirmation") until the
  corresponding journal is posted — visibility only, never automatic.

## P4.9.2 — Extended Import Catalogue

Nine more importers, reusing the identical Template → Dry Run → Duplicate
Analysis → Explicit Commit → Result → Audit engine — no second import
framework was built. Master data only, same as every P4.6 importer — none
of these create an operational transaction (an order, a result, an
invoice, a journal, a purchased package).

- **Laboratory Test Catalogue** (`lab_tests`) — `code`, `name`, `category`,
  `specimenType`, `resultType` (numeric/text), `price`, optional `unit`/
  reference range/`turnaroundHours`. Catalogue only — never creates a lab
  order or result.
- **Laboratory Panels** (`lab_panels`) — a panel plus its member test codes
  in one `;`-separated column. Every referenced test code must already
  exist (import Lab Tests first) — an unresolved code invalidates the
  whole row, never silently drops the missing member.
- **Imaging Service Catalogue** (`imaging_services`) — `code`, `name`,
  `category` (the modality — X-Ray, CT, MRI, ...), `price`, optional
  `bodyPart`/`turnaroundHours`. Catalogue only — never creates an imaging
  order.
- **Packages** (`packages`) — a package plus its included services as
  `serviceCode:sessions` pairs in one column (e.g.
  `"PHYSIO01:10;CONSULT01:1"`). Every referenced service must already exist
  (import Services first). Never creates a patient's purchased package.
- **Payors** (`payors`) — `code`, `name`, `payorType`, optional contact
  fields. Internal payor master data only — not an insurance eligibility/
  claims integration (no NPHIES, no clearinghouse).
- **Assets** (`assets`) — `assetCode`, `name`, `category`, `branchCode`,
  optional serial/manufacturer/model/department/employee link/purchase
  date/cost/warranty. **Deliberately bypasses the interactive `createAsset`
  function's own acquisition-journal posting** — `cost` is recorded as
  informational metadata only, the same restraint Opening Inventory already
  applies to its own financial consequence. Post a manual journal
  separately if migrated asset cost should appear on the books. No
  depreciation schedule is created (nothing in the current architecture
  reads those fields yet).
- **Chart of Accounts** (`chart_of_accounts`, **HIGH RISK**) — `code`,
  `name`, `type`, optional `parentAccountCode`. A parent must **already
  exist** in the database before the child row referencing it — import
  root accounts first, then children in a separate, later file. This also
  makes a genuinely circular hierarchy impossible to construct through this
  importer. **Never creates or infers an Account Mapping** — "Accounts
  Receivable" as a name does not become the AR posting intent; map it
  explicitly afterward on the Accounting page (Readiness Review shows
  what's still missing).
- **Payroll Runs** (`payroll_runs`, **HIGH RISK, DRAFT-ONLY**) — one row is
  one employee's line for one branch+period; rows sharing the same
  branch+period become one `PayrollRun`. **Creates `draft` runs only** —
  approving/paying a run posts real accounting journals through the normal
  posting service, which a bulk historical import cannot safely reproduce
  without either fabricating journals outside that service or leaving a
  "paid" run with no journal at all. Review, approve, and mark paid through
  the normal Payroll screens afterward. If a run already exists for a
  branch+period (any status, including an existing draft), the whole group
  is skipped — never appended to or overwritten. No commission accrual is
  attached (that's live, current-state data).
- **Users** (`users`, **HIGH RISK, SECURITY SENSITIVE**) — `email`,
  `firstName`, `lastName`, `roleNames` (`;`-separated), `branchCodes`
  (`;`-separated), optional `username`/`status`/`employeeNumber`. **No
  password is ever accepted, generated as a default, or persisted
  anywhere retrievable** — each created account gets a random,
  immediately-discarded password hash, making it genuinely unusable until
  activated. Activation reuses the existing self-service "Forgot password"
  flow at `/login` — real email delivery for that flow still depends on a
  configured transactional email provider (see
  `docs/COMMERCIAL_READINESS.md`); this import does not change that.
  **Bulk-creating a "Super Admin" account is refused outright**, regardless
  of the importing actor's own role.

Every high-risk importer above requires the same domain permission the
equivalent interactive screen already requires (`chart_of_account.manage`,
`payroll.process`, `users.manage`, `asset.manage`/`inventory.adjust`), in
addition to `data_import.manage` — and requires an explicit on-screen
confirmation checkbox before Commit, not just Dry Run.

## Recommended Import Order

Only as restrictive as real dependencies require — most of these can run in
parallel; the ordering below only matters where one importer's rows
reference another's:

1. Organization / Branch (interactive setup, not an import)
2. Chart of Accounts
3. Services
4. Imaging Services
5. Laboratory Tests
6. Laboratory Panels (needs Laboratory Tests)
7. Products
8. Medications (creates its own linked Product — no separate Products step needed for medications specifically)
9. Suppliers
10. Providers
11. Employees
12. Users (needs Employees only if linking logins to them)
13. Payors
14. Packages (needs Services)
15. Patients
16. Opening Inventory (needs Products/Medications, Suppliers if referenced)
17. Payroll Runs (needs Employees; draft-only — see above)

## CSV Templates

`GET /api/onboarding/template/{type}` — authenticated, `data_import.manage`
only. Returns the importer's own `requiredHeaders` + `optionalHeaders` as an
empty (header-only) CSV, named `<template-version>.csv`. Deliberately no
example data row (an example row risks accidentally being imported as a
real record) — the required/optional fields, formats, and duplicate rules
are instead shown as help text directly in the import dialog.

| Type | Template version |
|---|---|
| Patients | `patients-v1` |
| Services | `services-v1` |
| Products | `products-v1` |
| Suppliers | `suppliers-v1` |
| Medications | `medications-v1` |
| Employees | `employees-v1` |
| Providers | `providers-v1` |
| Opening Inventory | `opening-inventory-v1` |

## Field Handling Conventions

- **Dates**: `YYYY-MM-DD` only. An ambiguous format (`01/02/26`) is
  rejected outright, never guessed. Parsed at UTC noon specifically so no
  timezone conversion anywhere in the app can shift a calendar date (DOB,
  joining date, expiry) to the adjacent day.
- **Enums**: validated against the real, current model values before ever
  reaching Prisma — never an unsafe `value as never` cast.
- **Email**: trimmed and lowercased (matching the same normalization the
  login flow already applies), rejected if present but malformed, never
  required unless the target field genuinely requires it.
- **Phone**: preserved verbatim (trimmed) — no country-assumption
  normalization; that's future regulatory/localization work.
- **Whitespace**: trimmed; a blank optional field becomes `null`, never an
  empty string. Names/identifiers/codes are never otherwise rewritten.
- **References** (branch, department, product, supplier): resolved by a
  stable, human-readable code/name your CSV already carries — never a raw
  database id. An unresolvable reference is reported as invalid (`UNKNOWN_BRANCH`,
  `UNKNOWN_PRODUCT`, etc.), never silently dropped or defaulted.

## Import Limits (§68)

- **Max file size**: 5 MB.
- **Max rows**: 10,000 data rows per file (split larger migrations into
  multiple files).
- **Max field length**: 2,000 characters per cell.
- **Commit batch size**: 200 rows per transaction (§69) — bounded so no
  single import ever needs an unusually long transaction/timeout; a large
  import commits as several sequential, individually-safe batches instead.

## Accounting Setup

Reuses the existing Chart of Accounts and Account Mapping screens
(`/accounting`) entirely — no new mapping UI. Onboarding readiness checks
for the mappings a normal billing workflow actually needs:

- **Always required**: Accounts Receivable, Revenue, and at least one
  tender/payment account (cash, card, bank, online, or insurance).
- **Required only if pharmacy/inventory is enabled**: Inventory Asset and
  COGS.
- Tax, payroll, and asset-related mappings are not required by readiness —
  they only matter once the corresponding workflow (tax, payroll, fixed
  assets) is actually used, and forcing them on every clinic regardless
  would violate the phase's own "don't require a module a clinic doesn't
  use" principle.

### Opening balances (§32-33)

P4.6 deliberately does **not** import historical Journal entries, and the
Opening Inventory importer deliberately does **not** post an automatic
accounting journal for the stock it creates (see Opening Inventory above) —
inventing a new "opening balance equity" posting intent purely for this
would be new accounting semantics this phase's own scope explicitly warns
against building casually.

**The existing, already-supported path**: a real double-entry Manual
Journal (`createManualJournal`, `/accounting`) can establish any opening
balance safely — for example, once Opening Inventory has been imported,
review its total value and post one deliberate journal:

```
Dr Inventory Asset    <total imported stock value>
    Cr Opening Balance Equity (or an equivalent equity account)
```

This is one reviewed, intentional accounting action per migration — not
10,000 auto-generated postings — and it preserves real double-entry
integrity using a mechanism that already exists and is already tested.

## Security / PHI Handling

- **Authorization**: `data_import.manage` (new, narrow permission — see
  Schema/Permission Changes) gates every import entry point (dry run,
  commit, template download, error report download). Not folded into the
  broad `users.manage`/`settings.edit` — a role can have onboarding/import
  ability without also getting full user management, and vice versa.
  Granted automatically to Super Admin and Organization Administrator only
  (the same `PERMISSIONS.map(p => p.code)` mechanism every new permission
  in this catalog already uses) — never to a branch-level operational role.
- **Tenant isolation**: `organizationId` is **always** derived from the
  authenticated session, never trusted from the CSV or any client payload.
  Every reference (branch code, product SKU, supplier code, ...) resolves
  only against the caller's own organization's data — a code that happens
  to match another organization's record is invisible and reported as
  unknown, never silently cross-resolved. Verified by a dedicated
  cross-organization test.
- **No PHI in logs**: the structured logger's own field shape (`src/lib/platform/logger.ts`)
  is deliberately narrow (short identifiers, no free-text payload) — an
  import's log lines carry only `organizationId`, the `ImportJob` id, and
  the import type, never row content.
- **No PHI in error rows**: `ImportJobError` stores only row number, field
  name, a stable error code, and a safe, human-readable message — never the
  source row's own field values. A stale/rejected row's actual data lives
  only in the uploaded file the user already has (which the server never
  persists), never in this database.
- **CSV formula-injection protection**: every value this app *generates*
  into a CSV (a template header, an error-report cell) is escaped if it
  begins with `=`, `+`, `-`, or `@` (a leading `'` forces plain text in
  every common spreadsheet application). This is export-time display safety
  only — it never touches how an *imported* value is parsed or stored;
  business data is never mutated just because it happens to start with one
  of those characters.
- **File safety**: CSV only, plain text parsing (no formula evaluation, no
  HTML/script execution of any kind — the parser only ever produces
  strings). Extension is checked (`.csv`) before parsing. Size/row/field
  limits are enforced before any row-level work begins.

## Opening Inventory Reconciliation

After an Opening Inventory commit, the resulting `StockLedgerEntry` rows
are the same rows every other stock report/reconciliation already reads —
no separate reconciliation mechanism was built or is needed. To verify an
import: `stockLedgerEntry` rows with `referenceType = 'opening_balance'`
and `referenceId = <the ImportJob id>` are the complete, exact set of
movements that one import produced; their sum, per product/branch, is the
resulting opening balance, and their `purchaseCost` (via the linked
`ProductBatch`) is the exact cost basis future COGS postings will use when
that stock is eventually sold/dispensed.

## Fresh-Clinic Go-Live Checklist

1. Confirm Organization identity (`/admin/settings`).
2. Create at least one active Branch.
3. Create an administrator + at least one operational user (`/admin/users`).
4. Create Provider(s) and Service(s).
5. Configure Accounts Receivable, Revenue, and a tender account
   (`/accounting`) — Inventory Asset + COGS too if pharmacy is enabled.
6. Import Suppliers, Products/Medications, and Services if migrating from
   an existing system (or create them directly if starting fresh).
7. Import Opening Inventory if there's existing stock to bring in; post the
   corresponding Manual Journal if the clinic wants it reflected on the
   balance sheet immediately (see Accounting Setup above).
8. Import Patients if migrating existing records.
9. Check `/admin/onboarding`'s Readiness Review — "Operational setup
   ready" once every required item is green.
10. Run one real, small end-to-end transaction (register/find a test
    patient, book, check in, consult, bill, pay) before relying on the
    system for real patients.

This is **operational readiness**, not a compliance/certification claim of
any kind (see Known Limits).

## Known Limits

- **No staging/production-scale import benchmark** — only local
  measurements exist (see the P4.6 report's own Representative Import
  Performance section). A production-equivalent load test remains future
  work, same as P4.5's own documented staging-validation requirement.
- **Very large single-file patient imports are linear, not instant** — the
  Patients importer calls the real MRN sequence generator per row (the same
  system-integrity guarantee the interactive registration flow uses), which
  is measurably slower than a bulk `createMany` (see the report). Fine for
  realistic clinic sizes (hundreds to low thousands of patients); a very
  large single-file historical migration (many thousands of rows) may be
  worth splitting into multiple smaller files using the same 10,000-row
  limit as a natural chunk boundary.
- **`managerId` (Employees) and expired-stock write-off (Opening Inventory)
  are not supported** by this V1 — both are documented, deliberate scope
  cuts (see their own sections above), not oversights.
- **No jurisdiction/country-specific onboarding** — deliberately
  jurisdiction-neutral, matching this whole codebase's existing approach;
  no `CountryProfile` or regulatory adapter was introduced.

## Re-running Tests

```bash
npx prisma validate
npx prisma migrate status
npm run typecheck
npm run lint
npm run test            # full integration suite, against his_test only
npm run build
```

The onboarding/import test suite lives in
`test/integration/p4-6-clinic-onboarding-data-import.test.ts` — it creates
and tears down its own fully isolated, disposable test organization(s) (not
the shared seeded one), so it can be re-run any number of times without
manual cleanup.
