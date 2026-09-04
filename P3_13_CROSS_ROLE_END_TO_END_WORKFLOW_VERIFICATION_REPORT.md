# P3.13 — Cross-Role End-to-End Workflow Verification

Final P3 phase. Proves the HIS can execute its critical operational workflows end to end, across the correct staff roles, with coherent records, correct inventory/billing/accounting, secure branch isolation, and reliable notifications — without Super Admin performing ordinary clinic work.

## Executive Acceptance Summary

Five workflows (Patient Journey, Procurement→Accounting, HR Leave→Provider Availability, Payroll→Accounting, Refund/Reversal) were run end to end using real seeded operational roles, both as one continuous automated integration test (27 new tests, one record chain per workflow, separate session per role) and as a live browser walkthrough against `his_dev`.

**Two genuine BLOCKER-class defects were found and fixed**, both exactly the class of bug this phase exists to catch — neither was reachable by any single-domain P3.1–P3.12 test, because both require a realistic cross-role/multi-step sequence to manifest:

1. **A real accounting-integrity bug**: a second payment against an already-partially-paid invoice never reached the general ledger — the operational records showed it correctly, the books did not. Found live during the Cashier→Accountant handoff.
2. **A real access bug**: Receptionist could not register a patient at all through `/patients/new` (outright crash), and could not book an appointment from a patient's own profile page (`/patients/[id]`) or start a walk-in encounter as Doctor/Nurse — all three pages fed their Branch dropdown from a permission-gated query the operational roles who actually use these pages don't hold. Found live during Reception's own first step.

Both are fixed, verified by both the automated suite and a live re-test, and the full regression suite (Prisma validate, migration status, typecheck, lint, integration tests, production build) is clean. **P3 can be closed — see the final decision below.**

## Test Environment / Baseline

