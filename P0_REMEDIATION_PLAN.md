# P0_REMEDIATION_PLAN.md

Pre-implementation plan for the six P0 — Critical findings from SYSTEM_AUDIT.md, per P0.md's remediation spec. Each item below was re-verified against the current codebase (not assumed from the original audit text) before planning a fix; deviations from what the audit originally reported are called out explicitly.

---

## P0-01 — Branch Data Isolation

**Root cause.** `session.branchIds` (populated from `user_branch_access`, `src/lib/auth/session.ts:127`) is the system's own designed mechanism for "which branches can this user touch" — `can()`/`assertCan()` (`src/lib/platform/permissions-core.ts`) already supports checking a single `branchId` against it, and this check is correctly used on the *write* paths that target one specific branch (booking, invoice generation, employee creation). But no equivalent exists for *read* paths: list functions accept `branchId` as an optional, unenforced caller-supplied filter, and get-by-id functions don't check the fetched record's branch at all. Re-verified directly: `getInvoice` (`billing/invoices.ts:173-179`) filters only by `id, organizationId`; `listInvoices` (`:181-197`) takes `filters.branchId` as pure client input. Confirmed unchanged from the audit.

**Files involved.** Every domain's list/get functions that touch a branch-scoped model: `billing/{invoices,payments,refunds,charges,cashier}.ts`, `appointments/service.ts`, `patients/service.ts`, `clinical/{encounters,notes,diagnoses,prescriptions,orders,vitals}.ts`, `inventory/*.ts`, `procurement/*.ts`, `assets/assets.ts`, `hr/*.ts`, `laboratory/*.ts`, `pharmacy/*.ts`, `radiology/*.ts`, `analytics/{dashboards,reports/*}.ts`, plus the new `src/lib/platform/branch-scope.ts` this plan introduces.

**Database models involved.** Every model carrying `branchId` directly (Appointment, Encounter, Invoice, Charge, Payment, ClinicalOrder, VitalSign, Employee, StockLedgerEntry, etc.) and every model that inherits branch scope through a parent relation (Diagnosis/ClinicalNote/Prescription → Encounter; PaymentAllocation → Payment → Invoice) per P0.md §5.

**Security implications.** Currently: any authenticated user holding an ordinary `*.view` permission can read another branch's patients, invoices, appointments, and clinical data — a real HIPAA/patient-privacy-class exposure in a multi-branch deployment, not a theoretical one.

**Data integrity implications.** None directly (this is a read-path confidentiality issue, not a write-path corruption issue) — but it undermines the entire point of `user_branch_access` existing as an access-control primitive.

**Proposed fix.**
1. Add `src/lib/platform/branch-scope.ts` exporting `getAuthorizedBranchScope(session, permission)`, returning `{ organizationId, isOrgWide: boolean, branchIds: string[] }` — `isOrgWide` true only for Super Admin (the system's only existing org-wide bypass, per `can()`). This is additive; it does not change `can()`'s existing signature or behavior.
2. Add `assertBranchAccess(session, branchId)` — throws `ForbiddenError` if the branch isn't in the caller's authorized scope (Super Admin exempt). Used by get-by-id functions after fetching a record, before returning it.
3. Systematically update every list function's `where` clause to intersect with the authorized scope (`branchId: scope.isOrgWide ? filters.branchId : { in: scope.branchIds }` — narrowed further if the caller also supplied an explicit filter that's itself validated against the scope) and every get-by-id function to call `assertBranchAccess` on the fetched record's `branchId` (traversing to the owning Encounter/Invoice/Payment where the model doesn't carry `branchId` directly, per P0.md §5 — no redundant `branchId` columns added).
4. Record routes that fetch-then-render (e.g., `/invoices/[id]/page.tsx`, `/patients/[id]/page.tsx`) inherit the fix automatically once the underlying `getX` function enforces it, since they already call through the domain layer — verified no page does its own separate unguarded query.
5. Unauthorized direct navigation to a record surfaces the same generic error the app already uses for "not found in this org" (`findFirstOrThrow`-style 404), not a distinguishable "exists but forbidden" — avoids the enumeration leak P0.md §4 warns against.

