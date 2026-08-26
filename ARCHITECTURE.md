# ARCHITECTURE.md

Living reference for the HIS system architecture. Updated at the end of every phase. Rationale/tradeoffs for decisions live in [BLUEPRINT.md](BLUEPRINT.md) and individual ADRs in `/docs/adr/`; this file is the current-state operational reference.

## 1. Style

Modular monolith. One Next.js (App Router, TypeScript) application, one PostgreSQL database. Domains are isolated by folder/module boundary and service-layer contracts, not by network boundary. See BLUEPRINT.md §74/§2 for rationale.

## 2. Domain Map

```
identity        organization, branch, department, room, user, role, permission, session
patients        patient, patient_document, patient_allergy, patient_condition,
                 patient_medication_history, consent
providers        provider, provider_schedule, provider_leave_block
scheduling       appointment, queue_entry
clinical         episode, encounter, vital_sign, diagnosis, clinical_note,
                 clinical_order (+ type detail tables), prescription, prescription_item,
                 follow_up_recommendation
laboratory       lab_test, lab_panel, lab_panel_test, specimen, lab_order_test
                 (no separate lab_result table — result fields live on lab_order_test)
pharmacy         medication, dispensing_record, dispensing_return
radiology        imaging_service, imaging_order (no separate imaging_report table —
                 result fields live on imaging_order, same precedent as lab_order_test)
billing          charge, invoice, invoice_line, payment, payment_allocation,
                 cashier_session, refund
claims           payor, insurance_plan, policy, patient_coverage, prior_authorization,
                 claim, claim_item (one domain folder, not the two — "payors" and
                 "claims" — speculatively sketched pre-Phase-11; see §12)
inventory        product, product_batch, stock_ledger_entry, stock_transfer
procurement      supplier, purchase_request, purchase_order, goods_receipt,
                 supplier_invoice
assets           asset, maintenance_record, calibration_record
hr               employee, employee_document, shift, attendance_record, leave_request, leave_balance
payroll          payroll_run, payroll_run_line, commission_rule, commission_accrual
                 (no separate payslip table — printed from payroll_run_line)
accounting       chart_of_account, account_mapping, journal, journal_line
communications   comm_template, comm_message (`lead` not built in Phase 12 — see §13)
portal           patient_portal_account, patient_portal_session
booking          (no new tables — reuses appointment/patient, tagged bookingSource=online)
analytics        (no new tables — reads every domain's existing tables directly; see §17)
platform         audit_log, clinical_access_log, notification, number_sequence,
                 outbox_event, saved_search
```

Dependency direction (importing domain → depended-on domain) is one-way except where a domain event is used instead of a direct call. See BLUEPRINT.md §2 table for the full dependency matrix.

## 3. Patient Journey (canonical spine)

```
Registration → Duplicate Check → Appointment → Arrival → Check-In → Queue
 → Encounter (± Episode) → Vitals → Consultation → Diagnosis → Orders → Prescription
 → Encounter Finalized → Charges Captured → Invoice → Payment → Accounting Journal
 → Commission Accrual → Patient Timeline → Follow-Up
```

Order branches: `Encounter → Lab Order → LIS → Result → EMR`; `Encounter → Medication Order → Pharmacy → Dispensing → Inventory → EMR`; `Encounter → Imaging Order → RIS → Report → EMR`; `Encounter → Procedure → Room + Inventory → Charge`.

## 4. Clinical Workflow

