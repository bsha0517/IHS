# SYSTEM_AUDIT.md

A comprehensive, read-only audit of the Avant HIS codebase against Audit.md's 18-section spec. Findings are verified against actual source (schema, routes, server actions, domain services) — not inferred from file/route/model names or from PROJECT_STATUS.md's own claims. Where PROJECT_STATUS.md/ARCHITECTURE.md/SECURITY.md/DATABASE.md's self-description was checked against code and found accurate, that is noted; where it wasn't, the discrepancy is called out explicitly.

No code was changed in the course of this audit.

---

## Executive Summary

The system is substantially more real than a typical "demo that compiles" — there is no hardcoded dashboard data, no mock arrays standing in for queries, no fake charts, and no forms that silently fail to persist anywhere in the codebase. Money is stored as `Decimal`, never `Float`. Double-entry accounting is enforced at two independent layers (application-level sum check *and* a Postgres deferred constraint trigger). Duplicate MRNs, duplicate invoice numbers, and doctor/room double-booking are all prevented by real database constraints, reused consistently across every booking path including the newer public-booking flow. The core patient journey — registration through encounter, diagnosis, prescription, charge, invoice, payment, and GL posting — is genuinely automated end to end via a transactional outbox pattern, not manually re-keyed at each step. RBAC is enforced by a single real chokepoint (`assertCan()`), consistently applied across the ~25+ domain files sampled, and five of the six named cross-role security boundaries (Receptionist→Clinical Notes, Doctor→Payroll, HR→Clinical Records, Cashier→Salary, Inventory→Accounting) are correctly blocked server-side.

But the system is not ready for real clinic operations, for reasons that have nothing to do with polish. **The sixth boundary — branch data isolation — is not enforced on read paths at all**: any authenticated user with base list/view permissions can read another branch's invoices, appointments, and patients, regardless of `user_branch_access`. **Journal-posting and commission-accrual failures are silently swallowed and never retried**, despite a code comment claiming otherwise — meaning the general ledger can quietly diverge from operational reality with zero error surfaced to anyone. **Expired inventory batches are not excluded from FEFO allocation**, so pharmacy dispensing and procedure consumption can hand out expired stock. **Password reset is both unreachable from the UI and non-functional** even if invoked directly. **Cascading deletes are configured on clinical documentation (an entire encounter's vitals/diagnoses/notes/orders/lab results/prescriptions) and on financial ledger detail**, contradicting the codebase's own stated immutability discipline, though no current code path actually triggers them. And **automated test coverage is essentially absent** for every area Audit.md specifically flags as highest-risk: authentication, authorization, invoice/payment/refund calculations, payroll, and clinical finalization.

None of this requires a rebuild. It requires a focused pass on exactly the things Audit.md's own prioritization (§17) names: data-loss risk, security, clinical and financial integrity, inventory integrity, broken workflows, authorization, then performance and UX.

---

## Critical Issues

1. **Branch data isolation is not enforced server-side on reads.** `listInvoices`, `getInvoice`, `listAppointments`, `getPatient`, and likely others filter only by `organizationId`; `branchId` is an optional caller-supplied filter, never derived from or checked against the session's `user_branch_access`. A Branch A user with ordinary `invoice.view`/`patient.view` permissions can read Branch B's financial and clinical records by omitting a filter or navigating directly to a record URL. *(Security)*
2. **Journal-posting and commission-accrual failures are silent and never retried.** `dispatchPendingOutboxEvents` marks a failed handler's event `status: "failed"` but only ever re-queries `status: "pending"` — there is no code path that resets a failed event, and no admin surface to detect or replay one. The function's own doc comment claims "leaves the event pending to retry"; the code does not do this. If `postInvoiceIssued` throws (e.g., a missing `AccountMapping`), the invoice still shows as issued to the user, and the transaction it should have produced simply never exists — logged only to `console.error`. Independently found by two separate investigations of unrelated modules (revenue/accounting and inventory/procurement), which increases confidence this is real. *(Financial integrity / Data loss)*
3. **Expired stock is not excluded from FEFO allocation.** `listAvailableBatchesInternal` orders available batches by `expiryDate asc nulls last` for FEFO selection with no filter excluding already-expired batches — meaning an expired batch, being earliest-expiry, is preferentially consumed *first*, by both pharmacy dispensing and procedure-linked inventory consumption. Independently confirmed by two separate investigations. *(Clinical/patient safety integrity)*
4. **Password reset is unreachable and non-functional.** No "Forgot password?" link exists anywhere in the UI, the wiring action is never imported, and even called directly the underlying function only `console.log`s the reset token — no delivery mechanism exists. A locked-out staff member has no self-service path. *(Broken workflow / Security)*
5. **Dangerous cascading deletes are configured on clinical and financial data with no compensating DB-level protection.** `onDelete: Cascade` is set from `Encounter` onto `VitalSign`, `Diagnosis`, `ClinicalNote`, `ClinicalOrder` (and everything chained beneath it — lab results, imaging reports, prescriptions); from `Patient` onto `PatientAllergy`/`PatientCondition`/`PatientMedicationHistory`; and from `Journal`/`Invoice`/`Payment` onto their line-item/allocation detail — directly contradicting explicit in-schema comments stating these records are "never deleted, only reversed/amended." No current application code path triggers a delete on these models, so today's practical risk is low, but nothing in the schema or DB privileges prevents it, and there is no lower-privileged DB role with UPDATE/DELETE revoked to provide defense in depth. *(Data loss risk)*
6. **Audit-log immutability is convention-only, not DB-enforced, despite a code comment claiming otherwise.** `src/lib/platform/audit.ts:26` states DB-level privilege enforcement "lands in Phase 14." No migration — including the one literally named `phase14_indexing` — contains a `REVOKE` statement. Application code never updates/deletes these rows today, but a compromised credential or a future careless change could, with nothing at the database level to stop it. *(Security / Audit integrity)*

