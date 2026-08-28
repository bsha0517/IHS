# P0 Remediation Report

Scope: P0 (Critical) findings from SYSTEM_AUDIT.md / FAKE_OR_INCOMPLETE_FUNCTIONALITY.md, remediated per P0.md. No P1/P2/P3/P4 work performed except where a P0 fix technically required it (none did). SYSTEM_AUDIT.md, IMPROVEMENT_ROADMAP.md, and FAKE_OR_INCOMPLETE_FUNCTIONALITY.md are left untouched as historical record.

Plan reference: P0_REMEDIATION_PLAN.md (written before implementation, per P0.md §1).

---

## P0-01 — Branch Data Isolation

**Finding:** Server-side branch authorization was inconsistently enforced on read paths. `branchId` values arriving from query strings, route params, or client state were sometimes trusted directly instead of being checked against the authenticated session's authorized branches.

**Root Cause:** No centralized authorization primitive existed. Each domain service implemented its own (often absent) branch check, so coverage depended on whether an individual author remembered to add one.

**Fix:** Added [src/lib/platform/branch-scope.ts](src/lib/platform/branch-scope.ts) — `getAuthorizedBranchScope(session)`, `narrowBranchFilter(scope, requestedBranchId)`, `assertBranchAccess(scope, branchId)`, and `patientVisibilityWhere(scope)` (Patient is visible via registration branch OR any appointment at an authorized branch, since patients are not strictly single-branch). Applied mechanically across every `list*`/`get*` function that reads branch-owned data. Super Admin remains the system's one intended org-wide bypass (`isOrgWide`), mirroring the existing `can()` short-circuit. Raw-SQL report functions (accounting reports built on `Prisma.sql`) got an equivalent `resolveReportBranchFilter` helper since they can't use Prisma's `where` builder.

During this pass, found and fixed one pre-existing cross-tenant leak not called out in the original audit: `listPatientMedicationHistory` (pharmacy dispensing) had no organization filter at all, because `PatientMedicationHistory` has no `organizationId` column of its own — fixed by filtering through the related `patient` record.

**Files Changed:** 49 files under `src/lib/domains/**` (billing, appointments, patients, clinical, inventory, procurement, assets, hr, laboratory, pharmacy, radiology, claims, payroll, accounting, packages, analytics, communications, identity) plus the new `src/lib/platform/branch-scope.ts`. Full list in `git status`.

**Migration:** None — authorization logic only, no schema change.

**Tests Added:** [test/integration/branch-isolation.test.ts](test/integration/branch-isolation.test.ts) — 13 tests against real DB fixtures in two branches, covering list/get for patients, appointments, invoices, clinical orders, inventory, and reports; a single-branch session, an org-wide-by-grant session, and a Super Admin session.

**Test Result:** 13/13 passing.

**Live Verification:** Direct record routes (`/patients/[id]`, `/invoices/[id]`) confirmed via source read to call the branch-scoped `getPatient`/`getInvoice` functions, not a bypassing query — grep-verified across `src/app`. Live browser walkthrough (Super Admin session) confirmed `/invoices/[id]` renders correctly through the branch-checked path.

**Remaining Risk:** This was a systematic pattern-application across ~50 files by one author in one pass; residual risk is a missed call site the grep/read sweep didn't catch, rather than a design gap. No route was found that queries `db` directly, bypassing the service layer, for the entities in scope.

**Status: FIXED**

---

## P0-02 — Outbox Reliability

**Finding:** Failed outbox events were marked `failed`, but the dispatcher only queried for `pending`, so failures never retried. Invoice issuance could succeed while its accounting journal silently never posted.

**Root Cause:** The dispatch query's `WHERE status = 'pending'` never widened to include `failed` events past their retry window; there was no retry-scheduling or dead-letter concept at all.