**Migration required?** No — this is entirely application-layer (query `where` clauses and a new guard function). No schema change.

**Tests required?** Yes — mandatory per P0.md §6: a new integration test file exercising two branches, four roles (Branch A Receptionist/Doctor/Cashier, Org-wide Manager), asserting Branch A cannot list/open Branch B patients/appointments/invoices/clinical records/inventory/reports, and that the org-wide role and Super Admin can.

**Rollback considerations.** Purely additive query-scoping — reverting is a code revert with no data-shape change to undo. Low rollback risk.

**Risk of regression.** The main risk is over-scoping: a legitimately org-wide user (e.g., an Accountant who should see all branches' invoices for reconciliation) getting incorrectly restricted if their `user_branch_access` rows aren't complete. Mitigated by testing an explicit "organization-wide authorized user" case per P0.md §6, and by only changing enforcement (not changing who currently has which `user_branch_access` rows) — this plan does not attempt to redesign the access-grant model, only to enforce what it already claims to grant.

---

## P0-02 — Outbox Reliability

**Root cause.** `dispatchPendingOutboxEvents` (`src/lib/platform/outbox.ts:44-63`) marks a handler failure as `status: "failed"` but only ever queries `status: "pending"` — confirmed unchanged. A second, more dangerous fact surfaced during re-verification and **not fully captured in the original audit**: the nine posting functions in `accounting/posting-service.ts` are **not currently idempotent** — none of them check for an existing journal before creating one. Retrying a handler that partially succeeded (posted the journal, then crashed before the outbox row was marked processed) would create a duplicate journal today. Adding retry without fixing this first would be strictly worse than the current bug, exactly the risk P0.md §9 names.

A further, previously-unflagged bug found while designing the idempotency key: `postPayrollApproved` and `postPayrollPaid` (`posting-service.ts:371-422`) both post with `referenceType: "payroll_run"` against the *same* `referenceId` (the run's id). A naive "does a journal already exist for this reference" check would make `postPayrollPaid` silently no-op after `postPayrollApproved` already ran — a real, previously-undiscovered latent defect that this remediation must not introduce.

**Files involved.** `src/lib/platform/outbox.ts`, `src/lib/domains/accounting/posting-service.ts`, a new `src/app/(dashboard)/admin/system-events/{page.tsx,actions.ts}`, `prisma/seed.ts` (new permissions), `prisma/schema.prisma` (OutboxEvent model).

**Database models involved.** `OutboxEvent` (extended with attempt-tracking fields and a richer status enum), `Journal` (whose existing `referenceType`/`referenceId` + index become the idempotency key — no schema change needed there), `Permission`/`RolePermission` (two new permission codes).

**Security implications.** The new admin UI must be gated behind a new permission (`system_events.view`/`system_events.retry`), granted only to Super Admin/Org Admin, per P0.md §10 — ordinary clinic roles must not be able to manipulate system events.

**Data integrity implications.** This is the highest-value fix in the whole P0 pass: today, a transient failure in journal posting or commission accrual is invisible and permanent. Fixing it closes the single largest "books silently stop matching reality" risk identified in the audit.

**Proposed fix.**
1. Extend `OutboxStatus` enum: `pending | processing | completed | failed | dead_letter` (replacing `processed`/`failed`-only). Add `attempts Int @default(0)`, `lastAttemptAt DateTime?`, `nextRetryAt DateTime?`, `lastError String?`, `completedAt DateTime?` to `OutboxEvent` (renaming `processedAt` → `completedAt` for the new terminology, migrated non-destructively).
2. Make posting idempotent at the single choke point every posting call already goes through: `postJournal` (`posting-service.ts`) checks for an existing `Journal` matching `(organizationId, referenceType, referenceId)` when `referenceId` is non-null, and returns the existing journal instead of creating a duplicate. Manual journals (`referenceId: null`) are exempt from the check — each is intentionally a one-off, and a null-keyed check would incorrectly treat every manual journal after the first as a duplicate.
3. Fix the payroll referenceType collision: rename `postPayrollPaid`'s tag from `"payroll_run"` to `"payroll_run_paid"` (leaving `postPayrollApproved`'s `"payroll_run"` tag unchanged, so existing historical rows aren't relabeled) so the two distinct business events no longer share an idempotency key.
4. Verify (not re-implement — already correct per the original audit and re-confirmed by reading the code) that `accrueInvoiceBasisCommissions`/`accruePaymentBasisCommissions` (`payroll/commissions.ts`) and the `EncounterCompleted` charge-generation handler (`event-handlers.ts`) already guard against duplicate creation on their own natural keys (`chargeId`/`paymentId`, existing-charge-for-encounter) — these do not need new guards, only confirmation they still hold after the outbox changes.
5. Rewrite `dispatchPendingOutboxEvents`: select `pending` events *and* `failed` events whose `nextRetryAt <= now()` and `attempts < MAX_ATTEMPTS` (3). Mark `processing` before running handlers (defends against a second concurrent dispatch call double-processing the same event — this app has always run as a single instance per ARCHITECTURE.md, but making the state explicit costs nothing and documents the intent). On success: `completed`. On failure: increment `attempts`; if `attempts < MAX_ATTEMPTS`, set `failed` with an exponential `nextRetryAt` (1 min / 5 min / 20 min); if `attempts >= MAX_ATTEMPTS`, set `dead_letter` and write an internal `Notification` to every Org Admin/Super Admin user in the organization (P0.md §11) with a message naming the event type — reusing the existing `Notification` model, no new delivery mechanism invented.
6. Add a minimal admin page at `/admin/system-events` (event type, entity reference, created, attempts, status, last error, last/next attempt; a "Retry now" action that resets `attempts: 0, nextRetryAt: null, status: pending`; no "Mark Resolved" — not technically meaningful for this event model, so omitted rather than added for form's sake per P0.md §10's "if technically appropriate").

**Migration required?** Yes — extends `OutboxEvent` with five new columns and widens `OutboxStatus`. Additive only (`ALTER TYPE ... ADD VALUE`, `ALTER TABLE ... ADD COLUMN` with safe defaults); existing `processed`/`failed` rows are backfilled (`processed` → `completed`) in the same migration, no data loss.

**Tests required?** Yes, per P0.md §12: successful processing, temporary failure with retry, exhausted retries → dead-letter, manual retry from dead-letter, idempotent replay (same event processed twice produces one journal, not two), and specifically a test proving `postPayrollApproved` + `postPayrollPaid` on the same run both post (regression test for the collision found above).

**Rollback considerations.** The status-enum widening and new columns are additive and backward-compatible with the old dispatcher logic if reverted. The `postJournal` idempotency check is a pure addition (never rejects a legitimately-first posting). Rollback = revert the code + a follow-up migration dropping the added columns if truly necessary (not required for functional rollback, since old code ignores unknown columns).

**Risk of regression.** The idempotency check inside `postJournal` is the one place a mistake could silently suppress a legitimate posting — mitigated by keying it on `referenceType`+`referenceId` (already the natural per-event key everywhere except the one payroll collision found and fixed above) and by the payroll-specific regression test.

---

## P0-03 — Expired Stock / FEFO

**Root cause.** `listAvailableBatchesInternal` (`src/lib/domains/inventory/stock.ts:68-81`) orders candidate batches by `expiryDate asc nulls last` for FEFO selection with **no filter excluding batches whose `expiryDate` has already passed** — confirmed unchanged, independently reproduced by direct code inspection (matches both prior investigations).

**Files involved.** `src/lib/domains/inventory/stock.ts` (`listAvailableBatchesInternal`, `allocateFefo`), `inventory/stock.test.ts` (new test cases).

**Database models involved.** `ProductBatch`, `StockLedgerEntry` — no schema change; this is a query-filter fix.

**Security implications.** None directly; this is a clinical-safety issue (expired medication/supply being dispensed), not an authorization issue.

**Data integrity / clinical-safety implications.** Direct patient-safety risk: expired stock, being earliest-expiry, is currently *preferred* by FEFO rather than excluded — the exact inversion of the control's purpose.

**Proposed fix.** Add `expiryDate: { equals: null }` OR `{ gte: <allocation date> }` as a `where` condition (an `OR` clause, since `expiryDate` is nullable and null means "does not expire") in `listAvailableBatchesInternal`, per P0.md §13's literal spec. Batches are excluded from the available pool entirely, not merely sorted after valid ones — an allocation that would otherwise need expired stock now fails with "Insufficient stock" (the same existing, already-tested error path in `allocateFefo`) rather than silently substituting expired product. Per P0.md §15, expired batches remain fully visible in `listExpiredBatches`/inventory reporting (already correct, unchanged) — this fix touches only the *allocation* candidate pool, not visibility.

**Migration required?** No.

**Tests required?** Yes, the exact scenarios in P0.md §14: Batch A (expired yesterday) / B (expires tomorrow) / C (expires next month) → allocation must produce B then C, never A; and a no-valid-stock case (all remaining batches expired) must fail with a meaningful error rather than falling back to expired stock.

**Rollback considerations.** Single-function query-filter change; trivial to revert.

**Risk of regression.** Very low. The only behavior change is that an allocation request that could previously be silently satisfied by expired stock now correctly fails — this is the intended fix, not a side effect to guard against. Worth confirming no current seed/test data depends on an expired batch being allocatable (checked: the existing `allocateFefo` unit tests use non-expired dates).

---

## P0-04 — Password Reset

**Root cause.** Re-verified: the underlying mechanics in `src/lib/auth/service.ts` are already fully correct and secure — cryptographically random token (`generateRawToken`), hashed at rest (`hashToken`), single-use (`usedAt`), 30-minute expiry, no-enumeration behavior, and session invalidation on successful reset. The *only* problems are: (1) `console.log`s the raw token instead of delivering it (`service.ts:118`); (2) `requestPasswordResetAction` exists but is never imported by any component; (3) no `/reset-password` route exists at all — `confirmPasswordReset` has no Server Action wrapper or UI to call it.

**Files involved.** `src/lib/auth/service.ts`, `src/app/login/{actions.ts,login-form.tsx}`, new `src/app/reset-password/{page.tsx,actions.ts,request-form.tsx,confirm-form.tsx}`, `src/proxy.ts` (add `/reset-password` to `PUBLIC_PATHS` — confirmed not currently present despite being referenced in earlier documentation).

**Database models involved.** `PasswordResetToken` — already correctly modeled, no schema change.

**Security implications.** Removing the `console.log` closes a real token-leakage path (server logs are a broader-access surface than the DB). No new security surface is opened — the request/confirm actions reuse the existing, already-secure token mechanics.

**Data integrity implications.** None.

**Proposed fix — the "preferred approach" per P0.md §16.** Reuse the existing, honest `CommunicationAdapter` pattern (`src/lib/domains/communications/adapters/*`) rather than inventing a parallel one: the adapter interface (`send(input: {to, subject, body})`) is generic, not patient-scoped (patient-scoping lives in the separate `sendMessage()`/`CommMessage` wrapper, which staff password reset has no reason to go through). `requestPasswordReset` calls `new NullEmailAdapter().send(...)` directly and branches its return UI-side: since no live provider is configured in this environment, the request action returns a state telling the UI "If an account with that email exists, reset instructions would be sent — email delivery is not currently configured in this environment; contact an administrator," matching P0.md §16's explicit script for the honest-adapter case. Add the missing pieces: a "Forgot password?" link on the login form → `/reset-password` (request-email view) → on submit, the message above (never confirming/denying account existence) → the same route also serves the confirm view when a `?token=` param is present (new `confirmPasswordResetAction` wrapping the already-correct `confirmPasswordReset` service function) → success redirects to `/login`. `/reset-password` is added to `proxy.ts`'s public-path list (it must be reachable without a session).

**Migration required?** No.

**Tests required?** Not mandated explicitly by P0.md for this item, but a light unit/integration check that `requestPasswordReset` no longer logs the raw token and that the full request→confirm→login cycle works end-to-end with a real (non-Null, in-test) adapter stub is worth adding alongside the mandatory tests for the other five items.

**Rollback considerations.** Additive UI/route; no data migration. Reverting is a plain code revert.

**Risk of regression.** Low. The reused `NullEmailAdapter` already exists and is exercised elsewhere (Communications module) — no new adapter logic to get wrong. The main risk is UX confusion if the "delivery not configured" messaging isn't clear, mitigated by following P0.md's own suggested wording closely.

---

## P0-05 — Cascade Delete Protection

**Root cause.** Re-verified via a full grep of `onDelete: Cascade` in `prisma/schema.prisma` — every relation P0.md §18 names by parent model is confirmed present exactly as the audit found: from `Encounter` onto `VitalSign`, `Diagnosis`, `ClinicalNote`, `ClinicalOrder` (and everything chained beneath `ClinicalOrder`: `LabOrderDetail`/`ImagingOrderDetail`/`ProcedureOrderDetail`/`ReferralOrderDetail`, `Specimen`, `LabOrderTest`, `ImagingOrder`), `Prescription`, `FollowUpRecommendation`; from `Patient` onto `PatientAllergy`/`PatientCondition`/`PatientMedicationHistory`; from `Journal` onto `JournalLine`; from `Invoice` onto `InvoiceLine`; from `Payment` onto `PaymentAllocation`; plus `PatientPackageSession` (from `PatientPackage`), `PayrollRunLine` (from `PayrollRun`), `DispensingReturn` (from `DispensingRecord`), `ClaimItem` (from `Claim`). `Refund` itself was checked and is **not** a cascade child of anything — no change needed there; it's named in P0.md §18 as a model to *review*, and the review found it already safe. Confirmed via repo-wide grep (re-run during this planning pass) that no current application code path calls `.delete()`/`.deleteMany()` on any of these models — today's practical risk is latent, not exercised, matching the original audit.

**Files involved.** `prisma/schema.prisma` (the ~19 relation fields listed above), one new migration.

**Database models involved.** All models named above.

**Security implications.** None directly (this is data-loss protection, not access control).

**Data integrity implications.** This is the fix directly named in P0.md §18-21: prevents an entire encounter's clinical documentation, a patient's safety-critical allergy/condition/medication history, or ledger/invoice/payment detail from being silently destroyable via a parent-record delete — regardless of whether today's UI happens to expose a delete button for the parent.

**Proposed fix.** Change `onDelete: Cascade` to `onDelete: Restrict` on exactly the relations named above (and only those — join tables, sessions/tokens, notifications, provider-schedule/config, queue entries, service-consumption templates, and lab-panel-membership rows correctly remain `Cascade`, per P0.md §19's "important historical records" framing; those aren't historical records, they're operational/config data). This is a pure FK-behavior change — no new status enum, no new column, matching P0.md §19's "prefer RESTRICT... or controlled status changes" with RESTRICT chosen as the minimal, non-destructive option (the models already have appropriate status fields for the *application's* own soft-delete-equivalent lifecycle — Encounter's `active/completed/finalized`, Invoice's `issued/void`, etc. — this fix only closes the FK-level escape hatch around that discipline, it doesn't change the discipline itself).

**Migration required?** Yes. Per P0.md §20: before writing it, verify no orphan rows exist that would make a `Restrict` constraint retroactively invalid at creation time (a `Restrict` constraint only blocks future deletes; it doesn't validate existing rows, so this is a formality, but will be checked). The migration is `ALTER TABLE ... DROP CONSTRAINT ...`, `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... ON DELETE RESTRICT` for each relation — no table recreation, no data movement, fully non-destructive and reversible.

**Tests required?** Yes, per P0.md §21: attempt to delete a Patient with clinical history, an Encounter with finalized documentation, an Invoice with payments, a Journal with lines — assert each is rejected by the database (a real integration test against the live constraint, matching the existing pattern already used for the booking-exclusion and journal-balance-trigger tests).

**Rollback considerations.** `ON DELETE RESTRICT` is the FK default rollback target — reverting to `CASCADE` is a symmetric migration if ever needed. No data is touched by either direction.

**Risk of regression.** The only way this could break existing behavior is if some code path *relies on* the cascade today. Confirmed via grep: none does. Zero functional risk to the happy path; the only "regression" possible is a future *attempt* to delete one of these records now correctly failing — which is the fix working as intended, not a bug.

---

## P0-06 — Audit Log Immutability

**Root cause, re-verified with new information not in the original audit.** Confirmed no migration contains a `REVOKE` statement (unchanged from the audit). But direct verification this session found something the original audit didn't check: the connecting database role (`postgres`, used identically for both migrations and runtime — a Supabase-project-owner-style role) is the **literal owner** of both `audit_log` and `clinical_access_log` (`SELECT tablename, tableowner FROM pg_tables` confirms `tableowner = postgres` for both). In PostgreSQL, a table owner's privileges on their own table are implicit and are **not removable by `REVOKE` against that same role** — a `REVOKE UPDATE, DELETE ON audit_log FROM postgres` would execute without error but have **zero actual effect**. Applying it anyway would be exactly the false claim P0.md §23 explicitly warns against.

**Files involved.** New migration only if a new role is introduced; `SECURITY.md` (documentation of the real, verified state either way).

**Database models involved.** `AuditLog`, `ClinicalAccessLog`.

**Security implications.** This is the finding itself: today, immutability is enforced purely by the absence of any `update`/`delete` call in application code (re-confirmed: no such call exists anywhere in `src/`), not by the database. A compromised app credential or a future careless code change has nothing at the DB level stopping it.

**Data integrity implications.** Same as above — the audit trail's evidentiary value depends on this.

**Proposed fix.** Per P0.md §23's explicit guidance for exactly this situation ("if separate runtime role can safely be introduced now, implement it; otherwise implement the strongest safe protection available and document what remains"): create a new, non-owner Postgres role (`avant_app_runtime`) scoped to this database, `GRANT` it `SELECT, INSERT, UPDATE, DELETE` on every application table it needs at runtime **except** `audit_log`/`clinical_access_log`, which get `SELECT, INSERT` only — a real, verifiable restriction, tested empirically (attempt an `UPDATE` as the new role and confirm Postgres rejects it) rather than assumed. This role is created and granted via a migration-adjacent script (not a schema-tracked Prisma migration, since role/grant management is outside Prisma's migration model — documented as such, matching how this project has already handled non-schema database concerns). Cutting the *live* application over to this role (updating `DATABASE_URL` in Vercel's production environment) is a manual deployment step outside this session's tool access, exactly as the earlier production-database setup in this project's history also required — documented explicitly as a remaining step rather than silently left undone or falsely claimed complete. The local dev `.env` may optionally be pointed at the new role to prove it works end-to-end before handoff.

**Migration required?** Yes, in the sense of a database-setup script creating the role and grants (run once, idempotently guarded) — not a schema migration in the Prisma sense, since no table structure changes.

**Tests required?** An empirical verification (not a vitest test, since it requires a distinct DB connection/role) proving: (a) the new role's `UPDATE`/`DELETE` against `audit_log`/`clinical_access_log` is rejected by Postgres, (b) the new role's normal read/write on every other table it needs still works, (c) confirmation that the *existing* `postgres` role — which remains necessary for running migrations — is explicitly documented as still holding full privileges (it always will, as table owner; this is disclosed, not hidden).

**Rollback considerations.** The new role is additive; it can be dropped without affecting the existing `postgres`-role-based setup this app already runs on entirely. Zero risk to current operation, since nothing is switched over automatically.

**Risk of regression.** None to current behavior unless/until the user manually cuts the live `DATABASE_URL` over — which is out of scope for this pass to do unilaterally (a credential/infrastructure change of the same category flagged as needing explicit user action earlier in this project's history), and is documented, not silently deferred.

---

## Summary of what will NOT be touched (per P0.md §32)

No dashboard redesign, no CRM, no AI, no new domains, no new dependencies beyond what's already in `package.json`, no microservices, no framework/ORM/database swap, no refactor of code unrelated to these six items, and no P1/P2/P3/P4 work except where a P0 fix technically requires it (the payroll referenceType rename inside P0-02 is the one such case, and it's documented above as directly required for retry safety, not scope creep).