## High Priority

7. **Refund double-completion race.** `requestRefund` checks the requested amount against `invoice.paidAmount`, but `paidAmount` is only decremented at completion — two concurrent refund requests against the same invoice can each individually pass the check, both be authorized, and both complete, posting more in refunds than was ever paid on the invoice. *(Financial integrity)*
8. **POS retail product sales don't deduct inventory.** Ad-hoc charges with `sourceType: "product"` have no `productId` field and never call `consumeStock` — a retail product sale generates real revenue with zero inventory deduction. *(Inventory integrity)*
9. **Standalone supplier invoices can drive Accounts Payable negative.** `SupplierInvoice.purchaseOrderId` is optional and the dialog to create one is reachable without a PO/goods-receipt link; AP is only ever credited by goods-receipt posting, so paying a PO-less supplier invoice debits AP with no matching credit ever posted. *(Financial integrity)*
10. **No GL posting exists for three real transaction types**: asset purchases (`Asset.cost` recorded with zero accounting impact), inventory adjustments/write-offs (stock value changes with no journal trace), and inventory consumption/COGS at the point of sale (revenue is recognized on the invoice; the matching cost is never expensed). *(Financial integrity)*
11. **Lab specimen reject/receive and result entry lack server-side status guards.** Enforced only by hiding the relevant UI button in the wrong state — a direct server-action call can reject an uncollected specimen, receive it twice, or enter a result before collection. Contrast with the otherwise-consistent enter/verify guard pattern used everywhere else in the codebase (pharmacy, radiology, lab verification itself). *(Workflow / data integrity)*
12. **Leave balance is never enforced.** `requestLeave` never reads `LeaveBalance`; an employee can request, and have approved, leave far beyond their allocation. The balance figure shown in the UI is informational only. *(Broken workflow)*
13. **Notifications are write-only.** Real rows are created for lab-ready, imaging-ready, and patient-waiting events; nothing in the application ever reads them, and there is no bell icon or notification UI at all. *(Broken workflow — see FAKE_OR_INCOMPLETE_FUNCTIONALITY.md #2)*
14. **Communications never deliver, and failure is invisible at the point of the click.** All three channel adapters always fail by design (honestly, no fake delivery) — but the UI doesn't surface that failure when staff click "Send," only in a separate History tab. *(Broken workflow — see FAKE_OR_INCOMPLETE_FUNCTIONALITY.md #3)*
15. **Primary clinical nav links (Episodes/Encounters/Orders) dead-end at placeholder pages** while the real encounter workspace exists at a different, unlinked URL. *(UI/UX — see FAKE_OR_INCOMPLETE_FUNCTIONALITY.md #5)*
16. **`rescheduleAppointmentAction` and `updateProviderAction` are fully built and completely unreachable**, plus nine dead "deactivate" catalog actions. *(Broken workflow — see FAKE_OR_INCOMPLETE_FUNCTIONALITY.md #4)*
17. **Report provider filter silently ignored on 5 of 7 report tabs.** *(Reporting integrity — see FAKE_OR_INCOMPLETE_FUNCTIONALITY.md #6)*
18. **Missing indexes on exactly the columns the dashboard queries by date range**: `Invoice.issuedAt`, `Payment.receivedAt`, `Charge.createdAt` have no supporting index, while comparable tables (`Expense`, `AttendanceRecord`) are correctly indexed the same way — a clear, fixable inconsistency, not a fundamental gap. *(Performance)*
19. **Commission accrual issues up to ~90 sequential DB queries inside one open transaction** for a multi-line, multi-payment invoice, on the POS checkout hot path — a real throughput/lock-contention risk under concurrent cashier load, worsening as invoice volume grows. *(Performance)*
20. **Automated test coverage is effectively absent for the highest-risk areas.** Of the 13 areas Audit.md names as needing tests, only Commission calculation is well-covered; 8 have zero coverage, including Authentication, Authorization, Invoice calculations, Payments, Refunds, Payroll, and Clinical finalization. *(Testing gap)*
21. **Missing FK relations on ~48 "actor" fields** (`createdBy`, `verifiedBy`, `authoredBy`, etc.) across nearly every model — contradicts DATABASE.md's own documented convention that these should be real FKs to `User`. *(Database design)*
22. **Accounting postings generate no audit_log entry of their own** — only indirectly covered via the audit entry of the triggering business event. **`clinical_access_log` has no admin viewer UI at all**, despite the permission that gates it explicitly promising one in its own seed description. *(Audit trail)*

## Medium Priority

23. Batch-blind inventory adjustments (no batch selector in the write-off dialog) desync per-batch FEFO balances from the aggregate stock total.
24. `AccountMapping.intent` is a bare `String` despite being documented as a fixed 14-value enum — a real schema/documentation mismatch.
25. Missing uniqueness constraints on `User.username` and `Provider.licenseNumber`.
26. Missing `updatedAt` on `Invoice`, `Charge`, and `Payment` — all three mutate in place after creation.
27. Branch-isolation inconsistency at the column level: `VitalSign`/`ClinicalOrder` carry `branchId` directly; sibling `Diagnosis`/`ClinicalNote`/`Prescription`/`FollowUpRecommendation` don't, with no documented reason for the split.
28. No pagination anywhere in Reports; CSV-only export (no Excel/PDF); Invoices list and Stock Ledger are hard-capped (100/200 rows) with no way to reach older records.
29. Systemic unbounded-historical-aggregation pattern: cash position, income statement, and inventory balance are all recomputed by summing full history on every read, with no materialized/running balance anywhere. Fine today, all three become simultaneous bottlenecks at the volumes spec.md targets.
30. No payslip document exists — only a payroll-run ledger table covering all employees, not an individual payslip.
31. `ProcedureCompleted`, named in ARCHITECTURE.md's own event table and workflow diagram, is never registered or fired anywhere — Procedure→Charge is entirely manual, contradicting the documented diagram.
32. `listPatientMedicationHistory` (pharmacy) and lab's `"processing"` status enum value are both dead/unused.
33. `SESSION_SECRET` is required and validated but never actually consumed by any code path.
34. One layering violation: a raw Prisma call directly inside a page component (`queue/page.tsx`) instead of going through the domain-service layer used everywhere else.
35. No structured server-side logging anywhere — only ~8 ad hoc `console.*` calls, most inside error boundaries.

## Low Priority

36. `ChartOfAccount.parentAccountId` self-relation has no DB-level cycle guard.
37. `Room.roomType`/`Service.requiredRoomType` matched by free-text convention with no shared enum — a typo in either silently breaks room-matching.
38. `PatientStatus` has no merged/duplicate-record state; `AllergySeverity` has no distinct life-threatening tier.
39. Largest files in the codebase (`accounting/page.tsx` 394 lines, `patients/[id]/page.tsx` 365 lines) are markup-heavy multi-tab page components, not logic-dense — a maintainability nice-to-have to split, not a correctness concern.
40. `getTaxRate` is queried once per invoice line instead of loaded once and mapped in memory — trivial cost today (tiny config table), multiplies round-trips on the checkout path.

---

## Architecture Problems

- The outbox/event pattern (the system's core automation mechanism, wiring the entire patient-journey and revenue chain together) has a real reliability gap: failure is terminal and silent (Critical #2). This is the single most consequential architectural finding — it undermines trust in every "automatic" link the rest of the audit otherwise confirms works correctly in the happy path.
- No materialized/cached balance anywhere (cash position, trial balance/income statement, inventory on-hand) — architecturally consistent (nothing wrong with deriving from history), but all three will need the same fix simultaneously once transaction volume grows, and there's no shared mechanism for it today.
- No structured logging or request tracing exists at all — for a system this size, diagnosing a production issue (including the silent outbox failures above) currently depends entirely on manually querying the database.
- The dead-code pattern (fully-built actions/functions with zero UI callers, notifications with zero readers) suggests build velocity outpaced UI wiring in the later phases — worth a systematic "is everything we built actually reachable" pass before adding new domains.

## Database Problems

See Critical #5, #6 and High #21, #22, #24-27 above. In summary: currency handling, business-document uniqueness (MRN/invoice/claim numbers), and the soft-delete-vs-status-field policy are all genuinely solid. The two real structural gaps are the schema-wide absence of FKs on actor/attribution fields, and cascading deletes configured on data the codebase's own comments say should never disappear.

## Security Problems

See Critical #1, #6 and High #22 above. Authentication (password hashing, lockout, session handling, the patient portal's isolated auth context) is genuinely solid and matches SECURITY.md's own description. RBAC's chokepoint is real and consistently applied — five of six named cross-role boundaries are correctly blocked server-side. The one boundary that fails (branch isolation on reads) is a significant, concretely exploitable gap, not a theoretical one.

## Workflow Problems

See Critical #3, #4 and High #7-#17 above, plus the Patient Journey/Lab/Pharmacy/Procurement/HR trace details in this audit's supporting research. The automated linkages that were built (registration→appointment→encounter→charge→invoice→payment→GL, leave-approval→scheduling-block, goods-receipt→AP) genuinely work as designed. The breaks are concentrated in: things that were built but never wired to a button (dead actions), things that fail silently instead of loudly (outbox), and one entire nav-linked workflow (Episodes/Encounters/Orders top-level pages) that leads nowhere.

## UI/UX Problems

Spot-verified live in-browser (dashboard, patients, POS, invoices, reports, settings, mobile viewport, a dangerous-action confirmation flow) in addition to the code-level findings above:
- Dangerous actions (invoice void, confirmed live) do trigger a real confirmation dialog with mandatory reason capture — this pattern is good and should be the template, not the exception.
- Content renders correctly at a 375px mobile viewport (structural check only — full pixel-level responsive QA wasn't possible in this session without visual screenshot capability).
- The Reports page, live, briefly surfaced a genuine transient Supabase-pooler connection error ("Connection terminated unexpectedly") — caught gracefully by a real error boundary rather than crashing white-screen, which is a positive resilience signal, though it's a known dev-environment pooler quirk this project has documented before, not a new regression.
- The single most consequential UX problem is Critical #4/High #15 above: the sidebar's own primary clinical navigation items lead to dead placeholder pages for Doctor/Nurse roles.
- A full role-by-role walkthrough (Receptionist/Doctor/Nurse/Cashier/Clinic Manager/Inventory Manager/HR Manager/Accountant, as Audit.md §11 asks for) was not exhaustively performed live for every role in this session — the findings above are drawn from a combination of live spot-checks as Super Admin and structural code review of each role's pages. A dedicated live UX pass per role is a reasonable follow-up before real deployment.

## Performance Problems

See High #18, #19 and Medium #28, #29, #40. Summary: the team clearly knows the correct patterns (batched `Promise.all` dashboard queries, one `groupBy` for stock summaries, debounced search) and applies them in most places — the gaps found are specific and fixable, not systemic incompetence: three missing date indexes on the busiest tables, one N+1 on the checkout hot path, and the shared unbounded-aggregation pattern named above.

## Testing Gaps

See High #20. The 10 test files that exist (8 unit, 2 real-database integration) are well-targeted at genuinely tricky logic — FEFO ordering, commission tier boundaries, booking-constraint error translation, the journal-balance DB trigger — not superficial. All 51 tests pass. The gap is coverage *surface*, not test *quality*: exactly the areas this audit independently flagged as highest-risk (branch isolation, refund races, invoice math, payroll) have zero automated protection against regression.

## Missing Features

- CRM/Lead management — confirmed absent, honestly represented as "Coming Soon," matches PROJECT_STATUS.md's documented scope decision (not in spec.md's literal Phase 12 list).
- Payslip document (only a payroll-run ledger view exists).
- Notification viewer UI (bell/inbox) for the `Notification` rows the system already writes.
- `clinical_access_log` viewer UI.
- Excel/PDF report export.
- Any live SMS/WhatsApp/email provider integration (by design, honestly stubbed).
- Self-service password reset delivery mechanism.

## Technical Debt

- Dead code: `listPatientMedicationHistory`, unused `"processing"` lab status, unused `SESSION_SECRET`, unused dashboard `branchId` parameter, nine dead deactivate actions, two dead-end mutation actions.
- No structured logging/observability layer.
- No lower-privileged DB role separate from the migration-running role (documented in SECURITY.md as a known gap since Phase 14).
- Documentation/schema drift: `AccountMapping.intent` documented as an enum but implemented as a string; ARCHITECTURE.md's event table lists `ProcedureCompleted` as if wired when it isn't.