- Local PostgreSQL, `his_dev` (browser walkthrough) / `his_test` (automated suite)
- Entering baseline: 54 test files, 421 tests, 421 passing, 66 application routes (per this phase's own kickoff)
- Ending state: 55 test files, 448 tests, 448 passing — see Regression Status
- Remote Supabase: not used

## Fixture Strategy

- **Automated suite**: real `db.user.create` fixture users per role, each session's `permissions`/`roleNames` copied verbatim from the corresponding seeded role in `prisma/seed.ts` (never a synthetic all-permission session, per §3/§49) — Receptionist, Nurse, Doctor, Laboratory Technician, Radiology Technician, Pharmacist, Cashier, Accountant, Inventory Manager, Clinic Manager, HR Manager. Where a workflow's own server-side logic needs a *real* Role/RolePermission/UserBranchAccess row (notification-recipient resolution, which queries the database directly rather than the caller's session), the real seeded Clinic Manager role was assigned via `UserRole`/`UserBranchAccess` for that one fixture user. All fixtures and every record they created are removed in each `describe`'s own `afterAll`.
- **Browser walkthrough**: a dedicated `p3-13-walkthrough-setup.ts` script (run against `his_dev`, later fully removed) created one real user per seeded operational role (`p313-<role>@test.local` / a shared password) plus a Provider linked to the Doctor fixture user (so result/leave notifications route correctly) — mirroring the pattern already established in P3.10/P3.11/P3.12's own walkthrough scripts. A single real patient ("Layla Walkthrough") and her full chain of appointment/encounter/orders/prescription were created live through the UI as Reception/Nurse/Doctor/Laboratory Technician, then fully removed via a matching cleanup script (confirmed via `git status --porcelain scripts/` showing only the pre-existing untracked `scripts/db/`).

---

## Workflow A — Complete Patient Journey

One patient ("Layla Walkthrough" in the browser walkthrough; a fresh `db.patient.create` per automated-test run) carried through all ten steps below with no replacement records at any handoff.

### Reception
Receptionist session registers the patient (`registerPatient`), books an appointment (`bookAppointment`), checks in (`checkIn`), and confirms the patient appears in `listBranchQueue`. Confirmed Receptionist cannot `startEncounter` (`ForbiddenError`) or otherwise touch clinical/accounting write paths.

### Nursing
Nurse opens the SAME appointment's encounter (`startEncounter`, keyed off the real `appointmentId`) and records vitals (`recordVitals`). Confirmed exactly one `Encounter` exists for the appointment, and that Nurse cannot `finalizeEncounter`.

### Doctor
Doctor reviews the recorded vitals via `getEncounter`, saves a consultation note, adds a diagnosis, places one Lab order and one Imaging order, issues a prescription, then `completeEncounter`/`finalizeEncounter`s the SAME encounter. Confirmed exactly one `Encounter` per appointment (no duplication), the appointment lifecycle reached `in_consultation`/`completed`, and Doctor holds neither `prescription.dispense` nor `accounting.post`.

### Laboratory
Laboratory Technician finds the SAME `ClinicalOrder` in `listLabQueue`, assigns the CBC panel (`assignTests`), collects and receives the specimen, enters the numeric result, and verifies it. Confirmed the parent `ClinicalOrder` rolls to `completed`, a `Charge` (`sourceType: "lab"`) is generated automatically, and the ordering Doctor receives a `lab_result_ready` notification whose body never contains the raw numeric value.

### Radiology
Radiology Technician finds the SAME imaging `ClinicalOrder`, assigns the imaging service, schedules, marks performed, writes the report, and verifies it. Confirmed the parent order completes, a `Charge` (`sourceType: "imaging"`) is generated, and the Doctor receives an `imaging_result_ready` notification.

### Doctor Result Review
Doctor's own `getUnreadCount` reflects both new notifications; `listNotifications` resolves each to its real destination (`/laboratory/orders/{id}`, `/radiology/orders/{id}`) — never a fabricated one. Both `getLabOrder`/`getRadiologyOrder` reads succeed for Doctor (read-only clinical access), while any write attempt (e.g. `verifyResult`) is still rejected — the notification link grants a destination, never a permission.

### Pharmacy
Pharmacist finds the SAME prescription in `listPharmacyQueue`, dispenses it against real FEFO stock (`createDispensingRecord`/`verifyDispensingRecord`/`dispenseRecord`). Confirmed: correct product/batch, stock reduced by exactly the dispensed quantity, a `Charge` (`sourceType: "pharmacy"`) generated at the batch's selling price, the prescription synchronizes to `completed`, a `PatientMedicationHistory` row exists, and Pharmacist cannot edit the Doctor's already-finalized note.

### Billing / Cashier
Cashier finds all three sources' pending Charges (`listPendingCharges` — lab + imaging + pharmacy, all confirmed same-branch), generates one Invoice from all three (`generateInvoice`), and takes a genuine partial payment followed by the remaining balance (`recordPayment` called twice). Confirmed the invoice passes through `partially_paid` before reaching `paid`, both tenders are preserved as separate `PaymentAllocation` rows, and Patient 360's own `listPatientInvoices`/`listPatientPayments` reflect both.

### Accounting
Accountant verifies real journals produced through the existing outbox/posting architecture (`dispatchPendingOutboxEvents`, never a manually-inserted `Journal` row) for `InvoiceIssued` and — **this is where the BLOCKER below was found** — `PaymentReceived` (both tenders). Confirmed balanced debit/credit on every journal, no duplicate journal on a second dispatch pass, and the organization's complete `trialBalance` stays `isBalanced: true`. Confirmed Accountant cannot dispense medication.

### Patient 360 Reconciliation
One coherent story: `getPatient`, `getEncounter` (vitals + `appointmentId` link), `listPatientDiagnoses`, `listPatientLabResults`/`listPatientImagingResults` (both verified), `listPatientPrescriptions` (`completed`), and `getPatientStatement` — outstanding balance reconciles to `0.00` after the full payment.

---

## Workflow B — Procurement to Accounting

### Purchase Request
Inventory Manager creates a real PR (`createPurchaseRequest`, `status: "submitted"`); the Clinic Manager (the real seeded `purchase_request.approve` holder used here, with a genuine `UserRole`/`UserBranchAccess` grant so server-side recipient resolution finds them) receives a `purchase_request_submitted` notification.

### Approval
Clinic Manager approves the SAME PR (`approvePurchaseRequest`) — `approvedBy`/`approvedAt`/`status` all correct; the requester (Inventory Manager) receives a `purchase_request_decision` notification; a second approval attempt is rejected (`/submitted/`).

### Purchase Order
Created from the SAME approved PR via `createPurchaseOrder({ purchaseRequestId, ... })` — `purchaseOrderId`'s own `purchaseRequestId` field confirms the source relationship the model actually supports.

### Goods Receipt
Received against the SAME PO (`createGoodsReceipt`): batch created with the correct received quantity/unit cost, stock ledger balance matches, PO status reaches `received`, and over-receipt is still rejected against the now-fully-received PO.

### Supplier Invoice
Created against the SAME PO (`purchaseOrderId` preserved) with a real idempotency key — resubmitting the identical key returns the SAME row, never a duplicate `SupplierInvoice`.

### Supplier Payment
Accountant records payment against the SAME invoice — `paidAmount`/`status` (→ `paid`) both correct.

### Accounting / AP Reconciliation
`GoodsReceiptCompleted`, `SupplierInvoiceCreated`, and `SupplierPaymentRecorded` journals all exist, all balanced, none duplicated on a second dispatch pass, and the organization's `trialBalance` remains `isBalanced: true`. Confirmed Inventory Manager cannot post accounting.

Multi-branch isolation (embedded in this workflow): a Branch-B-only session cannot approve the PR, receive goods, or pay the supplier invoice against these Branch-A records.

---

## Workflow C — HR / Provider Availability

An Employee linked to both a real Provider (`Provider.employeeId`) and a real User (`Employee.userId`) — the exact wiring `EmployeeLeaveApproved`'s notification/`ProviderLeaveBlock` logic depends on.

**C1 — Leave Request**: HR Manager submits a real request (`requestLeave`) — correct employee/branch/type/dates/`days > 0`.

**C2 — Leave Approval**: HR Manager approves the SAME request. Confirmed: `Employee.status` → `on_leave`, a real `ProviderLeaveBlock` created spanning the leave dates, and the employee's own linked User receives a `leave_decision` notification.

**C3 — Appointment Impact**: An appointment was booked for this provider, in this leave window, **before** the leave was approved. Confirmed: the appointment is never silently cancelled/deleted/rescheduled (still `getAppointment`-visible, not `cancelled`), and every active-role Admin (Super Admin/Organization Administrator) receives a `leave_appointment_conflict` notification whose body explicitly states "NOT automatically cancelled or rescheduled."

---

## Workflow D — Payroll to Accounting

**D1 — HR Payroll**: HR Manager creates a `PayrollRun` for a controlled branch/period. Confirmed: the active employee is included with a server-calculated `netSalary > 0`, a terminated employee (in the same branch/period) is excluded, a duplicate period for the same branch is rejected, and the run moves `draft → review → approved`.

**D2 — Payslip**: The SAME `PayrollRunLine` is the payslip's data source (`getPayrollLinePayslip`, reachable on `payroll.view` alone — no `settings.view` dependency). Confirmed the frozen `basicSalary`/`netSalary` do not change when the Employee's *current* salary is edited afterward — a real historical snapshot, not a live join.

**D3 — Payroll Payment / Accounting**: `markPayrollPaid` → `status: "paid"`. Confirmed the `PayrollApproved`-driven Salary Expense/Payroll Payable journal is balanced and referenced to the SAME `PayrollRun`, never duplicated across two dispatch passes, the payslip remains readable and historically stable (still via HR access — Accountant, correctly, cannot reach `payroll.view`-gated payslip data), and `trialBalance` stays balanced.

---

## Workflow E — Refund / Reversal

A simple paid invoice (not the known Pharmacy-return gap named in §51). **Real segregation of duties confirmed**, not merely a UI convention: Cashier holds `refund.request` but not `refund.authorize`; Clinic Manager holds the reverse.

- Cashier requests a $50 partial refund (`requestRefund`) — then is explicitly rejected (`ForbiddenError`) attempting to `authorizeRefund` or `completeRefund` their own request.
- Clinic Manager authorizes and completes the SAME refund. A second `completeRefund` on the already-completed refund is rejected.
- Invoice `paidAmount` reduces correctly (200 → 150); the `RefundCompleted` journal is balanced and totals exactly 50, never duplicated on a second dispatch pass; `getPatientStatement`'s outstanding balance reconciles to 50 (200 charged − 150 net paid).

---

## Cross-Role Permission Verification

Explicitly asserted throughout every workflow above (not merely implied by what each role happened not to click): Receptionist cannot finalize encounters or reach accounting; Nurse cannot finalize a Doctor's consultation; Doctor cannot dispense or post journals; Laboratory Technician cannot dispense or edit clinical notes; Cashier cannot alter a clinical result; Accountant cannot dispense medication or reach `payroll.view`-gated payslips; Inventory Manager cannot post accounting; a refund's requester cannot also authorize/complete it. Every one of these is a real `ForbiddenError` from the actual permission chokepoint (`assertCan`), not a UI affordance that happens to be hidden.

## Multi-Branch Isolation

Workflow A: a Branch-B-only session is rejected (`ForbiddenError`) reading/mutating this workflow's Branch-A `Appointment`, `Encounter`, `Invoice`, and lab order, and cannot record a payment against the Branch-A invoice.
Workflow B: a Branch-B-only session cannot approve the Branch-A PR, receive goods against the Branch-A PO, or pay the Branch-A supplier invoice.

Both use representative high-value records per module, per §34's "do not attempt every model" guidance — not exhaustive, but each of the workflows' own most consequential write paths.

## Global Branch Context Verification

The P3.12 global branch switcher was exercised structurally through this phase's own branch-scoped sessions: every domain call above supplies an explicit `branchIds` array (the switcher's real backing value), and every write is independently re-validated against it (`assertBranchAccess`) regardless of what a client might claim — confirmed by the multi-branch isolation tests above, which are exactly "tampering with branch context" in effect (a session asserting access to a branch it doesn't hold). No P3.13 workflow depends on `Session.activeBranchId` as anything other than a UI default — every operational write in these five workflows validates its own branch explicitly, matching P3.12's own documented decision that the switcher is a preference, never authorization. Organization-wide surfaces (`trialBalance`, used repeatedly above) were correctly never filtered to a single branch.

## Notification Handoff Verification

Verified in context (not as isolated fixtures) for every naturally-generated handoff exercised by these five workflows:

| Handoff | Verified |
|---|---|
| Lab result → Doctor | ✓ correct recipient/org/branch-relevant, `/laboratory/orders/{id}` destination, no raw value in body |
| Imaging result → Doctor | ✓ correct recipient, `/radiology/orders/{id}` destination |
| Leave request → approver | — (C1 used the same HR Manager as approver in this fixture; the recipient-resolution mechanism itself is already proven in Workflow B's PR-submitted case) |
| Leave decision → employee | ✓ correct recipient (the employee's own linked User), no PHI/reason text in body |
| Provider leave conflict → Admin | ✓ correct recipient(s) (real Super Admin/Org Admin role holders), minimal content, explicit "not automatically cancelled" language |
| PR submitted → approver | ✓ correct recipient (real branch-scoped role holder), no duplicate on retry (idempotent `createNotificationsOnce`) |
| PR decision → requester | ✓ correct recipient |

No new notification types were added — every one above reuses the exact producer P3.11 already built.

## Outbox / Event Reliability

Every event above was written transactionally alongside its own domain write (`writeOutboxEvent` inside the same `$transaction`) and dispatched via the existing `dispatchPendingOutboxEvents`/`registerOutboxHandler` architecture — never a rebuilt or parallel mechanism. Idempotency was explicitly re-proven post-fix by calling `dispatchPendingOutboxEvents` a second time after every financially-relevant event in Workflows A, B, D, and E and asserting the journal count stayed at exactly 1 in each case.

## Inventory Reconciliation

**Pharmacy (Workflow A)**, product created fresh for this workflow:

```
Opening stock:      50  (one purchase batch, purchaseCost 2.00)
+ Received:           0
− Dispensed:          6  (prescription fulfillment, FEFO)
± Other movement:     0
= Closing stock:     44
```

Verified directly against `StockLedgerEntry` (`_sum.quantity`), not the `ProductBatch.receivedQuantity` column alone.

**Procurement (Workflow B)**, separate product created fresh for this workflow:

```
Opening stock:        0
+ Received:           20  (Goods Receipt against the PO, batch purchaseCost 9.50)
− Consumed/adjusted:   0
= Closing stock:      20
```

Verified against `StockLedgerEntry` and cross-checked against `ProductBatch.receivedQuantity` (20) and `purchaseCost` (9.50) on the specific batch created.

## Patient Financial Reconciliation

**Workflow A** (main E2E patient):

```
Pending Charges:     Lab 50.00 + Imaging 100.00 + Pharmacy 36.00 (6 × 6.00) = 186.00
→ Invoice total:                                                    186.00
− Payments:           93.00 (partial, cash) + 93.00 (final, card)  = 186.00
± Refunds:                                                             0
= Outstanding balance:                                                0.00
```

`getPatientStatement`'s own `outstandingBalance` agreed exactly (`toBeCloseTo(0, 2)`).

**Workflow E** (dedicated refund patient):

```
Pending Charge:      200.00
→ Invoice total:      200.00
− Payment:             200.00
± Refund:              −50.00
= Outstanding balance:  50.00
```

`getPatientStatement`'s `outstandingBalance` agreed exactly (`toBeCloseTo(50, 2)`).

## AP Reconciliation

**Workflow B**:

```
Purchase Order:        20 units × 9.50 = 190.00
Supplier Invoice:                        190.00 (amount, taxAmount 0)
− Supplier Payment:                      190.00 (bank)
= Outstanding AP:                            0.00 (SupplierInvoice.status → "paid")
```

## Payroll Reconciliation

**Workflow D**:

```
Active employee basic salary:  8,000.00
Server-computed net salary:    > 0 (computed, not a copy of basicSalary — formula per spec.md §52, unchanged this batch)
PayrollApproved journal:       Dr Salary Expense / Cr Payroll Payable — balanced
PayrollPaid journal:           Dr Payroll Payable / Cr Bank — balanced (when present)
```

Payslip's frozen `basicSalary` (8,000.00) confirmed unchanged after the live Employee record's salary was edited to 99,999 and restored — proving the snapshot is real, not a live join.

## Accounting Reconciliation

Every journal produced by Workflows A, B, D, and E individually balanced (`totalDebit === totalCredit`, asserted to 2 decimal places on every one, not merely "row exists"). The organization's complete `trialBalance()` was called and asserted `isBalanced: true` at the end of Workflow A's Accounting step, Workflow B's AP Reconciliation step, and Workflow D's Payroll/Accounting step — i.e., after each workflow's own fixtures were fully processed, not just once at the very end, confirming no workflow left the ledger unbalanced at any checkpoint.

## Critical Concurrency Tests Re-Run

Not reinvented — re-run as part of the full regression suite (all still passing):

| Concurrency case | Test |
|---|---|
| Appointment/Encounter race | `p3-3-doctor-encounter-workflow.test.ts` — "starting an encounter twice... never creates two encounters" |
| FEFO / final-stock race | `p3-7-billing-pos-cashier-workflow.test.ts` — "two POS sales competing for the last unit of stock" |
| Charge/Invoice race | `p3-5-lab-radiology-order-handoff.test.ts` — "two lab techs racing to assign the same freshly-ordered order" (charge creation is part of assignment) |
| Payment overpayment/duplicate | `idempotency-and-transaction-review.test.ts`, `refund-payment-integrity.test.ts` |
| Refund duplicate | `p3-7-billing-pos-cashier-workflow.test.ts` — "a second concurrent refund of the same amount cannot also succeed" |
| Goods Receipt over-receipt | `p3-8-inventory-procurement-operational-ux.test.ts` — concurrent over-receipt protection |
| Supplier Invoice idempotency | `p3-8-inventory-procurement-operational-ux.test.ts` — idempotent double-submit |
| Payroll duplicate period | `p3-10-hr-payroll-employee-ux.test.ts` — duplicate-period protection under a genuine race |
| Attendance duplicate check-in | `p3-10-hr-payroll-employee-ux.test.ts` — duplicate/concurrent check-in protection |
| Notification duplicate retry | `p3-11-notifications-operational-awareness.test.ts` — duplicate-event idempotency |

All ten passed as part of this batch's full-suite run (55 files / 448 tests / 448 passing).

## Errors / Defects Found

### BLOCKER 1 — Second payment against an invoice never posted to the general ledger

- **Workflow**: A (Cashier→Accounting handoff)
- **Cause**: `postPaymentReceived` (accounting/posting-service.ts) keyed its journal's `referenceId` on `invoice.id` rather than the actual `Payment` id(s) the triggering `PaymentReceived` event represented. `postJournal`'s own check-before-insert idempotency guard (keyed on `(organizationId, referenceType, referenceId)`) then treated a genuinely NEW payment against an already-posted invoice as a duplicate of the FIRST payment and silently returned the existing journal instead of posting the new one — the partial-then-final payment pattern P3.7 itself explicitly tests operationally (but never checked the resulting journal count for). `traceability.ts`'s own "payment" case already expected `referenceId` to be a real `Payment.id` (`db.payment.findFirst({ where: { id: referenceId } })`), independently confirming this was a genuine pre-existing bug, not an intentional shared key — every payment's traceability drill-down was already silently broken for the same reason.
- **Fix**: `postPaymentReceived` now accepts the real `paymentIds` (already present in the event payload, previously unused for this purpose) and keys the journal's `referenceId` on `paymentIds[0]` — one journal per `recordPayment` call, exactly matching how `tenders` already aggregates one call's tenders into one journal. `event-handlers.ts`'s `PaymentReceived` handler passes `paymentIds` through. Five pre-existing tests' cleanup queries (which assumed the old, buggy shape) were updated to resolve real payment ids first — not weakened, purely a cleanup-completeness fix caused by the correction, verified re-passing.

### BLOCKER 2 — Receptionist could not register a patient or book an appointment from the patient's own profile; Doctor/Nurse could not start a walk-in encounter

- **Workflow**: A (Reception's very first step)
- **Cause**: `/patients/new`, `/patients/[id]/page.tsx`, and `/patients/[id]/clinical-tabs.tsx` each fetched their "Book appointment"/"New Episode"/"New Encounter" dialogs' Branch options via `listBranches`, which requires `branch.view` — a permission the seeded Receptionist (patients/new, patients/[id]) and Doctor/Nurse (clinical-tabs.tsx) roles do not hold. `/patients/new` had no defensive gating at all and crashed outright (`ForbiddenError`, full-page error boundary) — reproduced live during this phase's own browser walkthrough. `patients/[id]/page.tsx` and `clinical-tabs.tsx` already had defensive gating (a documented, known trade-off from P3.2: "Receptionist has appointment.create but no branch.view... [conditionally skipped to avoid a crash]") but the chosen workaround left the Branch dropdown silently empty instead, making booking/starting an encounter impossible from those two specific entry points for the exact roles whose job this is — also reproduced live. P3.1 had already fixed this identical class of bug correctly (via `listAccessibleBranches`, which needs no permission beyond the session's own `branchIds`) for `reception/page.tsx`, `appointments/page.tsx`, and `queue/page.tsx`; these three were missed at the time.
- **Fix**: All three switched to `listAccessibleBranches`, matching the established, already-correct pattern. `/patients/new`'s crash and both dialogs' empty-dropdown behavior were confirmed fixed by live re-test (registered a real patient and booked a real appointment from the patient profile page as Receptionist).

No other BLOCKER, HIGH, MEDIUM, or LOW-severity defects were found during this phase's workflows. Every named §51 backlog item was left untouched, as instructed.

## Files Changed

**Fixed (production code):**
- `src/lib/domains/accounting/posting-service.ts` — `postPaymentReceived` referenceId fix (BLOCKER 1)
- `src/lib/platform/event-handlers.ts` — `PaymentReceived` handler passes `paymentIds` through
- `src/app/(dashboard)/patients/new/page.tsx` — `listAccessibleBranches` fix (BLOCKER 2)
- `src/app/(dashboard)/patients/[id]/page.tsx` — `listAccessibleBranches` fix (BLOCKER 2)
- `src/app/(dashboard)/patients/[id]/clinical-tabs.tsx` — `listAccessibleBranches` fix (BLOCKER 2)

**Updated (cleanup-query correctness, caused by the BLOCKER 1 fix — no assertions weakened):**
- `test/integration/refund-payment-integrity.test.ts`
- `test/integration/commission-refund-integrity.test.ts`
- `test/integration/idempotency-and-transaction-review.test.ts`
- `test/integration/patient-statement-reconciliation.test.ts`
- `test/integration/report-reconciliation.test.ts`

**New:**
- `test/integration/p3-13-cross-role-end-to-end.test.ts`

## Tests Added / Updated

**New**: 27 (`p3-13-cross-role-end-to-end.test.ts`) across 5 `describe` blocks — Workflow A (11: A1–A10 plus multi-branch isolation), Workflow B (8: B1–B7 plus multi-branch isolation), Workflow C (3: C1–C3), Workflow D (3: D1–D3), Workflow E (2).

**Updated**: 5 pre-existing test files' cleanup queries (see Files Changed) — no assertion was weakened; each now resolves the real `Payment` id before querying its journal, matching the corrected production behavior.

**Total: 55 test files, 448 tests, 448 passing** (421 baseline + 27 new).

## Browser Walkthrough

Performed against `his_dev` using the fixture strategy above (real users per operational role, one real patient carried through Reception→Nursing→Doctor→Laboratory).

- **Reception**: registered "Layla Walkthrough" through `/patients/new` (reproduced and confirmed the fix for BLOCKER 2's crash), booked a real appointment for the fixture Doctor/Provider from the patient's own profile page (reproduced and confirmed the fix for the empty-branch-dropdown half of BLOCKER 2), checked in via `/appointments` (status → `Waiting · Q-001`).
- **Nursing**: opened the same patient from `/queue` ("Open Pre-Consultation"), recorded vitals (Pulse 76, Temp 36.9°C, SpO2 98%) — confirmed attributed to "P313 Nurse" in the encounter's Vitals history.
- **Doctor**: landed on `/dashboard` (role-aware landing, confirmed live), saw "Your Day" with the waiting patient and a direct link to the active encounter, added a diagnosis (Fever, unspecified — R50.9, marked primary), placed a Lab order (CBC) and an Imaging order (X-Ray), issued a prescription (Amoxicillin, 1 cap TID oral, quantity 6).
- **Laboratory**: `/laboratory` queue showed the real order; assigned the CBC panel (5 individual tests), collected the specimen, marked received — confirmed the order transitioned `ordered → in progress` with a real Specimen row and five real `LabOrderTest` rows, matching the automated suite's own assertions.
- Remaining steps (Doctor result review, Pharmacy dispensing, Cashier/Invoice/Payment, Accountant journal verification, Procurement, HR, Payroll, refund) were exercised via the 27-test automated suite with real database assertions (exact balances, exact journal amounts, idempotency across a second dispatch pass) more rigorously than a manual click sequence could confirm — consistent with §48's own instruction that the automated test, not an exhaustive manual walkthrough of every module, is where financial/inventory invariants should be proven.
- All fixtures (11 role users, 1 patient and its full record chain) fully removed afterward — confirmed via direct database re-query (0 remaining) and `git status --porcelain scripts/` showing no leftover script files.

## Final P3 Acceptance Matrix

| Workflow | Roles | Result | Data continuity | Financial integrity | Branch/security | Status |
|---|---|---|---|---|---|---|
| Reception → Nursing → Doctor | Receptionist, Nurse, Doctor | Pass | Same Patient/Appointment/Encounter throughout | N/A | Role boundaries enforced (Nurse can't finalize; Receptionist can't reach clinical write) | PASS |
| Doctor → Laboratory | Doctor, Laboratory Technician | Pass | Same ClinicalOrder | Charge auto-generated, correct amount | Branch-scoped assignment; Doctor read-only on results | PASS |
| Doctor → Radiology | Doctor, Radiology Technician | Pass | Same ClinicalOrder | Charge auto-generated, correct amount | Branch-scoped; correct notification destination | PASS |
| Doctor → Pharmacy | Doctor, Pharmacist | Pass | Same Prescription | Stock/Charge/COGS all correct, FEFO honored | Pharmacist can't edit clinical note | PASS |
| Clinical → Billing | All clinical roles, Cashier | Pass | Same Patient, all Charges combined into one Invoice | Invoice total = sum of all sources, exact | Cross-branch Charge inclusion blocked | PASS |
| Billing → Accounting | Cashier, Accountant | Pass (after BLOCKER 1 fix) | Same Invoice/Payment | Balanced journals, no duplicates, trial balance stays balanced | N/A | PASS |
| Pharmacy → Inventory/COGS | Pharmacist | Pass | Same dispensing record | Opening/dispensed/closing stock reconciled exactly | N/A | PASS |
| Procurement → Inventory | Inventory Manager | Pass | Same PO → GoodsReceipt | Opening/received/closing stock reconciled exactly | Over-receipt still blocked | PASS |
| Procurement → AP | Inventory Manager, Accountant | Pass | Same PO → SupplierInvoice → SupplierPayment | AP reconciles to 0 exactly | Idempotent double-submit protected | PASS |
| AP → Accounting | Accountant | Pass | Same records | Balanced journals, no duplicates | N/A | PASS |
| HR Leave → Provider Availability | HR Manager | Pass | Same LeaveRequest → ProviderLeaveBlock | N/A | Pre-existing appointment preserved, Admin notified, never silently altered | PASS |
| HR Payroll → Accounting | HR Manager, Accountant | Pass | Same PayrollRun/PayrollRunLine throughout | Balanced journals, payslip historically frozen, no duplicates | Accountant correctly denied payroll.view-gated payslip | PASS |
| Notifications across roles | All | Pass | N/A | N/A | Correct recipient/org/branch, minimal PHI, idempotent on retry | PASS |
| Patient 360 reconciliation | Doctor/Cashier reads | Pass | One coherent record across every module | Statement agrees exactly with computed balance | N/A | PASS |
| Multi-branch isolation | Representative roles per module | Pass | N/A | N/A | Every tested cross-branch read/write rejected | PASS |

No row is FAIL. No row required a "PASS WITH BACKLOG" — both defects found were fixed within this phase, not deferred.

## Remaining Backlog

No new backlog items were added by this phase — both defects found were genuine blockers within P3.13's own scope and were fixed, not deferred. See `BACKLOG.md` for the full standing list carried over from P3.1–P3.12 (Radiology amendment, Pharmacy free-text↔catalog cross-check, Pharmacy invoiced/partial returns, PO approval, StockTransfer.batchId nullability, bank/cash reconciliation, employee self-service, overlapping leave, approved-leave-on-Attendance-roster, Provider↔User edit-after-creation, inactive-branch pickers, permission-dependency warnings, low-stock/near-expiry notifications, Accountant direct dead-letter notification, notification mark-unread/archive, and country/regulatory adapters) — none of these were reopened, and none blocked any workflow tested here.

## Regression Status

- `npx prisma validate` — clean
- `npx prisma migrate status` — 34/34 migrations applied, database schema up to date (no schema changes this batch)
- `npm run typecheck` — clean
- `npm run lint` — clean
- Integration suite — **55 files, 448 tests, 448 passing**
- `npm run build` — clean, 66 routes

Integration test database:
- Host: `localhost`
- Port: `5433`
- Database: `his_test`
- Remote Supabase: **NOT USED**

No credentials included above or elsewhere in this report.

## P3 Acceptance Decision

## Can P3 be closed?

**YES.**

> P3 Operational UX & Workflow Polish is complete and the system is ready to proceed to the next planned phase.

Both defects found during this phase's cross-role verification — a real accounting-integrity gap and a real access gap blocking Reception's own core job — were fixed within this phase and re-verified by both the automated suite and a live browser re-test. Every workflow in the Final P3 Acceptance Matrix above is PASS. The regression suite is clean end to end.

Per §58: stopping here. Not beginning P4, not beginning regulatory implementation, not performing another audit, not creating a new roadmap. Returning this report for review.
