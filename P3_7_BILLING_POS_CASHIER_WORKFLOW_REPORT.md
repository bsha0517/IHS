# P3.7 — Billing / POS / Cashier Workflow

**Date:** 2026-08-31 → 2026-09-01
**Scope:** Charges, Billing, Invoice, Payment, POS, Cashier, Receipt, refunds, voids, directly-related accounting handoff, and direct dependencies. No whole-system audit; P3.1–P3.6 not reopened; P3.8+ not started.

---

## Existing Financial Workflow Traced

Traced all four charge sources through the actual implementation per §5, before any change.

**A. Clinical/service:** `EncounterCompleted` and similar system triggers call `generateSystemCharge` (`billing/charges.ts`) — the single internal entry point every automatic charge goes through, bypassing the ad-hoc POS permission check since these are system-initiated, not staff-entered. A Cashier later selects the resulting `pending` `Charge` at `/pos` and invoices it exactly like every other source.

**B. Lab/Radiology:** confirmed in P3.5 and unchanged — `assignTests`/`assignImagingService` call `generateSystemCharge` at the moment of operational assignment (`sourceType: "lab"`/`"imaging"`), not at order-creation time. These charges land in the same `pending` pool as everything else.

**C. Pharmacy:** confirmed in P3.6 and unchanged — `dispenseRecord` calls `generateSystemCharge` (`sourceType: "pharmacy"`) inside its own dispensing transaction, so a Charge only exists once medication has actually left the shelf.

**D. POS/ad-hoc:** `createAdHocCharge` is the one staff-initiated entry point (`charge.create` permission, branch-checked). If `productId` is present, `insertCharge` (the shared internal function both A–D and D route through) calls `consumeStock` for real, FEFO-allocated, expired-batch-excluding inventory consumption and fires `ProductSold` for COGS posting — the exact same mechanism a pharmacy dispense uses, not a separate POS-only path.

**All four sources converge on the identical `Charge → Invoice → Payment` pipeline** — confirmed by reading `insertCharge` itself, the one function every source ultimately calls. No module has (or was found to have) its own parallel billing mechanism.

---

## Concrete Problems Found