**Fix:** Added explicit state machine (`pending → processing → completed`, or `pending → processing → failed → ... → dead_letter`) with `attempts`, `lastAttemptAt`, `nextRetryAt`, `lastError`, `completedAt` columns. Retry uses increasing delays (1min / 5min / 20min) up to `MAX_ATTEMPTS = 3`, then `dead_letter` plus an in-app notification to every Super Admin / Organization Administrator. Centralized idempotency in `postJournal` (every accounting posting function funnels through it) via an existing-record check keyed on `referenceType` + `referenceId` — this uncovered and fixed a real latent bug: `postPayrollApproved` and `postPayrollPaid` shared the same `referenceType`, which would have made the second posting silently no-op once idempotency checking went live. Renamed `postPayrollPaid`'s tag to `payroll_run_paid`. Added an admin UI at `/admin/system-events` (permissions `system_events.view` / `system_events.retry`) showing every event's status/attempts/error with a manual retry action.

**Files Changed:** `prisma/schema.prisma` (OutboxEvent/OutboxStatus), [src/lib/platform/outbox.ts](src/lib/platform/outbox.ts) (rewritten), [src/lib/platform/system-events.ts](src/lib/platform/system-events.ts) (new), `src/app/(dashboard)/admin/system-events/{actions.ts,page.tsx,retry-button.tsx}` (new), `src/lib/domains/accounting/posting-service.ts` (idempotency + payroll referenceType fix), `prisma/seed.ts` (two new permissions), `src/components/layout/nav-config.ts` (nav entry).

**Migration:** Two files, split for a Postgres requirement (a newly-added enum value can't be used in the same transaction it's added in): `20260826192144_p0_02_outbox_reliability` (enum widening only) and `20260826192200_p0_02_outbox_reliability_data` (data remap of the 30 existing rows, column rename, new columns, backfill, index). Verified against real data: zero rows lost, all correctly remapped.

**Tests Added:** [test/integration/outbox-reliability.test.ts](test/integration/outbox-reliability.test.ts) — 6 tests: successful processing, temporary failure + retry, repeated failure → dead-letter, dead-letter admin notification, manual retry, idempotent replay (duplicate journal prevention).

**Test Result:** 6/6 passing.

**Live Verification:** Booked a real patient journey through invoice issuance and payment in the running app; both the resulting `InvoiceIssued` and `PaymentReceived` outbox events show `completed` status with `attempts: 1` in the live `/admin/system-events` UI — confirming the fix works in the actual running application, not only in the test harness.

**Remaining Risk:** The dispatcher currently runs synchronously inline with the triggering request (no separate scheduled worker/cron). This matches the existing architecture and was not flagged as a P0 item in its own right — a periodic sweep for stuck `processing` events (e.g. a crash mid-dispatch) would be a reasonable P1 follow-up, not attempted here.

**Status: FIXED**

---

## P0-03 — Expired Stock / FEFO

**Finding:** FEFO sorted all batches by expiry date without excluding batches already past expiry, so expired stock could be allocated first if it happened to sort earliest.

**Root Cause:** `listAvailableBatches` filtered on `quantity > 0` only; there was no `expiryDate` exclusion clause.

**Fix:** Added an explicit exclusion — a batch is allocatable only if `expiryDate IS NULL OR expiryDate >= today`. Expired batches are excluded from the allocation candidate pool entirely (not merely sorted after valid stock), while remaining visible in inventory reporting per P0.md §15's requirement that expired stock not disappear from view.

**Files Changed:** `src/lib/domains/inventory/stock.ts`.

**Migration:** None — query logic only.

**Tests Added:** [test/integration/fefo-expiry.test.ts](test/integration/fefo-expiry.test.ts) — the exact scenario from P0.md §14: Batch A (expired yesterday), B (expires tomorrow), C (expires next month). Confirms A never appears in the allocatable list, B and C are ordered correctly, a 15-unit consumption draws from B then C without ever touching A, and a request exceeding B+C's combined stock fails with a clear error rather than silently drawing on A.

**Test Result:** 4/4 passing.

**Remaining Risk:** None identified for the P0 scope. The "special controlled workflow" for using near-end-of-life stock under supervision (P0.md §15) was explicitly deferred, per instruction, as a future workflow, not a P0 item.

**Status: FIXED**

---

## P0-04 — Password Reset

**Finding:** A backend function and Server Action existed but had no UI entry point; the reset token was printed to `console.log` instead of being delivered.

