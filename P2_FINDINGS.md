# P2_FINDINGS.md

Batch 0 of the P2 pass (P2.md §2): verifies every historical P2-relevant finding from SYSTEM_AUDIT.md (Medium/Low priority + High #18/#19) and IMPROVEMENT_ROADMAP.md's P2 tier against the current codebase, after the P0 and P1 remediation passes. No code changed in this batch — verification only, via direct schema/source reads, not assumption. Later batches implement the CONFIRMED items below, in P2.md's own §3-§21 order. Findings are cited to file/line evidence gathered this batch, not carried forward from the old audit unchecked.

Status key: **CONFIRMED** (still real, unfixed) · **ALREADY FIXED** (P0/P1 closed it, not previously credited) · **PARTIALLY FIXED** · **NO LONGER APPLICABLE** · **NEWLY DISCOVERED** (found this batch, not in the original audit).

---

## §3. Database Index Review

**CONFIRMED.** The three originally-named columns are still unindexed, verified directly against `prisma/schema.prisma`:
- `Charge`: indexes on `(organizationId, patientId, status)`, `encounterId`, `branchId`, `providerId`, `serviceId`, `productId` — **no index touches `createdAt`**.
- `Invoice`: indexes on `(organizationId, patientId, status)`, `branchId`, `providerId`, `payorId` — **no index touches `issuedAt`**.
- `Payment`: indexes on `cashierSessionId`, `branchId`, `claimId` — **no index touches `receivedAt`**.

Phase 14's 34-index pass (DATABASE.md) targeted FK columns specifically and correctly skipped these three (they're not FKs) — so this was never actually addressed, just out of that pass's stated scope. Real query-pattern review (which date-range combos matter, not blind indexing) is later-batch implementation work.

## §4. Commission Performance / N+1

**CONFIRMED.** `payroll/commissions.ts`'s payment-basis accrual (`accruePaymentBasisCommissions`) is a nested loop — `for (const payment of payments) { for (const line of invoice.lines) { ... await tx.commissionAccrual.findFirst(...) ... } }` — one existing-accrual query per (payment × line) pair, plus `resolveCommissionRule`'s own 2 queries called from inside that same nesting. For a multi-line, multi-payment invoice this reproduces the ~90-query pattern SYSTEM_AUDIT named almost exactly. Untouched by P0/P1 — neither pass's scope included commission query shape (P1 Batch 5 verified payroll *posting* idempotency only, not accrual query cost).

## §5. Batch-Aware Inventory Adjustments

**CONFIRMED, but the service layer is already half-ready.** `recordAdjustment` (`inventory/stock.ts:180`) already accepts an optional `batchId` and correctly checks that specific batch's balance when one is given. The gap is entirely in the UI: [adjustment-dialog.tsx](src/app/(dashboard)/inventory/adjustment-dialog.tsx) has no batch selector at all — direction, type, quantity, reason only — so every adjustment made through it is still effectively batch-blind from a user's perspective, exactly as SYSTEM_AUDIT #23 described. Cheaper fix than the original finding implied, since the backend contract already exists.

## §6. Accounting Auditability