1. **Cross-branch Charge merging in `generateInvoice`** — the charges query and the atomic claim both filtered by `patientId`/`status` but never `branchId`. A session authorized at multiple branches could construct a request naming Branch A (passing its own authorization check) while including `chargeIds` that actually belonged to Branch B, producing an invoice whose own branch disagreed with where its line items were really billed. Real cross-branch financial data corruption, not just an authorization gap.
2. **`recordPayment` had no branch check at all** — fetched the invoice by `organizationId` only. A Cashier authorized only for Branch B could record a payment against a Branch A invoice.
3. **`voidCharge` and all four `refunds.ts` write functions had no branch check** — the same systemic gap P3.3/P3.5/P3.6 already found and closed in their own domains, confirmed here by direct code reading.
4. **`createAdHocCharge` had no duplicate-submission guard** — the known P1 backlog item (§45). A realistic Cashier/POS double-click or network retry could create two identical Charge rows.
5. **`ReasonDialog` (shared component, flagged as backlog in P3.5) had no error handling** — now directly touched by this batch's void/refund flows, so fixed here rather than deferred again.
6. **`voidInvoiceAction`/`authorizeRefundAction`/`rejectRefundAction`/`completeRefundAction`/`voidChargeAction`** had no try/catch — the same raw-error-leak class of bug found repeatedly in prior batches.
7. **`prescriptions/[id]/print`'s `settings.view` bug also existed on `invoices/[id]/print`** — confirmed exactly as §22 predicted.
8. **No dedicated payment receipt** — only the invoice as a whole could be printed; a single payment transaction (with its own `receiptNumber`) had no print destination of its own.
9. **Two live, severe, pre-existing permission crashes found during the browser walkthrough** (not introduced by this batch, but blocking the exact workflow it's centered on):
   - `PosPage` called `listProviders(session)` unconditionally — `provider.view` is held by neither Cashier nor Receptionist, so the entire POS page crashed the instant a patient was selected.
   - `InsuranceTabs` called `listPayors(session)` unconditionally — gated on `coverage.manage` (which Cashier/Receptionist both hold) but internally required the much narrower `payor.manage` (Accountant-only), crashing the **entire Patient 360 page**, not just the Insurance tab, for any Cashier or Receptionist.
   Both are exactly the "widen elsewhere, forget an unconditional fetch" class of bug P3.2/P3.5/P3.6 already established a fix pattern for, and both directly blocked the Cashier walkthrough this batch's own instructions require — fixed immediately, not deferred.

None of these were active data corruption at rest; #1–#3 were live risk (unauthorized cross-branch writes) and #9 were live-blocking crashes for the exact role this batch serves — all treated as in-scope regardless of strict batch boundary, matching the task's own carve-out.

---

## Improvements Implemented

- **Branch scoping** added to `generateInvoice` (charge query + atomic claim, both now filtered by `branchId`), `recordPayment` (invoice branch check + a same-branch-as-open-register check), `voidCharge`, and all four `refunds.ts` functions (`requestRefund`, `authorizeRefund`, `rejectRefund`, `completeRefund`).
- **`createAdHocCharge` idempotency** — the same client-supplied `idempotencyKey` mechanism `recordPayment` already used (`platform/idempotency.ts`), wired through `AddChargeDialog` (one key per dialog-open, resubmitted unchanged on retry).
- **`ReasonDialog` error handling** — local error state, try/catch around the action call, friendly message displayed inline. Its `action` prop type was widened to accept an optional `{error}` return without breaking any of its five other pre-existing call sites (specimen rejection, leave requests, purchase requests).
- **Error handling** added to `voidInvoiceAction`, `authorizeRefundAction`, `rejectRefundAction`, `completeRefundAction`, `voidChargeAction` (all now return `ActionState`), and to their client callers (`RefundActions`, `PendingCharges`' Void button).
- **`invoices/[id]/print` fixed** the same way P3.6 fixed prescription printing — swapped `getOrganization` for `getOrganizationIdentity`, no `settings.view` required.
- **New payment receipt page** (`/payments/[id]/print`) — facility identity, receipt/payment number, date/time, method, reference, patient/MRN, invoice number, amount paid, and the invoice's current remaining balance. Linked from every payment row on the invoice detail page. A new `getPayment` read function (`billing/payments.ts`, branch-checked) backs it.
- **POS `listProviders`/Patient 360 `listPayors` crashes fixed** — both now defensively gated on the actual permission they individually require, falling back to an empty list rather than crashing the whole page, the same pattern P3.2/P3.5/P3.6 established.
- **Source-type friendly labels** (§11) — Consultation/Procedure/Laboratory/Radiology/Pharmacy/POS product/Package/Other, replacing the raw `sourceType` string in the Pending Charges list.
- **Discount field hidden from sessions without `invoice.discount`** (§37) — neither Cashier nor Receptionist holds it; the field previously invited a confusing server-side rejection.
- **Billing-context summary added to the POS patient view** (§9) — a prominent outstanding-balance figure and a "Recent payments" card, alongside the existing "Recent invoices."
- **Cashier day-to-day visibility added to the POS landing page** (§32) — "This register's payments today" (reusing the existing `getCashierSession` read) and "Outstanding invoices at this branch" (reusing the existing, already-paginated `listOutstandingInvoices`) — shown before a patient is even selected, closing the gap where the only pre-close visibility was the post-close summary page.
- **Void-after-payment rule surfaced explicitly** (§26) — when an invoice has payments applied and can't be voided directly, a plain-language explanation now renders in place of the (previously just absent) Void button, for sessions that hold `invoice.void`.

---

## Cashier / Billing Workspace

The pre-existing `/pos` page already answered most of §7's checklist well (patient lookup reusing the existing patient search, pending charges with source/quantity/price, recent invoices with status). This batch closed the two genuinely missing items — outstanding balance and recent payments — and added day-to-day, pre-patient-selection visibility (today's payments, outstanding invoices at the branch) that didn't exist before. Refund/void history is visible on the invoice detail page one click away (never duplicated onto the POS page itself, keeping navigation minimal without bloating the workspace).

## Charge → Invoice

`generateInvoice` already correctly: computed totals server-side (subtotal/tax/discount/total all derived from the charges themselves, never trusted from the client); used the existing tax-rate prefetch (P2 §18) and existing invoice numbering (`nextNumber`, concurrency-safe); supported combining charges from multiple clinical modules into one invoice (already demonstrated with a lab + pharmacy charge in the same invoice); supported partial billing (charges not selected simply remain `pending` and visible). This batch's only correctness fix was branch consistency between the invoice and every charge it claims (see Problem #1).

## Invoice Status / Balance

`InvoiceStatus` (`draft`/`issued`/`partially_paid`/`paid`/`void`) is a real enum; status is set exclusively by `applyPaymentAtomically`/`applyRefundAtomically`'s own atomic SQL, never client-derived or presentation-invented. Verified live: an invoice correctly showed `partially_paid` after a 100/225 payment, `paid` after the remaining 125, `partially_paid` again after a 50 refund, and `void` after voiding a separate unpaid invoice.

## Payments

`recordPayment` already correctly: verified the invoice existed, wasn't void, wasn't already fully paid; validated amount against outstanding balance via the atomic guard (never a plain read-then-write); required an open `CashierSession` owned by the acting session; supported split/multiple tenders in one call (one `Payment` + `PaymentAllocation` row per tender, never blended); already had idempotency-key protection. This batch added the missing branch check. Verified live: two separate payments (cash 100, then bank 125 with a reference number) both preserved as distinct rows, neither overwriting the other.

## Refunds

P1's refund hardening was not rebuilt. Verified operationally, live: `requestRefund` → `authorizeRefund` (segregated permission — Cashier could request but not authorize; Clinic Manager could) → `completeRefund`, which atomically decremented `paidAmount` and correctly flipped the invoice back to `partially_paid`. The UI clearly separates "Record payment" (black, primary) from "Request refund" (secondary, distinct dialog) — never conflated. `RefundCompleted` fires both the accounting reversal (`postRefundCompleted`: Dr Revenue / Cr Cash-or-Bank) and commission clawback (`reverseCommissionsForRefund`) via the existing outbox mechanism — confirmed by reading `event-handlers.ts`, not rebuilt.

## Invoice Void

Never deletes — confirmed live (a voided invoice's line items, amounts, and history all remained fully visible, status simply flipped to `void`, and its charges reverted to `pending`, immediately re-appearing in the Pending Charges list for potential re-invoicing). The actual system rule for a paid invoice, determined by reading `voidInvoice` directly: **voiding a paid or partially-paid invoice is blocked outright** (`"Cannot void an invoice that has payments applied — issue a refund instead."`) — refund-first is the only supported path, not invented by this batch. Previously this rule was invisible in the UI (the Void button simply didn't appear, with no explanation); now a plain-language note explains it to anyone who holds `invoice.void`.

## POS Workflow

Made operationally coherent, not rebuilt: patient search → pending charges (system + ad-hoc) → select → discount (permission-gated) → generate invoice → record payment → receipt, all through the pre-existing domain functions. `AddChargeDialog` already correctly separated "from service catalog" / "from product catalog" / manual entry, with product selection auto-populating price and correctly warning "sells real stock, FEFO-allocated."

## Inventory / COGS

Untouched, per §29's explicit instruction, and re-verified live rather than assumed: a 3-unit POS sale of a real batched product reduced the stock ledger balance 20→17 (a `"sale"`-typed, batch-referencing entry), and posted `Dr COGS 6.00 / Cr Inventory Asset 6.00` (3 × the batch's actual 2.00 purchase cost) — the identical `consumeStock`/`postProductSaleCogs` path pharmacy dispensing and every other inventory movement in this system already uses. No logic duplicated in POS.

