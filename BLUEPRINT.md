# HIS System Blueprint — v0 (Pending Approval)

Status: **APPROVED (2026-08-24).** Recommended corrections accepted as-is. The six open architecture decisions in §43 are locked to their stated recommendations (hand-rolled DB-session auth; single-org-per-deployment; React-PDF; seed-subset ICD table, admin-importable; communication provider selection deferred to Phase 12; single configurable currency per organization). Superseded/refined by [ARCHITECTURE.md](ARCHITECTURE.md), [DATABASE.md](DATABASE.md), [SECURITY.md](SECURITY.md), and [API.md](API.md) where those documents provide more implementation-level detail — this file remains the narrative record of *why*.

---

## PART A — SYSTEM BLUEPRINT

### 1. Executive Architecture Summary

We are building a **modular monolith** — one deployable Next.js/TypeScript application, one PostgreSQL database, internally organized into domain modules with explicit contracts between them. Modules communicate primarily through:

- **Direct service calls** within a request (e.g., billing service calling accounting service) wrapped in a single DB transaction when they must be atomic.
- **Internal domain events** (in-process, transactionally-outboxed) for cross-cutting side effects that don't need to block the primary transaction (notifications, analytics, non-critical downstream updates).

The system is built around a **single longitudinal patient journey**: every clinical, operational, and financial fact traces back to `Patient → Episode → Encounter → Order/Charge → Invoice → Payment → Ledger`. No module is allowed to be an island — every write path that spec.md identifies as cross-domain (§93) must be enumerated in that module's design doc before it's built.

Multi-tenancy is **single-org-per-deployment for v1**, with `organization_id` present on every table from day one so a future SaaS multi-tenant mode is a permission/scoping change, not a schema rewrite. Multi-branch is a first-class concept within one organization from Phase 1.

Money is `NUMERIC(14,2)` (or `NUMERIC(14,4)` where sub-cent tax precision is needed), never floating point. All financial mutations flow through a **central accounting posting service** — no module writes journal entries directly. All inventory mutations flow through an **immutable stock ledger** — no module writes stock quantities directly.

### 2. Domain Architecture

Fifteen domains, each owning its own tables, service layer, and (where applicable) UI routes:

| Domain | Owns | Depends on (reads) |
|---|---|---|
| `identity` (org/branch/dept/room/users/roles/permissions) | tenancy + RBAC primitives | — |
| `patients` | patient master, medical profile, documents, consent | identity |
| `providers` | provider master, schedules, leave-blocked slots | identity, hr |
| `scheduling` | appointments, calendar, queue | patients, providers |
| `clinical` | episodes, encounters, vitals, diagnosis, notes, CPOE orders, prescriptions | patients, scheduling, providers |
| `laboratory` (LIS) | test master, specimens, results | clinical (consumes orders) |
| `pharmacy` (PIS) | medication master, dispensing | clinical (consumes rx), inventory |
| `radiology` (RIS) | imaging orders, reports | clinical (consumes orders) |
| `billing` | charges, invoices, payments, refunds, cashier sessions | clinical, laboratory, pharmacy, radiology, inventory |
| `payors` | payors, plans, coverage, claims | billing, patients |
| `inventory` | products, batches, stock ledger, transfers | procurement, clinical/pharmacy (consumption) |
| `procurement` | suppliers, purchase requests/orders, goods receipt | inventory, accounting |
| `assets` | asset register, maintenance, calibration | identity, procurement |
| `hr` | employees, attendance, leave, payroll, commissions | identity, providers |
| `accounting` | chart of accounts, journals, ledger, statements | consumes events from billing/inventory/hr/procurement |
| `engagement` | leads, communications, patient portal, online booking | patients, scheduling, billing |
| `platform` | audit log, access log, notifications, number sequences, global search, reports | reads across all domains |

Dependency direction is deliberately one-way where possible (clinical does not depend on billing; billing depends on clinical). Cycles are avoided by using domain events instead of direct calls where a "back-reference" would otherwise be needed (e.g., `accounting` never calls back into `billing`; it only reacts to `InvoiceIssued`/`PaymentReceived` events).

### 3. Module Hierarchy

```
Platform Foundation
 └─ Identity & Tenancy (org/branch/dept/room, users, roles, permissions, audit, sequences)
     └─ Practice Management (patients, providers, services, scheduling, reception, queue)
         └─ Clinical / EMR (episodes, encounters, vitals, diagnosis, notes, CPOE, prescriptions)
             ├─ Laboratory (LIS)
             ├─ Pharmacy (PIS)
             ├─ Radiology (RIS)
             └─ Revenue Cycle
                 ├─ Billing Engine (charges, invoices, payments, refunds, cashier)
                 └─ Payors & Claims
         └─ Resource Management / ERP
             ├─ Inventory & Procurement
             ├─ Assets
             └─ HR & Payroll (incl. commissions)
     └─ Finance & Accounting (central posting engine, GL, statements)
     └─ Patient Engagement (communications, portal, booking, leads)
     └─ Administration & Intelligence (dashboards, reports, search, settings)
```

Each layer can function with the layers above it stubbed/disabled (e.g., a clinic with no pharmacy simply disables the `pharmacy` module flag), but never with the layers below it missing — clinical cannot exist without practice management, billing cannot exist without clinical.

### 4. Patient Journey

Canonical flow (also the basis of the Phase-driven E2E test in §85):

```
Registration → Duplicate Check → Patient Master
 → Appointment (Scheduling)
 → Arrival → Check-In → Queue Token
 → Encounter opened (optionally under an Episode)
 → Vitals recorded
 → Clinical Consultation (History, Exam, Assessment)
 → Diagnosis (ICD-coded)
 → Orders raised (Lab / Imaging / Procedure / Referral) — CPOE
 → Prescription issued
 → Encounter Finalized
 → Charges captured from every billable event in the encounter (consultation fee,
   procedures, orders, dispensed medication)
 → Invoice generated (aggregates charges)
 → Payment collected (cash/card/insurance/split) at POS or portal
 → Accounting journal posted automatically
 → Provider commission accrued
 → Patient Timeline updated (denormalized/query-derived, not hand-maintained)
 → Follow-Up scheduled (creates next Appointment)
```