**CONFIRMED.** No admin/accountant read-only "Business Transaction → Journal → Journal Lines → Source Reference" viewer exists anywhere under `src/app/(dashboard)/admin/*` or `/accounting`. The underlying data is traceable (every `Journal` carries `referenceType`/`referenceId`, `postJournal` is the sole writer, `reverseJournal`/`postInvoiceVoided` link reversal journals back to what they reverse — see TRANSACTION_BOUNDARIES.md), so this is a real, buildable UI gap, not a data-model gap. Accounting postings still generate no `audit_log` entry of their own (only reachable indirectly via the triggering business event's own audit entry) — unchanged since the original audit.

## §7. Clinical Access Log Viewer

**CONFIRMED.** `grep -rn "clinical_access_log\|clinicalAccessLog\|writeClinicalAccessLog" src/app` returns zero matches — no viewer page exists anywhere. `/admin/audit` ([page.tsx](src/app/(dashboard)/admin/audit/page.tsx)) is the mutation-audit (`audit_log`) viewer only, already paginated, gated on `audit.review` — a genuinely different log, doesn't cover this. SECURITY.md confirms `writeClinicalAccessLog` now has 3 real callers (`getEncounter`, `listPatientLabResults`, `listPatientImagingResults`) since Phase 14 — the write side is real; the read/admin side named here is what's still missing.

## §8. Pagination of Large Datasets

**PARTIALLY FIXED — real, if narrow, progress since the original audit.**

Genuinely paginated today (`page`/`pageSize`/`totalCount`/`totalPages`, verified in source): **Patients** (`patients/service.ts`, pre-existing), **Audit Log** (`admin/audit`, pre-existing), **System Events** (`platform/system-events.ts`, built in P0-02), and — new this session, outside any P0/P1/P2 batch — **Episodes/Encounters/Orders** (`clinical/episodes.ts`, `encounters.ts`, `orders.ts`).

Still hard-capped or fully unbounded (verified via `grep -n "take:\|findMany"` across `src/lib/domains`):
| Screen | File | Current behavior |
|---|---|---|
| Invoices | `billing/invoices.ts:306` | `take: 100`, no page param |
| Payments | `billing/payments.ts:188` | `take: 100`, no page param |
| Stock Ledger | `inventory/stock.ts:159` | `take: 200`, no page param |
| Goods Receipts | `procurement/goods-receipts.ts:173` | `take: 100`, no page param |
| Supplier Invoices | `procurement/supplier-invoices.ts:159` | `take: 100`, no page param |
| Purchase Orders / Requests | `procurement/purchase-orders.ts:91`, `purchase-requests.ts:65` | `take: 100` each |
| Journals | `accounting/reports.ts:158` (`listJournals`) | `take: 200`, no page param |
| Claims | `claims/service.ts:312` (`listClaims`) | **fully unbounded**, no `take` at all |
| Employees | `hr/employees.ts:16,25` | **fully unbounded** |
| Assets | `assets/assets.ts:17` | **fully unbounded** |
| Leave, Attendance, Expenses, Communications, Transfers | `hr/leave.ts:167`, `hr/attendance.ts:133`, `accounting/expenses.ts:61`, `communications/service.ts:106`/`hub.ts:45`, `inventory/transfers.ts:128` | `take: 100`/`200` each, no page param |
| Refund requests | `billing/refunds.ts:167` (`listPendingRefundRequests`) | unbounded, but status-filtered to `requested`/`authorized` only — a queue, not a historical list; naturally small |

Reports pagination (Reports hub, Notifications) not separately re-verified this batch — assume still absent per the original finding pending later-batch confirmation.

## §9. Report Scalability

Not a "verify a historical finding" item — P2.md §9 is inspection/optimization work for a later batch. No baseline exists yet (that's §22/PERFORMANCE_BASELINE.md, also later-batch work). Noted for completeness, not classified.

## §10. AccountMapping.intent Type

**CONFIRMED.** `AccountMapping.intent` (`prisma/schema.prisma:2439`) is still a bare `String`, no enum, no CHECK constraint — DATABASE.md's own Batch 3/4 notes already document new posting intents (`cogs`, `goods_received_not_invoiced`, `fixed_asset`, etc.) being added as **plain string values**, confirming this was never revisited even as the taxonomy grew to 20 values across P1.

## §11. Uniqueness and Data Quality

**CONFIRMED for both named fields.**
- `User.username` (`schema.prisma:251`): `String?`, no unique index anywhere on the model — only `@@unique([organizationId, email])`.
- `Provider.licenseNumber` (`schema.prisma:753`): `String?`, appears exactly once in the schema (the field declaration) — no `@@unique` constraint.

Other candidates named in P2.md §11 (employee number, SKU, service code, medication/product code, lab test code, imaging service code) already carry real `@@unique(organizationId, code)`-style constraints per DATABASE.md's per-phase schema sections (`employee_number`, `product.sku`, `service.code`, `lab_test.code`, `imaging_service.code` are all documented `UNIQUE(org_id, ...)`) — not re-verified line-by-line this batch, flagged for a quick confirmation pass before implementation, not expected to surface new gaps.

## §12. Missing updatedAt Fields

**CONFIRMED.** Verified directly: `Charge`, `Invoice`, `Payment` models all lack `updatedAt` — none of the three field lists read from `schema.prisma` this batch contain it, unlike `User`/`Provider` (both correctly carry `updatedAt @updatedAt`). All three are genuinely mutable after creation (`Invoice.paidAmount`/`status`, `Charge.status`, `Payment.status` all change in place), so this is a real traceability gap, not a candidate for "leave it, it's append-only" per §12's own carve-out.

## §13. Branch Consistency in Clinical Data

**CONFIRMED, exact split unchanged.** Verified all six models directly:
- Carry `branchId` directly: `VitalSign`, `ClinicalOrder`.
- Do NOT (inherit only via `encounterId`): `Diagnosis`, `ClinicalNote`, `Prescription`, `FollowUpRecommendation`.

`Episode`/`Encounter` both carry `branchId` (authoritative). No P1 batch touched this — P1 Batch 6's clinical-integrity work added cancellation/entered-in-error states and lab amendment chains, not branch-column consistency. No cross-branch leakage was found in this batch's review (every child is reached only via its parent `Encounter`, which is itself branch-scoped and access-checked), so the risk is inconsistency/documentation, not an active security hole — matches P0-01's branch-isolation work, which fixed *read-path enforcement*, not *schema-level* column presence.

## §14. Actor Foreign Keys

**CONFIRMED.** Every actor field sampled (`Diagnosis.diagnosedBy`, `ClinicalOrder.createdBy`, `VitalSign.recordedBy`, `ClinicalNote.authoredBy`/`finalizedBy`, `Prescription.createdBy`, `Invoice.createdBy`, `Charge.createdBy`, etc.) remains a plain `String?` with no `@relation` to `User`. Neither P0 nor P1 touched actor-field FKs (confirmed via ARCHITECTURE.md/DATABASE.md's full batch-by-batch changelog — no mention of this anywhere). ~48-field scope from the original audit not independently re-counted this batch; spot-checked across clinical, billing, and accounting models with 100% of samples still plain strings.

## §15. Procedure Event Alignment

**PARTIALLY FIXED — the documentation-drift half of this finding is closed; the architectural question is still open, undecided by design.** SYSTEM_AUDIT's actual complaint was that ARCHITECTURE.md's event table *implied* `ProcedureCompleted` was wired when it wasn't. That's no longer true: ARCHITECTURE.md §15's event table and SYSTEM_INTEGRITY_MATRIX.md's Procedure Completion row now both explicitly and correctly state it's "registered but has no real subscriber" and that procedure billing is deliberately ad-hoc/manual at POS — verified by direct read this batch, not assumed. What P2.md §15 actually asks this pass to do — decide whether the event is architecturally still needed, or should be removed — has not been decided; that decision is later-batch implementation work, not a finding to verify.

## §16. Structured Server Logging

**CONFIRMED.** `find src/lib -iname "*logger*" -o -iname "*logging*"` returns nothing — no centralized logger abstraction exists. Only 6 files in `src/lib`/`src/app` use any `console.*` call at all (consistent with the original audit's "~8 ad hoc calls" figure). No structured fields, no correlation id, no domain/operation tagging anywhere.

## §17. Global Query / Raw Prisma Consistency

**CONFIRMED, narrow — exactly one instance, matching the original finding precisely.** `grep -rl "^import { db }" src/app --include="*.tsx"` returns exactly one file: [queue/page.tsx](src/app/(dashboard)/queue/page.tsx:5), which calls `db.provider.findUnique(...)` directly to resolve whether the signed-in user has a linked Provider — the identical single instance SYSTEM_AUDIT #34 named, unchanged since. Everywhere else, business queries correctly route through the domain-service layer.

## §18. Tax Lookup Performance

**CONFIRMED.** `generateInvoice` (`billing/invoices.ts:162-167`) still calls `getTaxRate(organizationId, charge.serviceId)` once per charge inside `charges.map(async (charge) => ...)` — one query per invoice line, unbatched, unchanged since the original audit. Precedence logic itself (`getTaxRate`'s own service-specific → org-default → zero fallback, `invoices.ts:114+`) is correct and must be preserved exactly when batched.

## §19. Large Component / File Review

**CONFIRMED but low-value to act on, per P2.md §19's own restraint.** `accounting/page.tsx` (410 lines, was 394) and `patients/[id]/page.tsx` (370 lines, was 365) — both grew slightly from P1's own additions (periods panel, reverse-journal dialog, statement tab) but remain markup-heavy multi-tab compositions, not logic-dense or hard-to-test. Neither shows the actual red flags P2.md §19 names (mixed responsibilities, duplicated business logic, rerender storms, "dangerous to modify"). Recommend leaving both alone this pass — flagged here for completeness, not queued for a later batch.

## §20. Dead Code Review

Mixed — several items confirmed still dead, one partially resolved:
- `listPatientMedicationHistory` (pharmacy) — **CONFIRMED still dead**: zero callers anywhere in `src/app` (P0-01 fixed its cross-tenant-leak bug but never gave it a caller).
- `SESSION_SECRET` — **CONFIRMED still unused**, now honestly documented as such in DEPLOYMENT.md rather than silently present (a real improvement in accuracy, not in dead-code removal).
- `"processing"` lab status — **PARTIALLY FIXED / reclassify**: no longer purely dead — `laboratory/orders/[id]/page.tsx:158` reads it in a UI conditional, and `LAB_ORDER_TEST_TRANSITIONS` (`laboratory/results.ts:29`) includes it as a real transition target (`collected → processing`). Not independently re-verified this batch whether any action actually *writes* `status: "processing"` today, or whether it's reachable-in-theory-only — flag for a quick confirmation before deciding to keep or remove.
- Nine dead "deactivate" catalog actions — **not independently re-verified item-by-item this batch**; a broad grep found `deactivate*Action` definitions across 7 action modules, but distinguishing genuinely-dead catalog-deactivation actions from real, wired ones (e.g. `deactivatePortalAccessAction`, which is real and used) needs a closer per-action pass — deferred to implementation batch rather than asserted here without verification.
- `updateProviderAction` — **CONFIRMED still fully dead** (zero call sites outside its own definition), unlike its sibling `rescheduleAppointmentAction`, which P1 Batch 7 wired for real via [reschedule-dialog.tsx](src/app/(dashboard)/appointments/reschedule-dialog.tsx) (verified — **ALREADY FIXED** for that half of the original IMPROVEMENT_ROADMAP #14 item).

## §21. Data Retention / Deletion Consistency

**ALREADY FIXED, more thoroughly than the original finding anticipated.** `grep -rln "deleteEncounter\|deletePatient\|deleteInvoice\|deleteJournal" src/app` returns nothing — no UI anywhere exposes a raw delete action against a `Restrict`-protected entity that would surface an ugly DB error. P1 Batch 6 specifically built the "sensible operational alternatives" this section asks for: `updatePatientStatus` (ACTIVE/INACTIVE/DECEASED), `cancelEncounter`/`markEncounterEnteredInError`, `cancelOrder`, `voidInvoice` (now with `postInvoiceVoided` reversing its own journal), and `reverseJournal` for manual entries — all verified present via ARCHITECTURE.md's §3/§4/§6 and confirmed as real functions, not just documented intent. Nothing found this batch needing translation from a raw DB error to a friendly message, because nothing found still exposes the raw path.

## §22-23 (Performance Baseline / 200-User Prep)

Not "historical findings" — both are new inspection/documentation work P2.md assigns to a later batch (PERFORMANCE_BASELINE.md, PERFORMANCE_NOTES.md). Not addressed in this findings pass.

---

## Cross-reference: IMPROVEMENT_ROADMAP.md's P2 tier (items 19-27)

All nine map 1:1 onto sections above and are covered by the corresponding entry: #19→§3, #20→§4, #21→§5, #22→§6/§7, #23→§8, #24→§10/§11/§12, #25→§13, #26→§15, #27→§16. No item in that list was found already resolved beyond what's noted above.

## Summary table

| § | Finding | Status |
|---|---|---|
| 3 | Missing date indexes (Invoice/Payment/Charge) | CONFIRMED |
| 4 | Commission accrual N+1 | CONFIRMED |
| 5 | Batch-blind stock adjustments | CONFIRMED (service ready, UI missing) |
| 6 | Accounting traceability viewer | CONFIRMED |
| 7 | Clinical access log viewer | CONFIRMED |
| 8 | Pagination | PARTIALLY FIXED |
| 10 | AccountMapping.intent as string | CONFIRMED |
| 11 | User.username / Provider.licenseNumber uniqueness | CONFIRMED |
| 12 | Missing updatedAt (Invoice/Charge/Payment) | CONFIRMED |
| 13 | Branch column inconsistency (clinical siblings) | CONFIRMED |
| 14 | Actor fields lack FKs | CONFIRMED |
| 15 | ProcedureCompleted doc/architecture mismatch | PARTIALLY FIXED (docs corrected; decision pending) |
| 16 | No structured logging | CONFIRMED |
| 17 | Raw Prisma in page component | CONFIRMED (1 instance, `queue/page.tsx`) |
| 18 | Per-line tax lookup | CONFIRMED |
| 19 | Large page components | CONFIRMED (low priority, recommend no action) |
| 20 | Dead code | MIXED — see detail above |
| 21 | Delete UX dead-ends on RESTRICT | ALREADY FIXED |