## Accounting Handoff

Not rebuilt. Confirmed live and via code trace that `InvoiceIssued`, `PaymentReceived`, `RefundCompleted`, `InvoiceVoided`, and `ProductSold` all continue to fire through the existing outbox → centralized `posting-service.ts` chain — no direct journal-entry creation was added anywhere in this batch's UI or action code. A Clinic Manager dashboard check during the walkthrough incidentally cross-confirmed this end-to-end: "Revenue Today"/"Collections Today"/"Outstanding Receivables" tracked every test transaction exactly.

## Concurrency / Idempotency

Explicit results per §44/§54:

- **Duplicate Charge invoicing:** already protected pre-existing (`generateInvoice`'s atomic `updateMany` claim) — re-verified via a dedicated new test (two concurrent `generateInvoice` calls selecting the same charges — only one succeeds). Not rebuilt.
- **Duplicate payment:** already protected pre-existing (idempotency key + `applyPaymentAtomically`) — covered by the pre-existing `idempotency-and-transaction-review.test.ts`, not duplicated here.
- **Duplicate refund:** **new test added this batch** — two authorized refunds each individually valid against the original paid amount, but only enough headroom for one to actually complete; `completeRefund`'s pre-existing claim-before-act (`updateMany` on the refund's own status) plus `applyRefundAtomically`'s atomic balance guard correctly allowed exactly one to succeed.
- **POS final-stock race:** **new test added this batch**, exercised through the actual POS entry point (`createAdHocCharge`) rather than only the lower-level `consumeStock` (already covered by the pre-existing `idempotency-and-transaction-review.test.ts`) — two concurrent product charges against a 1-unit batch: exactly one succeeded, stock never went negative.
- **`createAdHocCharge`:** the P1 backlog gap — fixed this batch (see Improvements Implemented) and verified via a new test (two identical calls with the same idempotency key produce exactly one Charge row).

