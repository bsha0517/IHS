# P3.9 — Finance / Accounting Operational UX

Scope: the accounting domain, Chart of Accounts, AccountMapping, Journals/lines, AR, AP, supplier invoices/payments, billing financial handoff, refunds/voids, financial periods, reconciliation, accounting-related outbox visibility/recovery, financial statements, and direct dependencies. P3.1–P3.8 are closed and untouched except where this batch's own findings directly overlapped (see Concrete Problems Found). No whole-system audit was run; unrelated findings were routed to `BACKLOG.md`.

---

## Existing Accounting Flows Traced

Traced in full before any code was touched, per this batch's own Step 1. The centralized posting service (`accounting/posting-service.ts`) was found to be a genuinely mature, P0/P1/P2-hardened system — every posting function funnels through one chokepoint, `postJournal`, which (a) checks debit=credit before writing anything, (b) is idempotent on `(organizationId, referenceType, referenceId)` — a second call for an already-posted reference returns the existing journal rather than creating a duplicate, and (c) calls `assertPeriodOpen` before writing, so a closed period blocks every posting function equally. Actual debit/credit behavior, from code:

| Event | Posting |
|---|---|
| **A. Invoice** (`postInvoiceIssued`) | Dr Accounts Receivable (full `totalAmount`) / Cr Revenue (non-package lines) / Cr Unearned Revenue (package lines, proportional discount split) / Cr Tax Payable |
| **B. Payment** (`postPaymentReceived`) | Dr [tender account per method] / Cr Accounts Receivable — one debit line per tender for a split payment |
| **C. Refund** (`postRefundCompleted`) | Dr Revenue / Cr [tender account] — reverses recognized revenue, not the receivable; commission reversal (`reverseCommissionsForRefund`) fires alongside for collected-revenue-basis commissions |
| **D. Product Sale** (`postProductSaleCogs`) | Dr Cost of Goods Sold / Cr Inventory Asset, valued at the FEFO-consumed batches' actual cost (specific identification) |
| **E. Invoice Void** (`postInvoiceVoided`) | Exact mirror of the original `postInvoiceIssued` journal (every line's debit/credit swapped) — reads back what was actually posted rather than recomputing, so it can never drift |
| **F. Supplier Invoice** (`postSupplierInvoiceCreated`) | Dr Goods Received Not Invoiced (PO-linked) or Dr Inventory Asset (standalone) + Dr Recoverable Tax / Cr Accounts Payable (`amount + taxAmount`) |
| **G. Supplier Payment** (`postSupplierPaymentRecorded`) | Dr Accounts Payable / Cr [tender account] |
| **H. Inventory Adjustment** (`postInventoryAdjustment`) | `direction: "out"`: Dr Inventory Write-off / Cr Inventory Asset. `direction: "in"`: Dr Inventory Asset / Cr Inventory Adjustment Gain. A `return`-type adjustment is deliberately never posted (documented, pre-existing) |

Also confirmed already built and correct, not invented this batch: manual journal entry (`postManualJournal`/`createManualJournal`, permission- and period-checked, client-side balance enforcement before submit is even possible); manual journal reversal (`reverseJournal`, scoped to `referenceType: "manual"` only — a domain-tied journal reverses through its own domain's void/refund workflow instead); full journal source traceability (`traceability.ts` — `resolveSourceReference`/`getRelatedJournals`, friendly labels, source navigation); Trial Balance, Income Statement, Balance Sheet, Cash Flow (defaulting to current month); AR (`/receivables`) and AP (`/payables`) pages with pagination; the general-purpose outbox/system-events admin queue (`/admin/system-events`) with retry, sweep, and stuck-event recovery already built in P0-P2.

## Concrete Problems Found

1. **Account Mappings UI could configure only 16 of the 22 real `PostingIntent` enum values** — `postingIntents` (accounting/schemas.ts) and a second, independently hardcoded list in `mapping-dialog.tsx` were both missing `cogs`, `inventory_write_off`, `inventory_adjustment_gain`, `goods_received_not_invoiced`, `recoverable_tax`, and `fixed_asset`. Seed data happens to pre-populate all 22 as org-wide defaults, so this was silent — but any org that ever needed to add a branch override, or recover from one of those 6 defaults being deleted, had **no way to do so except direct DB access**, guaranteeing a permanent, unrecoverable dead-letter for every goods receipt/inventory write-off/COGS posting/taxed supplier invoice/asset acquisition in the meantime. A live, financial-corruption-risk-class bug.
2. **Payables "Outstanding" balance omitted tax** — `listOutstandingSupplierInvoices`'s aggregate and the Payables page's per-row calculation both computed `amount - paidAmount`, silently dropping `taxAmount` from the real AP obligation (`amount + taxAmount`, the same total `recordSupplierPayment`'s own guard and `postSupplierInvoiceCreated`'s own credit already use). Understated what the organization actually owed on every taxed supplier invoice. The Finance dashboard's own "Payables" tile had the identical bug.
3. **Accountant could not reach any page after login** — `getManagementDashboard` (which the Accountant role qualifies for via `reports.export`) unconditionally called three `inventory.view`-gated functions (`listLowStock`, `listNearExpiryBatches`, `listMaintenanceDue`); Accountant does not hold `inventory.view`. This crashed the entire `/dashboard` landing page — the default post-login destination — for the primary role this batch exists to serve. Found live during this batch's own browser walkthrough, the same "unconditional fetch behind a permission the qualifying role doesn't hold" class of bug found and fixed in P3.2/P3.5/P3.6/P3.7's own domains.
4. **Accountant held no way to view invoices or payments** — the seeded Accountant role had `accounting.view` (gating the `/receivables` page itself) but not `invoice.view` (required by `listOutstandingInvoices`, which that page calls) or `payment.view`. `/receivables` — a page this batch's own §25 explicitly names — crashed on its very first read for the role it exists for. Also found live during the walkthrough.
5. **Accountant had no visibility into failed accounting postings at all** — `/admin/system-events` (the existing outbox/queue admin page) is gated on `system_events.view`/`system_events.retry`, which Accountant does not hold and should not be broad-granted (§42's own "never broad-grant... just to operate Finance"). Accounting-relevant failures were fully invisible to the only role that needs to see and recover them.
6. **No org-wide missing-mapping visibility** — the Account Mappings tab listed configured mappings but gave no indication of which of the 22 intents had no org-wide default at all — the exact condition that guarantees a posting failure.
7. **Pharmacy dispensing returns posted zero financial effect regardless of invoicing state** (the P3.6/P3.7 deferred item) — see Pharmacy Return Financial Review below.

## Improvements Implemented

- **`postingIntents`** (accounting/schemas.ts) extended to all 22 real `PostingIntent` enum values, now the single source of truth; `mapping-dialog.tsx`'s independent hardcoded copy removed in favor of importing it. Added `POSTING_INTENT_LABELS`, a friendly label for every intent (e.g. "Cost of Goods Sold", "Goods Received Not Invoiced"), used by the mapping dialog, the Mappings tab, and the new missing-mappings banner.
- **`listOutstandingSupplierInvoices`** and the Payables page's per-row calculation fixed to include `taxAmount`; the Payables page gained a Tax column; `getFinanceDashboard`'s Payables tile fixed the same way.
- **`getManagementDashboard`** — the three `inventory.view`-gated calls now check `can(session, "inventory.view")` first, degrading to empty results (0-count tiles) rather than crashing the whole dashboard for a role that can't see inventory.
- **Accountant role (seed.ts)** gained `invoice.view` and `payment.view` — deliberately read-only; `invoice.create`/`invoice.void`/`invoice.discount`/`payment.create`/`refund.*` stay Cashier/Clinic-Manager-only operational controls, per §30's own "never give Accountant cashier operational controls they don't need."
- **New Accounting Exceptions workspace** (`accounting/exceptions.ts`, a new "Exceptions" tab on `/accounting`): reuses `/admin/system-events`'s exact same `outboxEvent` table and retry/sweep mechanism (`retryOutboxEvent`/`processPendingOutboxEvents` — no second retry implementation), filtered to only the 13 event types that actually reach the posting service, gated on `accounting.view`/`accounting.post` instead of `system_events.view`/`system_events.retry`. Shows event type (friendly-labeled), created time, attempts, status, failure message, next retry time — never raw payload.
- **New Accountant landing "Overview" tab** on `/accounting` (now the default tab): failed-postings count (linking to Exceptions), outstanding receivables/payables totals with links, account-mapping configuration coverage (`22/22` or `N missing`, with the specific missing intents named), a closed-period notice, and the 8 most recent journals.
- **Missing-mapping visibility**: the Mappings tab now shows a banner naming every posting intent with no org-wide default mapping, computed from the same `postingIntents` list.
- **AR aging buckets** (`getReceivablesAging`, a small SUM-with-CASE extension of the same outstanding-invoice population `listOutstandingInvoices` already scopes/totals) added to `/receivables`: current (0-30d), 31-60, 61-90, over-90.
- **Journal detail dialog** now uses the real `REFERENCE_TYPE_LABELS` friendly labels (passed from the server, since `traceability.ts` is server-only) for both its own transaction-type line and any related/reversal journals, instead of a weaker local `replace(/_/g," ")` fallback.
- **Pharmacy return financial reversal** — see below.

## Finance / Accountant Workspace

New "Overview" tab, now the default landing tab for `/accounting`. Answers, at a glance: failed postings (count + link), outstanding receivables/payables (totals + links to the full pages), account-mapping coverage, closed-period notice, and the most recent journals. Deliberately operational, not a BI dashboard — no charts, no trend lines, just counts and direct links into the tab/page that explains each one.

## Chart of Accounts

Unchanged — already correct (code, name, type, parent hierarchy, create/edit dialog). No taxonomy redesign.

## Account Mappings

Fixed to cover all 22 real intents (was 16 in two independently-drifted places); friendly labels throughout; missing-org-wide-default banner added. Branch scope and account selection remain fully manual — nothing here auto-selects or guesses an account.

## Journals / Traceability

Unchanged architecturally (already excellent — filters, pagination, friendly source labels, source navigation, related/reversal-journal display, debit=credit verification shown per journal). Fixed the one remaining raw-label gap in the detail dialog (see above). Verified live: every journal opened during the walkthrough showed Total Debit = Total Credit; a journal whose source invoice had been deleted by an earlier, unrelated dev-environment session correctly showed "Invoice not found (may have been deleted)" rather than crashing — `resolveSourceReference`'s own designed graceful-degradation path, confirmed working under a real (if incidental) missing-record condition.

## Manual Journals

**Already exist**, fully built (`postManualJournal`/`createManualJournal`/`journals/manual-journal-dialog.tsx`) — not invented this batch. Verified: permission (`accounting.post`, branch-scoped), open-period enforcement (via the same `assertPeriodOpen` chokepoint every posting funnels through), debit=credit (both a live client-side running total that disables Submit until balanced, and the server-side `postJournal` check as the actual authority), date, description, account validation, branch, actor (`postedBy`), and audit (`auditFromSession`). Reversal (`reverseJournal`) also already exists, scoped to manual journals only, posts an exact mirror, and is guarded against reversing the same journal twice.

## Financial Periods

Unchanged — already correct. `AccountingPeriod` has no `branchId` column at all; periods are legitimately organization-wide by design (a period closes for the whole org, matching `assertPeriodOpen`'s own org-scoped, no-branch-filter check) — this is the §44 "organization-wide by design, don't force branch scoping" case, documented rather than changed. Close requires a reason (`closePeriod`'s `reason` param, required, non-empty); reopening is fully audited and never deletes the historical row. No complex month-end workflow was invented.

## Accounting Exception / Failed Posting Workflow

- **Closed-period failure**: `assertPeriodOpen` (unchanged, P1-era) throws inside `postJournal`, before anything is written, for every posting function equally — verified directly (a manual journal dated into a freshly-closed period is rejected with a clear message) and via the outbox-level scenario below.
- **Missing-mapping failure**: `resolveAccountId` throws a friendly `"No account mapping configured for \"{intent}\" — configure it under Accounting > Account Mappings."` — never a raw Prisma error. The new missing-mappings banner now lets an Accountant fix this *before* it ever causes a failure.
- **Retry/recovery**: the new Exceptions tab reuses `/admin/system-events`'s exact retry (`retryOutboxEvent` — resets attempts, re-queues for the next dispatch pass) and sweep (`processPendingOutboxEvents` — recovers stuck `processing` events and dispatches everything due) mechanisms verbatim, only narrowing *who* can reach them (via `accounting.view`/`accounting.post` instead of `system_events.view`/`system_events.retry`) and *which* events they see (the 13 accounting-posting event types only). No second retry implementation exists anywhere.
- **Duplicate-posting protection**: `postJournal`'s own `(organizationId, referenceType, referenceId)` existing-journal check is the actual mechanism — verified with a real invoice: `generateInvoice` posts once via the outbox, then `postInvoiceIssued` was called twice more directly (simulating exactly what a retry does); exactly one `Journal` row exists throughout.
- **The full P3.7 scenario, end to end**: verified via `test/integration/p3-9-finance-accounting-operational-ux.test.ts` — a real period is closed (a safe, far-past month, never the shared database's real current month, matching `accounting-period-control.test.ts`'s own established precedent for exactly this reason), a manual journal into it is rejected, a synthetic `failed` `OutboxEvent` (eventType `InvoiceIssued`, a period-closed-shaped `lastError`) is confirmed visible via `listAccountingExceptions`, the period is reopened, the event is retried via the same `retryAccountingException` the UI's Retry button calls (confirmed reset to `pending`/0 attempts), and a real invoice posted immediately afterward confirms exactly one journal exists for it. The whole scenario runs inside a `try/finally` that unconditionally reopens the period, plus a defensive `afterAll` re-open as a second guarantee — the shared database's real current-month period was never touched.

## Accounts Receivable

Unchanged page/list logic (already paginated, already correct `totalAmount - paidAmount`, already branch-scoped). Fixed: Accountant can now actually reach the page (see Concrete Problems Found #4). Added: basic aging buckets (current/31-60/61-90/over-90), a genuinely small extension of the existing outstanding-invoice query, not a new aging engine.

## Accounts Payable

Fixed the tax-omission bug (see above) in both the page and its underlying aggregate; preserved P2's already-correct pagination-then-filter fix (`listOutstandingSupplierInvoices` filters in the WHERE clause, not after fetching); preserved P3.8's branch-scoping fix. No Procurement rebuild.

## Reconciliation

**Does not exist** — confirmed by a direct schema search (`prisma/schema.prisma`), not inferred from an absent page. No `BankStatement`/`Reconciliation`/equivalent model, no domain file, no UI. The closest existing concept, `getPatientStatement`'s own internal `reconciled: boolean`, is an entirely different thing (one patient's own running-balance self-consistency check, not bank/cash-against-ledger reconciliation). Per this batch's own explicit "don't assume, don't build a whole reconciliation feature un-prompted" instruction, this was documented rather than built — a real bank/cash reconciliation feature (statement entry, transaction matching, matched/unmatched tracking) is genuine new architecture, not a trivial extension. See `BACKLOG.md` for the precise design recommendation.

## Financial Statements

Trial Balance, Income Statement, Balance Sheet, Cash Flow all unchanged (already correct, already using `getFinancialStatements`'s shared single-scan optimization from P2). Verified live against real fixture-adjacent production data: Trial Balance's Total Debit = Total Credit (737.80 = 737.80); Balance Sheet's Total Assets = Total Liabilities + Total Equity (680.20 = 0.00 + 680.20); Cash Flow correctly defaulted to the current month with a visible date range. No formula was rewritten — no concrete defect was found in any of the four.

## Pharmacy Return Financial Review

**Path A implemented for one safe, fully-determinable sub-case; Path B (deferred, with a precise design recommendation) for the rest.** This is more precise than a single binary choice because the trace surfaced a real, clean boundary between a case the existing models CAN safely close and a case they genuinely cannot yet:

- **Traced**: `DispensingRecord.chargeId` is a real, unique FK to `Charge`, always set once dispensed. `InvoiceLine.chargeId` is likewise a real, unique FK — so a returned dispensing's own `Charge` (and, once invoiced, its own `InvoiceLine.lineTotal`/`taxAmount`/`discountAmount`) *are* reliably determinable, even on a multi-line invoice. This is more than P3.7's original finding established.
- **The real blocker, precisely identified**: `PaymentAllocation` (billing/invoices.ts) is invoice-level only — there is no line-level payment allocation anywhere in the model. On a multi-line, partially-paid invoice, there is no way to know whether the specific returned line was ever actually paid, is still fully outstanding, or was covered by a payment really intended for a sibling line. `Refund` (confirming P3.7's original finding) is also invoice-level lump-sum with no charge/line linkage.
- **Path A implemented**: a **full** return (every unit dispensed, across all `DispensingReturn` rows) of a charge that is still `status: "pending"` (never invoiced) is now completely, correctly closed — the charge is voided and its COGS journal reversed via the exact same charge-id-keyed `postProductSaleVoided`/`ProductSaleVoided` mechanism `voidCharge` already uses for a POS sale. This state has zero ambiguity (no `InvoiceLine`, no revenue ever recognized, no payment ever possible), so every leg is genuinely closed, not partially.
- **Path B (deferred) for**: a return of an already-`invoiced` charge, and a **partial** return of a still-pending charge (the charge has no supported way to reduce its own quantity/amount in place). Both return `financialReversal: "manual_review_required"` — stock is still restored, but the charge is never silently mutated. Precise design recommendation (in `BACKLOG.md`): a `CreditNote`/line-level payment-allocation extension.
- **Safety at minimum (§39), satisfied regardless of path**: `return-dialog.tsx` now states up front, before submission, that a return restores stock only and does not automatically refund/credit money; after submission it reports the actual outcome via a toast (`"...the original charge/cost were reversed"` vs. `"...no revenue/refund was reversed automatically. Route to Accounting for manual review."`) rather than closing silently.
- Verified via three integration tests (full pre-invoice return → charge void + COGS reversal journal exists; full post-invoice return → charge untouched, no reversal journal, `manual_review_required`; partial pre-invoice return → charge untouched, `manual_review_required`).

## Security / Branch Scoping

- `createManualJournal`/`reverseJournal`: already correctly branch-scoped (`accounting.post` checked with `{branchId}`).
- `closePeriod`/`reopenPeriod`: correctly *not* branch-scoped — `AccountingPeriod` has no `branchId` column; periods are legitimately organization-wide (§44 case, documented above).
- `supplier_invoice.manage`/`recordSupplierPayment`: branch-scoped (P3.8 fix, preserved, re-verified unchanged).
- `listJournals`/`getJournal`/`listOutstandingInvoices`/`listOutstandingSupplierInvoices`/`getReceivablesAging`: all branch-scoped via `narrowBranchFilter`/`assertBranchAccess`, never trusting a client-supplied branch id.
- The new `listAccountingExceptions`/`retryAccountingException`/`sweepAccountingExceptions` are gated on `accounting.view`/`accounting.post` (not `system_events.*`), and `retryAccountingException` additionally re-filters to `eventType: { in: ACCOUNTING_EVENT_TYPES }` server-side — an Accountant session cannot use this narrowed permission to retry an unrelated (HR/clinical/notification) event even by guessing its id.
- Accountant's widened permissions (`invoice.view`, `payment.view`) are deliberately read-only; no clinical editing, pharmacy dispensing, inventory adjustment, or HR administration permission was added.

## Performance

- No new N+1s introduced. `listAccountingExceptions` uses one `findMany` + one `groupBy` (for the `needsAttention` count), not a per-row query.
- `getReceivablesAging` is one additional raw SQL aggregate per Receivables page load (not per row).
- P2's Balance Sheet/Income Statement/Trial Balance single-scan optimization (`getFinancialStatements`) is unchanged.
- Pagination preserved everywhere it already existed (journals, invoices, supplier invoices); the new Exceptions tab is paginated the same way `/admin/system-events` already is.
- No Redis/caching added.

## Files Changed

**Domain logic:**
- `src/lib/domains/accounting/schemas.ts` — `postingIntents` extended to all 22 values; `POSTING_INTENT_LABELS` added
- `src/lib/domains/accounting/exceptions.ts` — new (Accounting Exceptions workspace domain functions)
- `src/lib/domains/procurement/supplier-invoices.ts` — AP outstanding-balance tax fix
- `src/lib/domains/billing/invoices.ts` — `getReceivablesAging` added
- `src/lib/domains/analytics/dashboards.ts` — `getManagementDashboard`'s unconditional inventory-gated calls fixed; `getFinanceDashboard`'s payables tax fix
- `src/lib/domains/pharmacy/dispensing.ts` — `returnDispensingRecord` financial-reversal logic
- `prisma/seed.ts` — Accountant role gained `invoice.view`, `payment.view` (re-seeded on both `his_dev` and `his_test`)
- `src/app/(dashboard)/inventory/transfer-dialog.tsx` — incidental: this batch's own `npm run lint` surfaced a `react-hooks/set-state-in-effect` violation in P3.8's own code (an updated eslint-plugin-react-hooks rule, not something P3.9 introduced or a change in behavior). Fixed narrowly — moved the batch-selection reset into the two Select `onValueChange` handlers instead of the data-fetching effect's own body — to keep the regression check honest; no functional change to P3.8's transfer behavior.

**UI/actions:**
- `src/app/(dashboard)/accounting/page.tsx` — Overview tab, Exceptions tab, missing-mappings banner, friendly journal-detail label wiring
- `src/app/(dashboard)/accounting/mapping-dialog.tsx`, `journal-detail-dialog.tsx`, `actions.ts`, `exception-retry-button.tsx` (new), `exception-sweep-button.tsx` (new)
- `src/app/(dashboard)/payables/page.tsx` — tax column/fix
- `src/app/(dashboard)/receivables/page.tsx` — aging buckets
- `src/app/(dashboard)/pharmacy/actions.ts`, `[id]/return-dialog.tsx` — financial-reversal outcome messaging

## Tests — new + total

New: `test/integration/p3-9-finance-accounting-operational-ux.test.ts` — 10 tests covering: `postingIntents`/`POSTING_INTENT_LABELS` completeness against the real Prisma enum; outbox-retry idempotency (two direct re-posts of one invoice → exactly one journal); the full closed-period → visible-exception → reopen → retry → posts-exactly-once scenario; the Exceptions view's event-type scoping; the AP tax-outstanding fix; AR aging bucket sanity; pharmacy-return Path A (full pre-invoice return closes charge + COGS); pharmacy-return Path B (invoiced return, and partial-pending return, both correctly deferred without mutating the charge).

Total: **51 test files, 350 tests, 350/350 passing** (baseline was 50 files/340 tests entering this session).

## Browser Verification

Performed against `his_dev`, logged in as a real fixture "Accountant"-role user (`p3-9-walkthrough@avant.local`), with real fixture patient/charge/supplier/supplier-invoice data (300 + 30 tax):

- Confirmed the dashboard crash (Concrete Problems Found #3) live, fixed it, reloaded, confirmed clean load with correct 0-count inventory tiles and a correct `Payables: 330.00` finance tile.
- Confirmed the `/accounting` crash (#4) live, fixed the seed permissions, re-seeded both databases, reloaded without needing to re-login (session permissions resolve live, not from a stale cached token) — Overview tab rendered fully: failed postings 0, outstanding payables 330.00, account mappings 22/22 (all configured), 8 recent journals with friendly transaction-type labels.
- Journals tab: 16-type friendly-labeled filter dropdown confirmed complete; opened a real journal (JRN-000016, Invoice) — debit=credit shown (10.00/10.00), branch/posted-by/date all present, source-transaction section correctly showed a graceful "not found" for a source record deleted by an earlier, unrelated dev-environment session (proving the designed fallback, not a crash).
- Exceptions tab: 21 real historical accounting postings shown, all correctly friendly-labeled and scoped (no unrelated event types leaked in); status filter (`failed`) correctly returned an empty state.
- Account Mappings tab: all 22 intents shown with friendly labels and no missing-mapping banner (fully configured); opened "Set mapping" and confirmed "Fixed Asset" (one of the 6 previously-missing intents) is now a selectable option.
- Trial Balance (737.80 = 737.80), Income Statement (Net Income 680.20), Balance Sheet (680.20 = 0.00 + 680.20) all confirmed balanced; Cash Flow confirmed defaulting to the current month.
- Periods tab: existing history (a September 2026 period, closed then reopened by an earlier P3.7 test) displayed correctly.
- `/receivables`: previously-crashing page now loads; aging buckets render (all 0.00, no outstanding invoices at the time of the walkthrough).
- `/payables`: correctly shows Amount 300.00 / Tax 30.00 / Outstanding 330.00 for the fixture supplier invoice — direct live confirmation of the tax fix.
- Pharmacy Return Review: verified via the three integration tests described above rather than a separate live UI pass under a Pharmacist-role login (the automated tests assert directly on the underlying financial state — Charge status, Journal existence — which is a stronger correctness check than visually reading dialog text; the new `return-dialog.tsx` copy itself was verified by direct code review).

Fixtures (one Accountant-role user, one patient, one charge, one supplier, one supplier invoice) were created via a temporary setup script and fully removed via a temporary cleanup script afterward; both scripts were deleted from the repository once the walkthrough was complete. No real `his_dev` accounting state (existing journals, periods, accounts) was modified or deleted.

## Remaining Finance/Accounting Backlog

Logged to `BACKLOG.md` (not fixed here, each with its own reasoning):
- **New**: no bank/cash/ledger reconciliation model or UI exists — documented, with a precise design recommendation, rather than built (genuine new architecture, not a trivial extension).
- **Updated**: the pharmacy-return financial-reversal backlog entry — now marked partially resolved (Path A for the safe pre-invoice case), with a materially more precise architectural finding (the real blocker is `PaymentAllocation`'s lack of line-level granularity, not `Refund`'s shape alone as P3.7 first suspected) and design recommendation for the remaining invoiced-return case.

No other new out-of-scope findings surfaced during this batch's trace that weren't already either fixed or pre-existing/documented elsewhere.

## Regression Status

- `npx prisma validate` — schema valid.
- `npx prisma migrate status` — database schema up to date, no pending migrations (this batch made no schema changes).
- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npm run test:integration` (full suite) — **51 files, 350/350 passing**, run against local PostgreSQL `his_test` (`localhost:5433`) via this project's standard `TEST_DATABASE_URL`/`TEST_DIRECT_DATABASE_URL` substitution (`test/setup-test-database.ts`). Remote Supabase was **not** used by any integration test in this session.
- `npm run build` — clean production build (Turbopack), full route manifest generated, no type errors.
- Browser walkthrough was run against local PostgreSQL `his_dev` (`localhost:5433`); all temporary fixtures were created and removed via temporary scripts, which were deleted afterward. `prisma/seed.ts`'s Accountant-role permission change was applied to both `his_dev` and `his_test` via `prisma db seed`.

No credentials appear in this report.

---

Per §55: stopping here. Not beginning P3.10, HR/Payroll UX, Notifications, Admin/Settings, P4, or country-specific financial regulations. Awaiting review and explicit instruction to continue.