**Root Cause:** The feature was half-built — no `/reset-password` page, no "Forgot password?" link, and a debug `console.log(resetToken)` left in code that would leak a live credential into server logs in production.

**Fix:** Chose the self-service email-reset approach (preferred option per P0.md §16), reusing the existing `CommunicationAdapter` pattern rather than building a parallel implementation. Real email is not configured in this environment, so it uses the existing `NullEmailAdapter`, which honestly reports `status: "failed"` — the UI tells the user "password reset delivery is not configured" rather than falsely claiming an email was sent. The `console.log(resetToken)` was removed entirely; the raw token is never returned to the browser or logged. The response is identical whether or not the account exists (no account-enumeration signal). Added `/reset-password` request and confirm pages, and a "Forgot password?" link on the login page.

**Files Changed:** `src/lib/auth/service.ts` (`requestPasswordReset` rewritten), `src/app/reset-password/{actions.ts,request-form.tsx,confirm-form.tsx,page.tsx}` (new), `src/app/login/actions.ts` (dead code removed), `src/app/login/login-form.tsx` (link added).

**Migration:** None — `PasswordResetToken` model and its hashing/expiry/single-use logic already existed and were already correct; only the delivery and entry-point gaps were fixed.

**Tests Added:** None new (this was UI wiring + a `console.log` removal + adapter reuse, not new business logic); verified live instead (see below), which is a stronger signal for this kind of change than a unit test would be.

**Test Result:** N/A (no new automated test; live-verified).

**Live Verification:** Full flow tested end-to-end in the browser against a disposable test user created for this purpose (deliberately not the real admin account, to avoid touching its live credentials): requested a reset, confirmed the UI's honest "delivery not configured" message, retrieved the token from the database directly (standing in for the email a real deployment would send), submitted a new password successfully, and confirmed the same token is rejected on a second use.

**Remaining Risk:** Real email delivery is not configured in this environment — this is a deployment configuration gap (an SMTP/provider credential), not a code defect; the honest-failure UI correctly reflects that state rather than masking it. See "Manual Deployment Steps" below.

**Status: FIXED**

---

## P0-05 — Cascade Delete Protection

**Finding:** Several relationships involving clinical and financial history used `onDelete: Cascade`, meaning deleting a parent record (e.g. an Encounter) would silently destroy dependent history (Diagnoses, Clinical Notes, Vitals, Orders, Prescriptions) with no trace.

**Root Cause:** Schema defaults inherited from early scaffolding; cascade is the easy default but wrong for records that represent historical/legal/financial fact.

**Fix:** Changed 24 relations from `onDelete: Cascade` to `onDelete: Restrict`: PatientAllergy, PatientCondition, PatientMedicationHistory (→ Patient); VitalSign, Diagnosis, ClinicalNote, ClinicalOrder, Prescription, FollowUpRecommendation (→ Encounter); LabOrderDetail, ImagingOrderDetail, ProcedureOrderDetail, ReferralOrderDetail, Specimen, LabOrderTest, ImagingOrder (→ ClinicalOrder); PrescriptionItem (→ Prescription); InvoiceLine (→ Invoice); PaymentAllocation (→ Payment); PatientPackageSession (→ PatientPackage); JournalLine (→ Journal); PayrollRunLine (→ PayrollRun); DispensingReturn (→ DispensingRecord); ClaimItem (→ Claim). A parent record with any of these children can no longer be deleted through ordinary application operations — the database itself now enforces this, not just application convention.

**Files Changed:** `prisma/schema.prisma`.

**Migration:** [prisma/migrations/20260826200219_p0_05_cascade_delete_protection/migration.sql](prisma/migrations/20260826200219_p0_05_cascade_delete_protection/migration.sql) — 24 paired `DROP CONSTRAINT` / `ADD CONSTRAINT ... ON DELETE RESTRICT` statements. Non-destructive: changing `ON DELETE` behavior does not touch existing rows or validate existing data, only future delete attempts. Applied cleanly against the real database with `prisma migrate deploy`.

