# P1 Financial Integrity Findings

Systematic inspection of Charges, Invoices, InvoiceLines, Payments, PaymentAllocations, Refunds, Cashier, Accounting, Procurement, Supplier Invoices, Inventory Accounting, Assets, Payroll, and Claims per P1.md §6. This is a findings-only pass — **nothing below has been fixed**, except where explicitly noted as already covered by the P0 pass. Each finding was verified by reading the actual current code (file:line evidence), not inferred from naming or documentation. This document drives later P1 batches.

Findings are grouped by root-cause pattern, then listed in the order P1.md's own numbered sections (§7-§19) raise them, since later batches will work section by section.

---

## Pattern A: Check-then-act races — no transactional locking on shared balances

The single most common root cause found in this sweep. The pattern repeats across at least eight call sites: a function reads a balance or count *before* opening a database transaction (or reads it inside the transaction but without `SELECT ... FOR UPDATE` / an atomic conditional update), validates against that snapshot, then writes based on the same stale snapshot. Two concurrent calls both read the same "before" state, both pass validation independently, and both commit — producing a lost update, an overpayment, an over-refund, double-billing, or overselling inventory. None of these are hypothetical; each is confirmed by reading the exact code path with no lock, no `SELECT FOR UPDATE`, and no conditional `WHERE` guard on the eventual write.

### A1. Payment allocation concurrency (P1 §29)