Branches off this spine: Lab Order → LIS workflow → Result → back into EMR. Medication Order/Prescription → Pharmacy Queue → Dispensing → Inventory reduction → Charge → back into medication history. Imaging Order → RIS Queue → Report → back into EMR. Procedure → Room + Inventory consumption → Charge.

### 5. Episode/Encounter Model

- **Patient**: the person. One row per human, ever (never duplicated per visit).
- **Episode**: a clinically-meaningful *problem or care journey* with a start and (optional, open-ended) end. Groups related encounters. Optional — not every encounter needs one (e.g., a walk-in for a single unrelated complaint can be a standalone encounter).
- **Encounter**: one bounded interaction (a visit, a review, a therapy session). Always has a provider, a start, and (once finalized) an end. Encounters reference `episode_id` (nullable).
- **Appointment**: purely a scheduling object. `appointment.id` is referenced by at most one `encounter.appointment_id` (an appointment *may* produce an encounter — e.g., a no-show never does; a walk-in encounter may have no appointment at all).

This three-way separation is deliberate (see ADR-002 in §90) — collapsing Episode/Encounter, or Appointment/Encounter, is the single most common modeling mistake in clinic software and blocks proper longitudinal history and multi-visit treatment plans (e.g., 10-session physiotherapy package under one episode).

### 6. Clinical Order Architecture (CPOE)

A single polymorphic-by-type **`clinical_order`** parent table with `order_type` (`lab | medication | imaging | procedure | referral | other`) and a shared status state machine (`draft → ordered → acknowledged → in_progress → completed | cancelled`), plus **type-specific detail tables** (`lab_order_detail`, `imaging_order_detail`, etc.) joined 1:1 on the order id. This gives:

- One place to query "all orders for this encounter/patient" (patient timeline, doctor dashboard).
- One place to enforce the order lifecycle and audit it.
- Type-specific systems (LIS/RIS/Pharmacy) each own only their detail table and their downstream workflow, subscribing to `OrderPlaced` events filtered by type.

Orders are the **only** bridge from EMR into LIS/PIS/RIS — those systems never read encounter notes directly.

### 7. Billing Architecture

`billing` owns three escalating concepts:

1. **Charge** — an atomic billable fact created by an *originating domain* the moment a billable event occurs (consultation billed on encounter finalize, lab test billed on order placement or result, dispensed drug billed on dispensing, procedure billed on completion). Charges are immutable once created (voided via a linked reversal charge, never deleted/edited).
2. **Invoice** — a container that aggregates one or more pending charges for a patient (per visit, per day, or manually curated at POS) into a billable document with tax/discount applied at the line and/or document level.
3. **Payment** — money received, allocated against one or more invoices (or held on account). Split across tenders in one payment event, each tender producing its own `payment_allocation` row.

No UI (POS included) writes an invoice line directly from a form; it always goes through the Billing Engine's `createChargesFromEvent()` / `generateInvoice()` / `recordPayment()` service functions, which are the only writers of these tables and the only callers of the accounting posting service.

### 8. Revenue Cycle Architecture

```
Registration → Eligibility (payor/coverage check, self-pay skips this) → Appointment
 → Encounter → Charge Capture (automatic, event-driven) → Coding (ICD/CPT-style codes on
   diagnosis/procedure) → Invoice → Claim (insurance path only) → Payment/Remittance
 → Reconciliation → AR Follow-up (aging, dunning)
```

Self-pay path: `Registration → Appointment → Encounter → Charge Capture → Invoice → Payment (POS)` — no eligibility/claim steps, invoice is payable in full immediately. Insurance path adds `payor_id`/`policy_id` on the invoice, splits `patient_responsibility` vs `payor_responsibility`, and the payor-responsibility portion routes into the Claims domain.

### 9. Inventory Architecture

Every stock quantity is a **derived sum over an immutable stock ledger** (`stock_ledger_entry`), never a mutable `quantity` column edited in place (a cached/materialized `stock_balance` table is allowed for read performance but is only ever written by replaying/aggregating ledger entries in the same transaction as the ledger insert). Batch/expiry tracked per lot; FEFO applied at issue time for clinical consumption and dispensing. All consumption (procedure templates, pharmacy dispensing, POS product sale) posts a ledger entry with a polymorphic `reference_type`/`reference_id` back to the originating transaction (procedure, dispensing record, POS sale line) — full traceability from a stock movement back to the clinical/financial event that caused it, and back further into accounting (inventory asset value ↔ COGS/expense).

### 10. Accounting Architecture

Double-entry, strictly balanced (`Σdebit = Σcredit` per journal, enforced at the DB layer via a check/trigger, not just application code). A single **Central Accounting Posting Service** exposes intent-based methods (`postPatientPayment()`, `postCreditSale()`, `postInventoryPurchase()`, `postPayroll()`, `postRefund()`, `postCommissionAccrual()`, etc.) that internally resolve **configurable account mappings** (e.g., "which GL account is Cash-branch-3?") from an `account_mapping` settings table, then write to `journal` + `journal_line`. No other module is permitted to insert into `journal_line` directly — this is enforced by application-layer service boundaries and reinforced by restrictive DB privileges in Phase 14 hardening.

### 11. HR Architecture

`Employee → Schedule → Attendance → Leave → Payroll → Payslip → Payment → Accounting`. Providers (clinical) and Employees (HR) are **separate but linked** entities: a `provider` row has an optional `employee_id` FK (a provider might be a visiting/contracted doctor with no employee record; an employee might have no provider record — e.g., a receptionist). Approved leave for a provider blocks scheduling availability (reads from HR, enforced in `scheduling`). Payroll computation reads attendance + leave + commission accruals (from `billing`/`clinical` via a read-only commission ledger) and, on approval, calls the accounting posting service — payroll never writes journals itself.

### 12. Patient Engagement Architecture