**Tests Added:** [test/integration/cascade-delete-protection.test.ts](test/integration/cascade-delete-protection.test.ts) — 5 tests building full real fixture chains (Patient→Encounter→Diagnosis; Charge→Invoice→InvoiceLine; CashierSession→Payment→PaymentAllocation; Journal→JournalLine) and asserting each parent-delete attempt throws.

**Test Result:** 5/5 passing.

**Regression Found and Fixed:** The full-suite verification run (Step 3) surfaced that this change broke an existing pre-P0 test — `test/integration/journal-balance-trigger.test.ts`'s cleanup deleted a `Journal` row without first deleting its `JournalLine` children, which used to work under cascade and now correctly fails under restrict. Fixed the test's cleanup to delete children first ([test/integration/journal-balance-trigger.test.ts](test/integration/journal-balance-trigger.test.ts)). This is exactly the kind of "fix anything this remediation broke" regression P0.md §29 anticipated, not a defect in the P0-05 fix itself — any code path that deletes these parent records without first handling children will now correctly fail, which is the intended, protective behavior.

**Remaining Risk:** An explicit status-based deletion policy (Patient ACTIVE/INACTIVE/MERGED, Encounter OPEN/FINALIZED/CANCELLED, etc., per P0.md §19) was not implemented — that is a larger UX/workflow change beyond "prevent silent data loss," and P0.md's actual requirement was the RESTRICT protection, which is what was delivered. Recommended as a P1 item.

**Status: FIXED**

---

## P0-06 — Audit Log Immutability

> **Update (P1 §1, 2026-08-27): the cutover described as "remaining" below has since been completed and live-verified.** `DATABASE_URL` now connects as `avant_app_runtime`; the sections below are preserved as the original P0-pass record — see the Status line at the end of this section for the current, corrected status, and DATABASE.md's "Connection Roles" / DEPLOYMENT.md's "Database Privileges" for the full verification record.

**Finding:** `audit_log` and `clinical_access_log` were immutable only by application convention (no update/delete function existed in code) — not enforced by the database itself.

**Root Cause:** The application's only database connection (`postgres`, used since Phase 1) owns every table it created, including the audit tables. In PostgreSQL, a table owner's privileges are implicit and cannot be revoked from itself — `REVOKE UPDATE, DELETE ... FROM postgres` would execute without error but have zero actual effect. This is exactly the trap P0.md §23 warned against, and was verified empirically (not assumed) via `pg_tables.tableowner`.

**Fix:** Created a genuinely separate, non-owner database role (`avant_app_runtime`) with `SELECT, INSERT, UPDATE, DELETE` granted on all tables, then `UPDATE, DELETE` explicitly revoked on `audit_log` and `clinical_access_log` only. Because this role owns nothing, the revoke is real — empirically verified via a live second connection as that role: `UPDATE`/`DELETE` against the audit tables genuinely fail; `SELECT`/`INSERT` on them and full access to every other table genuinely still work. Confirmed via source read that no `updateAuditLog`/`deleteAuditLog`/generic admin CRUD path exists anywhere in the codebase — `audit.ts` exports exactly `auditFromSession` and `writeAuditLog`, both insert-only.

**Files Changed:** `prisma/db-setup/p0-06-create-runtime-role.sql` (new, reference script — role/GRANT management is cluster-level, not something Prisma migrations track), `src/lib/platform/audit.ts` (doc comment corrected to accurately describe current state, removing a prior false "fully live" claim).

**Migration:** None via Prisma (by design — see script header for why). The role itself was created and verified against the real database as part of this pass.

**Tests Added:** [test/integration/audit-log-immutability.test.ts](test/integration/audit-log-immutability.test.ts) — Part 1 (always runs): asserts `audit.ts`'s only exports are the two insert-only functions. Part 2 (runs when `RUNTIME_ROLE_DATABASE_URL` is set): connects as the restricted role and empirically proves UPDATE/DELETE rejected, SELECT/INSERT allowed, and normal table access unaffected.

**Test Result:** 5/5 passing (both parts ran and passed in this environment, since the role and its connection string were created and configured here).