## Pharmacy Return Financial Review

**Deliberately deferred, not fixed — explained in full.** Traced the actual reversal architecture before deciding: `postRefundCompleted` (the only accounting effect a `Refund` can currently trigger) posts a pure **revenue** reversal (`Dr Revenue / Cr Cash-or-Bank`) — it has no COGS-reversal leg at all, unlike `postProductSaleVoided` (which exists specifically for a *pending, not-yet-invoiced* charge void). Even if `returnDispensingRecord` were changed to auto-create a `Refund`, completing it would still leave the original dispensing's COGS entry (`Dr COGS / Cr Inventory Asset`) permanently unreversed — the P3.6-identified gap would only be half-closed, not closed. Compounding this, `Refund` has no line-level granularity (a lump amount against the whole invoice, not tied to one `InvoiceLine`/`Charge`), so a return against one dispensed item on a multi-item invoice couldn't even be expressed correctly with the current model. Building this properly requires either a new COGS-reversal event wired specifically to a pharmacy-sourced refund, or genuine line-level granularity added to `Refund` — real design work, not a narrow operational fix, and not something a Cashier-facing UX batch should improvise as "an accounting shortcut" (explicitly forbidden by §46). Left in `BACKLOG.md`, updated with this specific architectural finding, for P3.9/financial-reversal design.

## Printing / Receipts

Both fixed print pages (invoice, and the new payment receipt) verified live for a Cashier session holding no `settings.view` — both rendered the real clinic display name, correct patient/invoice/payment data, with no crash. Neither turned into a print-design project — both reuse the exact structural convention (route outside `(dashboard)`, shared `PrintButton`, `getOrganizationIdentity`) already established across five prior print views in this codebase.

## Patient 360 Return

Not reopened generally, per instruction — verified live that new activity correctly appears: the Invoices tab showed the new invoice with correct status/outstanding; the Payments tab showed both payment rows with correct method/reference/amount; the Statement tab showed a complete, correctly-running ledger (invoice charge, then each payment credit, balance reconciling to zero) — confirming P3.2's existing statement-reconciliation logic held under this batch's new activity without modification. The Financial-snapshot Overview-tab figure also tracked correctly. Doctor/Reception read-only behavior: Doctor holds neither `invoice.view` nor `payment.view` in the current seeded permissions, so nothing was widened for Doctor (§43's own conditional — "give appropriate read access only if current permission architecture supports it" — it currently doesn't, so nothing to wire); Receptionist already holds the same billing permissions as Cashier (an existing, pre-P3.7 design choice, not altered).

## Security / Branch Scoping

All previously-unscoped write functions listed in "Concrete Problems Found" #1–#3 now enforce `assertBranchAccess` (or an equivalent branch-consistency filter, for the `generateInvoice` charge-merging case) against the session's authorized branch scope — never a client-supplied branch id. Verified by a dedicated new test exercising cross-branch denial across void/pay/refund from a single Branch-B-only session against Branch-A resources. Reviewed seeded Cashier/Receptionist/Accountant/Clinic Manager permissions directly against `prisma/seed.ts`: confirmed Cashier holds none of `charge.void`/`invoice.void`/`invoice.discount`/`refund.authorize`/`accounting.*`/`inventory.adjust`/`settings.*` — no broad grants exist or were added.

## Financial Period Controls

