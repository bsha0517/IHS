# DATABASE.md

Living reference for the PostgreSQL schema. Updated at the end of every phase with the entities that phase actually implemented (Prisma is the source of truth — `prisma/schema.prisma` — this file is the human-readable index into it). Phase 1 entities are marked **[P1]** below; later phases add to this file as they land.

## Conventions

- Primary keys: `id UUID DEFAULT gen_random_uuid()`.
- Every business table carries `organization_id`, and (where applicable) `branch_id`.
- Money: `NUMERIC(14,2)`; tax-rate/rounding-sensitive fields `NUMERIC(14,4)`.
- Timestamps: `TIMESTAMPTZ`, never naive `TIMESTAMP`. `created_at`/`updated_at` on every table; `created_by`/`updated_by` FK to `user` on business tables. **In Prisma, this requires `@db.Timestamptz(3)` on every `DateTime` field explicitly** — Prisma's default Postgres mapping for `DateTime` is a naive `TIMESTAMP`, which silently violates this convention (discovered and fixed retroactively in Phase 2; see PROJECT_STATUS.md's Architecture Decisions for that phase).
- Soft delete (`deleted_at TIMESTAMPTZ NULL`) only on config-like/operational rows (users, services, products). Clinical and financial rows are never soft-deleted (see BLUEPRINT.md §70/§92) — they are superseded, amended, or reversed.
- Number sequences: DB-backed `number_sequence` table incremented via `SELECT ... FOR UPDATE`, never `COUNT(*) + 1` (spec.md §68).

## Phase 1 — Platform Foundation Schema

```
organization        [P1]  id, legal_name, display_name, default_currency, default_timezone,
                            status, created_at
branch               [P1]  id, organization_id FK, name, code, timezone, address, phone,
                            status, created_at
department           [P1]  id, branch_id FK, name, code, status
room                 [P1]  id, department_id FK, name, code, room_type, status
user                 [P1]  id, organization_id FK, email UNIQUE(org_id,email), username,
                            password_hash, status, failed_login_count, locked_until,
                            last_login_at, mfa_enabled(bool, default false), created_at
user_branch_access   [P1]  id, user_id FK, branch_id FK, UNIQUE(user_id,branch_id)
session              [P1]  id, user_id FK, active_branch_id FK NULL, ip, user_agent,
                            expires_at, revoked_at NULL, created_at
login_history        [P1]  id, user_id FK NULL, email_attempted, success(bool), ip,
                            user_agent, reason NULL, created_at
password_reset_token [P1]  id, user_id FK, token_hash, expires_at, used_at NULL
role                 [P1]  id, organization_id FK, name, is_system_role(bool), created_at
permission           [P1]  id, code UNIQUE ("patient.view" style), category, description
role_permission      [P1]  id, role_id FK, permission_id FK, UNIQUE(role_id,permission_id)
user_role            [P1]  id, user_id FK, role_id FK, UNIQUE(user_id,role_id)
audit_log            [P1]  id, organization_id FK, user_id FK NULL, action, entity_type,
                            entity_id, old_values JSONB NULL, new_values JSONB NULL,
                            ip NULL, user_agent NULL, created_at   (INSERT-only)
clinical_access_log  [P1]  id, organization_id FK, user_id FK, patient_id FK,
                            resource_type, resource_id NULL, action, created_at (INSERT-only)
number_sequence      [P1]  id, organization_id FK, branch_id FK NULL, sequence_type,
                            prefix, current_value, padding, UNIQUE(organization_id,
                            branch_id, sequence_type)
outbox_event         [P1]  id, organization_id FK, event_type, payload JSONB,
                            status(pending|processed|failed), created_at, processed_at NULL
setting              [P1]  id, organization_id FK, branch_id FK NULL, key, value JSONB,
                            UNIQUE(organization_id, branch_id, key)
notification         [P1]  id, organization_id FK, recipient_user_id FK, type, title, body,
                            reference_type NULL, reference_id NULL,
                            status(unread|read|archived), created_at
```

Indexes (Phase 1): B-tree on every FK; `UNIQUE(organization_id, email)` on `user`; partial unique on `role.name` per org; GIN trigram on `patient.first_name/last_name/mrn` deferred to Phase 2 when `patient` lands. `audit_log(entity_type, entity_id, created_at)` composite for record-history lookups. `outbox_event(status, created_at)` partial index `WHERE status='pending'` for the poller.

