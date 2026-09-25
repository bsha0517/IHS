# P5.3 — First Pilot Clinic Implementation & UAT — Results

## 1. Purpose

This document records the results of executing a full, real pilot-clinic lifecycle against a
running instance of Avant HIS: provisioning one synthetic pilot clinic, onboarding it exactly the
way a real implementation team would, running a full synthetic clinic day across every clinical and
financial workflow, and taking the organization through go-live. Every scenario below was executed
against the real application and database (Playwright E2E, `test/e2e/p5-3/`) — not inspected in
source and assumed to work. Where a query is shown, it is a direct read against `his_dev`, not a
UI-only assertion.

## 2. Pilot Clinic Configuration

- **Organization**: "P5.3 Pilot Clinic \<suffix\>", plan Enterprise, country PK, 2 branches (Main
  Branch, Secondary Branch), 16/17 modules enabled (Assets deliberately disabled for the
  entitlement/security scenario, §7 below).
- **Users (10, each an existing seeded system role)**: Super Admin, Receptionist, Doctor ×2 (one
  Branch-A-only, one deliberately Branch-B-only), Nurse, Pharmacist, Laboratory Technician,
  Radiology Technician, Inventory Manager, Accountant, HR Manager.
- **Providers**: 2 doctors + 1 nurse, each linked to their user login and assigned to the branch
  matching their user's own branch access.
- **Master data**: 1 billable consultation service, 1 billable procedure, 1 supplier, 1 clinical
  consumable product, 1 retail product, 2 medications (one prescription-only, one OTC-style), 1 lab
  test, 1 imaging service, 2 payors (self-pay, insurance), 1 treatment package bundling the
  consultation service.
- **Accounting**: a real 10-account Chart of Accounts and 11 Account Mappings (Cash, Accounts
  Receivable, Revenue, Inventory Asset, COGS, Accounts Payable, Expense Default, Salary Expense,
  Payroll Payable, Goods Received Not Invoiced, Bank Transfer) — confirmed by direct inspection that
  provisioning creates none of this automatically; it is a genuine, deliberate implementation step a
  real pilot clinic's finance lead would have to take.
- **Communication templates**: 5 (appointment confirmation, appointment cancellation, appointment
  reminder, payment reminder, birthday greeting) — same finding as accounting: provisioning creates
  none of these automatically either (§9 in the Completion Report).
- **Opening inventory**: imported via the real P4.6 CSV import framework.
- **Onboarding checklist**: all 13 required items completed; a Pilot UAT cycle started on the
  platform-operator side.

## 3. UAT Results by Area

Each row was exercised end-to-end through the real UI as the relevant role, then verified against
the database directly (not just a UI success toast).