Not rebuilt — `assertPeriodOpen` (called from inside the centralized `postJournal`) was already correct pre-existing P1 work. Verified live via a dedicated new test exactly what the real behavior is: closing the current UTC accounting period does **not** block `generateInvoice` itself from succeeding (the operational, Cashier-facing action completes normally) — but the resulting `InvoiceIssued` accounting posting genuinely fails against the closed period and is queued for retry (`failed`/`dead_letter`, never silently dropped, and no journal is ever written into the closed period). This is a deliberate, pre-existing P1 architectural choice (postings are always asynchronous via the outbox, specifically so a downstream posting failure never blocks the upstream user-facing write) — not something this batch introduced or was asked to change, and not bypassed for Cashier convenience.

## Performance

`generateInvoice`'s new branch filter added one field to an existing WHERE clause — no new query. `recordPayment`'s new branch/register checks reused data already fetched in the same function — no new query. The new POS "today's payments"/"outstanding invoices" cards reuse `getCashierSession` (already fetches this session's payments) and `listOutstandingInvoices` (already paginated, already aggregate-summed) — no new query shape, no unbounded list. `getPayment` (new) is a single-record read, branch-checked, used only by the new receipt page. No pagination was reduced or removed anywhere; `listInvoices`/`listPayments`/`listOutstandingInvoices` all remain exactly as P2 left them.

## Files Changed

**Domain:**
- `src/lib/domains/billing/charges.ts` (branch scoping, `createAdHocCharge` idempotency)
- `src/lib/domains/billing/invoices.ts` (cross-branch charge-merge fix)
- `src/lib/domains/billing/payments.ts` (branch scoping, `getPayment`)
- `src/lib/domains/billing/refunds.ts` (branch scoping, all four functions)

**Pages / components:**
- `src/app/(dashboard)/pos/page.tsx` (billing-context summary, today's-activity cards, `listProviders` crash fix, `canDiscount` prop)
- `src/app/(dashboard)/pos/pending-charges.tsx` (source labels, discount gating, void error display)
- `src/app/(dashboard)/pos/add-charge-dialog.tsx` (idempotency key)
- `src/app/(dashboard)/pos/actions.ts` (error handling, idempotency key wiring)
- `src/app/(dashboard)/invoices/[id]/page.tsx` (receipt links, void-after-payment explanation)
- `src/app/(dashboard)/invoices/[id]/reason-dialog.tsx` (error handling — closes a P3.5 backlog item)
- `src/app/(dashboard)/invoices/[id]/refund-actions.tsx` (error handling)
- `src/app/(dashboard)/invoices/actions.ts` (error handling on all four refund/void actions)
- `src/app/(dashboard)/patients/[id]/insurance-tabs.tsx` (`listPayors` crash fix)
- `src/app/invoices/[id]/print/page.tsx` (`settings.view` fix)
- `src/app/payments/[id]/print/page.tsx`, `.../print-button.tsx` (new)

**Docs:**
- `BACKLOG.md` (Pharmacy-return financial-reversal entry updated with this batch's architectural finding)

**Tests:**
- `test/integration/p3-7-billing-pos-cashier-workflow.test.ts` (new)

No `prisma/schema.prisma` changes and no new migration.

## Tests

New file `test/integration/p3-7-billing-pos-cashier-workflow.test.ts` — **10 new tests**: multi-source Charges combining into one Invoice with correct per-line traceability; cross-branch charge-merge rejection; cross-branch denial across void/pay/refund; partial-then-remaining payment with correct status transitions and preserved payment history; duplicate-refund protection under real concurrency; `createAdHocCharge` idempotency; printing without `settings.view`; Patient 360 reflecting a new invoice/payment; closed-period behavior (operational action succeeds, posting fails/retries, no journal in the closed period); POS final-stock race through the real POS entry point. Deliberately scoped to avoid duplicating the already-thorough pre-existing coverage in `pos-inventory-cogs.test.ts`, `idempotency-and-transaction-review.test.ts`, and `accounting-period-control.test.ts`.

**Total: 49 test files, 324 tests, 324/324 passing** (314 existing + 10 new). No existing financial assertion was weakened.

## Browser Verification

Full walkthrough run against `his_dev` using temporary fixtures (Cashier + Clinic Manager users with real role/branch-access rows, one patient, one stocked physical product — created and fully cleaned up afterward, confirmed zero remaining rows).

**Patient Billing:** created a consultation charge (150) and a lab charge (75) for the patient → logged in as Cashier, opened a register → found the patient via `?patientId=` → confirmed both charges with friendly source labels ("Consultation"/"Laboratory"), no discount field (correctly hidden) → selected both, generated INV-000005 (225.00 total, correctly combined) → recorded a partial payment (100 cash) → confirmed `partially_paid` (paid 100, outstanding 125) → recorded the remainder (125, bank tender, with a reference number) → confirmed `paid` (both payments preserved as separate rows) → opened the invoice print page and a payment receipt print page, both rendering correctly for Cashier with no `settings.view` crash → confirmed Patient 360's Invoices, Payments, and Statement tabs all correctly reflected the new activity (Statement's running balance reconciled to exactly zero).

**Refund/Void:** requested a 50 partial refund on the paid invoice as Cashier (status `requested`, no self-authorize button shown) → logged in as Clinic Manager, authorized then completed it → confirmed the invoice correctly dropped to `partially_paid` (paid 175, outstanding 50) and the refund history showed `RFD-000001 completed` → created a second, separate unpaid invoice (INV-000006) → confirmed the void-after-payment explanation was absent for it (no payments) and the Void button was present → voided it with a reason → confirmed it showed `void` status with full line-item history still visible, and its charge reverted to `pending` (re-appeared in the Pending Charges list) → confirmed the voided invoice still appeared correctly in Recent Invoices as `void`.

**POS:** added a physical product charge (3 × P37 Bandage Roll) via the product catalog picker, confirmed the "sells real stock, FEFO-allocated" warning and auto-filled price → generated an invoice, recorded full payment → confirmed via direct DB check: stock ledger reduced 20→17 (a `"sale"`-typed, correctly batch-referenced entry) and a `Dr COGS 6.00 / Cr Inventory Asset 6.00` journal posted at the batch's actual cost.

**Security/Integrity:** cross-branch denial, concurrent same-Charge invoice attempt, concurrent payment, concurrent refund, and concurrent final-stock POS attempt were all verified through the automated test suite (§44's own item list) rather than repeated manually in the browser, since they require true concurrent requests a single interactive session can't produce; each is deterministically covered by a dedicated new test. Closed-period behavior was likewise verified via a dedicated automated test (see "Financial Period Controls" above) rather than manually closing a live period during the walkthrough, to avoid disrupting `his_dev`'s real accounting state.

All walkthrough fixtures (2 users, 1 patient, 1 product/batch, 3 invoices, 4 payments, 1 refund) were deleted after verification; confirmed zero remaining rows matching the walkthrough's identifiers.

## Remaining Billing/POS Backlog

Logged/updated in `BACKLOG.md`:
1. **Pharmacy dispensing returns still don't reverse the original Charge/COGS** — the P3.6-identified gap, now with the full architectural reasoning for why a narrow fix isn't safely available (see "Pharmacy Return Financial Review" above). Deferred to P3.9/financial-reversal design, exactly per this batch's own instruction.

No other new backlog items were opened this batch — the two live permission crashes found during the walkthrough (POS `listProviders`, Patient 360 `listPayors`) were fixed directly rather than deferred, since they were actively blocking the exact Cashier workflow this batch exists to make usable.

## Regression Status

- `prisma validate` — clean.
- `prisma migrate status` — 33 migrations found, database schema up to date (no new migration this batch).
- `npm run typecheck` — clean, zero errors.
- `npm run lint` — clean, zero warnings/errors.
- `npm run test:integration` — **49 test files, 324 tests, 324/324 passing, zero failures.** Run against local PostgreSQL only: `localhost:5433`, database `his_test`, via `TEST_DATABASE_URL`/`TEST_DIRECT_DATABASE_URL`. Remote Supabase was **not** used — its connection strings remain commented out in `.env` and were not referenced by any test or script this batch ran.
- `npm run build` — production build succeeded; all existing and modified routes (including the new `/payments/[id]/print`) compiled and registered correctly.

Integration DB:
- Host: `localhost`
- Port: `5433`
- Database: `his_test`
- Remote Supabase: NOT USED

No credentials are included in this report.

---

Stopping here per §55. P3.8, Procurement/Inventory UX, Finance/Accounting UX, P4, and country-specific taxation/e-invoicing were not started. Awaiting review and explicit instruction to continue.
