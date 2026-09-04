# Data Export Dictionary

Every CSV export Avant HIS produces, in one place — for customer contracts,
onboarding, and support reference. See
[`docs/REPORTING_AND_EXPORTS.md`](REPORTING_AND_EXPORTS.md) for the
architecture and behavior this dictionary describes the shape of.

All exports: CSV, UTF-8 (BOM on every entry below unless noted), formula-
injection-safe, filtered server-side using the same filters the screen used,
capped at 50,000 rows (Stock Movement: 5,000) with a clear error — never a
silent truncation — if exceeded.

---

## Report-category exports (`GET /api/reports/export?category=...&from=...&to=...&branchId=...&providerId=...`)

| Category | Permission | Filters | Fields | Row limit | Sensitive |
|---|---|---|---|---|---|
| `practice` | `reports.export` + `appointment.view` | from, to, branch, provider | Date/time, patient, MRN, provider, service, branch, status, source | 50,000 | No |
| `clinical` | `reports.export` + `encounter.view` | from, to, branch, provider | Diagnosis, count | 50,000 | No |
| `lab` | `reports.export` + (`encounter.view` or `lab_result.verify`/`.enter`) | from, to, branch | Status, count | 50,000 | No |
| `radiology` | `reports.export` + (`encounter.view` or `imaging_result.verify`/`imaging_order.perform`) | from, to, branch | Status, count | 50,000 | No |
| `financial` | `reports.export` + `accounting.view` | from, to, branch | Type (Revenue/Expense), code, name, amount | 50,000 | **Yes** — audited |
| `revenue-cycle` | `reports.export` + (`invoice.view` or `claim.create`) | from, to, branch | Invoice #, patient, MRN, branch, date, gross, discount, tax, net, paid, outstanding, status | 50,000 | No |
| `inventory` | `reports.export` + `inventory.view` | from, to, branch | Product, category, balance, reorder level, low-stock flag, unit cost, value | 50,000 | No |
| `hr` | `reports.export` + `payroll.view` | from, to, branch | Period start/end, status, employee count, net total | 50,000 | **Yes** — audited (payroll) |
| `assets` | `reports.export` + `inventory.view` | from, to, branch | Asset #, name, category, branch, status, cost | 50,000 | No |
| `daily-ops` | `reports.export` + `appointment.view` | to (used as the reported date), branch | One row: appointment counts, encounters completed, billing/collections/pharmacy/lab/imaging counts | 1 row | No |
| `patients` | `reports.export` + `patient.view` | from, to, branch | MRN, legacy MRN, first/middle/last name, DOB, gender, mobile, status, branch, registered date | 50,000 | **Yes** — audited |
| `import-history` | `reports.export` + `data_import.manage` | from, to, branch | Type, file, status, actor, started, completed, total/valid/invalid/duplicate/imported/skipped rows | 50,000 | **Yes** — audited |

---

## Data-portability exports (`GET /api/reports/export/data/{type}?from=...&to=...&branchId=...`)

| Type | Permission | Filters | Fields | Row limit | Sensitive |
|---|---|---|---|---|---|
| `patient-master` | `reports.export` + `patient.view` | from/to (registration date), branch | MRN, legacy MRN, first/middle/last name, DOB, gender, nationality, mobile, WhatsApp, email, address, city, country, preferred language, status, branch, registered date | 50,000 | **Yes** — audited |
| `general-ledger` | `reports.export` + `accounting.view` | from/to (journal date), branch | Journal #, date, account code, account name, debit, credit, reference type, reference ID, branch, memo | 50,000 | **Yes** — audited |
| `trial-balance` | `reports.export` + `accounting.view` | to (as-of date), branch | Code, name, type, debit, credit, plus a TOTAL row | none (one row per account) | **Yes** — audited |
| `collections` | `reports.export` + `payment.view` | from/to (payment received date), branch | Receipt #, date, patient/invoice, method, amount, cashier | 50,000 | No |
| `refunds` | `reports.export` + `payment.view` | from/to (refund requested date), branch | Refund #, date, invoice #, amount, reason, status, requested by, authorized by | 50,000 | No |
| `stock-movement` | `reports.export` + `inventory.view` | from/to (movement date), branch, product | Date, product, batch, branch, transaction type, quantity, reference type, reference ID, actor | 5,000 | No |
| `audit-log` | `audit.review` only | from/to (event date) | When, user, action, entity type, entity ID | 50,000 | **Yes** — audited. Excludes mutation payload (old/new values), IP, user agent |
| `clinical-access-log` | `audit.review` only | from/to (event date), branch (patient's registration branch) | When, user, patient MRN, resource type, resource ID, action | 50,000 | **Yes** — audited. Excludes nothing further — this export *is* the sensitive-access record itself |

---

## Field meaning notes

- **"Gross/discount/tax/net/paid/outstanding"** (Invoice Report): `gross` =
  `subtotal`, `net` = `totalAmount` (post discount/tax — matches how
  `Invoice.totalAmount` is computed at issue time), `outstanding` =
  `totalAmount − paidAmount`.
- **AR Aging basis**: `issuedAt` (Invoice has no `dueDate` field — the aging
  buckets are honestly labeled `basis: "issuedAt"`, not implied as
  due-date-based).
- **AP Aging basis**: `dueDate` (SupplierInvoice *does* model this, but it's
  nullable — a row with no due date is excluded from the buckets and
  reported separately as `undated`).
- **Stock Movement `quantity`**: signed — positive for stock in, negative
  for stock out, matching `StockLedgerEntry.quantity`'s own sign convention.
- **Patient Master vs. Patient Registration Report**: the `patients`
  category export is the lighter demographic-lite shape (no
  address/contact-beyond-mobile); `patient-master` (data-portability) is the
  fuller shape used for actually migrating a clinic's patient data
  elsewhere. Neither includes national ID, passport number, or any
  authentication/security field — a Patient is never itself a login.
- **General Ledger `debit`/`credit`**: always balance in total for a given
  export (verified by test) — this is the real, posted double-entry ledger,
  never a derived/estimated figure.

## What is deliberately NOT exported

- Patient national ID / passport number (real government-ID PII) — not in
  any export this phase built.
- Any password, session token, or authentication secret.
- Full clinical records (encounters, clinical notes, diagnoses beyond
  aggregate counts, prescriptions beyond aggregate counts, lab/imaging
  result values) — clinical data portability is explicitly deferred, per
  P4.7 §49.
- Audit-log mutation payloads (`oldValues`/`newValues`), IP addresses, or
  user agents — the audit-log export is an activity trail, not a raw table
  dump.
- Raw uploaded import files or full source CSV rows (unchanged from P4.6).