`Episode` (optional grouping) → `Encounter` (bounded interaction, statuses `draft → active → completed → finalized`) → structured documentation (chief complaint, HPI, exam, assessment) → `Diagnosis` (ICD-coded, primary/secondary) → `CPOE Order` (lab/medication/imaging/procedure/referral/other) → `Prescription`. Finalized encounters and notes are never edited in place — corrections create an amendment row referencing the original (`amends_id`), full version chain preserved. A finalized encounter with a triggering diagnosis/procedure that is later amended does **not** retroactively alter charges already generated from it (Correction #2, approved) — a correction requires a new adjustment charge/credit.

Referral orders (Correction #1) distinguish `referral_scope` (`internal | external`) and track a `referral_status` (`issued → acknowledged → seen → closed`) independent of the shared CPOE status enum, in `referral_order_detail`.

Follow-up is modeled explicitly via `follow_up_recommendation` (Correction #1): `encounter_id, recommended_date, reason, status(open|scheduled|dismissed)`, queried by the notification engine and reports — not inferred from a future appointment's free-text note.

## 5. Revenue Workflow

```
Billable Event (encounter completion / order completion / dispensing / procedure completion)
 → Charge (immutable, source-typed, unbilled until invoiced)
 → Invoice (aggregates pending charges, applies line/document discount + tax)
 → Payment (single or split across tenders, allocated via payment_allocation)
 → Accounting Journal (posted automatically by the central posting service)
```

**Status: Charge → Invoice → Payment fully implemented in Phase 4** (`src/lib/domains/billing/*`). The centralized billing engine (spec.md §33) is the *only* writer of `Charge`/`InvoiceLine` — the POS UI never constructs billing data directly. `EncounterCompleted` is the live trigger for the "Consultation" source; `lab` is live as of Phase 8 (fired at test-assignment time, see §9); `pharmacy` is live as of Phase 9 (fired at dispensing time, see §10); `imaging` is live as of Phase 10 (fired at service-assignment time, see §11); `procedure`/`product`/`package`/`other` sources remain POS-entered ad-hoc. **Accounting Journal implemented in Phase 6** — `InvoiceIssued`/`PaymentReceived`/`RefundCompleted` now have real handlers calling the central posting service (see §6); every invoice, payment, and refund posts a balanced journal automatically.

**Insurance path implemented in Phase 11** (see §12): `Invoice` carries `payorId`/`patientCoverageId`, splitting `estimatedPatientResponsibility`/`estimatedPayorResponsibility` at issue time (from the coverage's copay) and `finalPatientResponsibility`/`finalPayorResponsibility` post-remittance (two distinct, separately-timestamped fields, never an in-place edit of the original estimate). Deliberately not added to the Phase 4 `Invoice` schema ahead of the Payor domain existing — self-pay patients worked with zero payor configuration from Phase 4 through Phase 10 (spec.md §38), and every field this phase added is nullable, so that remains true today.

Packages (Correction #3, approved) — **sale and consumption implemented in Phase 4, accounting treatment implemented in Phase 6**: a `PatientPackage` purchase creates a pending `Charge` (source `package`) through the same engine as everything else; at invoice time `postInvoiceIssued()` credits the package-sourced portion of the invoice to `unearned_revenue` (not `revenue`), and each `patient_package_session` consumption triggers `postPackageSessionConsumed()` — a `recognize_package_revenue`-style posting moving `purchasePrice / totalSessionsAllocated` from Unearned Revenue to Revenue, pro-rata per session regardless of which of the package's bundled services the session was used against. `PatientPackage` usability remains independent of payment status (see PROJECT_STATUS.md's Phase 4 Architecture Decisions) — accounting recognition and clinical usability are two separate concerns.

## 6. Accounting Workflow

All postings go through the Central Accounting Posting Service (`/lib/domains/accounting/posting-service.ts`) — no other module writes `journal_line` directly. Intent-based methods resolve GL accounts via configurable `account_mapping` rows (keyed by branch + transaction intent), never hardcoded account numbers. Every journal is balanced (`Σdebit = Σcredit`), enforced by a DB trigger, not just application code.

**Status: implemented in Phase 6** (`src/lib/domains/accounting/*`). `resolveAccountId(organizationId, branchId, intent)` resolves against a fixed 14-value `PostingIntent` taxonomy — branch-specific mapping wins, falls back to the org-wide default (`branchId: null`), throws a clear configuration error if neither exists. `postJournal()` is the sole `Journal`/`JournalLine` writer, generating the sequence number (`JRN-000001`, ...) and doing a fast application-level `Σdebit = Σcredit` check before the DB's `CHECK` constraint + `DEFERRABLE CONSTRAINT TRIGGER` (see DATABASE.md) enforce it authoritatively at commit. Eight named posting functions cover every accounting-relevant trigger: `postInvoiceIssued`, `postPaymentReceived`, `postRefundCompleted`, `postGoodsReceiptCompleted`, `postSupplierPaymentRecorded`, `postPackageSessionConsumed`, `postExpense`, `postManualJournal`. The first six post asynchronously via the existing outbox pattern (§11) — a missing account mapping never blocks the triggering clinical/revenue/inventory action, it just leaves the posting `failed` for retry; `postExpense` and `postManualJournal` post synchronously, in the same transaction as the triggering row, since both are direct accountant actions expecting immediate confirmation. Financial reports (Trial Balance, Income Statement, Balance Sheet, a simplified direct-method Cash Flow) are computed live from `journal_line` at read time — never cached.

Tax (Correction #4, approved; **implemented in Phase 4**): tax is a configurable rate attached per `service` (`tax_rule` table, with an org-wide default when no service-specific rule matches), not a flat hardcoded percentage — required groundwork for future ZATCA/regional e-invoicing compliance (spec.md §77). No `TaxRule` configured at all (the Phase 4 default state) means 0% tax, a valid self-pay-clinic configuration, never a fabricated nonzero fallback. Rounding policy: computed and rounded **per invoice line**, then summed for the invoice total (locked convention, verified live in Phase 4 testing). Jurisdiction-based rule selection (vs. today's service-based selection) is deferred until a real multi-jurisdiction deployment need names it.

## 7. Inventory Workflow

```
Purchase Request → Approval → Purchase Order → Goods Receipt → Stock Ledger Entry (in, new ProductBatch)
 → Consumption (treatment consumption via billing / manual adjustment / transfer) → Stock Ledger Entry (out, FEFO batch selection)
 → Reorder Alert (low stock / near expiry / expired)
```

**Status: implemented in Phase 5** (`src/lib/domains/inventory/*`, `src/lib/domains/procurement/*`). Stock balance is always a derived aggregate over `stock_ledger_entry`; no table stores a directly-mutable quantity — not even `ProductBatch.receivedQuantity`, which is a historical fact about what a receipt brought in, not a running balance. A materialized balance cache is an accepted future optimization (BLUEPRINT.md §"Scalability Issues"), not built until profiling in Phase 14 shows it's needed.

Automatic clinical consumption (spec.md §44, `ServiceProductConsumption` templates) is triggered from the billing engine's Charge-creation chokepoint (`src/lib/domains/billing/charges.ts`), not from CPOE order completion — Charge already carries the `serviceId` needed to look up a template and already fires for every path a service gets billed through (system-generated or POS ad-hoc), so this covers the spec requirement without reopening Phase 3's CPOE model or Phase 4's deferred automatic-procedure-charge decision. Consumption runs in the same transaction as the Charge; insufficient stock throws and the whole Charge is rolled back, not just skipped.

FEFO (spec.md §42) is a real multi-batch allocation, not a single-oldest-batch shortcut: `consumeStock()` walks every batch with remaining balance in expiry-date order (nulls last), taking from each until the requested quantity is satisfied, throwing if total availability falls short.

Procurement follows Purchase Request → Approval → Purchase Order → Goods Receipt → Supplier Invoice → Payment (spec.md §46), with Approval a distinct permission from request creation (segregation of duties, same pattern as Phase 4's refund workflow). Partial receiving is supported by construction — `PurchaseOrderLine.receivedQuantity` is derived from summing `GoodsReceiptLine` rows, never stored, so multiple receipts against one PO can't drift from the truth. Supplier Invoice creates the accounts-payable obligation; **Goods Receipt and Supplier Payment both post real journal entries as of Phase 6** (`postGoodsReceiptCompleted`: Dr Inventory / Cr AP; `postSupplierPaymentRecorded`: Dr AP / Cr the paying tender's account) via the same central posting service as the revenue side.

## 8. HR, Payroll & Assets Workflow

```
Employee → Schedule → Attendance → Leave → Payroll → Payslip → Payment → Accounting Journal
Asset → Maintenance / Calibration → Alert (warranty expiring / calibration due)
```

**Status: implemented in Phase 7** (`src/lib/domains/hr/*`, `src/lib/domains/payroll/*`, `src/lib/domains/assets/*`). `Employee` is the HR master; `Provider.employeeId` (a nullable, unique FK dormant since Phase 2) links it to the clinical scheduling/billing identity — two separate, both-optional concerns, wired together for real this phase via a small dedicated link action rather than folded into the full Provider edit form.

Leave approval directly affects scheduling (spec.md §51): approving a `LeaveRequest` for an employee linked to a Provider creates a `ProviderLeaveBlock` via the `EmployeeLeaveApproved` handler — the identical mechanism Phase 2's booking-conflict check already reads, so a doctor's approved leave blocks new appointments through the exact same code path a manually-entered leave block would.

Provider Commissions (spec.md §53): `CommissionRule` resolves most-specific-wins across (provider, service) → (provider, org-wide-service) → (org-wide-provider, service) → (org-wide-provider, org-wide-service), supporting fixed/percentage/tiered types against gross-invoice/net-invoice/collected-revenue bases. Two distinct trigger points, chosen for correctness rather than convenience: gross/net-invoice-basis rules accrue once at `InvoiceIssued` (the amount doesn't change with how many payments eventually settle it); collected-revenue-basis rules accrue per payment, proportional to what that specific payment actually collected (keyed to a real `Payment` row id, so redelivery-safe). Accruals never post to the ledger on their own — they're pulled into a `PayrollRunLine.commission` figure at payroll time and reach `journal_line` only as part of that combined posting.

Payroll (spec.md §52): Draft → Review → Approved → Paid. Creating a run snapshots each employee's `basicSalary` plus their pending commission accruals (immediately marking those `included_in_payroll` so a second run can't double-count them); `netSalary` is fixed once computed, the same "historical fact once finalized" precedent as `Invoice.totalAmount`. Approved posts `Dr Salary Expense / Cr Payroll Payable` (spec.md §55's own named payroll example) via two new `PostingIntent`s (`salary_expense`, `payroll_payable`); Paid posts `Dr Payroll Payable / Cr [the run's tender account]` — both through the same central posting service as every Phase 6 posting, using `netSalary` on both sides of both postings (deductions are netted into the expense figure, not modeled as a separate payable — see PROJECT_STATUS.md's Phase 7 Known Issues for what this trades away).

Assets (spec.md §47/§48): `Asset` tracks the full named field set including all seven statuses; `MaintenanceRecord`/`CalibrationRecord` are its history. No accounting posting on asset purchase — the physical purchase already flows through Expense or the procurement chain if bought that way, and spec.md §47 doesn't name a dedicated posting the way Payroll does. Warranty and calibration-due alerts are computed live against a 30-day horizon, never stored flags — the same discipline as Phase 5's stock alerts.

## 9. Laboratory (LIS) Workflow

```
Doctor Order (ClinicalOrder + LabOrderDetail, free-text intent, Phase 3)
 → Assign Tests (structured LabOrderTest lines from the LabTest/LabPanel catalog + Charge generated, Phase 8)
 → Specimen Collection → Result Entry (abnormalFlag computed server-side)
 → Verification → Final Result → Patient EMR + LabResultFinalized
```

**Status: implemented in Phase 8** (`src/lib/domains/laboratory/*`). A deliberate two-stage model: the doctor's Phase 3 CPOE lab order captures clinical *intent* only (free-text `testName`) and is left completely untouched by this phase; lab staff then "assign" catalog `LabTest`/`LabPanel` entries against that order, which is the point structured, billable `LabOrderTest` rows and their `Charge`s (`sourceType: "lab"`, defined in Phase 4, unused until now) get created — one `Charge` per test, one per panel (covering all its members, not one per member). A `LabPanel` expands into one `LabOrderTest` per member test at assignment time, each independently resulted and verified, since a panel like CBC produces several distinct results with different reference ranges, not one combined value.

`Specimen` is its own table (one specimen commonly services several `LabOrderTest` lines from one physical draw), with its own pending → collected → received → rejected lifecycle. `LabOrderTest.unit`/reference range are snapshotted from the catalog at **result-entry time**, not order-assignment time, since that's the actual clinical-interpretation moment — a later catalog edit never rewrites an already-entered result's context, the same discipline as `InvoiceLine`'s snapshot fields. `abnormalFlag` is always computed server-side from the entered value against the snapshotted range, never client-submitted.

`lab_result.enter` vs `lab_result.verify` are distinct permissions (segregation of duties, reserved since Phase 1's permission catalog, actually exercised for the first time this phase). Verifying the last outstanding `LabOrderTest` on an order rolls `ClinicalOrder.status` to `completed` and fires `LabResultFinalized` — reserved in this file's event table since Phase 2, wired for real only now (§15).

## 10. Pharmacy (PIS) Workflow

```
Doctor Order (Prescription + PrescriptionItem, free-text intent, Phase 3)
 → Create DispensingRecord (structured, catalog-referenced, quantity, Phase 9)
 → Verify → Dispense (Inventory Reduction → Billing → Patient Medication History, one transaction)
 → [optional] Return (correcting record, stock added back — never edits the original dispensing)
```

**Status: implemented in Phase 9** (`src/lib/domains/pharmacy/*`). The identical two-stage model Phase 8 built for lab orders, deliberately reused rather than reinvented: the doctor's Phase 3 `Prescription`/`PrescriptionItem` (free-text `medicationName`) captures clinical intent only and is left completely untouched; pharmacy staff then create one or more structured `DispensingRecord` rows against a catalog `Medication` per prescription item, supporting partial fills across visits (remaining-to-dispense always derived live by summing `quantityDispensed` across non-cancelled records, never a stored counter).

`Medication` is a 1:1 companion to `Product` (`productId` UNIQUE FK), not a parallel item master — stock, batches, expiry, and cost are all inherited from the existing Phase 5 inventory machinery wholesale, the same "extend, don't duplicate" precedent `CommissionRule` set for `Product` in Phase 7.

`prescription.verify` vs `prescription.dispense` are distinct permissions (segregation of duties, the same enter/verify pattern as `lab_result.enter`/`verify`). Dispensing itself (`dispenseRecord()`) does inventory reduction, billing, and patient medication history update **all in one transaction**, matching spec.md §29's named ordering exactly: `consumeStock()` (Phase 5, extended with an optional `transactionType: "dispensing"` parameter rather than a second consumption function) walks FEFO batches; `generateSystemCharge()` bills through the same chokepoint every other automatic charge uses (`sourceType: "pharmacy"`, defined in Phase 4, unused until now); `PatientMedicationHistory` is updated to `current`. A stock shortfall rolls back the whole transaction, not just the stock step — the same discipline as Phase 5's over-consumption guard.

Returns (`DispensingReturn`) are correcting records, never edits to the original `DispensingRecord` — adds stock back via a `return` ledger entry, rejects returning more than net-outstanding (dispensed minus prior returns), and never touches the original `Charge`.

The pharmacy-disable capability spec.md §29 explicitly requires ("architecture must allow pharmacy to be disabled for clinics that do not operate one") is implemented by finally wiring up the generic `Setting` table (`src/lib/platform/settings.ts`) — reserved in the schema since Phase 1, never consumed by any domain until now — rather than a new ad-hoc flag mechanism. Every dispensing action checks `isPharmacyEnabled()`; the medication catalog and queue remain viewable regardless.

## 11. Radiology (RIS) Workflow

```
Doctor Order (ClinicalOrder + ImagingOrderDetail, free-text intent, Phase 3)
 → Assign Imaging Service (structured, catalog-referenced ImagingOrder + Charge generated, Phase 10)
 → Scheduling → Imaging Performed → Radiologist Report → Result Verification → Patient EMR
```

**Status: implemented in Phase 10** (`src/lib/domains/radiology/*`). The identical doctor-intent-vs-structured-execution split §9 (LIS) and §10 (Pharmacy) both already established, reused a third time: the doctor's Phase 3 CPOE imaging order captures intent only (free-text `imagingType`/`bodyPart`) and is left completely untouched; radiology staff "assign" a catalog `ImagingService` against it, which is the point a structured, billable `ImagingOrder` and its `Charge` (`sourceType: "imaging"`, defined in Phase 4, unused until now) get created.

Unlike Lab (one order can fan out into several `LabOrderTest` rows via panels), `ImagingOrder` is a genuine 1:1 with its `ClinicalOrder` — a real doctor orders one imaging study per CPOE order, never a bundle the way "CBC, lytes" bundles lab analytes. No separate `imaging_report` table either — report fields (`reportText`, `impression`) live directly on `ImagingOrder`, the same "no separate lab_result table" precedent §9 set for `lab_order_test`.

Five-stage status flow matching spec.md §30's named workflow exactly: `ordered → scheduled → performed → reported → verified` (+`cancelled`). `imaging_order.perform` gates assignment through report-writing (the entire technologist+radiologist side); `imaging_result.verify` is a distinct final-verification permission (segregation of duties, the same pattern as `lab_result.enter`/`verify` and `prescription.dispense`/`verify`). Verifying an `ImagingOrder` always rolls its parent `ClinicalOrder` to `completed` and fires `ImagingResultFinalized` — no sibling check needed, since the relationship is 1:1.

`ImagingOrder.accessionNumber`/`externalImageUrl` are the PACS integration surface spec.md §30 explicitly asks to prepare ("do not attempt to build a PACS from scratch") — populated by a real future integration, unused today. Scheduling (`scheduledAt`/optional `roomId`) is informational only, not a hard double-booking constraint — imaging studies are not modeled as `Appointment`s and don't participate in Phase 2's booking-conflict exclusion constraint.

## 12. Payors & Insurance / Claims Workflow

```
Payor → Insurance Plan → Policy → Patient Coverage (spec.md §38)
Eligibility → Authorization → Treatment → Claim → Submission (via adapter)
 → Adjudication → Remittance (ordinary insurance-tender Payment) → Rejection → Resubmission
```

**Status: implemented in Phase 11** (`src/lib/domains/claims/*` — one domain folder, not the two, "payors" and "claims", speculatively sketched in §2 before this phase; Payor/Plan/Policy/Coverage/Authorization/Claim are tightly coupled enough — every Claim references a PatientCoverage and a Payor directly — that splitting them into two folders would have meant a circular cross-domain dependency for no real isolation benefit). Self-pay needs zero rows in any of these tables — every field this phase adds to `Invoice` is nullable, and spec.md §38's "self-pay patients should work without insurance configuration" holds literally.

Eligibility and Authorization are real checks/records, not live payor API calls — `checkEligibility()` validates a `PatientCoverage`'s own status/dates; `PriorAuthorization` records what a real clinic does today (call/fax/portal the payor, then record the answer), not a simulated live pre-auth response. Both are the extensible seam spec.md §39's "eligibility architecture" language asks for, not full real-time verification (spec.md §92 forbids faking an integration that doesn't exist).

Claims follow spec.md §39's exact named lifecycle: `draft → submitted → adjudicated/rejected → remitted`. Submission goes through a real `ClaimSubmissionAdapter` interface with exactly one honest implementation today (`ManualSubmissionAdapter` — no live clearinghouse connected, records that submission happened externally rather than faking a response), the seam spec.md §39's "create adapters for future country-specific integrations" asks for. Rejection → Resubmission creates a **new** `Claim` row (`resubmissionOfId` self-relation) rather than editing the rejected original — the same "never overwrite a finalized/historical record" discipline as `Appointment.rescheduledFromId` (Phase 2) and `ClinicalNote` amendments (§4).

Remittance is recorded as an ordinary insurance-tender `Payment` (spec.md §35 already named "Insurance" as a payment method in Phase 4) — `recordRemittance()` reuses the exact same `PaymentReceived` posting/commission pipeline every other payment goes through (§6), rather than a second, parallel remittance ledger. It deliberately bypasses the cashier-session requirement `recordPayment()` (POS) enforces, since a remittance arrives via bank/EFT reconciliation, not a physical register.

`Invoice` gained `payorId`/`patientCoverageId` and `estimated`/`final` `PatientResponsibility`/`PayorResponsibility` (all nullable) — the insurance path §5 named as deferred back in Phase 4. `estimated*` is computed at invoice-issue time from the coverage's copay; `final*` is set once, separately, at remittance time — never an in-place edit of the estimate. This is invoice-level informational data, not a GL sub-ledger split: `postInvoiceIssued()` (§6) is unchanged, still posting one combined `Dr AR / Cr Revenue+Tax+Unearned` regardless of payor.

## 13. Patient Engagement Workflow

```
Communication engine: CommTemplate (8 seeded, spec.md §56) -> sendMessage() -> CommunicationAdapter (sms/whatsapp/email) -> CommMessage (history)
Patient Portal: PatientPortalAccount/PatientPortalSession (separate auth context, spec.md §57) -> release-rule-gated read views
Online Booking: Branch -> Specialty -> Provider -> Service -> Date -> Slot -> Patient Details -> Confirmation (spec.md §58, public, no auth)
```

**Status: implemented in Phase 12** (`src/lib/domains/communications/*`, `src/lib/domains/portal/*`, `src/lib/domains/booking/*`, `src/lib/auth/portal-*`).

**Communication engine**: `CommTemplate` (org-wide catalog, seeded with all 8 spec.md §56-named templates) + `CommMessage` (append-only send history — spec.md §56's "maintain communication history"). `CommunicationAdapter` is a real, swappable interface — three implementations (`NullSmsAdapter`/`NullWhatsAppAdapter`/`NullEmailAdapter`), each honest that no live provider is connected, per spec.md §56's own explicit "do not fake successful external API delivery" (the same pattern §12's `ClaimSubmissionAdapter` already established, reused here for a second channel-style integration point). Two of the eight templates fire automatically off real domain events — `AppointmentBooked` (reserved since Phase 2, finally given a real subscriber) and a new `AppointmentCancelled` event — the rest are genuinely time/judgment-based triggers this modular monolith has no background job runner for (§15's "no unnecessary distributed infrastructure" holds), so three (Reminder/Payment reminder/Birthday) got a real, one-click, data-driven manual-send hub instead of a fake scheduler.

**Patient Portal**: `PatientPortalAccount`/`PatientPortalSession` are structurally identical to staff `User`/`Session` (same lockout fields, same session TTL) but genuinely separate tables and a separate cookie (`his_portal_session`) — proxy.ts branches into three route classes (public / portal-authenticated / staff-authenticated). Staff-provisioned (`enablePortalAccess()`), not patient self-registration. "Clinical information must only become patient-visible according to configurable release rules" (spec.md §57) is a real, working org-wide `Setting` (`portal_clinical_release_enabled`, default off, reusing Phase 9's Setting machinery) gating prescriptions/lab-results/imaging-results as a whole — a deliberately simple v1 of "configurable," not a per-record release workflow.

**Online Booking**: `/book` is fully public (no auth, in proxy.ts's public-path list). `BookingSource.online` — defined in the schema since Phase 2, unused until now — tags every completed public booking. Slot computation is real (walks `ProviderSchedule` working hours minus conflicting `Appointment`s/`ProviderLeaveBlock`s); "prevent slot race conditions" (spec.md §58) is enforced by the *same* DB exclusion constraint Phase 2 already built and verified live (see DATABASE.md), reused via exported `translateBookingError`/`assertNoLeaveConflict` helpers rather than re-implemented. Patient matching is exact-mobile-number-only (simpler than staff registration's fuzzy duplicate-detection dialog, since no human is in this loop to resolve a "maybe" match). A simple per-mobile-per-24h count satisfies SECURITY.md's own pre-committed "Phase 12" public-endpoint rate-limiting note.

**Deliberately not built this phase**: Lead CRM (spec.md §59) — not named in spec.md's actual numbered Phase 12 "Implement" list, despite an earlier speculative forward-schema grouping; a live SMS/WhatsApp/Email provider connection; portal self-service password reset; a portal-specific login-history table; IP-based rate limiting or CAPTCHA on `/book`.

## 14. Folder Structure

See BLUEPRINT.md §29 — unchanged, reproduced in the repo root as the project scaffolds in Phase 1.

## 15. Domain Event / Outbox Architecture

`outbox_event` row written in the same transaction as the state change (`writeOutboxEvent`, `src/lib/platform/outbox.ts`). Dispatch is **not** a timer-driven background poller as originally sketched — it's `dispatchPendingOutboxEvents(organizationId)` called immediately after the writing transaction commits, from the same service function (see `patients/service.ts` and `appointments/service.ts`). This is still "transactional outbox" in effect (the write is durable and atomic with the state change; a handler failure doesn't roll back the state change, it just leaves the event `pending` for the next dispatch call to retry) — a true timer/queue-driven poller is deferred until multiple app instances actually need shared dispatch, consistent with §73's "no unnecessary distributed infrastructure." Event list is fixed to what spec.md §73/§93 names explicitly — no speculative additions. Current registered events (`src/lib/platform/event-handlers.ts`, grows per phase):

| Event | Phase introduced | Handlers |
|---|---|---|
| `PatientRegistered` | 2 | registered, no-op (comms welcome message is Phase 12) |
| `AppointmentBooked` | 2 | **live** (Phase 12): sends the "Appointment confirmation" template via `sendMessage()` (spec.md §56) |
| `AppointmentCancelled` | 12 | **live**: sends the "Cancellation" template via `sendMessage()` (spec.md §56) |
| `AppointmentCheckedIn` | 2 | **live**: creates a "Patient waiting" `Notification` for the provider's linked user (spec.md §64) |
| `EncounterFinalized` | 3 | registered, no-op (no current subscriber — a future compliance/audit hook is the plausible one; billing hooks off `EncounterCompleted` instead, see below) |
| `EncounterCompleted` | 4 | **live**: generates the "Consultation" `Charge` (spec.md §73's own named example; matches the Core End-to-End Test's §85 ordering) |
| `InvoiceIssued` | 4 | **live** (Phase 6): posts `Dr AR / Cr Revenue (+Unearned Revenue for package lines) (+Tax Payable)` via `postInvoiceIssued` |
| `PaymentReceived` | 4 | **live** (Phase 6): posts one `Dr [tender account]` line per tender, `Cr AR` for the total, via `postPaymentReceived` (patient statement remains a Phase 12 subscriber) |
| `RefundCompleted` | 4 | **live** (Phase 6): posts `Dr Revenue / Cr [refunded tender's account]` via `postRefundCompleted` |
| `GoodsReceiptCompleted` | 6 | **live**: posts `Dr Inventory / Cr AP` via `postGoodsReceiptCompleted` |
| `SupplierPaymentRecorded` | 6 | **live**: posts `Dr AP / Cr [paying tender's account]` via `postSupplierPaymentRecorded` |
| `PackageSessionConsumed` | 6 | **live**: posts pro-rata `Dr Unearned Revenue / Cr Revenue` via `postPackageSessionConsumed` |
| `LabResultFinalized` | 8 | **live**: creates a "Lab results ready" `Notification` for the ordering provider's linked user, if any (spec.md §64/§85); Patient 360's Lab Results tab reads verified rows live, no separate timeline write needed |
| `ImagingResultFinalized` | 10 | **live**: creates an "Imaging results ready" `Notification` for the ordering provider's linked user, if any — the identical shape as `LabResultFinalized`; Patient 360's Imaging tab reads verified rows live |
| `ProcedureCompleted` | 8/9/10 | billing, inventory, commission, timeline (procedure charges are ad-hoc/manual at POS until a real completion event exists for each support system) |
| `InventoryLow` | 5 | notification |
| `EmployeeLeaveApproved` | 7 | **live**: creates a `ProviderLeaveBlock` for the employee's linked Provider, if any (spec.md §51 — "doctor leave must affect scheduling") |

## 16. Permission Enforcement Chokepoint

Single function `can(session, permission, { branchId?, resourceOwnerId? })` in `/lib/platform/permissions-core.ts`. Called at three layers: middleware (route-level default-deny), service layer (business-rule-level), and query-projection layer (field-level — reception's `patient.view` excludes clinical-note fields per BLUEPRINT.md's Security Risks correction on field-level scoping). No layer trusts the layer above it.

## 17. Analytics Workflow

```
Dashboards: session permissions -> visibleDashboardSections() -> {Management,Reception,Doctor,Finance} sections (spec.md §8, /dashboard)
Reports: session permissions -> canViewReportCategory() -> {Practice,Clinical,Financial,Revenue Cycle,Inventory,HR,Assets} tabs (spec.md §65, /reports)
KPIs: getKpiTrends() -> 6-month bucketed trend -> CSS bar charts (spec.md §65, /analytics)
Exports: reports.export permission -> GET /api/reports/export?category=...&from=...&to=... -> CSV
```

**Status: implemented in Phase 13** (`src/lib/domains/analytics/*`, `src/app/(dashboard)/dashboard`, `src/app/(dashboard)/reports`, `src/app/(dashboard)/analytics`, `src/app/api/reports/export`).

**No new tables, no new permissions** — every dashboard tile, report row, and KPI point is a live query against a table another domain already owns (Appointment, Invoice, Payment, Encounter, Diagnosis, ClinicalOrder, Claim, StockLedgerEntry, AttendanceRecord, LeaveRequest, PayrollRun, CommissionAccrual, Asset, MaintenanceRecord, CalibrationRecord — see §2's domain map for who owns what), gated by the existing view permission that domain already checks (`appointment.view`, `encounter.view`, `accounting.view`, `invoice.view`/`claim.create`, `inventory.view`, `payroll.view`) rather than a parallel `report.view`/`dashboard.view` permission invented to match. The Management Dashboard section is the one exception worth naming: it reuses `reports.export` (already scoped to exactly the management-tier roles) as its visibility gate, not because it exports anything, but because that permission already encodes "this role sees cross-cutting operational summaries."

**Dashboards are sections on one page, not one page per role** — `visibleDashboardSections()` checks the four section-gating permissions independently and a user sees every section they qualify for (a Clinic Manager, holding both `reports.export` and `accounting.view`, sees Management *and* Finance). The Doctor section is gated differently from the other three — not a permission at all, but whether the signed-in `User` has a linked `Provider` row (`Provider.userId`, reserved since Phase 2 for exactly this purpose per its own doc comment) — since "my schedule, my patients" is an identity question, not a permission question.

**Reports reuse rather than reimplement wherever a function already exists**: the Financial category's P&L/Balance Sheet/Cash Flow are `accounting/reports.ts`'s own Phase 6 functions, called directly, not reimplemented against `journal_line` a second time (API.md §1's "no business rule is ever implemented twice for the same operation"). Where no aggregate existed yet (Practice's provider/room utilization, Clinical's diagnosis trends, HR's attendance/leave/commission rollups, Assets' register/maintenance/calibration summaries), Phase 13 wrote new, real aggregate queries directly in `analytics/reports/*.ts` — reports are inherently a new aggregation layer over existing data, not something every domain was expected to pre-build for itself.

**CSV export is this codebase's first real `/api/*` Route Handler** — every prior phase's mutations went through Server Actions; a file download needs a browser-navigable URL with real `Content-Disposition`/`Content-Type` headers, which a Server Action can't produce. `src/app/api/reports/export/route.ts` sits behind the same staff `proxy.ts` session check as every other non-public route (no new route class was needed) and independently re-checks both `reports.export` and the specific category's view permission — the same "service layer never trusts the layer above it" discipline as everywhere else (§16).

**No charting library** — `/analytics`'s six trend charts are plain CSS bars (height as a percentage of the period's max value), not a Recharts/Chart.js dependency. Consistent with this build's standing "no unnecessary complexity" discipline (§15's "no unnecessary distributed infrastructure," §13's "no fake scheduler") — six simple monthly bars don't need a charting library, though a future need for richer visualization (multi-series, zoom, tooltips) would be a legitimate reason to add one.

**Deliberately not built this phase**: Global Search (spec.md §66) and the master-data bulk Import/Export workflow (spec.md §83) — neither is named in spec.md's literal numbered Phase 13 "Implement" list (Dashboards/Reports/KPIs/Exports), the same "follow the literal phase directive" discipline Phase 12 applied to Lead CRM (§13).

## Status

Phase 0 architecture artifacts complete. Phase 1 (Platform Foundation) through Phase 14 (Hardening) implemented and verified (see PROJECT_STATUS.md) — the full spec.md build plan. Phase 2 corrected a systemic schema bug (naive `TIMESTAMP` instead of `TIMESTAMPTZ` — see DATABASE.md §"Conventions") and confirmed the proxy.ts authoritative-session design described in §16 works as intended under Next.js 16's Node-runtime Proxy. Phase 3 exercised the note-amendment/versioning pattern described in §4 end-to-end for the first time and found a real gap in it (a note amended after its encounter is finalized must itself be born `finalized`, not the schema default `draft` — fixed in `notes.ts`); it also generalized the Decimal-serialization fix flagged as a recurring risk during Phase 2 into the reusable `serializeDecimals()` utility rather than patching call sites a third time. Phase 4 delivered §5's Charge → Invoice → Payment chain in full (Accounting Journal deliberately deferred to Phase 6, its named subscriber), corrected its own predecessor's event-naming mismatch (billing hooks off the spec-named `EncounterCompleted`, not the Phase-3-invented `EncounterFinalized`), and caught a genuine RSC-boundary violation (a Server Component passing an inline closure — not a bare Server Action reference — into a Client Component prop) on first use rather than shipping it silently broken. Phase 5 delivered §7's full inventory/procurement chain, connected automatic clinical consumption to the billing engine rather than reopening Phase 3/4 decisions to wire it through CPOE, and verified the insufficient-stock path actually rolls back a Charge transactionally rather than merely rejecting the consumption step in isolation. Phase 6 delivered §6's Central Accounting Posting Service in full — every revenue-cycle and procurement event named as a Phase 4/5 "deferred to Phase 6" placeholder in this file now posts a real, DB-trigger-enforced-balanced journal, closing out the last major deferred-accounting gap this document has carried since Phase 4. Phase 7 delivered §8's HR/Payroll/Assets chain, wired up two dormant Phase 2 placeholders for real (`Provider.employeeId`, sitting unused since Phase 2; the `EmployeeLeaveApproved` event, reserved in this file's table since Phase 2 but never fired), extended the central posting service with Payroll's own named example from spec.md §55, and caught a real gap of its own before it could quietly undermine the phase's own deliverable — `createAdHocCharge` had no `providerId` field at all, which would have made every POS-entered charge (as opposed to system-generated consultation charges) unattributable to a provider and Provider Commissions silently inert for them. Phase 8 delivered §9's LIS chain, wired up a third dormant Phase 2 placeholder for real (`LabResultFinalized`, reserved in this file's table since Phase 2 but never fired), extended the billing engine to a new source type (`lab`, defined in Phase 4, unused until now) without touching Phase 3's CPOE lab-order dialog at all — the doctor's free-text order intent and the lab's structured, billable execution are deliberately two different tables. Phase 9 delivered §10's Pharmacy (PIS) chain, extended the billing engine to a fourth source type (`pharmacy`, defined in Phase 4, unused until now), and finally wired up the generic `Setting` table (reserved since Phase 1, never consumed by any domain until now) for spec.md §29's explicit pharmacy-disable requirement — the first real settings-driven feature flag in this codebase. **Phase 10 delivered §11's RIS chain**, extended the billing engine to a fifth source type (`imaging`, defined in Phase 4, unused until now), and reused the doctor-intent-vs-structured-execution split a third consecutive time — while also correctly departing from it where the underlying reality genuinely differs (`ImagingOrder` is a real 1:1 with its `ClinicalOrder`, not a fan-out the way `LabOrderTest` is, because one imaging CPOE order never bundles several studies the way a free-text lab order can bundle several analytes). Three phases running the identical core pattern, each with the judgment to diverge from it exactly where the domain's real-world shape demands it rather than forcing consistency for its own sake, is itself evidence this is a genuine architectural convention, not a one-off. **Phase 11 delivered §12's Payors & Insurance / Claims chain**, closing out the last of the revenue-cycle placeholders §5 has carried since Phase 4 (the insurance path), extended the billing engine's payment side to genuinely exercise the `insurance` tender for the first time since it was defined in Phase 4 — and in doing so, caught a real, previously-latent accounting bug: the `insurance` tender's account mapping collapsed to the same account as `accounts_receivable`, meaning every insurance remittance would have posted a self-canceling no-op entry the first time anyone actually recorded one. Fixed in both the seed default and the one already-seeded row (see PROJECT_STATUS.md). Also built this codebase's first true adapter-pattern seam (`ClaimSubmissionAdapter`) for a real, spec-named future integration point, and merged the domain map's two speculative "payors"/"claims" folders into one, once building the real thing showed how tightly coupled they actually are. **Phase 12 delivered §13's Patient Engagement chain**, reused the Phase 11 adapter-pattern seam a second time (`CommunicationAdapter`, three honest Null implementations for spec.md §56's own explicit "do not fake successful external API delivery"), finally wired up `AppointmentBooked` — reserved in this file's table since Phase 2, the fourth dormant Phase 2 placeholder given a real subscriber across this build (after `Provider.employeeId`, `EmployeeLeaveApproved`, and `LabResultFinalized`) — and stood up this codebase's *second* genuinely separate authentication context (`PatientPortalAccount`/`PatientPortalSession`, distinct cookie, distinct proxy.ts route branch), the first time this document's single-auth-context assumption implicit since Phase 1 needed to become two. Also delivered spec.md §58's public Online Booking flow by direct reuse of §3's Phase-2-built race-condition-prevention constraint rather than a parallel mechanism, and made a deliberate, spec-literal scope call to leave Lead CRM (spec.md §59) unbuilt despite an earlier speculative forward-schema note suggesting otherwise — spec.md's own numbered phase list is the authority this build follows, not an earlier planning artifact. **Phase 13 delivered §17's Analytics chain** — the first phase to add zero new tables and zero new permissions, reading every existing domain's tables directly instead — replaced the Phase 1 dashboard placeholder with four real, permission-gated sections, built a seven-category Reports hub reusing Phase 6's financial-statement functions verbatim rather than reimplementing them, and gave `reports.export` (seeded since Phase 1, never checked by real code until now) its first real consumer via this codebase's first genuine `/api/*` Route Handler. Continued the same "follow the literal numbered phase list" discipline Phase 12 established for Lead CRM, this time for Global Search (spec.md §66) and the master-data Import/Export workflow (spec.md §83) — both real, spec-described features, neither named in Phase 13's actual Implement list. **Phase 14 — Hardening, the last phase in spec.md's roadmap** — added no new domain (a review-and-fix phase, not a feature phase, so no new numbered workflow section here): a real `vitest` unit/integration test suite (46 unit tests against genuinely pure functions, 5 integration tests against the real database's own constraints — the DEFERRABLE journal-balance trigger from §6 and the Phase 2 appointment exclusion constraint (see DATABASE.md), both now permanent and repeatable instead of re-verified by hand each phase), two pure-function extractions specifically for testability (`computeInvoicePostingSplit` out of §6's `postInvoiceIssued`, `allocateFefo` out of §7's `consumeStock`), `writeClinicalAccessLog` finally wired to 3 real clinical-read call sites after 11+ phases with zero callers, 34 targeted database indexes added after a real `pg_constraint`/`pg_index` review (not a blind pass), Next.js error/not-found boundaries added where none existed before (validated live against a genuine transient Supabase pooler connection error, not just by inspection), and DEPLOYMENT.md fully corrected against what was actually built rather than what Phase 0 speculatively planned. One real limitation found and documented rather than silently worked around: this deployment has no separate low-privileged database role to apply SECURITY.md's own pre-committed audit-table privilege hardening to — the concrete fix is written down in DEPLOYMENT.md, not executed, since it means rotating live credentials. §15's event table and §2's domain map will keep growing as any future phase lands a new domain.
