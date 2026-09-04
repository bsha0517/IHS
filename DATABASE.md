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
                            status(pending|processing|completed|failed|dead_letter), attempts,
                            last_attempt_at NULL, next_retry_at NULL, last_error NULL,
                            created_at, completed_at NULL
                            — reshaped in the P0 remediation pass (P0-02, 2026-08-27); see
                            "P0 Remediation Schema Changes" below. Original Phase 1 shape
                            (status pending|processed|failed, processed_at) shown here for
                            history is superseded.
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
                                encounter_id FK NULL, service_id FK NULL, product_id FK NULL
                                (added P1 §9 — set only for a real retail product sale;
                                presence, not source_type, triggers real inventory
                                consumption in insertCharge — see "P1 Batch 3 Schema
                                Changes" below), provider_id FK NULL,
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

**Also reviewed, not changed in Phase 14 itself**: SECURITY.md's Phase-1-era pre-commitment that "Phase 14 hardening removes UPDATE/DELETE grants for the app role" on `audit_log`/`clinical_access_log`. This deployment's `DATABASE_URL` connects as Supabase's project-owner-equivalent role — the same role every migration in this project's history runs DDL as — so there was no separate lower-privileged "app role" to revoke anything from without breaking the application. Phase 14 documented the correct fix without executing it, since it requires rotating live credentials. **This was subsequently executed in the P0 remediation pass** — see below.

## P0 Remediation Schema Changes (2026-08-27, following the Phase 14 audit — not a numbered spec.md phase)

Three migrations, all applied and verified against the real database (`prisma migrate status` shows zero drift):

**`20260826192144_p0_02_outbox_reliability`** + **`20260826192200_p0_02_outbox_reliability_data`** (P0-02, split into two files — a newly-added Postgres enum value can't be used in the same transaction that adds it): `outbox_event.status` widened from `pending|processed|failed` to `pending|processing|completed|failed|dead_letter`; `processed_at` renamed to `completed_at`; new columns `attempts` (int, default 0), `last_attempt_at`, `next_retry_at`, `last_error`; new index `(status, next_retry_at)` for the retry sweep alongside the existing `(status, created_at)`. The 30 pre-existing rows (all `processed`) were remapped to `completed` as part of the data migration — verified zero rows lost.

**`20260826200219_p0_05_cascade_delete_protection`**: 24 foreign key constraints changed from `ON DELETE CASCADE` to `ON DELETE RESTRICT` (full list in P0_REMEDIATION_REPORT.md's P0-05 section) — `patient_allergy`/`patient_condition`/`patient_medication_history` → `patient`; `vital_sign`/`diagnosis`/`clinical_note`/`clinical_order`/`prescription`/`follow_up_recommendation` → `encounter`; the four order-detail tables plus `specimen`/`lab_order_test`/`imaging_order` → `clinical_order`; `prescription_item` → `prescription`; `invoice_line` → `invoice`; `payment_allocation` → `payment`; `patient_package_session` → `patient_package`; `journal_line` → `journal`; `payroll_run_line` → `payroll_run`; `dispensing_return` → `dispensing_record`; `claim_item` → `claim`. Non-destructive by construction — an `ON DELETE` behavior change doesn't touch or validate existing rows, only future delete attempts.

**No Prisma migration** (deliberately — see `prisma/db-setup/p0-06-create-runtime-role.sql`'s header for why role/GRANT management isn't schema-tracked): a new database role, `avant_app_runtime`, was created directly against each configured environment with `UPDATE`/`DELETE` revoked on `audit_log`/`clinical_access_log` specifically (P0-06) — closing the exact gap the paragraph above describes. **The running application was cut over to this role for real in the P1 remediation pass** (P1 §1, 2026-08-27) — see "Connection Roles" immediately below; P0-06 is FIXED, not partial, as of that cutover.

## Connection Roles (P1 §1, 2026-08-27 — closes the P0-06 gap for real)

Two separate environment variables, two separate database roles, never collapsed into one connection:

| Variable | Used by | Role | Rights |
|---|---|---|---|
| `DATABASE_URL` | The running application (`src/lib/db.ts`, every request) | `avant_app_runtime` (non-owner) | Full CRUD on every table **except** `audit_log`/`clinical_access_log`, where `UPDATE`/`DELETE` are revoked |
| `DIRECT_DATABASE_URL` | Prisma CLI only — `migrate deploy`/`migrate status`/`generate`/`db seed` (`prisma.config.ts`) | the schema owner | Full DDL + DML — required for migrations, never used by the running application |

Why two roles were necessary, not optional: PostgreSQL does not let a table owner's own privileges be revoked from itself (verified empirically via `pg_tables.tableowner` during P0-06) — `REVOKE UPDATE, DELETE ON audit_log FROM postgres` against the owner role executes without error but has zero actual effect. `avant_app_runtime` owns nothing, so the revoke against it is real. Setup script: `prisma/db-setup/p0-06-create-runtime-role.sql` (run once by hand per environment — role/GRANT management is cluster-level, not something `prisma migrate deploy` tracks or should track).

**Live-verified** (`test/integration/audit-log-immutability.test.ts`, run through `db` — the exact same client every domain service imports, connected via `DATABASE_URL`): the application can INSERT and SELECT `audit_log` rows, cannot UPDATE or DELETE them (PostgreSQL rejects it, not application-level logic), and retains full read/write access to a normal table (`branch`) through the identical connection. The full 84-test suite and a live browser session (login → dashboard → complete an encounter, exercising INSERT/UPDATE/SELECT across session, login_history, encounter, charge, and outbox_event) were both run against this same restricted connection with no regressions. See SECURITY.md §5 for the authorization-architecture writeup and DEPLOYMENT.md for the per-environment setup procedure.

## P1 Remediation Schema Changes, Batch 3 (2026-08-27 — POS/inventory/cost accounting, §9-§13)

**`20260826234516_p1_batch3_charge_product_link`**: one nullable column — `charge.product_id` (FK → `product`, `ON DELETE SET NULL`) — plus its covering index. Closes the gap P1_FINANCIAL_INTEGRITY_FINDINGS.md's B1 named: a POS charge sourced from a physical product previously had no field identifying *which* product, so `insertCharge` (billing/charges.ts) had no way to consume real inventory for it. Set only for a genuine retail product sale (`sourceType: "product"` with a real `productId` picked from the catalog) — every existing charge keeps `product_id NULL`, unaffected. No account-mapping schema change was needed for the new `cogs`/`inventory_write_off`/`inventory_adjustment_gain` posting intents — `account_mapping.intent` is a plain string column (not a DB enum), so these are seed-data additions (`prisma/seed.ts`'s `DEFAULT_ACCOUNTS`/`DEFAULT_MAPPINGS` — new Chart of Accounts rows `4100 Inventory Adjustment Gain`, `5100 Cost of Goods Sold`, `5200 Inventory Write-off Expense`), not a migration.

See INVENTORY.md for the valuation-method decision this batch also had to make (specific identification via batch-level `purchase_cost` — no schema change, since `product_batch.purchase_cost` already existed and already carried exactly the data this needed) and P1_REMEDIATION_REPORT.md for the full batch record.

## P1 Remediation Schema Changes, Batch 4 (2026-08-27 — pharmacy chain, supplier AP, over-receiving, asset acquisition, §14-§17)

**`20260827064558_p1_batch4_asset_supplier_invoice_fields`**: two `AlterTable` statements, no new tables.

- `supplier_invoice.tax_amount DECIMAL(14,2) NOT NULL DEFAULT 0` — recoverable purchase tax (e.g. input VAT), manually entered (no supplier-side tax-rule engine exists, unlike the sales side's `TaxRule`). The total AP obligation a supplier invoice creates is `amount + tax_amount`, not `amount` alone — `recordSupplierPayment`'s outstanding-balance check (`supplier-invoices.ts`) was updated to match. Defaulting to 0 means every existing row is unaffected.
- `asset.paid_via PaymentMethod` (nullable) — which tender an acquisition was paid with; set, `postAssetAcquired` credits that tender's resolved account, left null (bought on credit), it credits Accounts Payable instead.
- `asset.depreciation_method TEXT`, `asset.useful_life_months INTEGER`, `asset.salvage_value DECIMAL(14,2)`, `asset.depreciation_start_date DATE` (all nullable) — depreciation-readiness fields only, the same "prepare architecture, don't build the integration" precedent as `ImagingOrder`'s PACS fields (Phase 10). No calculation or posting logic reads any of these yet.

No account-mapping schema change was needed for the new `goods_received_not_invoiced`/`recoverable_tax`/`fixed_asset` posting intents — same reasoning as Batch 3's COGS intents: `account_mapping.intent` is a plain string column, so these are seed-data additions (`prisma/seed.ts`'s `DEFAULT_ACCOUNTS`/`DEFAULT_MAPPINGS` — new Chart of Accounts rows `1300 Recoverable Tax`, `1400 Fixed Assets`, `2050 Goods Received Not Invoiced`), not a migration. The over-receiving-authorization flag (§16) is likewise not a schema change — it's a request-level `allowOverReceipt` input to `createGoodsReceipt`, not a persisted column; the existing `goods_receipt` audit-log entry records whether it was used.

See ARCHITECTURE.md's Chart of Accounts / Central Accounting Posting Service section for the GR/IR clearing-account design this batch introduced, and P1_REMEDIATION_REPORT.md for the full batch record.

## P1 Remediation Schema Changes, Batch 5 (2026-08-27 — payroll replay verification, commission refund reversal, §18-§19)

**`20260827075348_p1_batch5_commission_refund_reversal`**: one nullable column, one index, one FK — no new tables.

- `commission_accrual.refund_id TEXT` (nullable, FK → `refund`, `ON DELETE SET NULL`) — set only on a reversal row `reverseCommissionsForRefund` (`payroll/commissions.ts`) inserts when a refund claws back `collected_revenue`-basis commission. Deliberately left `payment_id NULL` on these reversal rows (copying the original accrual's `payment_id` there would collide with the existing `@@unique([chargeId, paymentId])` — the original row already occupies that pair).

**`20260827080737_p1_batch5_commission_reversal_idempotency`**: one more nullable column, one unique index, one FK — a same-batch follow-up, not a separately motivated change. A real integration test (the multi-payment case in `test/integration/commission-refund-integrity.test.ts`) caught the first migration's idempotency design under-reversing: checking only `(refundId, chargeId)` for an existing reversal wrongly treated a second originating payment's reversal as "already done" once the first payment's reversal existed, silently leaving part of the commission un-clawed-back. Fixed with `commission_accrual.reversal_of_id TEXT` (nullable, self-referencing FK — which ORIGINAL accrual this row reverses) plus a real `@@unique([refundId, reversalOfId])` constraint, replacing the service-layer-only check with a DB-enforced one. Left as its own migration rather than folded into the first (never edit an already-applied migration, even within the same batch — same discipline the rest of this file's migration history follows).

§18 (payroll lifecycle replay) needed no schema change at all — it's a verification batch against the existing `postJournal` referenceType-keyed idempotency (`payroll_run` vs `payroll_run_paid`, P0-02), proven correct with new integration tests rather than any code or schema change.

See ARCHITECTURE.md's Provider Commissions section for the reversal design (including why `gross_invoice`/`net_invoice`-basis accruals are deliberately left untouched) and P1_REMEDIATION_REPORT.md for the full batch record.

## P1 Remediation Schema Changes, Batch 6 (2026-08-27 — lab order state integrity, critical results, clinical/encounter cancellation, §20-§25)

**`20260827092019_p1_batch6_clinical_integrity`**: two new enum values, three nullable columns, one FK — no new tables.

- `EncounterStatus` gains `cancelled` and `entered_in_error` (§24) — `cancelEncounter`/`markEncounterEnteredInError` (clinical/encounters.ts) are the new operational alternatives P0's `Restrict` cascades made necessary. Added via `ALTER TYPE ... ADD VALUE`, which must run outside the same transaction that uses the new value — not a concern here since nothing in this migration references them.
- `encounter.cancel_reason TEXT` / `clinical_order.cancel_reason TEXT` (nullable) — every cancellation captures a reason; user/timestamp come from the audit log, the same convention `Invoice.voidReason` already established.
- `lab_test.critical_low DECIMAL(10,3)` / `lab_test.critical_high DECIMAL(10,3)` (nullable, independent of `reference_range_low`/`high`) — §22's critical-panic thresholds, checked by `computeAbnormalFlag` only where actually configured.
- `lab_order_test.is_current BOOLEAN NOT NULL DEFAULT true` / `lab_order_test.amends_id TEXT` (nullable, self-referencing FK) — §21's amendment chain, the identical `isCurrent`/`amendsId` shape `ClinicalNote` (Phase 3) already established, reused via `amendLabResult` (laboratory/results.ts) rather than reinvented.

No schema change was needed for §20's centralized transition validation (a new shared function plus two in-memory transition-map constants, not a data-model change), §24's Patient status (the `PatientStatus` enum and `Patient.status` column already existed — only `updatePatientStatus`, the missing function, was new), or §24's Invoice-void/Journal-reversal fixes (both reuse `journal`/`journal_line`'s existing `referenceType`/`referenceId` columns — `invoice_void` and `manual_reversal` are new *values* in that plain string column, not a schema change).

See ARCHITECTURE.md's §4 Clinical Workflow, §8 HR/Payroll, and Central Accounting Posting Service sections for the full batch design, and P1_REMEDIATION_REPORT.md for the full batch record.

## P1 Remediation Schema Changes, Batch 7 (2026-08-27 — appointment reschedule/status transitions, package session locking, refund numbering, sequence concurrency, §26-§30)

**`20260827142820_p1_batch7_appointment_and_refund_integrity`**: one nullable column, one unique index — no new tables, no enum changes.

- `refund.refund_number TEXT` (nullable) — §30's genuine gap: every other financial document (`invoice.invoice_number`, `payment.receipt_number`, `goods_receipt.receipt_number`, `supplier_invoice.invoice_number`) already had a human-readable number; `Refund` never did. Assigned via a new `"RFD"` `nextNumber()` sequence type only at `completeRefund` — the first point a refund is guaranteed to actually move money — so it stays `null` through `requested`/`authorized`/`rejected`.
- `@@unique([organizationId, refundNumber])` — Postgres treats each `NULL` as distinct, so the many refunds still in a pre-completion status never collide with each other under this constraint.

No schema change was needed for §26/§27 (appointment reschedule reason and the centralized `APPOINTMENT_TRANSITIONS` map are both application-layer — `AppointmentStatusHistory` and the DB's own `appointment_provider_no_overlap`/`appointment_room_no_overlap` exclusion constraints already existed and needed no changes), §28 (the `SELECT ... FOR UPDATE` lock added to `consumeSession` is a query-time change, not a data-model one), or §30's two `nextNumber`/`appointmentNumber` fixes (see ARCHITECTURE.md's Patient Journey section) — both were application-code races, not schema gaps.

See ARCHITECTURE.md's §3 Patient Journey section for the full batch design, and P1_REMEDIATION_REPORT.md for the full batch record.

## P1 Remediation Schema Changes, Batch 8 (2026-08-27 — financial period control, transaction boundary review, idempotency review, §31-§33)

**`20260827161220_p1_batch8_period_control_and_idempotency`**: two new tables, one new enum — no column changes to any existing table.

- `accounting_period` (§31) — `AccountingPeriodStatus` (`open`/`closed`), `period_start`/`period_end` (an exclusive `[start, end)` calendar-month range), `closed_by`/`closed_at`, `reason`. A row exists ONLY for a month that has actually been closed at some point — an unclosed month has no row and is implicitly open, so nothing has to be pre-created for future months. `@@unique([organizationId, periodStart])` — reopening flips the same row's `status` back to `open` rather than deleting it, so the row's own presence plus the audit log is the full open→closed→reopened history. Read by `assertPeriodOpen` (`accounting/periods.ts`), called from inside `postJournal` itself.
- `idempotency_key` (§33) — `organization_id`, `scope`, `key`, nullable `result_id`, `created_at`. `@@unique([organizationId, scope, key])` is the actual concurrency-safety mechanism (see `platform/idempotency.ts`): a duplicate `(scope, key)` insert genuinely fails at the database level, and Postgres blocks a concurrent conflicting insert until the first transaction commits or rolls back — which is what makes "claim first, do the real work, then record the result, all in one transaction" safe against a true double-click race, not just a delayed retry. A single shared table + primitive, not a bespoke nullable+unique column bolted onto `GoodsReceipt`/`Payment`/`PatientPackageSession` individually.

**Runtime-role grant note, and a real regression it caused** (relevant only if your environment uses the `avant_app_runtime` restricted role per P0-06 — see DEPLOYMENT.md's "Database Privileges"): both new tables needed the idempotent `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "avant_app_runtime"` step re-run after this migration — Postgres does not retroactively grant privileges on tables created after that script last ran. Caught by this batch's own test run (`permission denied for table idempotency_key`/`accounting_period`) before it ever reached a real deployment. **But re-running only that bare GRANT statement — not the full script — re-granted UPDATE/DELETE on `audit_log`/`clinical_access_log` too**, silently reopening P0-06's audit-log immutability fix; `test/integration/audit-log-immutability.test.ts` failed in this same batch's own subsequent full-suite run, catching it for real (not hypothetically) before it went anywhere near a deployment. Fixed by re-running `REVOKE UPDATE, DELETE ON "audit_log", "clinical_access_log" FROM "avant_app_runtime"`, re-verified both by that test file passing again and a direct standalone check against both tables. New `prisma/db-setup/p0-06-regrant-new-tables.sql` now bundles the GRANT and the REVOKE in one script specifically so this can't be repeated by copying only half of the original script again.

See ARCHITECTURE.md's Central Accounting Posting Service section and the new [TRANSACTION_BOUNDARIES.md](TRANSACTION_BOUNDARIES.md) for the full batch design, and P1_REMEDIATION_REPORT.md for the full batch record.

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

Phase 1 through Phase 14 (the full spec.md build plan) schemas implemented and migrated — 20 migrations total: Phase 1's `phase1_platform_foundation` plus two `number_sequence_null_branch_uniqueness` housekeeping migrations, Phase 2's `phase2_patient_provider_service_appointment`, `timestamptz_and_booking_exclusion`, `provider_user_link`, `appointment_reschedule_link`, Phase 3's `phase3_core_emr`, `clinical_org_scoping`, Phase 4's `phase4_revenue`, Phase 5's `phase5_inventory_procurement`, Phase 6's `phase6_finance`, Phase 7's `phase7_hr_assets` plus the same-session `payroll_run_branch_required` follow-up, Phase 8's `phase8_lis`, Phase 9's `phase9_pharmacy`, Phase 10's `phase10_ris`, Phase 11's `phase11_payors_insurance`, Phase 12's `phase12_patient_engagement`, and Phase 14's `phase14_indexing` (Phase 13 added none, exactly as predicted) — see PROJECT_STATUS.md for verification detail. Phase 14 confirmed this file's own prediction from last phase almost exactly: schema-adjacent (indexing) rather than new domain tables, plus a DB-privilege-tightening review that found a real reason not to execute the change autonomously (see the Phase 14 section above). This is the last phase in spec.md's roadmap.

**P0 Remediation Pass (2026-08-27, following the Phase 14 audit)** added 3 more migrations — `20260826192144_p0_02_outbox_reliability`, `20260826192200_p0_02_outbox_reliability_data`, `20260826200219_p0_05_cascade_delete_protection` (23 total now) — plus the genuinely separate runtime DB role Phase 14 had documented but deliberately not executed.

**P1 Remediation Pass, Batch 0 (2026-08-27)** completed the cutover: the running application now connects via `DATABASE_URL` as the restricted `avant_app_runtime` role, not the schema owner — see "Connection Roles" above for the full verification. No new migrations this batch (role/GRANT changes are cluster-level, not schema-level).

**P1 Remediation Pass, Batch 3 (2026-08-27, POS/inventory/cost accounting)** added 1 more migration — `20260826234516_p1_batch3_charge_product_link` (24 total now) — linking `charge` to `product` so a POS retail sale can trigger real inventory consumption and COGS posting for the first time; see "P1 Remediation Schema Changes, Batch 3" above.

**P1 Remediation Pass, Batch 4 (2026-08-27, pharmacy chain / supplier AP / over-receiving / asset acquisition)** added 1 more migration — `20260827064558_p1_batch4_asset_supplier_invoice_fields` (25 total now) — `supplier_invoice.tax_amount` and four nullable `asset` columns (`paid_via` + the depreciation-readiness fields); see "P1 Remediation Schema Changes, Batch 4" above.

**P1 Remediation Pass, Batch 5 (2026-08-27, payroll replay verification / commission refund reversal)** added 2 more migrations — `20260827075348_p1_batch5_commission_refund_reversal` and `20260827080737_p1_batch5_commission_reversal_idempotency` (27 total then) — `commission_accrual.refund_id`, then a follow-up `reversal_of_id` + `@@unique([refundId, reversalOfId])` once a real integration test caught the first design under-reversing when one charge had multiple originating payments; see "P1 Remediation Schema Changes, Batch 5" above.

**P1 Remediation Pass, Batch 6 (2026-08-27, lab order state integrity / critical results / clinical & encounter cancellation)** added 1 more migration — `20260827092019_p1_batch6_clinical_integrity` (28 total now) — `EncounterStatus`'s two new terminal values, `encounter`/`clinical_order` cancel reasons, `lab_test` critical thresholds, and `lab_order_test`'s amendment chain; see "P1 Remediation Schema Changes, Batch 6" above.

**P1 Remediation Pass, Batch 7 (2026-08-27, appointment reschedule/status transitions / package session locking / refund numbering / sequence concurrency)** added 1 more migration — `20260827142820_p1_batch7_appointment_and_refund_integrity` (29 total then) — `refund.refund_number` plus its nullable-safe unique index; see "P1 Remediation Schema Changes, Batch 7" above.

**P1 Remediation Pass, Batch 8 (2026-08-27, financial period control / transaction boundary review / idempotency review)** added 1 more migration — `20260827161220_p1_batch8_period_control_and_idempotency` (30 total now) — the new `accounting_period` and `idempotency_key` tables; see "P1 Remediation Schema Changes, Batch 8" above.

**P1 Remediation Pass, Batch 9 (2026-08-27, adversarial test list / report and patient-statement reconciliation)** added no migrations (30 total, unchanged) — §34-§36 are entirely test coverage plus one new read-only application-layer function (`getPatientStatement`, `billing/statement.ts`) composed from existing `Invoice`/`Payment`/`PaymentAllocation`/`Refund` tables, no new columns or tables needed.

**P1 Remediation Pass, Batch 10 (2026-08-28, final synthesis and sign-off — §38-§43) — the pass concludes.** Added no migrations (30 total, final). §38-§43 are verification, reporting, and a small amount of test-only work: a genuine, previously-uncovered gap in `consumeSession`'s already-shipped (Batch 8) idempotency-key mechanism was found and closed with a new test (`package-session-concurrency.test.ts`), not a schema or application-code change. Two real application-layer gaps (`createAdHocCharge`/`createSupplierInvoice` both lacking `IdempotencyKey` protection) were found while building `SYSTEM_INTEGRITY_MATRIX.md` and reported rather than fixed, per this batch's own "synthesis and sign-off only" authorized scope — see `PROJECT_STATUS.md`'s Next Actions items 34-35 and `P1_REMEDIATION_REPORT.md`. 30 migrations is the final count for this entire P1 pass; no further phase-driven schema growth is expected beyond this, though real deployment needs (Global Search, master-data Import/Export, Lead CRM — tracked in PROJECT_STATUS.md's Next Actions) may still add tables or indexes in the future.

## P2 Remediation Schema Changes, Batch 1 (2026-08-28 — database schema quality, §3/§10/§11/§12)

**`20260828_p2_batch1_schema_quality`** (31st migration) — see [P2_FINDINGS.md](P2_FINDINGS.md) for the pre-batch verification and [P2_REMEDIATION_REPORT.md](P2_REMEDIATION_REPORT.md) for the full record. Every change below is backed by a verified real query pattern, a verified-clean existing dataset, or both — checked against the live database before writing, not assumed from the original audit.

**§3 — 15 new indexes, added only where a real query pattern was found uncovered** (verified via `grep` for actual `where`/`orderBy` usage across `src/lib/domains`, not "this table has a date column" alone):

| Table | Index added | The real query it supports |
|---|---|---|
| `Invoice` | `(organizationId, issuedAt)` | `financial.ts`/`revenue-cycle.ts` date-range aggregates; `listOutstandingInvoices` (Receivables page) |
| `Invoice` | `(organizationId, createdAt)` | Main Invoices list (`billing/invoices.ts`) — real `page`/`pageSize` pagination since P2 Batch 6 (§8), this index is what makes each page's `ORDER BY createdAt DESC LIMIT/OFFSET` cheap regardless of table size |
| `Payment` | `(organizationId, receivedAt)` | Same report aggregates; 3 separate `orderBy: receivedAt` list functions in `billing/payments.ts` |
| `Charge` | `(organizationId, createdAt)` | `revenue-cycle.ts`'s `groupBy(by: status, where: {..., createdAt: range})` dashboard aggregate |
| `GoodsReceipt` | `(organizationId, branchId, receivedAt)` | `listGoodsReceipts` — this table had **zero** indexes beyond its unique constraint before this |
| `SupplierInvoice` | `(organizationId, createdAt)` | `listSupplierInvoices` — neither existing index's trailing column was `createdAt` |
| `CommissionAccrual` | `(organizationId, providerId, accruedAt)` | `commissions.ts`'s own date-range functions; `analytics/reports/hr.ts`'s provider-grouped commission report |
| `Claim` | `(organizationId, createdAt)` | `listClaims` — real pagination since P2 Batch 6 (§8); was fully unbounded before |
| `Patient` | `(organizationId, createdAt)` | `listPatients` — already paginated, was sorting unindexed |
| `Episode`/`Encounter`/`ClinicalOrder` | `branchId` widened to `(branchId, startDate/startAt/orderedAt)` | `listEpisodes`/`listEncounters`/`listOrders` — the top-level list pages built to fix the "Scheduled in a later build phase" nav bug (see PROJECT_STATUS.md's "Post-P1 fixes") |
| `StockLedgerEntry` | `(organizationId, branchId, createdAt)` | `listLedgerEntries` — real pagination since P2 Batch 6 (§8), the audit's own named "stock ledger hard cap" example |

**Deliberately not indexed**, despite appearing in P2.md §3's own pattern list, because no real query was found using them: `StockLedgerEntry.referenceType`/`referenceId` (the model's own doc comment calls this a polymorphic pointer, but nothing in `src/lib/domains` currently filters on it) and `ProductBatch.supplierId` (zero call sites filtering by it). `Refund` was reviewed and left alone — its only org-wide list (`listPendingRefundRequests`) is a small, status-filtered queue already covered by the existing `(organizationId, status)` index, not a historical list needing a date index. `AuditLog`, `ClinicalAccessLog`, `OutboxEvent`, `Journal`, `Appointment`, `PayrollRun` were all reviewed and found already correctly indexed for their real query shape — no change.

**§10 — `AccountMapping.intent`: `String` → `PostingIntent` enum.** Verified against the live database before writing the migration: all 22 distinct existing `intent` values matched the `PostingIntent` union already hand-maintained in `posting-service.ts` exactly — zero cleanup needed. **A real bug caught in the generated migration SQL itself, not shipped**: Prisma's raw `migrate diff` output for this change was `ALTER TABLE account_mapping DROP COLUMN "intent", ADD COLUMN "intent" "PostingIntent" NOT NULL` — a naive drop-and-recreate that would have destroyed every existing mapping's value. Hand-corrected to `ALTER COLUMN "intent" TYPE "PostingIntent" USING ("intent"::text::"PostingIntent")`, a safe in-place cast — verified after applying that all 22 rows and their values survived intact. `posting-service.ts`'s own hand-written `PostingIntent` union type was replaced with a re-export of the generated Prisma enum (`export type PostingIntent = $Enums.PostingIntent`) so the two can never drift again — the original finding was exactly this kind of drift. `prisma/seed.ts`'s `DEFAULT_MAPPINGS` array is now typed against the same enum instead of a bare `string`, so a typo'd intent is a compile error, not a silently-broken seed row.

**§11 — composite org-scoped uniqueness on `User.username` and `Provider.licenseNumber`.** Both verified duplicate-free against the live database before adding `@@unique([organizationId, username])`/`@@unique([organizationId, licenseNumber])` — zero existing collisions found, so no remediation path was needed (had duplicates existed, per P2.md's own instruction, they would have been reported here rather than silently merged/deleted). NULL stays distinct under Postgres's normal unique-index semantics, matching the same tradeoff already accepted for `number_sequence`/`tax_rule`/`account_mapping`'s own nullable-branch uniqueness — a user/provider with none set yet never collides with another. The other identifiers P2.md §11 names (`employee_number`, `product.sku`, `service.code`, `lab_test.code`, `imaging_service.code`) were checked directly against `pg_indexes` and already carry real `(organizationId, ...)` unique constraints — no gap found, no change made.

**§12 — `updatedAt` on `Charge`, `Invoice`, `Payment`.** All three are genuinely mutable after creation (`Charge.status`/`voidReason`, `Invoice.paidAmount`/`status`/`final*Responsibility`, `Payment.status`) and now carry `updatedAt DateTime @updatedAt`, the same convention `User`/`Provider`/`Encounter` already use. Backfilled existing rows with `DEFAULT CURRENT_TIMESTAMP` at migration time (Prisma's raw diff omitted this default, which would have failed outright against the existing rows in these three tables — caught and added by hand before applying). Not added to `Refund`/`Claim`/append-only ledger tables — not named in P2.md §12's own list, and those are either already-immutable-in-practice or out of this section's explicit scope.

**Applying this migration outside this environment**: this session's sandboxed network could not reach the Supabase pooler directly (`prisma migrate diff --from-config-datasource` and `migrate deploy` both failed with P1001), so the migration script was generated instead via `prisma migrate diff --from-schema <prior schema.prisma> --to-schema <current>` (a pure schema-to-schema diff, no live connection needed), hand-corrected per the two bugs above, applied via a direct SQL connection, and recorded in `_prisma_migrations` with a matching SHA-256 checksum of the final `migration.sql` — so `prisma migrate status` reads correctly from a normal terminal with working connectivity. A future `prisma migrate deploy` against this same database will correctly see this migration as already applied.

## P2 Remediation Schema Changes, Batch 2 (2026-08-29 — branch scoping review / actor foreign keys, §13/§14)

**`20260829_p2_batch2_branch_scope_actor_fks`** (32nd migration) — see [P2_REMEDIATION_REPORT.md](P2_REMEDIATION_REPORT.md) for the full record. Applied via `prisma migrate deploy` directly this batch — the owner-role credential issue Batch 1 worked around was fixed (by the user, in the Supabase dashboard) between batches, so this migration used the normal CLI path, not the schema-diff-only fallback.

**§13 — branch ownership model, documented, not migrated.** Reviewed all ten models P2.md §13 names (Episode, Encounter, VitalSign, ClinicalNote, Diagnosis, ClinicalOrder, Prescription, plus lab/imaging/dispensing records) directly against `prisma/schema.prisma` and every write path that populates them. **The existing model was already correct and needed no schema change** — this section's real deliverable is the documentation below, per P2.md's own instruction not to duplicate `branchId` by default.

Two categories, by design, verified via source:
- **Authoritative direct field** (`branchId` stored, always *derived* from a parent at creation, never independently caller-supplied, never updated after creation): `Episode`, `Encounter` (the two root clinical entities — this is where the branch fact genuinely originates, from `assertCan(session, "encounter.create", { branchId: input.branchId })`'s own permission-checked input), `ClinicalOrder` (`branchId: encounter.branchId` at creation, `clinical/orders.ts`), `VitalSign` (`branchId: encounter.branchId`, `clinical/vitals.ts:27`), `Specimen` (`branchId: order.branchId`, `laboratory/orders.ts:116`), `DispensingRecord` (`branchId: item.prescription.encounter.branchId`, `pharmacy/dispensing.ts:42`). Stored directly for query-pattern reasons (P0-01's `narrowBranchFilter` needs a real WHERE-clause column for these high-volume, frequently branch-filtered tables — see §3 above) — a real denormalization, not ambiguity, since every write path proves it can never diverge from its parent and nothing ever updates it afterward (`grep`-verified: zero `.update()` calls anywhere touch any of these six models' `branchId`).
- **Correctly inherited, no direct field** (branch resolved only via the record's single parent relation): `ClinicalNote`, `Diagnosis`, `Prescription`, `FollowUpRecommendation` (all via `encounterId`), `LabOrderDetail`/`LabOrderTest`/`ImagingOrderDetail`/`ImagingOrder`/`ProcedureOrderDetail`/`ReferralOrderDetail` (via `clinicalOrderId`, a 1:1 or 1:N extension of `ClinicalOrder`, which itself already carries `branchId`), `DispensingReturn` (via `dispensingRecordId`). No independent branch meaning exists for any of these — a diagnosis, a prescription, a lab result cannot legitimately be "at" a different branch than the encounter/order that produced it, so a direct column would only be a redundant copy with no independent value, exactly what P2.md §13 warns against adding by default.

**A real cross-branch read-path leak was found and fixed, not a schema gap.** `listPatientPrescriptions`/`getPrescription` (`clinical/prescriptions.ts`) and `listPatientFollowUps`/`listOpenFollowUps` (`clinical/follow-ups.ts`) filtered only by `patient: visibility` (`patientVisibilityWhere` — registered branch OR has an appointment at an authorized branch) — the correct check for whether the *patient record* is visible at all, but insufficient for these two: both are per-encounter clinical content, not patient-level summaries, and a patient visible via Branch B does not make every prescription/follow-up from every other branch that patient was ever treated at visible too. `listPatientDiagnoses` (`clinical/diagnoses.ts`) and `listPatientLabResults`/`listPatientImagingResults` already scoped correctly via the record's own `encounter.branchId` (or `clinicalOrder.branchId`) — this was a genuine inconsistency with that established, correct pattern, found during this batch's own review of exactly the models §13 names, not a previously-catalogued P0/P1 finding. Fixed to match the correct pattern exactly (`encounter: { branchId: narrowBranchFilter(scope) }`, not ANDed with patient-level visibility — a patient with a real encounter at an authorized branch but no registration/appointment there otherwise must still see that encounter's own content). `listOpenFollowUps`'s explicit `branchId` filter parameter also changed meaning, deliberately: from "patient registered at this branch" to "recommended at this branch's encounter" — the branch actually responsible for scheduling it. See `test/integration/schema-quality-p2-batch2.test.ts` for the real two-branch proof (a Branch-B-only session cannot see a Branch-A encounter's prescription/follow-up for a patient who IS otherwise visible to it).

`listPatientMedicationHistory` (`pharmacy/dispensing.ts`) has the same patient-level-only visibility shape — **not fixed**, since it's confirmed dead code (zero callers anywhere in `src/app`, per P2_FINDINGS.md §20) with no live exposure; noted here for whoever eventually wires it up, not silently missed.

**§14 — actor foreign keys, 34 fields classified, 34 given a real FK this batch.** All 48 `*By` fields in the schema were enumerated (`grep`-counted, matching SYSTEM_AUDIT's own historical count exactly) and classified:

- **Category A (real FK to `user`, `onDelete: Restrict`) — 34 fields, added this batch**: `PatientAllergy.notedBy`, `PatientCondition.notedBy`, `PatientMedicationHistory.notedBy` (the patient-safety-notation trio — allergy/condition/medication documentation is squarely patient-safety-critical); `Episode.createdBy`, `Encounter.createdBy` (root clinical entities); `Diagnosis.diagnosedBy`; `ClinicalNote.authoredBy`/`finalizedBy` (documentation authorship/finalization — malpractice/compliance-relevant); `Specimen.collectedBy` (chain of custody); `LabOrderTest.enteredBy`/`verifiedBy`; `ImagingOrder.performedBy`/`reportedBy`/`verifiedBy`; `DispensingRecord.verifiedBy`/`dispensedBy`, `DispensingReturn.returnedBy` (controlled-substance/patient-safety accountability); `Charge.createdBy`, `Invoice.createdBy`, `Payment.receivedBy` (every dollar of revenue traces through these); `Refund.requestedBy`/`authorizedBy` (a deliberate segregation-of-duties control point); `CashMovement.recordedBy` (cash-handling accountability); `PurchaseRequest.requestedBy`/`approvedBy` (procurement segregation of duties); `GoodsReceipt.receivedBy`; `SupplierPayment.paidBy`, `Expense.paidBy` (money leaving the business); `AccountingPeriod.closedBy` (audit-critical control point); `Journal.postedBy` (direct, unmediated GL access for a manual entry); `LeaveRequest.decidedBy` (HR compliance decision); `PayrollRun.createdBy`/`approvedBy` (high financial and HR sensitivity); `AppointmentStatusHistory.changedBy` (the audit-trail table's own actor). Every FK is `onDelete: Restrict` — this app never hard-deletes a `User` today (deactivation only), so Restrict makes "a historical record must survive account deactivation" a real, DB-enforced guarantee rather than an unenforced convention, the identical reasoning P0-05 already applied to every clinical/financial parent relation.
- **Category B (deliberately no FK, left as a historical string)** — the remaining 13 fields not explicitly named above: `Patient.createdBy`, `ProviderLeaveBlock.createdBy`, `Appointment.createdBy`, `ClinicalOrder.createdBy` (the clinically-meaningful actor is already a real FK, `orderingProviderId`; this is secondary bookkeeping), `Prescription.createdBy` (same reasoning — `providerId` is already a real FK), `FollowUpRecommendation.createdBy`, `VitalSign.recordedBy`, `PatientPackage.createdBy`, `PatientPackageSession.consumedBy`, `StockLedgerEntry.performedBy` (extremely high-volume append-only ledger; `audit_log` already independently captures real mutation accountability for this action), `StockTransfer.requestedBy`, `PurchaseOrder.createdBy` (the real approval accountability is `PurchaseRequest.approvedBy`, already Category A), `SupplierInvoice.createdBy` (the real money-movement accountability is `SupplierPayment.paidBy`, already Category A), `AttendanceRecord.recordedBy` (high-volume, one row per employee per day), `MaintenanceRecord.performedBy`, `Claim.createdBy`.
- **Category C (system/external actor)**: `CommMessage.sentBy` — nullable and genuinely sometimes system-triggered (`sendMessage()` has no permission check of its own, per ARCHITECTURE.md §13's "internal system reaction" precedent); left without an FK for the same low-stakes-informational reasoning as Category B, not force-fit into A or a literal system-actor sentinel row.

**A real orphaned-reference bug was found and fixed before this migration was written, not discovered by the migration failing.** Every one of the 34 columns' existing non-null values was checked against `user.id` first (per P2.md's own "validate existing values, don't break existing mappings" instruction, applied here with the same rigor as §10's enum conversion) — 33 columns were clean; `patient_medication_history.noted_by` had 2 rows pointing at `00000000-0000-0000-0000-0000000000f4`, a hardcoded, never-created placeholder id from `test/integration/pharmacy-dispensing-integrity.test.ts`'s own session fixture (confirmed via `grep` — the only place that literal string appears in the codebase). Not silently deleted or merged: the 2 rows' `noted_by` was set to `NULL` (the medication-history fact itself is real; only its fabricated actor attribution was bogus and unrecoverable) and the test file itself was fixed to use a real seeded user, matching every other test file's own established convention — otherwise re-running that test would have hit the new FK constraint for real on its very next run, a predictable regression from this migration, not a hypothetical one. See P1_REMEDIATION-style precedent: this is the same "found while doing the real work, fixed because it directly blocks/breaks the real work, not scope creep" judgment call this whole pass has made repeatedly.

**Tests**: `test/integration/schema-quality-p2-batch2.test.ts` — real two-branch proof for the §13 fix (a Branch-B session cannot see a Branch-A encounter's prescription/follow-up for an otherwise-visible patient, org-wide session sees both) and real FK-enforcement proof for §14 (deleting a `User` still referenced by `PatientAllergy.notedBy` is rejected by Postgres, not just discouraged by application code; a `NULL` actor is unaffected).