**Remaining Risk — and an explicit, honest limitation:** The role exists and DB-level enforcement is real and verified, **but the application's live runtime connection has not been cut over to it.** The app still connects as `postgres` (the table owner) for normal operation — meaning audit-log immutability is currently enforced by application convention, exactly as before, not yet by the database, for the connection the running app actually uses. Cutting `DATABASE_URL` over to `avant_app_runtime` is a deliberate, separate deployment step (documented in the SQL script and below), not performed automatically by this pass, because it changes the live application's runtime identity and P0.md explicitly warned against overreach without being asked. The runtime role also cannot run migrations (no DDL rights) — the owner role must continue to be used for `prisma migrate deploy`.

**Status (at original P0 write-up): PARTIALLY FIXED** — the protection was real, tested, and ready, but not yet live for the running application.

**Status (current, as of P1 §1, 2026-08-27): FIXED.** The cutover was completed: `DATABASE_URL` now connects as `avant_app_runtime` for the running application; a new `DIRECT_DATABASE_URL` (owner role) is used only by the Prisma CLI for migrations. Live-verified through the exact connection the application uses — `db` (imported from `@/lib/db`) can INSERT/SELECT `audit_log` but cannot UPDATE/DELETE it, and retains full CRUD on normal tables — plus the full 84-test suite and a live browser session with no regressions. See P1_REMEDIATION_REPORT.md for the full record of this batch.

---

## Full Quality Check (P0.md §29)

| Check | Result |
|---|---|
| TypeScript typecheck | Clean, zero errors |
| Lint | Clean, zero warnings/errors |
| Integration tests | **84/84 passing** (15 test files, run together as a single full suite — not just individually) |
| Build (`next build`) | Succeeds — 48 static pages, all routes compile |
| Prisma validate | Schema valid |
| Prisma migrate status | Database schema up to date, 23 migrations applied, zero drift |

Two real regressions were found and fixed during this pass, both caused by this remediation and both fixed rather than worked around:
1. **Test flakiness under full-suite load** — vitest's 5000ms default test/hook timeout was tight enough against this environment's real Supabase pooler latency that individual test files passed in isolation but failed under full-suite cumulative load. Fixed at the root with a global `testTimeout: 20000` / `hookTimeout: 30000` in `vitest.config.mts`, rather than continuing to annotate individual `it()` blocks file-by-file.
2. **`journal-balance-trigger.test.ts` cleanup broke by P0-05** — see P0-05 section above.

No tests were skipped or suppressed to obtain a green build.

---

## Answers to P0.md §33

> **Update (P1 §1, 2026-08-27): P0-06 is now FIXED — see the note at the top of the P0-06 section above.** The answers below are preserved as originally written at the end of the P0 pass, when P0-06 was still partial; treat item 1 as now including P0-06 and item 2 as now empty.

**1. P0 issues fixed (as of the original P0 pass):** P0-01 (branch data isolation), P0-02 (outbox reliability), P0-03 (expired stock/FEFO), P0-04 (password reset), P0-05 (cascade delete protection).

**2. P0 issues partially fixed:** P0-06 (audit log immutability) — DB-level protection is real and verified, but the live application connection has not been cut over to the restricted role. See P0-06 above and "Manual Deployment Steps" below.

**3. P0 issues remaining:** None outstanding within the stated P0 scope beyond the P0-06 cutover step, which is a deliberate deployment action, not unfinished code.

**4. Migrations created:** 3 — `20260826192144_p0_02_outbox_reliability`, `20260826192200_p0_02_outbox_reliability_data`, `20260826200219_p0_05_cascade_delete_protection`. All applied cleanly against the real database; `prisma migrate status` confirms zero drift.

**5. Tests added:** 5 new integration test files — `branch-isolation.test.ts` (13), `outbox-reliability.test.ts` (6), `fefo-expiry.test.ts` (4), `cascade-delete-protection.test.ts` (5), `audit-log-immutability.test.ts` (5) — 33 new tests, all against the real database, no mocks.

**6. Number of tests passing:** 84/84 (full suite, 15 files, run together).

**7. Build result:** Succeeds cleanly. Typecheck and lint both clean.