`engagement` owns communication templates and a **provider-adapter pattern** for SMS/WhatsApp/Email (interface with pluggable concrete adapters — e.g., Twilio, Meta Cloud API, SES/Resend — selected via settings; a `console/log` adapter for local dev that never claims fake delivery success). All outbound messages are logged with actual provider status (`queued/sent/delivered/failed`) — never marked "sent" until the provider confirms. Patient Portal and Online Booking are read/write-limited façades over `patients`, `scheduling`, and `billing` with their own auth context (patient-scoped JWT/session, not staff RBAC) and a `clinical_release_rule` gate before any clinical data (results, notes) is portal-visible.

---

## PART B — DATABASE BLUEPRINT

### 13. Complete High-Level ERD (textual)

```
organization ─< branch ─< department ─< room
branch ─< user_branch_access >─ user ─< user_role >─ role ─< role_permission >─ permission

patient ─< patient_document
patient ─< patient_allergy, patient_condition, patient_medication_history
patient ─< episode ─< encounter
patient ─< appointment >─ provider
appointment ─0..1─ encounter (via appointment_id on encounter)
encounter ─< vital_sign
encounter ─< diagnosis
encounter ─< clinical_note (versioned)
encounter ─< clinical_order ─1:1─ {lab_order_detail | imaging_order_detail | procedure_detail | referral_detail}
encounter ─< prescription ─< prescription_item

clinical_order(type=lab) ─1:1─ lab_order_detail ─< specimen ─< lab_result
clinical_order(type=imaging) ─1:1─ imaging_order_detail ─< imaging_report
prescription_item ─< dispensing_record (pharmacy) ─< stock_ledger_entry

service ─< charge (polymorphic source: encounter|order|dispensing|procedure|package_usage)
charge >─ invoice_line ─< invoice ─< payment_allocation >─ payment
invoice >─ patient, branch, payor(nullable), policy(nullable)
payment ─< payment_allocation
invoice ─0..1─< claim ─< claim_item

package ─< package_service
patient_package ─< patient_package_session (usage log)

product ─< product_batch ─< stock_ledger_entry
stock_ledger_entry >─ location(branch/room), reference(polymorphic)

supplier ─< purchase_request ─< purchase_order ─< goods_receipt ─< stock_ledger_entry
purchase_order ─< supplier_invoice ─< accounts_payable_entry

asset >─ branch, department, room, assigned_employee, supplier
asset ─< maintenance_record, calibration_record

employee ─< attendance_record, leave_request, payroll_run_line
payroll_run ─< payroll_run_line ─< payslip

chart_of_account ─< journal_line >─ journal
account_mapping >─ chart_of_account

audit_log (append-only, references any entity polymorphically)
clinical_access_log (append-only)
notification (recipient user, polymorphic reference)
number_sequence (per document type, per branch)
```

### 14. Core Entities

Tier-1 entities every later module hangs off: `organization`, `branch`, `department`, `room`, `user`, `role`, `permission`, `patient`, `provider`, `episode`, `encounter`, `appointment`, `clinical_order`, `charge`, `invoice`, `payment`, `stock_ledger_entry`, `chart_of_account`, `journal`, `employee`, `audit_log`. These are designed first, in Phase 0/1, and never change shape casually afterward — everything else is additive around them.

### 15. Entity Relationships

Key cardinalities to lock in before coding (violating these is a modeling bug):

- `patient (1) — (N) episode` , `episode (1) — (N) encounter`, `encounter (0..1) — (0..1) appointment` (nullable both directions — encounter may exist without an appointment; appointment may never produce an encounter, e.g., no-show).
- `encounter (1) — (N) clinical_order`, `clinical_order (1) — (1) <type>_detail`.
- `charge (N) — (1) invoice_line`, but a charge can exist **unbilled** (no invoice yet) — `invoice_line.charge_id` is the FK, not the reverse, so charges are created independent of invoicing.
- `invoice (1) — (N) payment_allocation (N) — (1) payment` — many-to-many between invoices and payments through the allocation table, which is what makes split payment and paying multiple invoices in one transaction possible.
- `product_batch (1) — (N) stock_ledger_entry` — balance is `SUM(qty_in - qty_out)` per batch per location, never stored as mutable state.
- `journal (1) — (N) journal_line` with a DB-level constraint `SUM(debit) = SUM(credit)` per `journal_id`.

### 16. Important Database Constraints