| # | Area | Result | Evidence |
|---|------|--------|----------|
| 1 | Reception — registration, duplicate detection, search, booking, reschedule, cancel | PASS | 3 patients registered; duplicate-detection warning (non-blocking) fires on a genuine repeat; search by name and phone; 3 appointments booked across both branches; full confirm→arrive→check-in queue progression; reschedule creates a new row and marks the original `rescheduled` (never edited in place); cancel requires a reason and is reflected in `appointment.status` |
| 2 | Reception RBAC boundary | PASS | Receptionist blocked from direct navigation to accounting/payroll/admin-roles |
| 3 | Doctor / Nursing — encounter, vitals, diagnosis, orders, prescription | PASS | Encounter started from a checked-in appointment; vitals recorded; diagnosis, lab order, and prescription added within the same encounter; encounter finalized and confirmed never editable in place after finalization |
| 4 | Laboratory | PASS | Assign tests generates a real Charge; collect→receive→result→verify lifecycle; amending a verified result inserts a new row (`is_current` flips), never mutates the original |
| 5 | Radiology | PASS | Second encounter + imaging order; assign service generates a Charge; schedule→perform→report→verify lifecycle; amending a verified report requires a reason and never mutates the original |
| 6 | Pharmacy | PASS | Dispensing consumes the near-expiry batch first (FEFO), deducts stock, generates a Charge; insufficient stock rejected server-side with a clear message (no negative balance); dispensing a substitute medication shows a warning and blocks submit until confirmed; partial return restores stock and requires a reason |
| 7 | Billing / POS / Payments / Refunds / Commissions | PASS | 10% commission rule created; cashier register opened; invoice generated from mixed pending charges (consultation + lab + pharmacy); full cash payment recorded; invoice AND payment each post their own balanced journal; commission accrues on payment, not invoice; partial refund reverses the payment/invoice financially and claws back the commission proportionally (no duplicate/phantom accrual left standing); register closes with a computed, not manually-guessed, expected cash and variance |
| 8 | Inventory / Procurement | PASS | Purchase request created and self-approved by Inventory Manager (a real, confirmed small-clinic path); purchase order issued; goods receipt creates a real `ProductBatch` + `StockLedgerEntry`, updates PO status, and posts an automatic, balanced accounting journal with no manual posting step |
| 9 | Multi-Branch | PASS | A Branch-B-only doctor cannot reach a Branch-A appointment by direct URL and never sees Branch-A data in their own list; the same doctor operates normally within Branch B; org-wide roles (Inventory Manager, Accountant, HR Manager) see both branches |
| 10 | Security — tenant isolation | PASS | A second, throwaway synthetic organization provisioned specifically to test against; Org B's admin cannot reach Org A's patient, appointment, invoice, or support ticket by direct URL even knowing the exact id |
| 11 | Security — entitlement enforcement | PASS | The deliberately-disabled Assets module: nav link hidden, route redirects, AND the Server Action itself rejects a mutation attempted from an already-open stale form (the real, exact race P5.2 proved the server — not just the UI — must reject) |
| 12 | Security — suspension | PASS | Suspending the organization blocks a clinic user's normal login/operation immediately (an existing session is not grandfathered in); reactivating restores normal operation |
| 13 | Packages | PASS | Package sold to a patient and paid through the exact same Charge→Invoice→Payment pipeline as any other billable item (not a separate path); one session consumed decrements the remaining balance via a real, append-only `PatientPackageSession` row, never a mutable counter |
| 14 | HR / Payroll | PASS | Employee created and linked to an existing user login (a real, deliberately Admin-only action, not HR Manager's — see §5 in the Completion Report); leave request submitted and approved; full payroll lifecycle draft→review→approve→paid, with the approve AND paid transitions each posting their own balanced journal (Salary Expense/Payroll Payable, then Payroll Payable/Bank) |
| 15 | Support | PASS | Clinic user creates a ticket; platform operator adds both an internal and a customer-visible note; the clinic sees only the customer-visible one (verified both in the UI and directly against `support_ticket_note.visibility`) |
| 16 | Go-Live | PASS | UAT cycle signed off; all 4 go-live conditions (hosted backup, external error monitoring, clinic-specific UAT, transactional email) marked verified by the operator; go-live approval is server-validated against the exact same blocker logic the UI renders from, not UI-only; the clinic keeps operating normally immediately after approval |
| 17 | Reporting | PASS | Financial report's revenue/outstanding totals reconcile against the actual invoice/payment rows this UAT generated; stock ledger produces no negative balance for any product anywhere in the run; commission report reconciles against real `commission_accrual` rows including the refund clawback, with no phantom/duplicate accrual |
| 18 | Notifications | PASS | Verifying a lab result fires a real `lab_result_ready` notification addressed specifically to the ordering doctor, not a broadcast; no notification anywhere in the org references a mismatched organization |
| 19 | Concurrency | PASS | Two simultaneous invoice-generation attempts against the same pending charge never both succeed — the charge is invoiced exactly once, never twice, never zero times; two simultaneous check-in attempts on the same fresh appointment never produce two `QueueEntry` rows and the appointment lands in exactly one valid status |

**19/19 UAT areas: PASS.**

## 4. Reconciliation (Step 24)

Run directly against the database after the final full clean pilot-day run (org id in this run's
fixture), in addition to the per-stage reconciliation already embedded in §3's Billing/Procurement/
Payroll/Reporting rows above:

- **Every journal posted in the pilot org balances.** All 9 journals posted during the run
  (invoice, payment, refund, charge COGS, goods receipt, payroll approve, payroll paid) have
  `sum(debit) == sum(credit)`, with zero exceptions.
- **No negative stock ledger balance for any product.** The ledger is the sole source of truth for
  stock (confirmed by inspection: `product_batch` has no independent quantity column to drift
  from); summed across every movement, every product's running balance is ≥ 0.
- **No overpaid invoice.** No invoice's `paid_amount` exceeds its `total_amount`.
- **No double-invoiced charge.** No charge appears on more than one `invoice_line`.
- **Commission accruals are finite and reconcile.** Net accrual per provider (original accrual plus
  the refund-driven clawback reversal) is a real, finite number — never NaN or an orphaned row.

## 5. Full Synthetic Clinic Day

Executed as one continuous sequence against a single organization: patient registration through
reception, doctor consultation, lab and radiology orders and results, pharmacy dispensing, billing
and payment collection, commission accrual, a partial refund, inventory receiving, package sale and
consumption, employee/leave/payroll administration, support ticketing, and go-live approval — all
in one pilot org, all cross-referencing the same patients/branches/providers a real clinic day
would. The full sequence, run clean from a freshly-provisioned organization with no manual DB
intervention between stages, passed 63/63 (see Completion Report §12 for the stabilization history).

## 6. Defects Found During UAT

See `docs/P5_3_COMPLETION_REPORT.md` §16 for the full severity-classified list with fixes. Summary:
3 real, pilot-blocking application defects were found by this UAT (none by static inspection) and
fixed; a handful of accessibility/testability gaps were found, documented, and deliberately left
unfixed as backlog (real mouse users are not blocked, only automated testability is degraded).

## 7. Final Decision

**P5.3 first pilot UAT: PASS.** All 19 UAT areas pass against a real, fully-provisioned pilot
clinic; every discovered application defect was fixed and re-verified, not merely logged; the full
lifecycle reproduces cleanly from a fresh organization. Recommend proceeding to commercial pilot
operation.