**File:** [src/lib/domains/billing/payments.ts:24-72](src/lib/domains/billing/payments.ts#L24-L72)

`recordPayment` reads `invoice.paidAmount`/`invoice.totalAmount` via a plain `findFirstOrThrow` (line 24) *before* opening `db.$transaction` (line 44), computes `outstanding` from that snapshot (line 39), and validates the tendered amount against it. Inside the transaction, `newPaidAmount = invoice.paidAmount (stale) + totalTendered` is written unconditionally (line 70-72) — no re-read, no lock, no `WHERE paidAmount = <expected>` guard.

**Failure scenario:** Invoice outstanding = 500. Two simultaneous payment requests of 400 each. Both read `paidAmount = 0`, both compute `outstanding = 500`, both pass the `400 <= 500` check, both commit. Result: two Payment rows totaling 800 exist against a 500 invoice, while `invoice.paidAmount` reflects only whichever transaction's literal `0 + 400 = 400` wrote last — the invoice under-reports what was actually collected, and the total collected exceeds what was ever owed.

### A2. Refund concurrency (P1 §7) — the exact scenario P1.md names

**File:** [src/lib/domains/billing/refunds.ts:87-127](src/lib/domains/billing/refunds.ts#L87-L127)

`completeRefund` reads `refund.invoice.paidAmount` via `findFirstOrThrow` (line 90-93, not locked), then inside its transaction computes `newPaidAmount = invoice.paidAmount (stale) - refund.amount` and writes it unconditionally (line 104-111). `requestRefund` (line 18-47) only validates a new refund's amount against `invoice.paidAmount` — it never accounts for other refunds already requested-but-not-yet-completed, so the real "remaining refundable balance" is never computed anywhere.

**Failure scenario — literally P1.md's own example:** Payment = 1,000, an existing completed refund of 600 already applied (so `invoice.paidAmount = 400`). Two new refunds of 300 each are requested, both authorized, then completed simultaneously. Both `completeRefund` calls read `paidAmount = 400`, both compute `newPaidAmount = 100`, both commit — both refunds succeed (total 600 refunded this round, 1200 total against a 1000 payment), and `invoice.paidAmount` ends at 100 either way, silently absorbing the lost update. Nothing in this code path can ever reject the second refund, regardless of what the combined total should have blocked.

### A3. Supplier payment concurrency (same pattern as A1)

**File:** [src/lib/domains/procurement/supplier-invoices.ts:35-75](src/lib/domains/procurement/supplier-invoices.ts#L35-L75)

`recordSupplierPayment` has the identical shape: `invoice.paidAmount` read outside the transaction (line 38-40), `outstanding` validated against that snapshot (line 42-45), `newPaidAmount` written unconditionally inside the transaction (line 59-66) with no re-read or lock. Same overpayment/lost-update risk as A1, on the AP side.

### A4. Insurance remittance concurrency (same pattern as A1/A2, and it races *against* A1/A2 too)

**File:** [src/lib/domains/claims/service.ts:200-254](src/lib/domains/claims/service.ts#L200-L254)

`recordRemittance` reads `claim.invoice.paidAmount` (line 201, 206) and writes `newPaidAmount` unconditionally inside its transaction (line 229-239) — the same pattern as A1, but on a *different code path that updates the same `invoice.paidAmount` column*. This means a patient's direct cash payment (A1) and an insurance remittance (A4) against the same invoice, processed concurrently, race against each other exactly the same way two `recordPayment` calls would — the two code paths share no common lock.

### A5. Charge double-invoicing

**File:** [src/lib/domains/billing/invoices.ts:54-164](src/lib/domains/billing/invoices.ts#L54-L164)

`generateInvoice` selects charges with `status: "pending"` (line 57-63, outside any transaction), then inside the transaction flips each selected charge to `status: "invoiced"` via an **unconditional** `tx.charge.update({ where: { id: charge.id }, ... })` (line 154) — no `status: "pending"` guard in that `WHERE` clause.

**Failure scenario:** Two "Generate Invoice" requests are submitted for the same patient with overlapping charge selections (e.g. a double-click, or two staff members both invoicing from the same pending-charges list before either has refreshed). Both read the same charge as `pending`, both pass validation, both create a separate Invoice with an InvoiceLine for that charge, and both flip it to `invoiced` — the patient is billed twice for the same charge, on two different invoices, both of which post a real `InvoiceIssued` journal entry via the outbox.

### A6. Package session overconsumption (P1 §28) — the exact scenario P1.md names

**File:** [src/lib/domains/packages/service.ts:122-171](src/lib/domains/packages/service.ts#L122-L171)

`consumeSession` computes `usedForService` from `patientPackage.sessions` fetched by the initial (unlocked) `findFirstOrThrow` (line 125-128, 139), validates `usedForService < sessionsAllocated`, then — inside its transaction — unconditionally `create`s a new `PatientPackageSession` row (line 145-154) with no re-check and no unique constraint that would reject a second row past the allocation.

**Failure scenario — literally P1.md's own example:** Remaining sessions = 1. Two simultaneous treatment-completion requests both read `usedForService = allocated - 1`, both pass the check, both insert a session-consumption row. Two sessions are consumed from an allocation of one remaining.

### A7. Dispensing double-execution (P1 §14)

**File:** [src/lib/domains/pharmacy/dispensing.ts:81-147](src/lib/domains/pharmacy/dispensing.ts#L81-L147)

`dispenseRecord`'s `record.status !== "verified"` guard (line 89) is checked *before* the transaction opens, and the final `tx.dispensingRecord.update` (line 139-142) that flips status to `"dispensed"` has no `WHERE status: "verified"` guard — it updates by `id` alone.

**Failure scenario:** A double-click or a client retry on `dispenseRecord(id)` (both realistic — this is exactly the "double click/retry" scenario P1 §33 names) results in two full executions: `consumeStock` runs twice (double stock deduction for one physical dispensing), `generateSystemCharge` runs twice (the patient is billed twice for one dispensing), and the medication-history upsert runs twice. Unlike the outbox's own dispatcher (which uses an atomic `updateMany` claim — see P0-02), this direct Server-Action-invoked path has no equivalent protection.

### A8. FEFO/inventory consumption has no concurrency protection

**File:** [src/lib/domains/inventory/stock.ts:280-317](src/lib/domains/inventory/stock.ts#L280-L317)

`consumeStock` computes available balance via `listAvailableBatchesInternal` (a `SUM` over `stock_ledger_entry`, not a locking read), runs FEFO allocation in application code against that snapshot, then writes negative ledger entries — no `SELECT ... FOR UPDATE`, no serializable isolation, no re-check immediately before the insert.

**Failure scenario:** A batch has 10 units remaining. Two concurrent consumers (two dispensing operations, or — once P1 §9/§10 wire up POS product sales — two POS product sales) each request 8 units. Both read balance = 10, both are allocated 8 units by FEFO, both insert a `-8` ledger entry. The ledger's derived balance goes to −6 — oversold stock the "insufficient stock throws" guard was specifically supposed to prevent, defeated by the race rather than the logic being wrong in isolation.

### A9. Cashier session double-open (lower severity, noted for completeness)

**File:** [src/lib/domains/billing/cashier.ts:24-44](src/lib/domains/billing/cashier.ts#L24-L44)

`openSession`'s "you already have an open session" check (line 27-32) is an unlocked read-then-create. A double-click could open two sessions for the same cashier simultaneously. Lower severity than A1-A8 since it doesn't directly cause a money discrepancy — payments simply attach to whichever session id the UI happens to hold — but it does violate the intended one-open-register-per-cashier invariant and would confuse close-out reconciliation.

---

## Pattern B: Financial postings that don't exist yet, or that fire outside any safety net

### B1. Selling a physical product through POS never touches inventory (P1 §9 / §10 — confirmed exactly as suspected)

**Files:** [src/lib/domains/billing/charges.ts:31-84](src/lib/domains/billing/charges.ts#L31-L84), [src/lib/domains/billing/schemas.ts:16-27](src/lib/domains/billing/schemas.ts#L16-L27)

`insertCharge`'s only inventory hook is `if (input.serviceId)` (charges.ts line 68) — it looks up `ServiceProductConsumption` templates keyed by **service**, the mechanism Phase 5 built for automatic consumption tied to a *service* being delivered (e.g. "Wound Dressing consumes 2× Gauze"). `sourceType: "product"` exists as an enum literal (`chargeSourceTypes`, schemas.ts line 5-14) meant for direct retail/product sale, but `adHocChargeSchema` (schemas.ts line 16-26) has **no `productId` field at all** — there is no way to even identify which product was sold on a `"product"`-sourced charge, let alone consume stock for it. Confirmed via grep: no other code path in `src/lib/domains/billing/*` references `sourceType === "product"`, and the POS UI (`src/app/(dashboard)/pos/*`) has no product-selection field anywhere.

**Consequence:** An invoice can be issued and fully paid for a "product" sale — a real, posted `Dr AR / Cr Revenue` journal entry, per postInvoiceIssued — with **zero corresponding stock ledger entry**. Inventory on-hand never decreases; the stock valuation report and the physical shelf silently diverge from day one of any product sold this way.

### B2. P1 §10 (POS FEFO allocation) is moot until B1 is fixed

Because no code path ties a POS product charge to a product/batch at all, FEFO allocation for POS sales isn't wrong — it simply never runs. Fixing B1 must include FEFO-safe allocation (reusing `consumeStock`, per A8's caveat) from the start, not bolted on after.

### B3. No COGS posting exists anywhere (P1 §11)

**File:** [src/lib/domains/accounting/posting-service.ts](src/lib/domains/accounting/posting-service.ts) (full file read)

There are eight named posting functions in this file; none of them posts `Dr Cost of Goods Sold / Cr Inventory Asset`. `postInvoiceIssued` posts only the revenue side (`Dr AR / Cr Revenue [+Unearned][+Tax]`). Since B1 means product sales don't even reduce inventory yet, there is currently no code path anywhere that could post COGS even if the schema had an account mapping ready for it (`PostingIntent` does not list a COGS-specific intent — `inventory_asset` exists for the goods-receipt side only).

### B4. Inventory valuation method is undocumented and, for accounting purposes, effectively undefined (P1 §12)

Goods receipts post `Dr Inventory / Cr AP` at each batch's actual `unitCost` (posting-service.ts line 264-288) — i.e. batch-specific actual cost is captured at receipt time and is available. But because there is no COGS posting (B3) and no product-sale-to-batch consumption (B1), no code path ever *reads* that cost back out to value a sale's cost of goods. There is currently no single documented, enforced valuation method (FIFO / moving average / batch cost) that both a stock valuation report and a future COGS posting would be guaranteed to agree on — this needs to be chosen and documented before B1/B3 are implemented, not derived after the fact from whatever the first implementation happens to do.

### B5. Stock adjustments (damage/expiry/write-off/gain/count correction) never post accounting entries (P1 §13)

**File:** [src/lib/domains/inventory/stock.ts:162-195](src/lib/domains/inventory/stock.ts#L162-L195)

`recordAdjustment` creates a `StockLedgerEntry` and an audit log entry (line 179-193) — no `writeOutboxEvent`, no call into `posting-service.ts` anywhere in this function. Writing off expired/damaged stock or recording a physical-count gain has real financial impact (the balance sheet's Inventory Asset value should move) but currently has none: the ledger moves, the books don't.

### B6. Supplier Invoice creates no accounting entry of its own — AP is actually driven by Goods Receipt, and the two can diverge (P1 §15)

**Files:** [src/lib/domains/procurement/supplier-invoices.ts:13-32](src/lib/domains/procurement/supplier-invoices.ts#L13-L32), [src/lib/domains/accounting/posting-service.ts:264-288](src/lib/domains/accounting/posting-service.ts#L264-L288)

`createSupplierInvoice` writes only a `SupplierInvoice` row — no `writeOutboxEvent`, no posting call. The actual `Dr Inventory / Cr AP` entry P1 §15 asks about is posted by `postGoodsReceiptCompleted`, keyed off the **Goods Receipt**'s line totals (`quantityReceived × unitCost`), not off the Supplier Invoice's own `amount` field. `SupplierInvoice.purchaseOrderId` is optional (schema allows `null`), so a supplier invoice can exist with no linked goods receipt at all — and even when one exists, nothing enforces `SupplierInvoice.amount === sum(linked GoodsReceipt totals)`. `recordSupplierPayment`'s outstanding-balance check (A3) compares against `SupplierInvoice.amount`, a number the GL's AP account was never actually credited for if it differs from — or is entirely independent of — the goods-receipt-driven posting.

**Consequence:** A supplier invoice for freight, a price adjustment, or any amount not exactly matching its goods receipt(s) has no accounting representation at all until a payment is recorded against it — at which point `postSupplierPaymentRecorded` posts `Dr AP / Cr Cash` against an AP balance that GL-wise was never credited for that specific liability, understating (or, if no goods receipt exists at all, entirely fabricating a debit against) Accounts Payable.

### B7. Goods receipt does not prevent receiving beyond the ordered quantity (P1 §16)

**File:** [src/lib/domains/procurement/goods-receipts.ts:23-107](src/lib/domains/procurement/goods-receipts.ts#L23-L107)

The function computes `allReceived`/`anyReceived` (line 84-87) purely to set the PO's *status* — there is no validation anywhere in `createGoodsReceipt` that rejects (or even warns on) a `line.quantityReceived` that, summed with prior receipts against the same `purchaseOrderLineId`, exceeds `PurchaseOrderLine.quantity`. A PO for 100 units can be received against for 40, then 60, then another 500 with no error.

### B8. Goods receipt has no idempotency protection (P1 §16 / §33)

**File:** [src/lib/domains/procurement/goods-receipts.ts:23-107](src/lib/domains/procurement/goods-receipts.ts#L23-L107)

Every call to `createGoodsReceipt` unconditionally creates a new `GoodsReceipt` + stock entries + a `GoodsReceiptCompleted` outbox event (which posts a real journal). A double-submitted request (network retry, double-click) creates two full physical-receipt records for one actual delivery — doubling both the stock and the AP liability, with no duplicate-detection of any kind.

### B9. Asset acquisition posts no accounting entry at all (P1 §17)

**File:** [src/lib/domains/assets/assets.ts:42-68](src/lib/domains/assets/assets.ts#L42-L68)

`createAsset` stores `input.cost` on the `Asset` row (line 62) but calls neither `writeOutboxEvent` nor any posting-service function. This isn't "posted as ordinary expense instead of a fixed asset" (the miscategorization P1 §17 warns against) — it's not posted anywhere at all. Acquisition cost is tracked on the Asset record for reference only; the general ledger never reflects the purchase.

### B10. Payroll postings bypass the outbox entirely — no transactional coupling, no retry, no dead-letter visibility (P1 §18 / §32 / §33)

**File:** [src/lib/domains/payroll/payroll.ts:143-180](src/lib/domains/payroll/payroll.ts#L143-L180)

Every other financial-posting trigger in this codebase (Invoice, Payment, Refund, Goods Receipt, Supplier Payment, Package Session) writes its state change **and** an outbox event in one transaction, then dispatches — so a posting failure lands in the P0-02 retry/dead-letter machinery with full admin visibility (`/admin/system-events`), and a crash between the state write and the posting call still leaves a durable, retryable event row. Payroll does not follow this pattern:

- `approvePayrollRun` (line 143-156): `db.payrollRun.update({ ..., status: "approved" })` **commits as its own statement**, then `await postPayrollApproved(payrollRunId)` runs as a **separate, unprotected call** (line 153) — not inside any transaction with the status update, not routed through `writeOutboxEvent`.
- `markPayrollPaid` (line 159-180): the status/commission update is wrapped in a transaction (line 165-175), but `await postPayrollPaid(payrollRunId)` (line 177) still runs **after** that transaction commits, entirely outside it and outside the outbox.

**Failure scenario:** `postPayrollApproved` throws (most plausibly: no `salary_expense`/`payroll_payable` account mapping configured — `resolveAccountId` throws exactly this error). The run's status has *already* committed to `"approved"` before that call even started. The error surfaces to the UI as a failure, but the payroll run is now stuck in `"approved"` status with **no journal posted and no way to retry** — `approvePayrollRun` immediately rejects a second call with `"already approved"` (line 147), and there is no outbox event, no dead-letter entry, no `/admin/system-events` row to retry from. The only recovery is a manual journal entry by an accountant who has to know this happened, since nothing in the UI flags it. This is the single clearest instance in the whole codebase of P1 §6's exact target failure mode: *operational transaction succeeds, financial posting silently fails with no recovery path.*

### B11. Provider commission is never reversed, adjusted, or flagged when a refund occurs (P1 §19)

**Files:** [src/lib/domains/payroll/commissions.ts](src/lib/domains/payroll/commissions.ts) (grepped in full — zero references to `refund`), [src/lib/domains/billing/refunds.ts](src/lib/domains/billing/refunds.ts)

`completeRefund` (refunds.ts) posts `postRefundCompleted` (reversing revenue) but never touches `CommissionAccrual`. Whether a provider's commission was accrued invoice-basis (at `InvoiceIssued`) or collected-revenue-basis (at `PaymentReceived`, keyed to the specific `Payment` row), nothing in the refund path looks up or adjusts the corresponding accrual. A provider who earned commission on revenue later refunded keeps the full commission unconditionally, every time — not a rare edge case, the *only* behavior, since there is no code path that does otherwise.

---

## Already covered — not re-findings

For completeness, three things P1.md's own §6 list touches that were already verified fixed in the P0 pass and are **not** re-raised here: `postJournal`'s idempotency-by-`(referenceType, referenceId)` check (prevents a *retried* outbox handler from double-posting the same business event — this is what makes Invoice/Payment/Refund/GoodsReceipt/SupplierPayment/PackageSession safe against outbox-level retries, as distinct from the request-level races in Pattern A above, which happen *before* any outbox event is even written); FEFO's exclusion of expired batches (P0-03, still holds — Pattern A8's concurrency gap is a different problem from the expiry-exclusion logic itself, which is correct); and the outbox's own atomic claim (`updateMany` with a status precondition, `src/lib/platform/outbox.ts` — this is *why* Pattern A's fix, when it comes, should reuse the same primitive rather than invent a new one).

---

## Summary table

| # | Area | Finding | Severity |
|---|---|---|---|
| A1 | Payments | Overpayment / lost update on concurrent `recordPayment` | High |
| A2 | Refunds | Over-refund / lost update on concurrent `completeRefund` | High |
| A3 | Supplier payments | Same race, AP side | Medium |
| A4 | Claims/remittance | Same race, races against A1 too | High |
| A5 | Invoices | Same charge billed on two invoices under concurrent `generateInvoice` | High |
| A6 | Packages | Overconsumption of last remaining session | Medium |
| A7 | Pharmacy | Double dispensing = double stock deduction + double charge | High |
| A8 | Inventory | FEFO consumption can oversell (negative balance) under concurrency | High |
| A9 | Cashier | Double-open of a cashier session | Low |
| B1 | POS/Inventory | Physical product sales never reduce stock | Critical |
| B2 | POS/FEFO | Moot until B1 fixed | — |
| B3 | Accounting | No COGS posting exists | Critical |
| B4 | Inventory | No documented/enforced valuation method for accounting | Medium |
| B5 | Inventory | Stock adjustments (damage/expiry/gain) post no accounting entry | High |
| B6 | Procurement | Supplier Invoice and the AP it implies can diverge from what's actually posted (via Goods Receipt) | High |
| B7 | Procurement | Over-receiving against a PO is not prevented | Medium |
| B8 | Procurement | Goods receipt has no duplicate-submission protection | Medium |
| B9 | Assets | Asset acquisition posts no accounting entry at all | High |
| B10 | Payroll | Payroll postings bypass the outbox — no transaction/retry safety net | Critical |
| B11 | Payroll | Commission never reversed/adjusted on refund | High |

Nothing above has been remediated in this pass — this document is the input to later P1 batches, per P1.md §6's explicit instruction to inspect and report before modifying finance logic.