**8. Security improvements:** Branch data isolation is now centrally enforced server-side across every read path found for Patient, Appointment, Encounter, clinical data, Invoice, Payment, Inventory, Procurement, Assets, HR, Reports, Laboratory, Pharmacy, and Radiology — client-supplied `branchId` is never trusted as proof of access. Direct-record routes independently re-verify branch access rather than trusting the URL. A real cross-tenant data leak (patient medication history with no organization filter) was found and fixed as a byproduct of this sweep. Password reset tokens are no longer logged; the flow is honest about non-delivery and doesn't leak account existence. Audit-log DB-level immutability now has a real, tested enforcement mechanism, one deployment step from being fully live.

**9. Data-integrity improvements:** Clinical and financial history (diagnoses, notes, prescriptions, invoice lines, payment allocations, journal lines, and more) can no longer be silently destroyed by deleting a parent record — the database now rejects it. FEFO allocation can no longer draw from expired stock under any circumstance, including when only expired stock remains (the operation now fails loudly instead of consuming it). Outbox event failures now retry with backoff instead of disappearing, and duplicate-posting is prevented at the point every accounting entry funnels through, closing a real gap where an issued invoice could previously end up with no accounting journal.

**10. Any breaking changes:** Yes, deliberately: `PatientMedicationHistory` queries, purchase/procurement lists, and every other branch-scoped list/get now require and enforce an authorized session scope — code calling these functions with a session that has no branch grants will see empty results or a `ForbiddenError`, where it previously might have seen everything. Deleting a Patient/Encounter/Invoice/Journal/etc. with dependent history will now fail rather than cascading — any code path that relied on cascade delete (none were found in current application code, but this is a real behavior change at the database level) must be updated to handle status changes instead.

**11. Manual deployment steps:**
- Set real email/SMTP credentials and swap `NullEmailAdapter` for a real adapter if self-service password-reset delivery is wanted in production (currently honest about being unconfigured, which is safe but non-functional for end users).
- To complete P0-06: run `prisma/db-setup/p0-06-create-runtime-role.sql` against each environment's database (replacing `__PASSWORD__` with a freshly generated secret per environment), then update that environment's `DATABASE_URL` (locally in `.env`; in Vercel's project environment variables for production) to connect as `avant_app_runtime` instead of the migration-owner role. Keep the owner role's connection string available separately for `prisma migrate deploy`, since the runtime role cannot run migrations.
- The three new migrations must be applied to any environment not already migrated (`prisma migrate deploy`).

**12. Remaining risks:**
- P0-06's DB-level enforcement is not yet live for the running application (see above) — until the cutover happens, immutability is still convention-only in production, same as before this pass.
- The outbox dispatcher has no separate scheduled sweep for events stuck in `processing` after a crash mid-dispatch; not a P0.md item, flagged as a reasonable P1 follow-up.
- An explicit status-based deletion policy (P0.md §19) was not built; RESTRICT-level protection was, which was the actual P0 requirement.
- This pass's file-by-file pattern application to ~50 files (P0-01) carries a residual chance of one missed call site the grep sweep didn't surface, though none were found in this session's verification.

**Would you now trust this version to preserve patient, financial, and inventory information better than the audited version? Why?**

Yes, materially more so, with one honest caveat. Branch isolation is no longer ad hoc — it's centrally enforced and independently tested against a real database across every domain the audit named, and this pass found and closed a real cross-tenant leak the original audit didn't catch. Financial integrity is stronger in two concrete ways: an issued invoice can no longer end up with a missing accounting journal (outbox retry + idempotent posting), and expired inventory can no longer be dispensed under any code path, verified against the exact adversarial scenario requested. Clinical and financial history can no longer be silently destroyed by an unprotected cascade delete — the database itself now refuses it. The one place this version is not yet fully what it claims is P0-06: the protection is real and tested, but the live app still connects as the table owner, so audit-log immutability is DB-enforced in principle and one deliberate deployment step away from being DB-enforced in practice — that gap is stated plainly here rather than glossed over, which is itself part of why this version should be trusted more than one that would have claimed it was already done.