- `UNIQUE(organization_id, mrn)`, `UNIQUE(organization_id, branch_id, sequence_type, sequence_value)` for number sequences.
- `CHECK` constraints: money columns `>= 0` where negative is invalid (adjustments/refunds use dedicated sign-bearing entry types, not negative invoice totals); `journal` balance check (via trigger, since SUM across rows isn't a plain CHECK); vitals within physiologically sane bounds (soft warn, not hard block, to avoid blocking valid outliers).
- Foreign keys **not nullable** where the relationship is mandatory (`encounter.patient_id`), nullable where optional (`encounter.episode_id`, `encounter.appointment_id`).
- `EXCLUDE USING gist` constraint on `(provider_id, tstzrange(start_time, end_time))` and `(room_id, tstzrange(...))` for appointments — this is the actual double-booking prevention mechanism, not just application logic (§16 of spec.md requires it; app-layer checks alone race under concurrency).
- Soft-delete (`deleted_at`) only on operational/config-like rows (services, products, users-deactivation is a status not a delete). Clinical and financial records are **never** soft-deleted — they are superseded/amended/reversed with full history (spec.md §70, §92).
- Row-level `organization_id`/`branch_id` present on every business table to support future SaaS scoping and current branch-level reporting/isolation.

### 17. Indexing Strategy

- B-tree on every FK.
- Composite `(organization_id, branch_id, created_at)` on high-volume transactional tables (appointment, encounter, invoice, stock_ledger_entry) for branch-scoped date-range dashboard queries.
- Partial index on `appointment (branch_id, provider_id, date) WHERE status NOT IN ('cancelled','no_show')` for calendar queries.
- Trigram (`pg_trgm`) GIN index on patient name/phone/MRN and global-search targets.
- `GIST` index backing the exclusion constraints above (doubles as the conflict-check index).
- Covering index on `stock_ledger_entry (product_id, batch_id, location_id)` for balance aggregation performance; revisit with a materialized balance table if aggregation becomes a hot path at scale.

### 18. Transaction Boundaries

Explicit DB-transaction (all-or-nothing) units, per spec.md §72:

- **Check-in**: appointment status change + queue token creation.
- **Encounter finalize**: encounter status + charge creation for consultation + (if applicable) diagnosis/note finalization timestamps.
- **Order completion → downstream**: e.g., procedure completion = procedure record + inventory consumption ledger entries + charge + commission accrual line, in one transaction.
- **Dispensing**: dispensing record + inventory ledger entries + charge + patient medication history — one transaction (explicitly named in spec.md §72).
- **POS payment**: payment + payment_allocation(s) + invoice balance update + accounting journal + cashier session running total — one transaction (explicitly named in spec.md §72).
- **Payroll approval**: payslip finalize + accounting journal — one transaction.
- **Goods receipt**: inventory ledger entries + PO line received-quantity update — one transaction; supplier invoice/AP creation is a separate, subsequent transaction (can legitimately fail/be delayed independently).

Anything **not** in this list (e.g., "send SMS reminder" after appointment confirm) is intentionally *not* in the same transaction — it goes through the domain-event/outbox mechanism so a flaky SMS provider never rolls back a booking.

### 19. Audit Architecture

Two distinct, separately-permissioned logs (spec.md §62 vs §63 are different concerns and must not be merged):

1. **`audit_log`** — *mutation* audit. Append-only. Written by a shared data-access-layer hook (not scattered manual calls) so it's impossible to forget: on every INSERT/UPDATE on an audited table, capture `user_id, timestamp, action, entity_type, entity_id, old_values (jsonb), new_values (jsonb), ip, user_agent`. Covers patient, clinical, orders, results, prescriptions, invoices, refunds, inventory adjustments, accounting, payroll, permission changes (per spec.md §62 list).
2. **`clinical_access_log`** — *read* audit for sensitive records. Written at the API layer whenever a clinical record is fetched (patient chart view, encounter view, results view), capturing `user_id, patient_id, resource_type, resource_id, timestamp, action(view/print/export)`. This table is itself access-controlled to a narrow "compliance/admin" permission — most roles (including the doctor being logged) cannot browse it.

Both are insert-only at the DB privilege level in Phase 14 hardening (no UPDATE/DELETE grants for the application role on these tables).

---

## PART C — APPLICATION BLUEPRINT

### 20. Sidebar / Navigation

Exactly the grouping in spec.md §79 (Home/Dashboard, Practice, Clinical, Revenue, Resources, Workforce, Finance, Engagement, Intelligence, Administration), rendered from a **declarative nav-config array** annotated with the `permission` key required for each item, filtered server-side (never just CSS-hidden) before being sent to the client, and re-checked by the route/middleware layer regardless of what the sidebar shows.

### 21. Page Hierarchy

```
/dashboard
/patients, /patients/[id] (360 profile, tabbed per §10)
/providers, /providers/[id]
/services, /packages
/appointments (calendar: day/week/month/provider/dept/room views), /appointments/[id]
/reception (workspace), /queue (doctor queue view)
/episodes/[id], /encounters/[id] (clinical workspace)
/orders, /laboratory (worklist, specimen, result entry/verify), /pharmacy (queue, dispense),
  /radiology (worklist, report)
/pos, /invoices/[id], /payments, /payors, /claims/[id]
/inventory (products, batches, ledger), /purchasing (PR/PO), /suppliers, /assets/[id]
/employees/[id], /attendance, /leave, /payroll, /commissions
/accounting (COA, journals, ledger), /expenses, /receivables, /payables, /statements
/leads, /communications
/reports/[category], /analytics
/admin/users, /admin/roles, /admin/audit, /admin/settings/*
```

Each `[id]` detail route is itself tabbed/sectioned per the entity's own natural sub-resources (e.g., invoice detail: lines / payments / claim / print).

### 22. User Roles

The default set from spec.md §7, treated as **seed data, not hardcoded enum logic** — roles are rows in `role`, permissions are rows in `permission`, the mapping is data (`role_permission`) editable by an Org Administrator. Super Admin is the only role with an implicit all-permissions bypass (still logged).

### 23. Complete Permission Matrix

Permissions are capability strings `resource.action` (per spec.md §7 examples), stored as data and evaluated server-side on every request via a single `can(user, permission, {branch, resourceOwner})` check. A representative slice of the matrix (full matrix — one row per permission × role — is generated as a seed script + rendered admin screen, not maintained by hand in this doc):

| Permission | Super Admin | Org Admin | Clinic Mgr | Reception | Doctor | Nurse | Lab Tech | Pharmacist | Radiology Tech | Cashier | Accountant | HR Mgr | Inventory Mgr |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| patient.view/create/edit | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | view only | – | – | – |
| clinical_notes.view/edit | ✓ | ✓ | view | – | ✓ | view | – | – | – | – | – | – | – |
| encounter.finalize | ✓ | ✓ | – | – | ✓ | – | – | – | – | – | – | – | – |
| lab_order.create | ✓ | ✓ | – | – | ✓ | – | – | – | – | – | – | – | – |
| lab_result.enter/verify | ✓ | ✓ | – | – | – | – | enter/verify¹ | – | – | – | – | – | – |
| invoice.create/discount/refund | ✓ | ✓ | discount | create | – | – | – | – | – | create | – | – | – |
| accounting.view/post | ✓ | ✓ | view | – | – | – | – | – | – | – | ✓ | – | – |
| payroll.view/process | ✓ | ✓ | – | – | – | – | – | – | – | – | – | ✓ | – |
| inventory.view/adjust | ✓ | ✓ | view | – | – | – | – | dispense | – | – | – | – | ✓ |
| users.manage | ✓ | ✓ | – | – | – | – | – | – | – | – | – | – | – |

¹ verification requires a second, distinct permission from entry (segregation of duties — spec.md implies this via separate `lab_result.enter` / `lab_result.verify` permissions). Branch-scoping is a second dimension layered on top of this matrix (a role's permission grants *what*, `user_branch_access` grants *where*).

### 24. Dashboard Design

Four role-aware dashboards exactly as enumerated in spec.md §8 (Management, Reception, Doctor, Finance), each built from **real aggregate queries against persisted tables** (never mocked). Shared building blocks: a KPI-tile row, a "today" activity feed, and a branch/date-range filter — implemented once as reusable components, not four bespoke pages.

### 25. Major Workflow Screens

Priority screens (build order follows the Phase plan in §37 below): Patient Registration (with duplicate-check modal), Patient 360, Appointment Calendar + Booking drawer, Reception/Check-in workspace, Doctor Queue, Clinical Consultation Workspace (the most complex screen — split-pane: patient summary sidebar + documentation tabs + orders panel), Lab Worklist + Result Entry, Pharmacy Dispensing Queue, POS/Cashier, Invoice Detail, Inventory Stock/Ledger, Purchase Order flow, Payroll Run, Accounting Journal/Ledger, Report viewers.

### 26. API / Server Architecture

Next.js **Route Handlers** (`/app/api/<domain>/...`) for anything called from client components or external integrations (webhooks, portal, future mobile), plus **Server Actions** for form-bound mutations within server-rendered pages, both calling into the same domain **service layer** (`/lib/domains/<domain>/service.ts`) — the service layer is the single source of business logic; route handlers and server actions are thin adapters that do auth, validation, and call the service. This avoids duplicating business rules between an API route and a server action for the same operation.

### 27. Domain Event Architecture

In-process **transactional outbox**: when a service commits a state change that other domains care about (per the event list in spec.md §73 and the "what else does this affect" discipline in §93), it writes an `outbox_event` row in the *same transaction*. A background worker (in-process interval job for v1, no external queue needed per §73's "no unnecessary distributed infrastructure") polls the outbox and dispatches to registered in-process handlers, marking events processed. This gives at-least-once delivery without introducing Kafka/RabbitMQ, while keeping the primary transaction fast and not blocking on side effects (notification send, analytics refresh).

---

## PART D — TECHNICAL BLUEPRINT

### 28. Final Technology Stack

Per spec.md §69, confirmed with no deviation unless flagged:

- **Frontend**: Next.js (App Router) + React + TypeScript + Tailwind CSS + shadcn/ui + Lucide Icons.
- **Backend**: TypeScript, Next.js Route Handlers + Server Actions.
- **Database**: PostgreSQL.
- **ORM**: Prisma.
- **Validation**: Zod.
- **Calendar/scheduling UI**: FullCalendar (or equivalent) for the appointment calendar.
- **Charts**: Recharts.
- **PDF generation** (prescriptions, invoices, reports): `@react-pdf/renderer` or Puppeteer-based HTML→PDF — decision deferred to Phase 4 when the first print output is built; will flag for confirmation then.
- **CSV/Excel import-export**: `exceljs`.
- **File uploads/storage**: local filesystem in dev, pluggable object-storage adapter (S3-compatible) interface from day one so production storage is a config change.
- **Dates**: `date-fns` + `date-fns-tz` (explicit timezone handling is mandatory for a multi-branch clinical system — appointment times must always carry/derive branch timezone).
- **Auth**: Auth.js (NextAuth) credentials provider over a custom users table, or a hand-rolled session-cookie implementation — will confirm exact approach at Phase 1 kickoff since this affects the session/RBAC plumbing directly (see open question in §43).
- **Testing**: Vitest/Jest for unit + integration, Playwright for E2E.

I will verify current package versions/compatibility at the start of Phase 1 rather than pinning versions in this document, per spec.md §69's own instruction.

### 29. Project Folder Structure

```
/app                          # Next.js routes (thin: pages + route handlers only)
  /(dashboard)/...
  /api/<domain>/...
/lib
  /domains
    /patients        {service.ts, repository.ts, schema.ts, events.ts, permissions.ts}
    /providers
    /appointments
    /episodes
    /encounters
    /clinical
    /orders
    /laboratory
    /pharmacy
    /radiology
    /billing
    /payors
    /claims
    /inventory
    /procurement
    /assets
    /hr
    /payroll
    /accounting
    /communications
    /reports
    /admin
  /platform          {audit.ts, access-log.ts, sequences.ts, outbox.ts, permissions-core.ts}
  /db                {prisma client, migrations}
  /auth
  /ui                # shared design-system components (thin wrapper over shadcn)
/prisma
  schema.prisma
  /migrations
/tests
  /unit, /integration, /e2e
```

Matches spec.md §71's domain list exactly, with `/lib/platform` added to hold the cross-cutting infra (audit, sequences, outbox, permission engine) that every domain depends on but none owns.

### 30. Authentication Architecture

Credential-based login (email/username + password), passwords hashed with **argon2id** (bcrypt acceptable fallback), server-side session (DB-backed session table, not a fat stateless JWT, so sessions can be revoked instantly — required for "account lock" and "force logout" controls). Login attempts logged (`login_history`), failed-attempt counter with progressive lockout, password-reset via single-use expiring token emailed to the account, MFA/2FA schema present but gated off (feature-flagged) for v1 per spec.md §6. Every session carries `user_id`, active `organization_id`, and resolved `branch_access` for fast authorization checks without a join on every request.

### 31. Security Architecture

Layered per spec.md §75/§76: Zod validation at every input boundary; parameterized queries only (Prisma default — raw SQL banned outside reviewed exceptions); output-encoding by default (React) plus explicit sanitization for any rich-text clinical note field; CSRF protection on state-changing routes (SameSite cookies + double-submit token for non-Server-Action mutations); rate limiting on auth endpoints and public booking endpoints; secure cookie flags (`HttpOnly`, `Secure`, `SameSite=Lax/Strict`); secrets only via environment variables, never committed, validated present at boot; least-privilege data segregation enforced by the permission matrix (§23) rather than by module boundary alone — e.g., reception's `patient.view` permission is scoped to exclude clinical-note fields at the query-projection level, not just hidden in the UI.

### 32. File Storage Architecture

Abstract `StorageAdapter` interface (`put`, `get`, `getSignedUrl`, `delete`) with a local-disk implementation for development and an S3-compatible implementation for production, selected by config. All uploads validated for MIME type + size + (for images) re-encoded to strip EXIF/metadata before storage. Documents (`patient_document`, `employee_document`, etc.) store the storage key + metadata in the DB, never the file bytes.

### 33. Reporting Architecture

Two tiers: (1) **operational list/export reports** — server-side-paginated, filterable tables with CSV/Excel export, built once as a generic reusable table component per spec.md §80/§83; (2) **analytical reports** (P&L, Balance Sheet, revenue-cycle aging, provider utilization) — dedicated query modules in `/lib/domains/reports` that compute from source tables (never from a hand-maintained summary table that can drift), with heavier ones cached/materialized on a schedule if they become slow at scale.

### 34. Deployment Architecture

Single Next.js application deployed as a container (or platform-native build, e.g., a Node server target) behind HTTPS, connected to a managed PostgreSQL instance. Environment-based config for DB URL, storage, communication provider keys, session secret. Migrations run as an explicit deploy step (`prisma migrate deploy`), never auto-applied on boot in production. Documented fully in `DEPLOYMENT.md` once we reach it (see §89).

### 35. Backup Strategy

Automated daily full DB backup + continuous WAL archiving (point-in-time recovery) on the managed Postgres provider; documented restore drill procedure; uploaded documents backed up via the storage provider's own redundancy/versioning. Backup/restore procedure is written up as part of Phase 14 hardening, not left implicit.

### 36. Testing Strategy

Per spec.md §84/§85/§86/§87: unit tests for pure business logic (invoice totals, commission calc, journal balancing, stock FEFO selection), integration tests for the critical multi-table transactions in §18, and Playwright E2E tests for the three named end-to-end flows (Core Clinical→Revenue, Procurement, HR→Payroll). Auth/authorization get dedicated test suites since they're the most consequential to get wrong. Tests run in CI on every phase before it's marked complete, per the Definition of Done (§91).

---

## PART E — IMPLEMENTATION

### 37. Development Roadmap

Follows spec.md Phases 0–14 exactly, in order, one phase fully closed (code + tests + docs updated) before the next opens:

`Phase 0 Architecture → 1 Platform Foundation → 2 Patient & Practice → 3 Core EMR → 4 Revenue → 5 Inventory & Procurement → 6 Finance → 7 HR & Assets → 8 LIS → 9 Pharmacy → 10 RIS → 11 Payors & Insurance → 12 Patient Engagement → 13 Analytics → 14 Hardening`

Phase 4 ("commercially usable clinic core") is the first meaningful internal milestone; the full spec.md §94 Build Priority set (through HR/Assets/Reports) is the **v1 commercial target**, i.e., Phases 0–7 plus baseline reporting.

### 38. Dependencies Between Phases

- Phase 1 blocks everything (tenancy, auth, RBAC, audit, sequences are load-bearing for every later table).
- Phase 2 blocks Phase 3 (need patients/providers/appointments before encounters).
- Phase 3 blocks Phase 4 (billing needs something billable — encounters/orders) **and** blocks Phases 8–10 (LIS/PIS/RIS all consume CPOE orders defined in Phase 3).
- Phase 4 blocks Phase 6 (accounting posts against real invoices/payments) and Phase 11 (claims need invoices).
- Phase 5 (inventory) blocks Phase 9 (pharmacy dispensing reduces stock) and the consumption piece of Phase 3/4 procedures.
- Phase 6 (accounting) should land before Phase 7 payroll finalization (payroll posts journals) — Phase 7 can build employee/attendance/leave ahead of accounting, but payroll-approval-with-posting waits on Phase 6.
- Phases 8, 9, 10 are mutually independent and can be reordered relative to each other if the user's priorities differ, but all three depend on Phase 3 + Phase 4.
- Phase 12 (engagement/portal) depends on Phase 2–4 minimum (needs patients, appointments, invoices to expose).
- Phase 13 (analytics) can begin incrementally alongside each phase (each phase should ship its own dashboard tiles) but a dedicated cross-module analytics pass is reserved for Phase 13.
- Phase 14 (hardening) is continuous in spirit (every phase already runs tests/checks per the Definition of Done) but gets a dedicated final pass.

### 39. MVP Definition

Phases 0–4: Platform Foundation + Patient & Practice + Core EMR + Revenue. A clinic can register patients, schedule and see them, document a visit, prescribe, and get paid, with full audit and RBAC. This is the smallest slice that is *not* a toy — every piece is production-grade, just narrower in scope.

### 40. Version 1 Definition

Phases 0–7 (adds Inventory/Procurement, Finance/Accounting, HR & Assets) — matches spec.md §94's Build Priority list exactly. This is the first genuinely commercial-grade release: a clinic can run its entire back office (stock, suppliers, books, staff, payroll, assets) on the system, not just see patients.

### 41. Future Modules

Phases 8–13 (LIS, Pharmacy, RIS, Payors/Insurance/Claims, Patient Engagement/Portal/Booking, Analytics) plus explicitly-deferred items called out in spec.md itself: MFA/2FA (§6), PACS integration proper (§30 — only the integration *interface* is built now), full country-specific insurance format adapters (§39 — only the adapter *pattern* is built now), and a genuine multi-tenant SaaS mode (organization isolation is schema-ready per §5 but multi-org provisioning/billing is not in scope).

### 42. Major Risks

1. **Scope/sequencing risk** — this spec covers ~15 subsystems; the single biggest failure mode is horizontal sprawl (a bit of every module, nothing production-solid). Mitigated by strict phase gating and the Definition of Done (§91) — no phase is "done" on UI existing alone.
2. **Accounting correctness risk** — an unbalanced or wrongly-mapped journal silently corrupts financial statements. Mitigated by DB-level balance constraints, the single posting-service chokepoint, and dedicated journal-balancing tests (§84).
3. **Concurrency risk** — double-booking, race-condition stock oversells, duplicate number-sequence values. Mitigated by DB exclusion constraints (§16) and sequence generation via `SELECT ... FOR UPDATE`/DB sequences rather than app-level "read max, add one" (explicitly banned in §68).
4. **Clinical data integrity/immutability risk** — a finalized note or result being editable in place is both a data-integrity and a compliance problem. Mitigated by amendment/versioning pattern rather than in-place edit (§25, §92).
5. **Authorization drift risk** — as 15 domains and dozens of screens grow, it's easy for a new endpoint to forget a permission check. Mitigated by a single `can()` chokepoint used everywhere and middleware-level default-deny, plus authorization-focused tests.
6. **Over-engineering risk** — event-driven architecture, adapter patterns, and multi-tenant-readiness could balloon complexity if applied uniformly instead of where the spec actually calls for them. Mitigated by scoping outbox events to the explicit list in §73/§93 and adapters to the explicit list in §56, not inventing more.
7. **Timezone/multi-branch correctness risk** — branches may span timezones; naive `timestamp` handling corrupts appointment times and daily financial cutoffs. Mitigated by storing `timestamptz` everywhere and an explicit branch timezone field used at display/scheduling time.

### 43. Architecture Decisions That Must Be Finalized Before Coding

These are open questions I need your input on (or my recommended default, which I'll proceed with unless you redirect) before Phase 1 starts:

1. **Auth implementation**: Auth.js/NextAuth (credentials provider, DB session) vs. a hand-rolled session layer. *Recommendation: hand-rolled, DB-backed sessions* — gives full control over the lockout/login-history/instant-revocation requirements in §6 without fighting a library's assumptions; Auth.js is easier to start but less transparent for these exact controls.
2. **Multi-tenancy posture for v1**: single organization per deployment (schema still carries `organization_id` everywhere) vs. building actual multi-org provisioning now. *Recommendation: single-org-per-deployment*, per spec.md §5's own phrasing ("a future SaaS version").
3. **PDF generation approach**: React-PDF (component-based, faster, no headless browser) vs. Puppeteer/HTML-to-PDF (easier pixel-perfect branding templates, heavier). *Recommendation: React-PDF*, revisit if branding templates turn out to need HTML/CSS fidelity Puppeteer handles better.
4. **ICD terminology sourcing**: spec.md §24 requires *not* hardcoding the terminology into logic — do you have a licensed ICD-10/11 dataset to import, or should Phase 3 ship with a small seed subset (common codes) and an admin-manageable `diagnosis_code` table structured to bulk-import a full set later? *Recommendation: the latter*, since full ICD datasets often carry licensing terms.
5. **Communication provider selection**: which SMS/WhatsApp/Email providers should the concrete adapters target first (e.g., Twilio for SMS, Meta Cloud API for WhatsApp, Resend/SES for email)? Needed before Phase 12, not blocking earlier phases, but good to confirm now since it affects the adapter interface shape.
6. **Currency/locale**: single currency (e.g., AED, given the spec's examples) vs. multi-currency from day one? *Recommendation: single currency configured per organization for v1* — multi-currency is a real complexity jump (FX on the ledger) not evidenced as required.

---

## CRITICAL REVIEW

### Missing Healthcare Workflows

- **No-show and late-cancellation policy enforcement** isn't specified — appointment statuses exist (§17) but there's no fee/penalty or patient-flagging workflow tied to repeated no-shows. Recommend adding a lightweight "no-show count" on patient + optional policy hook, deferred to Phase 12 (engagement) but the *status tracking* should exist from Phase 2.
- **Referral management** is named as an order type (§26) but never gets its own workflow section (unlike Lab/Pharmacy/Radiology which each get full workflow write-ups in §28–30). A referral order needs at minimum: internal (to another provider/department) vs. external (outside the clinic) distinction, and a status for "referral letter issued" vs. "patient seen." Recommend a short referral workflow spec added alongside Phase 3.
- **Waitlist management** is absent — when a patient wants an earlier slot than available, there's no waitlist entity to notify them if a slot opens. Minor, but common in clinic operations; can be deferred to Phase 12 without harm.
- **Recall/preventive-care reminders** (e.g., "diabetic patients due for 6-month follow-up") aren't modeled beyond ad-hoc "Follow-Up" appointments. Given the spec explicitly lists "Follow-up due" as a notification type (§64), there should be a lightweight `follow_up_recommendation` entity (encounter → recommended date/reason) that the notification engine and reports can query, rather than relying on a plain future-dated appointment to carry that meaning. Recommend adding this to Phase 3.
- **Death/deceased-patient handling** — no status or workflow for marking a patient deceased, which affects scheduling (block future appointments), portal access, and reporting. Small addition to Patient Master status enum (Phase 2).

### Data Integrity Issues

- **Charge reversal on clinical amendment isn't addressed.** §25 mandates clinical amendments over edits, and §33 mandates charges are generated from clinical events — but what happens to an already-generated charge when the triggering diagnosis/procedure is later amended (e.g., procedure downgraded after the fact)? This needs an explicit rule: amendments to already-billed clinical facts do **not** retroactively change the original charge; a correction requires a new adjustment charge/credit, mirroring the "never delete financial transactions" rule (§92). I'll formalize this as ADR material in Phase 3/4.
- **Package session consumption vs. billing timing** is underspecified — does purchasing a 10-session package invoice for the full amount upfront, or does each session generate its own charge against a prepaid balance? These have very different accounting treatment (deferred revenue vs. recognized-on-purchase). This must be decided explicitly before Phase 4 — recommend **deferred revenue**: purchase creates a liability (unearned revenue), each session usage recognizes a slice of revenue. This is a real accounting nuance the spec doesn't surface but that any auditor will ask about.
- **Insurance responsibility split before adjudication** — §33/§39 imply `patient_responsibility`/`payor_responsibility` are known at invoice time, but real adjudication often changes the approved amount later (partial rejection). The model needs a clear distinction between *estimated* patient responsibility (at invoice time, from the coverage/copay config) and *final* patient responsibility (post-remittance), with a reconciling adjustment, not an in-place edit of the original invoice.
- **Duplicate detection (§9) is "warn not block"** but the spec doesn't define what happens to the *warning decision* — should it be logged (who overrode a duplicate warning and why)? Recommend logging the override reason to the audit trail; otherwise duplicate patient records will still accumulate silently over time with no way to investigate root cause later.

### Security Risks

- **Clinical Access Log (§63) needs its own strict access control**, and the spec correctly flags this — but doesn't address **who can access the access log for legitimate purposes** (e.g., a compliance officer investigating inappropriate access) vs. it becoming a blind spot no one ever reviews. Recommend a dedicated `audit.review` permission held only by Org Admin/Compliance role, plus a periodic-review workflow (even a manual report) rather than a table that's technically protected but functionally never looked at.
- **Reception's `patient.view` needs field-level, not just table-level, scoping** (per §76 — reception shouldn't see clinical notes automatically). This is a genuine implementation risk: Prisma queries are easy to write as `SELECT *` equivalents by habit. Recommend a hard rule from Phase 2 onward: every domain exposes explicit DTO/projection functions per permission level, never a raw model return, enforced by code convention + a lint rule/review checklist.
- **File upload validation (§75)** is listed but not detailed — for a healthcare system, documents (lab PDFs, ID scans) are a real attack surface (malicious PDFs, zip bombs, oversized uploads). Recommend explicit size caps, allow-listed MIME types validated by content-sniffing (not just file extension), and storage outside the web root/served only via signed URLs — this should be written into `SECURITY.md` explicitly, not left implicit.
- **Session fixation / concurrent session limits** aren't addressed — should a user be allowed unlimited concurrent sessions? For clinical staff on shared workstations, an idle-session timeout and visible "active sessions" admin view (tied into the login-history requirement, §6) is a reasonable addition, deferred to Phase 14 hardening but worth flagging now.

### Financial / Accounting Weaknesses

- **Tax handling is under-specified** — §33/§34 mention "Tax" as a line item but there's no tax-rule engine (e.g., different tax rates per service category, tax-exempt patients/payors, tax-inclusive vs. exclusive pricing). Since ZATCA (Saudi e-invoicing) is explicitly named as a future compliance target (§77), the invoice/tax model should be built with **tax as a configurable rate per service/product + jurisdiction**, not a flat hardcoded percentage, from Phase 4 — retrofitting tax architecture later is painful once thousands of invoices exist.
- **Multi-currency and rounding policy** aren't addressed (see §43 open question above) — even single-currency, the *rounding rule* for tax/discount calculation (round per line vs. round the total) needs to be an explicit, tested rule, since it's a classic source of "invoice total doesn't match sum of lines" bugs and audit complaints.
- **Cashier variance handling (§37)** tracks variance but doesn't specify the accounting treatment of a variance (is it posted to a suspense/over-short expense account? does it require manager approval above a threshold?). Recommend defining this explicitly in Phase 4/6 rather than leaving it to whoever implements the cashier-close screen.
- **Commission accrual vs. payment timing** — §53 allows commission basis on "collected revenue," which means commission can only be finalized once cash is actually received, not at invoice time. This needs to be modeled as an accrual that's provisional until payment confirms, with a clear "commission recalculation on invoice write-off/refund" rule — otherwise a refunded invoice could leave a paid-out commission stranded. Flagging this as a Phase 7 design detail to get right, not an afterthought.

### Scalability Issues

- **Stock balance as a pure ledger aggregation (§9/§43)** will eventually become a performance bottleneck for high-volume pharmacies once ledger rows number in the millions. The blueprint already allows a materialized `stock_balance` cache — I'm calling this out explicitly as a **known, accepted tradeoff**: build the pure-ledger model first (correctness first, per §43 of spec.md itself: "never directly manipulate inventory without a ledger"), add the materialized balance table with cache-invalidation-on-insert only if/when profiling in Phase 14 shows it's needed. Don't build the cache prematurely.
- **Global search (§66) across patients/appointments/invoices/etc.** will need a real search index (Postgres full-text/trigram is fine at clinic scale, likely insufficient at multi-branch/large-org scale). Acceptable for v1 with `pg_trgm`; flag for revisit if/when the SaaS multi-tenant future materializes.
- **Reporting queries directly against transactional tables (§33)** are fine at single-clinic scale but will need read-replica or materialized-view strategies at larger multi-branch scale. Not a v1 concern; documented as a forward-looking note only.

### Excessive Complexity Risks

- **Event-driven architecture (§73/§27) risks being over-applied.** The spec is explicit that only certain flows need events, and I'm scoping the outbox mechanism strictly to the enumerated event list rather than making every state change event-driven — this is called out above (§42 risk 6) but worth restating: the temptation to "event-ify everything" for a system with this many domains is real, and I intend to default to a direct synchronous service call unless there's a specific reason (decoupling a slow/unreliable side effect, or a genuine one-to-many fan-out) to use an event instead.
- **CPOE polymorphic order model (§6/§26)** — the shared-parent + type-detail-table pattern is the right call, but there's a risk of over-genericizing it into a fully pluggable "order type registry" framework. I'm keeping it to a fixed, small enum (`lab | medication | imaging | procedure | referral | other`) with concrete detail tables per type, not a generic EAV/plugin system — YAGNI applies here even though the domain (healthcare orders) tempts over-abstraction.
- **Adapter patterns (communications, storage, future insurance formats)** are justified by the spec's own explicit instructions (§39, §56) — not over-engineering — but I will keep each adapter interface minimal (the actual methods currently needed) rather than speculatively broad.

### Recommended Corrections Summary

1. Add referral workflow detail and a `follow_up_recommendation` entity to Phase 3 scope.
2. Formalize the "amendment does not retroactively alter an issued charge" rule as an explicit business rule before Phase 3/4 billing integration is built.
3. Decide package accounting treatment now: **deferred revenue on purchase, recognized per session** (my recommendation) — please confirm or override.
4. Add explicit tax-rule-per-service/jurisdiction modeling to Phase 4 scope instead of a flat percentage.
5. Add duplicate-override audit logging to Phase 2 patient registration.
6. Add field-level projection discipline as a stated engineering rule in this blueprint (done above) and re-state it in `SECURITY.md` once created.
7. Confirm the six open architecture decisions in §43 (auth approach, multi-tenancy posture, PDF library, ICD sourcing, communication providers, currency) — I'll proceed with my stated recommendations for any you don't respond to explicitly.

---

**This blueprint is not yet approved.** Once you confirm the corrections above (or redirect any of them) and answer/accept the §43 decisions, I will proceed to Phase 0 architecture artifacts proper (ERD diagram, RBAC matrix file, route map, roadmap) and then Phase 1 implementation, exactly in the order defined in spec.md.