Constraints (Phase 1): `journal` balance trigger deferred to Phase 6 (table doesn't exist yet). `number_sequence` increments happen inside `SELECT ... FOR UPDATE` transactions only — enforced by the service layer being the sole writer (no direct Prisma `update` calls from route handlers).

## Phase 2 — Patient & Practice Schema

```
patient                   [P2]  id, organization_id FK, registration_branch_id FK, mrn
                                 UNIQUE(org_id,mrn), first/middle/last_name, dob DATE, gender,
                                 nationality, mobile, whatsapp, email, address_line, city,
                                 country, national_id, passport_number, emergency_contact_*,
                                 preferred_language, referral_source, preferred_provider_id FK
                                 NULL, status, created_by, created_at, updated_at
patient_allergy           [P2]  id, patient_id FK, allergen, reaction, severity, is_alert(bool),
                                 status, noted_by, noted_at
patient_condition         [P2]  id, patient_id FK, category(chronic|active|previous|
                                 surgical_history|family_history|medical_history), description,
                                 is_alert(bool), status, noted_by, noted_at
patient_medication_history [P2] id, patient_id FK, medication_name, dose, status(current|past),
                                 start_date DATE NULL, end_date DATE NULL, noted_by, noted_at
provider                  [P2]  id, organization_id FK, employee_id NULL (Phase 7), user_id FK
                                 NULL UNIQUE (added mid-phase — see Architecture Decisions),
                                 provider_type, first/last_name, specialty, qualification,
                                 license_number, license_authority, license_expiry_date DATE,
                                 consultation_fee NUMERIC(14,2), default_appointment_duration_minutes,
                                 status, created_at, updated_at
provider_branch           [P2]  id, provider_id FK, branch_id FK, UNIQUE(provider_id,branch_id)
provider_department       [P2]  id, provider_id FK, department_id FK, UNIQUE(...)
provider_schedule         [P2]  id, provider_id FK, branch_id FK, department_id FK NULL,
                                 room_id FK NULL, day_of_week(0-6), start_time, end_time
                                 (both "HH:MM" text, branch-local), slot_duration_minutes, is_active
provider_leave_block      [P2]  id, provider_id FK, start_at, end_at, reason, created_by,
                                 created_at — checked at booking time, hard-blocks overlap
service                   [P2]  id, organization_id FK, code UNIQUE(org_id,code), name, category,
                                 department_id FK NULL, description, duration_minutes,
                                 price NUMERIC(14,2), billable(bool), is_active(bool),
                                 required_room_type, created_at, updated_at
service_provider          [P2]  id, service_id FK, provider_id FK, UNIQUE(service_id,provider_id)
appointment               [P2]  id, organization_id FK, branch_id FK, appointment_number
                                 UNIQUE(org_id,number), patient_id FK, provider_id FK,
                                 service_id FK NULL, department_id FK NULL, room_id FK NULL,
                                 start_time, end_time (TIMESTAMPTZ), booking_source, notes,
                                 status, rescheduled_from_id FK NULL (self-relation), created_by,
                                 created_at, updated_at
appointment_status_history [P2] id, appointment_id FK, from_status NULL, to_status, changed_by,
                                 changed_at, reason
queue_entry               [P2]  id, appointment_id FK UNIQUE, branch_id FK, token_number,
                                 arrived_at, checked_in_at, called_at, consultation_start_at,
                                 consultation_end_at, created_at
```

Hard constraints added this phase (`timestamptz_and_booking_exclusion` migration): `EXCLUDE USING gist ("provider_id" WITH =, tstzrange("start_time","end_time") WITH &&) WHERE (status NOT IN ('cancelled','no_show','rescheduled'))` on `appointment`, and the equivalent on `room_id` (nullable-safe via `WHERE room_id IS NOT NULL AND ...`). This is the actual double-booking prevention (spec.md §16) — application-level pre-checks exist too (for a readable error message) but are not what makes it safe under concurrency.

`number_sequence` gained `reset_period(never|daily)` and `last_reset_at` this phase, used by queue tokens (`Q-001`, resets daily) — still a single atomic `UPDATE ... RETURNING` per spec.md §68, the reset-vs-increment choice is one `CASE` expression inside that same statement, not a separate step.

`patient_document` and `consent` from the original Phase 2 forward-schema sketch were **not** built — deliberately deferred (see BLUEPRINT.md's scoping note in PROJECT_STATUS.md); spec.md's Phase 2 build checklist (§88 phase list) names Patient/Patient 360/Provider/Services/Scheduling/Appointments/Reception/Queue specifically and does not include Document Management (§60) or Consent Management (§61), which are broader cross-cutting sections better built as their own slice later rather than half-built now.

## Phase 3 — Core EMR Schema

```
episode                    [P3]  id, organization_id FK, patient_id FK, title, status,
                                   created_by, created_at, updated_at
encounter                  [P3]  id, organization_id FK, branch_id FK, department_id FK NULL,
                                   patient_id FK, episode_id FK NULL, appointment_id FK NULL,
                                   provider_id FK, encounter_number UNIQUE(org_id,number),
                                   encounter_type, status(active|completed|finalized),
                                   start_at, end_at NULL, created_by, created_at, updated_at
vital_sign                 [P3]  id, organization_id FK, patient_id FK, encounter_id FK,
                                   branch_id FK, height_cm/weight_kg/bmi NUMERIC (bmi computed
                                   server-side, never client-submitted), blood_pressure_systolic/
                                   diastolic, pulse_bpm, temperature_celsius, oxygen_saturation_
                                   percent, respiratory_rate_per_min, blood_glucose_mg_dl,
                                   recorded_by, recorded_at
diagnosis_code              [P3]  id, code UNIQUE (ICD-10 style), description, category
                                   — seed subset (~30 codes / 12 categories), admin-importable
diagnosis                  [P3]  id, organization_id FK, encounter_id FK, patient_id FK,
                                   code_id FK, is_primary(bool), status(active|resolved|ruled_out),
                                   diagnosed_by, diagnosed_at
clinical_note               [P3]  id, organization_id FK, encounter_id FK, patient_id FK,
                                   note_type, status(draft|finalized), chief_complaint,
                                   history_of_present_illness, review_of_systems,
                                   examination_findings, assessment, treatment_plan, content NULL,
                                   amends_id FK NULL (self-relation), is_current(bool, default true),
                                   authored_by, finalized_by NULL, finalized_at NULL,
                                   created_at, updated_at
clinical_order              [P3]  id, organization_id FK, encounter_id FK, patient_id FK,
                                   order_number UNIQUE(org_id,number), priority(routine|urgent|
                                   stat), status(ordered|acknowledged|in_progress|completed|
                                   cancelled), reason NULL, instructions NULL, ordered_by, ordered_at
lab_order_detail            [P3]  id, order_id FK UNIQUE, test_name, specimen_type NULL
imaging_order_detail        [P3]  id, order_id FK UNIQUE, imaging_type, body_part NULL
procedure_order_detail      [P3]  id, order_id FK UNIQUE, procedure_name
referral_order_detail       [P3]  id, order_id FK UNIQUE, referral_scope(internal|external),
                                   referred_to_provider_id FK NULL, referred_to_external NULL,
                                   referral_status(issued|acknowledged|seen|closed)
prescription                [P3]  id, organization_id FK, encounter_id FK, patient_id FK,
                                   prescription_number UNIQUE(org_id,number),
                                   status(active|cancelled), issued_by, issued_at
prescription_item           [P3]  id, prescription_id FK, medication_name, generic_name NULL,
                                   strength NULL, dose, frequency, route, duration_days NULL,
                                   quantity NULL, instructions NULL
follow_up_recommendation    [P3]  id, organization_id FK, encounter_id FK, patient_id FK,
                                   recommended_date DATE, reason, status(open|scheduled|dismissed),
                                   linked_appointment_id FK NULL, created_by, created_at
```

Deliberately **not** built this phase: a `medication_order_detail` CPOE type — `Prescription`/`PrescriptionItem` is the single path for medications in Phase 3 (see PROJECT_STATUS.md's Architecture Decisions); revisit only if Phase 9 (Pharmacy) needs order-vs-prescription lifecycles to diverge.

`clinical_org_scoping` migration: `vital_sign`, `diagnosis`, and `follow_up_recommendation` were missing `organization_id` in the initial `phase3_core_emr` migration — every other business table in the schema carries it, and its absence here was caught while writing `listPatientVitals()`, before any query relied on the gap. Added retroactively with no data-loss risk (tables held only test data at the time).

Note-amendment invariant (enforced in `src/lib/domains/clinical/notes.ts`, not just by convention): a `clinical_note` row is created via `saveNote()` while `draft` (freely editable in place). Once `finalized`, `saveNote()` refuses further edits; `createAmendment()` is the only path forward — it flips the original's `is_current` to `false` and creates a new row with `amends_id` pointing back to it, **created already `finalized`** (an amendment only ever targets an already-finalized note, and nothing ever sweeps a post-finalization note to `finalized` the way `finalizeEncounter()`'s one-time bulk update does for the original draft). `getEncounter()`'s `notes` relation is scoped `WHERE is_current = true`, so the workspace always shows the latest version; `getNoteHistory()` walks the full `amends_id` chain for an audit view.

## Phase 4 — Revenue Schema

```
charge                   [P4]  id, organization_id FK, branch_id FK, patient_id FK,
                                encounter_id FK NULL, service_id FK NULL, provider_id FK NULL,
                                source_type(consultation|procedure|lab|imaging|pharmacy|product|
                                package|other), source_reference_id NULL (loose polymorphic
                                pointer, interpretation depends on source_type — same convention
                                as notification.reference_id), description, quantity,
                                unit_price NUMERIC(14,2), amount NUMERIC(14,2) (server-computed,
                                never accepted from a client), status(pending|invoiced|void),
                                void_reason NULL, created_by, created_at
invoice                  [P4]  id, organization_id FK, branch_id FK, invoice_number
                                UNIQUE(org_id,number), patient_id FK, provider_id FK NULL,
                                status(draft|issued|partially_paid|paid|void), subtotal,
                                discount_amount, tax_amount, total_amount, paid_amount
                                (maintained only by payments/refunds services, never set
                                directly) NUMERIC(14,2) each, void_reason NULL, created_by,
                                created_at, issued_at
invoice_line             [P4]  id, invoice_id FK, charge_id FK UNIQUE (one line per consumed
                                charge — invoicing is what flips a charge to `invoiced`),
                                description, quantity, unit_price, discount_amount, tax_amount,
                                line_total NUMERIC(14,2) each
payment                  [P4]  id, organization_id FK, branch_id FK, receipt_number
                                UNIQUE(org_id,number), method(cash|card|bank|online|insurance|
                                credit|other), amount NUMERIC(14,2), reference NULL,
                                cashier_session_id FK NULL, status(completed|reversed),
                                received_by, received_at — one row per tender (spec.md §35
                                split-payment example = 3 Payment rows against 1 invoice)
payment_allocation       [P4]  id, payment_id FK, invoice_id FK, amount NUMERIC(14,2),
                                UNIQUE(payment_id,invoice_id) — many-to-many bridge (locked
                                Phase 0 design); Phase 4's UI only ever creates one allocation
                                per payment, schema supports more for future AR settlement
refund                   [P4]  id, organization_id FK, branch_id FK, invoice_id FK,
                                payment_id FK NULL ("where appropriate" per spec.md §36 — a
                                credit-note-style refund need not reverse one specific payment),
                                method, amount NUMERIC(14,2), reason, status(requested|
                                authorized|completed|rejected), cashier_session_id FK NULL,
                                requested_by, requested_at, authorized_by NULL, authorized_at
                                NULL, rejection_reason NULL, completed_at NULL
cashier_session           [P4]  id, organization_id FK, branch_id FK, cashier_user_id,
                                opening_cash, expected_cash NULL, actual_cash NULL,
                                variance NULL NUMERIC(14,2) each, status(open|closed), notes
                                NULL, opened_at, closed_at NULL — expected_cash always derived
                                at close time, never a directly-mutable balance
cash_movement             [P4]  id, organization_id FK, cashier_session_id FK,
                                direction(in|out), amount NUMERIC(14,2), reason, recorded_by,
                                recorded_at
package                   [P4]  id, organization_id FK, code UNIQUE(org_id,code), name,
                                description NULL, price, discount_amount NUMERIC(14,2) each,
                                validity_days NULL, is_active(bool), created_at, updated_at —
                                org-wide catalog, no branch_id (same precedent as service)
package_service           [P4]  id, package_id FK, service_id FK, sessions_allocated,
                                UNIQUE(package_id,service_id)
patient_package           [P4]  id, organization_id FK, branch_id FK, patient_id FK,
                                package_id FK, invoice_id FK NULL, purchase_price NUMERIC(14,2),
                                purchased_at, expires_at NULL, status(active|expired|exhausted|
                                cancelled), created_by
patient_package_session   [P4]  id, organization_id FK, patient_package_id FK,
                                package_service_id FK, encounter_id FK NULL, notes NULL,
                                consumed_by, consumed_at — append-only usage log; remaining
                                sessions are always COUNT()-derived against this table, never a
                                stored counter (spec.md §32: "every session consumption
                                requires history")
tax_rule                  [P4]  id, organization_id FK, name, rate NUMERIC(14,4),
                                service_id FK NULL (null = org-wide default), is_default(bool),
                                is_active(bool), created_at
```

Uniqueness note: `tax_rule` has no DB-level constraint enforcing "one default, one rule per service" — `service_id` is nullable and Postgres treats NULL as distinct in a unique index (the same class of gap already hit once with `number_sequence` in Phase 1). Enforced at the service layer instead, an intentional tradeoff for this low-volume, admin-only config table rather than repeating the `COALESCE(..., sentinel)` index workaround.

Deliberately **not** built this phase: `payor_id`/`policy_id` on `invoice` and the estimated/final patient-vs-payor responsibility split described in ARCHITECTURE.md §5 — the full `Payor`/`InsurancePlan`/`Policy` domain doesn't exist until Phase 11, and self-pay patients work correctly with zero payor configuration today (spec.md §38). Also not built: any `journal`/`chart_of_account` posting — `InvoiceIssued`/`PaymentReceived`/`RefundCompleted` are registered no-op event handlers, real posting is Phase 6.

## Phase 5 — Inventory & Procurement Schema

```
product                   [P5]  id, organization_id FK, sku UNIQUE(org_id,sku), barcode NULL,
                                 name, category, brand NULL, unit, purchase_cost,
                                 selling_price NULL NUMERIC(14,2) each, reorder_level,
                                 minimum_stock, maximum_stock NULL INTEGER each, is_active(bool),
                                 created_at, updated_at — org-wide catalog, no branch_id (same
                                 precedent as service/package); stock itself is per-branch
product_batch              [P5]  id, organization_id FK, product_id FK, batch_number
                                 UNIQUE(product_id,batch_number), manufacturing_date NULL,
                                 expiry_date NULL DATE each, supplier_id FK NULL, purchase_cost
                                 NUMERIC(14,2), received_quantity INTEGER (historical fact, not
                                 a running balance), created_at
stock_ledger_entry         [P5]  id, organization_id FK, branch_id FK, product_id FK, batch_id
                                 FK NULL, transaction_type(purchase|sale|dispensing|
                                 treatment_consumption|adjustment|transfer_in|transfer_out|
                                 damage|expiry|return), quantity NUMERIC(14,3) (signed: + in,
                                 - out — on-hand balance is always SUM(quantity), never stored),
                                 reference_type NULL, reference_id NULL (loose polymorphic
                                 pointer, same convention as notification/charge), reason NULL,
                                 performed_by, created_at
stock_transfer              [P5]  id, organization_id FK, from_branch_id FK, to_branch_id FK,
                                 product_id FK, batch_id FK NULL, quantity NUMERIC(14,3),
                                 status(pending|in_transit|completed|cancelled), notes NULL,
                                 requested_by, requested_at, completed_at NULL
supplier                   [P5]  id, organization_id FK, code UNIQUE(org_id,code), company_name,
                                 contact_name NULL, phone NULL, email NULL, address NULL,
                                 tax_number NULL, payment_terms NULL, bank_details NULL,
                                 status(active|inactive), created_at, updated_at
purchase_request            [P5]  id, organization_id FK, branch_id FK, request_number
                                 UNIQUE(org_id,number), status(draft|submitted|approved|
                                 rejected|converted), notes NULL, requested_by, created_at,
                                 approved_by NULL, approved_at NULL, rejection_reason NULL
purchase_request_line       [P5]  id, purchase_request_id FK, product_id FK, quantity, notes NULL
purchase_order              [P5]  id, organization_id FK, branch_id FK, po_number
                                 UNIQUE(org_id,number), supplier_id FK, purchase_request_id FK
                                 NULL, status(draft|issued|partially_received|received|
                                 cancelled), expected_delivery_date NULL DATE, notes NULL,
                                 created_by, created_at, issued_at NULL
purchase_order_line         [P5]  id, purchase_order_id FK, product_id FK, quantity,
                                 unit_cost NUMERIC(14,2) — received_quantity NOT stored, always
                                 derived by summing this line's goods_receipt_line rows (so
                                 "support partial receiving" can never drift from the truth)
goods_receipt                [P5]  id, organization_id FK, branch_id FK, receipt_number
                                 UNIQUE(org_id,number), purchase_order_id FK, supplier_id FK,
                                 status(draft|completed), notes NULL, received_by, received_at
goods_receipt_line           [P5]  id, goods_receipt_id FK, purchase_order_line_id FK,
                                 product_id FK, batch_number (creates a new product_batch —
                                 never references an existing one), manufacturing_date NULL,
                                 expiry_date NULL DATE each, quantity_received INTEGER,
                                 unit_cost NUMERIC(14,2)
supplier_invoice             [P5]  id, organization_id FK, branch_id FK, supplier_id FK,
                                 purchase_order_id FK NULL, invoice_number
                                 UNIQUE(org_id,supplier_id,number), amount, paid_amount
                                 (default 0) NUMERIC(14,2) each, status(pending|partially_paid|
                                 paid|cancelled), due_date NULL DATE, created_by, created_at
supplier_payment              [P5]  id, organization_id FK, branch_id FK, supplier_invoice_id FK,
                                 method(cash|card|bank|online|insurance|credit|other), amount
                                 NUMERIC(14,2), reference NULL, paid_by, paid_at — a direct 1:N
                                 against supplier_invoice, deliberately simpler than the
                                 revenue-side payment/payment_allocation many-to-many, since
                                 spec.md §46 describes one invoice paid at a time
service_product_consumption  [P5]  id, service_id FK, product_id FK,
                                 UNIQUE(service_id,product_id), quantity_per_unit NUMERIC(14,3)
                                 — "Wound Dressing consumes: Gauze x2..." (spec.md §44)
```

`tax_rule` gained `product_id` (nullable FK to `product`, alongside Phase 4's `service_id`) — the Product Master already named "Tax" as a field (spec.md §41) and the tax-rule table was designed in Phase 4 to eventually cover both.

Deliberately **not** built this phase: any AP ledger/journal posting from `supplier_invoice`/`supplier_payment` — that's Phase 6's central accounting engine, the same deferred-accounting pattern already used for the revenue side (`invoice`/`payment`) since Phase 4.

## Phase 6 — Finance Schema

```
chart_of_account          [P6]  id, organization_id FK, code, name, type(asset|liability|
                                 equity|revenue|expense), parent_account_id FK NULL
                                 (self-relation, hierarchy), is_active(bool), created_at,
                                 UNIQUE(organization_id, code)
account_mapping            [P6]  id, organization_id FK, branch_id FK NULL (null = org-wide
                                 default), intent (fixed 14-value PostingIntent taxonomy —
                                 cash|card|bank|online|insurance|credit|other|
                                 accounts_receivable|revenue|tax_payable|unearned_revenue|
                                 inventory_asset|accounts_payable|expense_default),
                                 account_id FK, created_at — branch-specific mapping wins,
                                 falls back to the org-wide row for the same intent
journal                    [P6]  id, organization_id FK, branch_id FK, journal_number
                                 UNIQUE(org_id,number), journal_date TIMESTAMPTZ,
                                 reference_type, reference_id NULL (loose polymorphic pointer,
                                 same convention as charge/notification/stock_ledger_entry),
                                 description, posted_by NULL, created_at
journal_line                [P6]  id, journal_id FK, account_id FK, debit NUMERIC(14,2)
                                 default 0, credit NUMERIC(14,2) default 0, description NULL —
                                 a line is a debit XOR a credit (never both/neither), enforced
                                 by a CHECK constraint (see below)
expense                     [P6]  id, organization_id FK, branch_id FK, expense_account_id FK,
                                 description, amount NUMERIC(14,2), paid_via(cash|card|bank|
                                 online|insurance|credit|other), expense_date DATE, paid_by
                                 NULL, created_at — posts synchronously in the same transaction
                                 as the row (see ARCHITECTURE.md §6), unlike every other Phase
                                 6 trigger
```

Balance enforcement, hand-appended to the generated migration (Prisma's schema language can't express either): a `CHECK` constraint on `journal_line` — `(debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)` — plus a `DEFERRABLE CONSTRAINT TRIGGER ... INITIALLY DEFERRED` (`journal_line_balance_check`, function `check_journal_balance()`) that sums every line on the affected journal after each `INSERT`/`UPDATE`/`DELETE` and raises unless `Σdebit = Σcredit`. Deferred (checked at end-of-transaction, not per-statement) so `postJournal()`'s create-journal-then-create-N-lines sequence never trips the trigger mid-construction — verified via `pg_trigger` that `tgdeferrable`/`tginitdeferred` are both true, and via a standalone test script that a genuinely unbalanced journal is rejected at commit with a readable error. This is the same hand-written-SQL-appended-to-a-generated-migration precedent as Phase 2's double-booking `EXCLUDE USING gist` constraint.

No separate `unearned_revenue_ledger` table was built (see PROJECT_STATUS.md's Phase 6 Architecture Decisions for why the forward-schema note below turned out to be unnecessary) — package deferred revenue is an ordinary `chart_of_account` row (liability type, seeded code 2200) posted to via ordinary `journal`/`journal_line` rows, same as every other account.

`number_sequence` gained a `"JRN"` sequence type this phase, same concurrency-safe atomic-`UPDATE`-`RETURNING` mechanism as every other sequence.

## Phase 7 — HR, Payroll & Assets Schema

```
employee                   [P7]  id, organization_id FK, branch_id FK, department_id FK NULL,
                                  user_id FK NULL UNIQUE, employee_number UNIQUE(org_id,number),
                                  first/last_name, designation, manager_id FK NULL
                                  (self-relation), joining_date DATE, employment_type(full_time|
                                  part_time|contract|intern), basic_salary NUMERIC(14,2),
                                  bank_details NULL, status(active|on_leave|terminated),
                                  created_at, updated_at
employee_document           [P7]  id, organization_id FK, employee_id FK, document_type(id_
                                  document|passport|visa|contract|professional_license|
                                  certification), document_number NULL, issue_date NULL,
                                  expiry_date NULL DATE each, notes NULL, created_at — metadata
                                  only, no file storage (same deliberate scope call as Phase 2's
                                  deferred patient_document)
shift                       [P7]  id, organization_id FK, name UNIQUE(org_id,name), start_time,
                                  end_time ("HH:MM", branch-local, same convention as
                                  provider_schedule), is_active(bool), created_at
attendance_record           [P7]  id, organization_id FK, branch_id FK, employee_id FK, shift_id
                                  FK NULL, date DATE, check_in_at NULL, check_out_at NULL
                                  TIMESTAMPTZ each, break_minutes, working_minutes NULL, late_
                                  minutes, early_departure_minutes, overtime_minutes INTEGER each
                                  (all but break_minutes server-computed at check-out, never
                                  client-submitted), status(present|absent|half_day|on_leave|
                                  holiday), notes NULL, recorded_by, created_at, updated_at —
                                  UNIQUE(employee_id, date), one row per employee per day
leave_request                [P7]  id, organization_id FK, employee_id FK, leave_type(annual|
                                  sick|unpaid|emergency|other), start_date, end_date DATE each,
                                  days INTEGER, reason NULL, status(requested|approved|rejected|
                                  cancelled), requested_at, decided_by NULL, decided_at NULL,
                                  rejection_reason NULL
leave_balance                 [P7]  id, organization_id FK, employee_id FK, leave_type, year
                                  INTEGER, allocated_days INTEGER, created_at —
                                  UNIQUE(employee_id, leave_type, year); used/remaining always
                                  derived live from approved leave_request.days, never stored
payroll_run                   [P7]  id, organization_id FK, branch_id FK, period_start, period_end
                                  DATE each, status(draft|review|approved|paid), paid_via
                                  PaymentMethod NULL, created_by, approved_by NULL, approved_at
                                  NULL, paid_at NULL, created_at
payroll_run_line              [P7]  id, payroll_run_id FK, employee_id FK, basic_salary,
                                  allowances, overtime, commission, bonus, advances, unpaid_
                                  leave_deduction, other_deductions, net_salary NUMERIC(14,2)
                                  each — UNIQUE(payroll_run_id, employee_id); net_salary is the
                                  fixed historical figure once the run is finalized (same
                                  precedent as invoice.total_amount); also the payslip's data
                                  source, no separate payslip table
commission_rule                [P7]  id, organization_id FK, provider_id FK NULL, service_id FK
                                  NULL, product_id FK NULL (null = applies more broadly — most-
                                  specific-wins resolution), type(fixed|percentage|tiered),
                                  basis(gross_invoice|net_invoice|collected_revenue), fixed_
                                  amount NULL, percentage_rate NULL NUMERIC each, tiers JSONB
                                  NULL (array of {minAmount,maxAmount,rate} brackets), is_active
                                  (bool), created_at
commission_accrual             [P7]  id, organization_id FK, branch_id FK, provider_id FK,
                                  charge_id FK, invoice_id FK, payment_id FK NULL (set only for
                                  collected_revenue-basis rows — the accrual trigger's basis
                                  determines whether this is populated), commission_rule_id FK,
                                  basis_amount, amount NUMERIC(14,2) each, status(pending|
                                  included_in_payroll|paid), payroll_run_line_id FK NULL,
                                  accrued_at — UNIQUE(charge_id, payment_id), safe against outbox
                                  at-least-once redelivery for the payment-keyed rows; invoice-
                                  basis rows (payment_id NULL) guarded by a service-layer
                                  check-before-insert instead, same NULL-uniqueness tradeoff as
                                  tax_rule/account_mapping
asset                           [P7]  id, organization_id FK, branch_id FK, department_id FK NULL,
                                  room_id FK NULL, asset_number UNIQUE(org_id,number), barcode
                                  NULL, name, category, manufacturer NULL, model NULL, serial_
                                  number NULL, assigned_employee_id FK NULL, supplier_id FK NULL,
                                  purchase_date NULL DATE, cost NULL NUMERIC(14,2), warranty_
                                  expiry_date NULL DATE, status(available|in_use|maintenance|
                                  damaged|lost|retired|disposed), created_at, updated_at
maintenance_record              [P7]  id, organization_id FK, asset_id FK, maintenance_type
                                  (preventive|corrective), service_provider NULL, cost NULL
                                  NUMERIC(14,2), work_performed, service_date DATE, next_service_
                                  date NULL DATE, performed_by NULL, created_at
calibration_record               [P7]  id, organization_id FK, asset_id FK, calibration_date DATE,
                                  certificate_number NULL, result(pass|fail|conditional),
                                  provider NULL, next_calibration_date NULL DATE, created_at
```

`provider.employee_id` promoted from a bare unlinked column (added in Phase 2, never wired to anything) to a real `UNIQUE` FK referencing `employee.id` — the 1:1 link a Provider's HR record hangs off.

`payroll_run.branch_id` was briefly modeled nullable (for a hypothetical org-wide run) in the first version of this phase's migration, then corrected to `NOT NULL` in a same-session follow-up migration (`payroll_run_branch_required`) before any real data existed — every other financial-posting-producing table in this schema requires a branch, and `postPayrollApproved`/`postPayrollPaid` need one to post the journal against.

No hand-written SQL this phase — Payroll's postings reuse Phase 6's existing journal balance trigger; no new cross-row constraint was needed.

Deliberately **not** built this phase: any file-attachment storage for `employee_document`/asset records (metadata/expiry-tracking only, same reasoning as Phase 2's deferred `patient_document`); any accounting posting triggered by `asset` purchase (spec.md §47 doesn't name one — an asset bought via Expense or the procurement chain already posts through those paths); a separate `payslip` table (printed from `payroll_run_line` + `employee` instead, matching how `invoice`/`payment` are already their own printable documents).

## Phase 8 — Laboratory Information System (LIS) Schema

```
lab_test                    [P8]  id, organization_id FK, code UNIQUE(org_id,code), name,
                                   category, specimen_type, result_type(numeric|text), unit NULL,
                                   reference_range_low NULL, reference_range_high NULL
                                   NUMERIC(10,3) each, reference_range_text NULL, price
                                   NUMERIC(14,2), turnaround_hours NULL INTEGER, is_active(bool),
                                   created_at, updated_at — org-wide catalog, no branch_id (same
                                   precedent as service/product/package)
lab_panel                    [P8]  id, organization_id FK, code UNIQUE(org_id,code), name, price
                                   NUMERIC(14,2), is_active(bool), created_at — a bundle priced as
                                   one billable line; expands into one lab_order_test per member
                                   at assignment time, not one combined result
lab_panel_test                [P8]  id, lab_panel_id FK, lab_test_id FK,
                                   UNIQUE(lab_panel_id,lab_test_id)
specimen                       [P8]  id, organization_id FK, branch_id FK, clinical_order_id FK,
                                   specimen_number UNIQUE(org_id,number), specimen_type,
                                   status(pending|collected|received|rejected), collected_by NULL,
                                   collected_at NULL TIMESTAMPTZ, rejection_reason NULL,
                                   created_at — one specimen commonly services several
                                   lab_order_test rows (one draw, several tests)
lab_order_test                  [P8]  id, organization_id FK, clinical_order_id FK, lab_test_id FK,
                                   lab_panel_id FK NULL (grouping only, for display — the panel's
                                   Charge attaches to only the first member row, since
                                   charge_id is UNIQUE), specimen_id FK NULL, charge_id FK NULL
                                   UNIQUE, status(ordered|collected|processing|resulted|verified|
                                   cancelled), result_type(numeric|text) (snapshot from lab_test
                                   at assignment time), numeric_value NULL NUMERIC(10,3),
                                   text_value NULL, unit NULL, reference_range_low/high NULL
                                   NUMERIC(10,3) each, reference_range_text NULL (all three
                                   snapshotted from lab_test at RESULT-ENTRY time, not assignment
                                   time — the actual clinical-interpretation moment), abnormal_
                                   flag(normal|low|high|critical_low|critical_high) NULL (server-
                                   computed at entry, never client-submitted; critical_low/high
                                   defined but never auto-emitted — see PROJECT_STATUS.md's Phase
                                   8 Known Issues), entered_by NULL, entered_at NULL, verified_by
                                   NULL, verified_at NULL TIMESTAMPTZ each, notes NULL, created_at
```

The doctor's Phase 3 `clinical_order`/`lab_order_detail` (free-text `test_name`) is left completely unchanged this phase — `lab_order_test` is a deliberately separate structured layer, created only once lab staff "assign" catalog tests/panels against an order, which is also the moment each line's `charge_id` gets set via the same `generateSystemCharge()` every other automatic charge already goes through (`charge.source_type = 'lab'`, defined in Phase 4, unused until now).

No hand-written SQL this phase — no new cross-row constraint was needed; `lab_order_test.charge_id UNIQUE` is a standard column-level constraint.

Deliberately **not** built this phase: a second, separate critical-value reference band on `lab_test` (only one normal-range band exists, so `abnormal_flag` never auto-computes `critical_low`/`critical_high` today — see PROJECT_STATUS.md's Phase 8 Known Issues); any file attachment on lab results (same metadata-only precedent as `employee_document`/asset records).

## Phase 9 — Pharmacy Information System (PIS) Schema

```
medication                     [P9]  id, organization_id FK, product_id FK UNIQUE, generic_name
                                   NULL, strength NULL, dosage_form, route NULL, controlled_
                                   substance(bool), requires_prescription(bool), created_at,
                                   updated_at — a 1:1 companion to product (stock/batch/cost/
                                   price all inherited wholesale), not a parallel item master
dispensing_record               [P9]  id, organization_id FK, branch_id FK, dispensing_number
                                   UNIQUE(org_id,number) (DISP sequence), prescription_id FK,
                                   prescription_item_id FK, medication_id FK, patient_id FK,
                                   quantity_dispensed INTEGER, status(pending|verified|dispensed|
                                   cancelled), charge_id FK NULL UNIQUE, verified_by NULL,
                                   verified_at NULL TIMESTAMPTZ, dispensed_by NULL, dispensed_at
                                   NULL TIMESTAMPTZ, notes NULL, created_at — one
                                   prescription_item can carry several dispensing_record rows
                                   over time (partial fills across visits); remaining-to-dispense
                                   always derived live, never a stored counter
dispensing_return               [P9]  id, organization_id FK, dispensing_record_id FK (ON DELETE
                                   CASCADE), quantity_returned INTEGER, reason, returned_by NULL,
                                   returned_at — a correcting record, never an edit to the
                                   dispensing_record it references
```

The doctor's Phase 3 `prescription`/`prescription_item` (free-text `medication_name`) is left completely unchanged this phase — `dispensing_record` is a deliberately separate structured layer, created only once pharmacy staff dispense against a catalog `medication`, the identical two-stage model `lab_order_test` established for lab orders in Phase 8. `dispensing_record.charge_id UNIQUE` mirrors `lab_order_test.charge_id UNIQUE` — a standard column-level constraint, not hand-written SQL.

`SequenceType` gained `"DISP"`. No hand-written SQL this phase — no new cross-row constraint was needed.

Deliberately **not** built this phase: a general settings-admin UI for arbitrary `setting` keys (only the one `pharmacy_enabled` boolean is exercised, via `getSetting`/`setSetting` in `src/lib/platform/settings.ts`); any file attachment on medications (same metadata-only precedent as `employee_document`/lab records).

## Phase 10 — Radiology Information System (RIS) Schema

```
imaging_service                [P10]  id, organization_id FK, code UNIQUE(org_id,code), name,
                                    category (modality: X-Ray/CT/MRI/Ultrasound/...), body_part
                                    NULL, price NUMERIC(14,2), turnaround_hours NULL INTEGER,
                                    is_active(bool), created_at, updated_at — org-wide catalog,
                                    no branch_id (same precedent as lab_test/service/product)
imaging_order                   [P10]  id, organization_id FK, clinical_order_id FK UNIQUE (a
                                    real 1:1, not one-to-many — see below), imaging_service_id
                                    FK, accession_number UNIQUE(org_id,number) (RAD sequence,
                                    the PACS-integration-ready identifier), status(ordered|
                                    scheduled|performed|reported|verified|cancelled), charge_id
                                    FK NULL UNIQUE, room_id FK NULL, scheduled_at NULL
                                    TIMESTAMPTZ, performed_by NULL, performed_at NULL
                                    TIMESTAMPTZ, report_text NULL, impression NULL, reported_by
                                    NULL, reported_at NULL TIMESTAMPTZ, verified_by NULL,
                                    verified_at NULL TIMESTAMPTZ, external_image_url NULL (PACS
                                    integration surface, unused today), notes NULL, created_at
```

The doctor's Phase 3 `clinical_order`/`imaging_order_detail` (free-text `imaging_type`/`body_part`) is left completely unchanged this phase — `imaging_order` is a deliberately separate structured layer, created only once radiology staff "assign" a catalog imaging service against an order, which is also the moment `charge_id` gets set via the same `generateSystemCharge()` every other automatic charge already goes through (`charge.source_type = 'imaging'`, defined in Phase 4, unused until now).

**A genuine deviation from `lab_order_test`'s shape, not an oversight**: `imaging_order.clinical_order_id` is `UNIQUE` — a real 1:1 with its `clinical_order`, not a one-to-many. One imaging CPOE order names exactly one study ("Chest X-Ray"), never a bundle the way a free-text lab order can name several analytes ("CBC, lytes"), so there's no panel-style fan-out to model. No separate `imaging_report` table either — report fields live directly on `imaging_order`, the same "no separate lab_result table" precedent Phase 8 set for `lab_order_test`.

`SequenceType` gained `"RAD"` (prefix `ACC`, for accession numbers). No hand-written SQL this phase — no new cross-row constraint was needed; `imaging_order.clinical_order_id UNIQUE` and `charge_id UNIQUE` are standard column-level constraints.

Deliberately **not** built this phase: any real PACS/DICOM integration or image file storage — `accession_number`/`external_image_url` are the prepared integration surface spec.md §30 explicitly asks for ("do not attempt to build a PACS from scratch"), left unpopulated; a hard double-booking constraint on `imaging_order.room_id`/`scheduled_at` (informational scheduling only — see PROJECT_STATUS.md's Phase 10 Known Issues).

## Phase 11 — Payors & Insurance Schema

```
payor                            [P11]  id, organization_id FK, code UNIQUE(org_id,code), name,
                                     payor_type(self_pay|insurance_company|corporate|government|
                                     other), contact_name/phone/email NULL, address NULL,
                                     is_active(bool), created_at, updated_at — org-wide catalog
insurance_plan                   [P11]  id, organization_id FK, payor_id FK, code
                                     UNIQUE(org_id,code), name, is_active(bool), created_at,
                                     updated_at — the product a payor sells
policy                           [P11]  id, organization_id FK, insurance_plan_id FK,
                                     policy_number UNIQUE(org_id,number), group_number NULL,
                                     is_active(bool), created_at — a specific enrolled contract;
                                     one policy can cover several people (subscriber + dependents)
patient_coverage                 [P11]  id, organization_id FK, patient_id FK, policy_id FK,
                                     member_id, relationship_to_subscriber (default 'self'),
                                     start_date TIMESTAMPTZ, end_date NULL TIMESTAMPTZ,
                                     copay_amount NULL NUMERIC(14,2), copay_percent NULL
                                     NUMERIC(5,2), deductible_amount NULL NUMERIC(14,2) (stored
                                     for reference, not applied to the estimate — see Phase 11
                                     Known Issues), annual_limit_amount NULL NUMERIC(14,2),
                                     is_primary(bool, default true), status(active|inactive|
                                     expired), notes NULL, created_at, updated_at — the
                                     per-patient enrollment actually billed against
prior_authorization               [P11]  id, organization_id FK, patient_id FK,
                                     patient_coverage_id FK, encounter_id NULL FK, auth_number
                                     NULL (the payor's own reference), status(requested|approved|
                                     denied|expired), requested_at, decided_at NULL, valid_from/
                                     until NULL TIMESTAMPTZ each, notes NULL, requested_by NULL,
                                     created_at — staff-recorded, not a live payor API result
claim                             [P11]  id, organization_id FK, branch_id FK, claim_number
                                     UNIQUE(org_id,number) (CLM sequence, reserved since Phase 1),
                                     patient_id FK, patient_coverage_id FK, payor_id FK,
                                     encounter_id NULL FK, invoice_id FK, status(draft|submitted|
                                     adjudicated|rejected|remitted|void), submitted_amount
                                     NUMERIC(14,2), approved_amount NULL, rejected_amount NULL,
                                     patient_responsibility_amount NULL NUMERIC(14,2) each,
                                     rejection_reason NULL, external_reference NULL (from the
                                     submission adapter), submitted_at/adjudicated_at/
                                     remitted_at NULL TIMESTAMPTZ each, resubmission_of_id NULL
                                     UNIQUE (self-relation — a NEW row per resubmission, never an
                                     edit to the rejected original), created_by NULL, created_at
claim_item                        [P11]  id, claim_id FK (ON DELETE CASCADE), invoice_line_id FK,
                                     diagnosis_id NULL FK (references the encounter's real
                                     Diagnosis row, Phase 3 — not a bare diagnosis_code catalog
                                     entry), procedure_code NULL (free text — no normalized CPT/
                                     HCPCS master, per spec.md §39's "do not hardcode one
                                     country's insurance format"), submitted_amount NUMERIC(14,2),
                                     approved_amount NULL, rejected_amount NULL NUMERIC(14,2)
                                     each, denial_reason NULL
```

`invoice` gained six nullable columns this phase: `payor_id` FK NULL, `patient_coverage_id` FK NULL, `estimated_patient_responsibility`/`estimated_payor_responsibility`/`final_patient_responsibility`/`final_payor_responsibility` NULL NUMERIC(14,2) each — `estimated*` computed at issue time from the coverage's copay, `final*` set once, separately, at remittance time. `payment` gained one nullable column: `claim_id` FK NULL, for traceability from a remittance-recorded `Payment` back to the claim it settles.

The doctor/billing-intent-vs-structured-execution split every clinical support system has used since Phase 8 applies here too, at the revenue-cycle level: `invoice`/`invoice_line` (Phase 4, unchanged) capture what was billed; `claim`/`claim_item` (this phase) capture what's being submitted to a specific payor, against which lines and diagnoses. `claim_number` uses the `"CLM"` sequence reserved since Phase 1 but never used until now — the same "dormant Phase 1 reservation wired for real several phases later" precedent as Phase 8's `"LAB"`.

No hand-written SQL this phase — no new cross-row constraint was needed; `claim.resubmission_of_id UNIQUE` is a standard column-level constraint (a self-relation, the same shape as `appointment.rescheduled_from_id`).

**Data correction, not schema**: the `insurance` `account_mapping` row seeded in Phase 6 pointed at the same account (1100, Accounts Receivable) as the `accounts_receivable` intent — a self-canceling `Dr 1100 / Cr 1100` entry the first time an insurance-tender payment was ever actually posted (nothing had been, until this phase). Corrected directly on the existing row (the seed only creates a mapping when none exists, so it doesn't self-heal), and the seed default itself now maps `insurance` → `1010` (Bank) for a fresh database. See PROJECT_STATUS.md's Phase 11 Known Issues.

Deliberately **not** built this phase: any real payor/clearinghouse submission integration (`ClaimSubmissionAdapter` has exactly one implementation, `ManualSubmissionAdapter` — see ARCHITECTURE.md §12); a normalized CPT/HCPCS procedure-code master (`claim_item.procedure_code` is free text); deductible-accumulation tracking (`patient_coverage.deductible_amount` is stored but not applied to the estimated-responsibility calculation); many-to-many payment-to-claim reconciliation (`payment.claim_id` is a single nullable FK, not a join table — one payment settles at most one claim in this build).

## Phase 12 — Patient Engagement Schema

```
comm_template                    [P12]  id, organization_id FK, key UNIQUE(org_id,key), channel
                                     (sms|whatsapp|email), name, subject NULL, body ({{variable}}
                                     placeholders), is_active(bool), created_at, updated_at —
                                     org-wide catalog, seeded with the 8 spec.md §56-named
                                     templates
comm_message                     [P12]  id, organization_id FK, patient_id FK, channel,
                                     template_id NULL FK, subject NULL, body (fully-rendered
                                     snapshot, not a live template reference), recipient_address,
                                     status(queued|sent|failed), provider_reference NULL, error
                                     NULL, reference_type/reference_id NULL each (loose
                                     polymorphic pointer, same convention as notification), sent_by
                                     NULL, created_at — one row per send ATTEMPT, success or not
patient_portal_account           [P12]  id, organization_id FK, patient_id FK UNIQUE, email
                                     UNIQUE(org_id,email), password_hash, status(active|inactive|
                                     locked), failed_login_count, locked_until NULL TIMESTAMPTZ,
                                     last_login_at NULL TIMESTAMPTZ, created_at, updated_at —
                                     mirrors `user`'s lockout fields exactly, a genuinely separate
                                     table (see ARCHITECTURE.md §13)
patient_portal_session            [P12]  id, portal_account_id FK (ON DELETE CASCADE), token_hash
                                     UNIQUE, ip NULL, user_agent NULL, expires_at TIMESTAMPTZ,
                                     revoked_at NULL TIMESTAMPTZ, created_at — mirrors `session`
                                     exactly, a genuinely separate table, not a shared one with a
                                     discriminator column
```

No new columns on any existing table this phase — Online Booking (spec.md §58) reuses `appointment`/`patient` unchanged, tagging bookings with the existing `booking_source = 'online'` enum value (defined since Phase 2, unused until now) rather than adding new columns.

No hand-written SQL this phase — no new cross-row constraint was needed.

**Naming correction from an earlier speculative note**: this file's Phase 0-era forward-schema note grouped `lead` alongside `comm_template`/`comm_message` under "Phase 12." `lead` is not built this phase — spec.md's actual numbered Phase 12 "Implement" list (Communication engine, SMS/WhatsApp/Email adapters, Patient portal, Online booking) does not name Lead CRM (spec.md §59), and this build follows the literal numbered phase directive over an earlier planning artifact (see PROJECT_STATUS.md's Phase 12 Known Issues). `lead` moves to the unassigned Forward Schema list below.

Deliberately **not** built this phase: a live SMS/WhatsApp/Email provider connection (`CommunicationAdapter` has three `Null*` implementations, all honest about not delivering — spec.md §56/§92); a normalized/typed variable schema per template (`{{variable}}` substitution is a flat string map — see PROJECT_STATUS.md's Phase 12 Architecture Decisions); a portal-specific `login_history` table (portal lockout is real, portal per-attempt audit history is not); IP-based rate limiting or CAPTCHA on `/book` (a simple per-mobile-per-24h count satisfies the SECURITY.md pre-commitment literally, not exhaustively).

## Phase 13 — Analytics Schema

No new tables, no new columns, no new enums — the Status paragraph's Phase 12-era prediction held exactly. Every dashboard tile, report row, and KPI trend point is a live query (Prisma aggregate/groupBy or a small number of `findMany` calls) against a table another phase's schema already created — `appointment`, `invoice`, `payment`, `encounter`, `diagnosis`, `clinical_order`, `claim`, `stock_ledger_entry`, `attendance_record`, `leave_request`, `payroll_run`, `commission_accrual`, `asset`, `maintenance_record`, `calibration_record`, among others. No hand-written SQL — no new cross-row constraint was needed.

Deliberately **not** built this phase: Global Search (spec.md §66) and the master-data bulk Import/Export workflow (spec.md §83) — neither is on spec.md's literal numbered Phase 13 "Implement" list, the same "follow the literal phase directive" reasoning applied to `lead` in Phase 12 (see below). Both move to the unassigned Forward Schema list.

## Phase 14 — Hardening Schema

No new tables, no new columns, no new enums — 34 new indexes only (`phase14_indexing` migration). A real `pg_constraint`/`pg_index` query found 115 single-column foreign keys in the `public` schema (excluding Supabase's own `auth.*`/`storage.*` schemas) with no covering index at any position; reviewed rather than blindly indexed, since most are already effectively covered in practice by an existing composite index leading with `organization_id` (every query in this codebase filters by organization first). Indexed the FK columns of the highest-volume, most-frequently-joined transactional tables:

```
appointment.service_id
charge.branch_id, charge.provider_id, charge.service_id
claim.branch_id, claim.patient_id, claim.payor_id
clinical_order.branch_id, clinical_order.ordering_provider_id
commission_accrual.branch_id, commission_accrual.invoice_id
dispensing_record.branch_id, dispensing_record.patient_id,
  dispensing_record.medication_id, dispensing_record.prescription_id
encounter.branch_id, encounter.episode_id
follow_up_recommendation.encounter_id
imaging_order.imaging_service_id
invoice.branch_id, invoice.provider_id, invoice.payor_id
journal.branch_id
lab_order_test.lab_test_id, lab_order_test.specimen_id
patient_package.branch_id, patient_package.invoice_id
payment.branch_id, payment.claim_id
prescription.encounter_id, prescription.provider_id
refund.branch_id, refund.payment_id
vital_sign.branch_id
```

**Deliberately left unindexed** (~80 remaining FK columns) — see PROJECT_STATUS.md's Phase 14 Known Issues for the full reasoning: mostly `organization_id`-alone gaps on smaller reference/config tables (`calibration_record`, `maintenance_record`, `leave_balance`, `medication`, `notification`, `outbox_event`, `cash_movement`, `dispensing_return`, `patient_package_session`) where no query pattern in this codebase filters on that column alone, plus a few low-cardinality nullable self-relations and small/ephemeral tables. Revisit with real production `EXPLAIN ANALYZE` evidence, not by extending this list speculatively.

**Also reviewed, not changed**: SECURITY.md's Phase-1-era pre-commitment that "Phase 14 hardening removes UPDATE/DELETE grants for the app role" on `audit_log`/`clinical_access_log`. This deployment's `DATABASE_URL` connects as Supabase's project-owner-equivalent role — the same role every migration in this project's history runs DDL as — so there is no separate lower-privileged "app role" to revoke anything from without breaking the application. The correct fix (a genuinely separate runtime role) is documented in DEPLOYMENT.md's "Database Privileges" section, not executed, since it requires rotating live credentials the running application depends on.

## Forward Schema (populated per phase as each phase lands)

- **Unassigned** (not part of any numbered phase's explicit build list): `lead` (spec.md §59 — see Phase 12 section above); a global-search index/table if one turns out to be needed for spec.md §66 (Phase 13 section above); any table a real master-data bulk Import/Export workflow (spec.md §83) turns out to need (an import staging/error-report table is the likely shape, not designed yet).

## Key Cardinalities (locked, spec.md §15 / BLUEPRINT.md §15)

- `episode (1)—(N) encounter`, `encounter (0..1)—(0..1) appointment` (nullable both directions).
- `encounter (1)—(N) clinical_order`, `clinical_order (1)—(1) <type>_detail`.
- `charge (N)—(1) invoice_line`, charge creatable independent of invoicing.
- `invoice (1)—(N) payment_allocation (N)—(1) payment` (many-to-many via allocation).
- `product_batch (1)—(N) stock_ledger_entry`, balance = `SUM(quantity)` (signed: + in, - out — implemented this way rather than separate qty_in/qty_out columns, same information, simpler aggregation).
- `journal (1)—(N) journal_line`, `SUM(debit)=SUM(credit)` per journal (Phase 6 `CHECK` + deferred trigger — implemented and verified this phase).
- `provider (0..1)—(0..1) employee` (nullable both directions, `provider.employee_id UNIQUE` — a provider may have no HR record, an employee may not be a clinical provider).
- `commission_accrual (N)—(1) charge`, `commission_accrual (N)—(0..1) payment` — one accrual per (charge, invoice-issue-event) for gross/net-invoice basis, one per (charge, specific payment) for collected-revenue basis; never both bases accruing for the same charge simultaneously (one resolved `commission_rule` per charge).
- `clinical_order (1)—(N) lab_order_test`, `specimen (1)—(N) lab_order_test` — a lab order's structured lines and the specimen(s) they were drawn against are each their own one-to-many, independent of the 1:1 `clinical_order`—`lab_order_detail` relationship carried over from Phase 3.
- `lab_panel (1)—(N) lab_order_test` (grouping only), but `lab_order_test.charge_id UNIQUE` — a panel's Charge attaches to exactly one of its member rows, never one Charge per member.
- `product (1)—(1) medication` (`medication.product_id UNIQUE`), `prescription_item (1)—(N) dispensing_record`, `dispensing_record (1)—(N) dispensing_return` — the same "one structured-execution row can fan out into several correcting/history rows over time" shape already established for `clinical_order`/`lab_order_test` and `invoice`/`payment`.
- `clinical_order (1)—(0..1) imaging_order` (`imaging_order.clinical_order_id UNIQUE`) — a genuine one-to-one, distinct from `clinical_order (1)—(N) lab_order_test`'s one-to-many, because one imaging CPOE order never bundles several studies the way a free-text lab order can bundle several analytes.
- `payor (1)—(N) insurance_plan (1)—(N) policy (1)—(N) patient_coverage` — the four-level payor hierarchy spec.md §38 names, each level a genuine one-to-many (one payor sells several plans, one plan is enrolled into by several policies, one policy can cover several people via `patient_coverage`).
- `invoice (1)—(N) claim`, `claim (1)—(N) claim_item (N)—(1) invoice_line` — one invoice can be claimed multiple times over its resubmission history; `claim.resubmission_of_id UNIQUE` makes the resubmission chain itself a one-to-one at each link, the same shape as `appointment.rescheduled_from_id`.
- `patient (1)—(0..1) patient_portal_account (1)—(N) patient_portal_session` — a patient has at most one portal account (`patient_portal_account.patient_id UNIQUE`), which can have many session tokens over time, the same one-account-many-sessions shape as `user`—`session`.
- `patient (1)—(N) comm_message (N)—(0..1) comm_template` — every message references the patient it was sent to and, when template-based, the template it was rendered from; `comm_message` itself never has a foreign key back to the domain object it's about (appointment, invoice, ...) beyond the loose `reference_type`/`reference_id` pointer, the same polymorphic convention `notification` already uses.

## Status

Phase 1 through Phase 14 (the full spec.md build plan) schemas implemented and migrated — 20 migrations total: Phase 1's `phase1_platform_foundation` plus two `number_sequence_null_branch_uniqueness` housekeeping migrations, Phase 2's `phase2_patient_provider_service_appointment`, `timestamptz_and_booking_exclusion`, `provider_user_link`, `appointment_reschedule_link`, Phase 3's `phase3_core_emr`, `clinical_org_scoping`, Phase 4's `phase4_revenue`, Phase 5's `phase5_inventory_procurement`, Phase 6's `phase6_finance`, Phase 7's `phase7_hr_assets` plus the same-session `payroll_run_branch_required` follow-up, Phase 8's `phase8_lis`, Phase 9's `phase9_pharmacy`, Phase 10's `phase10_ris`, Phase 11's `phase11_payors_insurance`, Phase 12's `phase12_patient_engagement`, and Phase 14's `phase14_indexing` (Phase 13 added none, exactly as predicted) — see PROJECT_STATUS.md for verification detail. Phase 14 confirmed this file's own prediction from last phase almost exactly: schema-adjacent (indexing) rather than new domain tables, plus a DB-privilege-tightening review that found a real reason not to execute the change autonomously (see the Phase 14 section above). This is the last phase in spec.md's roadmap — no further phase-driven schema growth is expected, though real deployment needs (a genuinely separate runtime DB role, Global Search, master-data Import/Export, Lead CRM — all tracked in PROJECT_STATUS.md's Next Actions) may still add tables or indexes in the future.
