# P4.9.1 — Commercial Readiness Corrections Report

**Date:** 2026-09-04
**Scope:** A narrow correction batch against P4.9's evidence and documentation. Does not reopen
P0–P4.9's engineering.

---

## Executive Summary

P4.9 closed with a CONDITIONAL GO and, in the course of getting there, fixed a real hosted-database
security exposure by hand and applied 7 pending migrations directly against the hosted database via
Supabase's own management connection. Both were real, correct, necessary actions at the time — but
neither was left in a state a future release could repeat without someone remembering exactly what
was done. This batch closes that gap on three fronts: (1) Row Level Security provisioning is now a
source-controlled, idempotent, dynamically-scoped script and two npm commands, wired into local
dev/test provisioning and the release gate, with its own test coverage; (2) P4.9's report and this
document now say precisely what did and did not happen with the hosted migration — the schema was
genuinely brought current, but not via `prisma migrate deploy` itself, which remains a named,
finite go-live condition rather than something quietly assumed proven; (3) the three documents that
state go-live requirements (`P4_9_COMMERCIAL_READINESS_ACCEPTANCE_REPORT.md`,
`docs/COMMERCIAL_READINESS.md`, `docs/FIRST_CLINIC_GO_LIVE_CHECKLIST.md`) now agree with each other
on exactly what is required, conditional, or deferred.

**A real, direct consequence of this batch's own RLS work was found and fixed before it ever
shipped**: enabling Row Level Security silently changed how `@prisma/adapter-pg` reports a unique-
constraint violation, which broke this project's own duplicate-request (idempotency) detection on
charge creation, payment recording, package-session consumption, goods receipts, and supplier
invoices — a real financial/inventory double-processing risk had it gone unnoticed. Caught by this
project's own existing test suite failing during this batch's own regression run, root-caused with
an isolated reproduction script, and fixed with a strictly more robust detection mechanism (see
Issue 1's Tests section and `BACKLOG.md`).

**P4 engineering closure: YES.** The commercial decision remains **CONDITIONAL GO** — these are
answered separately below, per this batch's own instruction that they are different questions.

## Scope Boundary

In scope, and only this: Supabase/PostgreSQL RLS provisioning, database setup/security scripts, the
Prisma production migration workflow and its documentation, the P4.9 report's evidence wording, and
consistency across the three commercial-readiness/go-live documents, plus targeted tests for all of
the above. No application business logic, authentication, or RBAC design changed. No new module, no
regulatory work, no UI cycle, no unrelated backlog cleanup, no start of P4.9.2. One genuinely new
mechanism was built (the RLS apply/check scripts) because that is precisely what Issue A asked for —
everything else is documentation correction and consistency, not new engineering.

## Issue 1 — RLS Reproducibility

### Previous Hosted RLS State

Traced before changing anything, as instructed:

1. **How RLS was enabled**: by hand, during P4.9, via ad hoc SQL executed through Supabase's
   project management connection (`apply_migration`/`execute_sql` MCP tools) — a hardcoded list of
   `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` statements for the 116 tables that existed at that
   moment, followed by a second hardcoded list of `CREATE POLICY` statements scoping access back to
   the `avant_app_runtime` role after the first pass accidentally locked the application itself out
   (both documented in P4.9's own transcript and report).
2. **Did the SQL exist in source control?** No. It existed only as commands run directly against
   the hosted database and in the conversation log — nowhere a future release or a new clinic's
   provisioning could find or re-run it.
3. **How are runtime-role policies created?** They weren't a reusable mechanism — one-off
   `CREATE POLICY` statements per table, typed out by hand.
4. **Would a future migration's new table automatically receive RLS protection?** No. Nothing
   re-enumerated the schema; a table created next month would ship with RLS disabled until someone
   remembered to repeat the manual procedure.
5. **Would a new clinic database be safe following only the repository's documentation/scripts?**
   No — before this batch, the repository had no RLS-provisioning script or command at all;
   `DATABASE.md` didn't mention Row Level Security anywhere.
6. **Do Supabase's `anon`/`authenticated` API roles remain denied?** Yes, as of P4.9's manual fix —
   verified again after this batch's changes (see Tests below); the policy design was already
   correct, only its reproducibility was the gap.

### Source-Controlled RLS Design

`prisma/db-setup/apply-rls.sql` — a PL/pgSQL `DO` block, not a hardcoded table list. It enumerates
every ordinary table (`pg_class.relkind = 'r'`) currently in the `public` schema at the moment it
runs and, for each: enables RLS (idempotent — a no-op if already enabled) and drops-then-creates
one named policy (`app_runtime_full_access`) scoped to the runtime role, whose actual name is
substituted in via a `__RUNTIME_ROLE__` placeholder — the same convention
`p0-06-create-runtime-role.sql` already uses for `__PASSWORD__`. Because the table list is computed
live rather than hardcoded, re-running this script after any future migration automatically covers
whatever new tables that migration added — closing the "future table" problem (Issue 8 in the
original command) without event triggers or other database-level magic, per that command's own
"simple and explicit is preferred" instruction.

`scripts/db/security.ts` provides `applySecurity()` and `checkSecurity()`, both requiring the
owner/direct connection (`assertNotPooledConnection`, reused from the existing backup/restore
guard) and deriving the runtime role's name directly from `DATABASE_URL`'s own username — never a
new, separately-maintained env var that could drift out of sync. `scripts/db/security-apply.ts` and
`scripts/db/security-check.ts` are the two CLI entry points, wired to `npm run db:security:apply`
and `npm run db:security:check`. `setupDatabase()` (the shared routine behind
`db:dev:setup`/`db:test:setup`) now calls `applySecurity()` right after the existing runtime-role
grant step — local development and test databases now provision under the identical security
posture production does, not an easier divergent one, per the original command's explicit
instruction not to weaken local test DB security for convenience.

### Runtime Role Policy

Exactly one policy per table: `FOR ALL TO <runtime role> USING (true) WITH CHECK (true)`. Deliberately
permissive for that one role — see "RLS and Multi-Tenancy Language" below for why that is correct,
not a shortcut. Deliberately **not** `TO public`.

### Anon / Authenticated API Access

No policy is ever created for Supabase's `anon` or `authenticated` roles — RLS's own default-deny
applies to any role with no matching policy, which is exactly what continues to protect Supabase's
Data API path. Verified locally with a simulated unprivileged role (see Tests below); the real
`anon`/`authenticated` roles only exist on a genuine Supabase project, so this is the closest
locally-reproducible equivalent, exactly as the original command anticipated ("insofar as locally
reproducible").

### Audit Immutability Verification

RLS and the table-level `GRANT`/`REVOKE` layer (`audit_log`/`clinical_access_log` UPDATE/DELETE
revoked from the runtime role, per P0-06) are independent enforcement mechanisms in PostgreSQL — a
permissive RLS policy cannot resurrect a privilege the GRANT layer already revoked. Verified
explicitly this batch, under RLS now enabled, not merely assumed: see Tests below.

### Future Table Protection

Solved by the dynamic enumeration in `apply-rls.sql` itself (see Source-Controlled RLS Design
above) — no event triggers, no second mechanism. The operational half of "a new table cannot
quietly enter production with RLS disabled" is `db:security:check` in the release gate (see Release
Integration below): a future migration adding a table without a subsequent `db:security:apply` run
now fails the release gate loudly, rather than shipping silently unprotected.

### Security Apply / Check Commands

- `npm run db:security:apply` — idempotent, requires the owner/direct connection, applies
  `apply-rls.sql`. No reset, no drop, no destructive data modification — only DDL that enables RLS
  and (re)creates one named policy.
- `npm run db:security:check` — read-only, safe in production, exits nonzero and names every
  unprotected table if RLS is disabled or the expected policy is missing anywhere in `public`.
  Prints no connection string or credential.

### Release Integration

Added to `scripts/release/check.ts`'s `GATES` array, immediately after the existing migration-drift
check (`prisma migrate status`) and before typecheck — both are cheap, read-only checks of the
target database's current state, fail-fast ahead of the slower gates. `docs/RELEASE_RUNBOOK.md`'s
Migration section and Default Release Sequence, and `DEPLOYMENT.md`'s Deployment Checklist, were
updated to the real sequence actually implemented: migrate deploy → (re-grant runtime role on new
tables, if any) → `db:security:apply` → `db:security:check` → application deploy → health/smoke.
`release:check` itself only ever *checks* (never applies) — an explicit design choice so this gate
can never silently mutate the database it's validating; a failing check tells the operator to run
`db:security:apply` and re-run the gate, exactly as a failing migration-drift check already tells
them to run `migrate deploy`.

### Tests

`test/integration/p4-9-1-db-security-rls.test.ts` (9 tests, run against local `his_test`, the real
`scripts/db/security.ts` functions — not a reimplementation):

- `deriveRuntimeRoleName` reads the real role name out of a connection string (both
  `his_app_runtime` and a `avant_app_runtime`-shaped string), never hardcoded.
- `applySecurity` is idempotent — runs twice in a row without error.
- `checkSecurity` reports every real public-schema table (120+ locally) as protected.
- `checkSecurity` correctly detects a table with RLS manually disabled as unsafe, and confirms
  `applySecurity` heals it back to safe on re-run — the actual future-table/drift scenario.
- A simulated unprivileged role (standing in for Supabase's `anon`/`authenticated`), despite a real
  table-level `SELECT` grant, reads **zero rows** from a table that genuinely has data — RLS, not
  an empty table or a missing grant, is what blocks it.
- The real application runtime role retains full normal read/write access under RLS.
- `audit_log`/`clinical_access_log` remain UPDATE/DELETE-blocked for the runtime role with RLS now
  enabled — re-confirming `test/integration/audit-log-immutability.test.ts`'s own guarantee under
  this phase's change, not merely assuming it still holds.
- A real duplicate-insert unique-constraint violation on `idempotency_key` is still correctly
  detected by `isIdempotencyKeyConflict()` with RLS enabled — the direct regression guard for the
  bug described immediately below.
- `applySecurity` refuses a pooled connection string for the owner/direct parameter.

`test/integration/p4-8-release-safety.test.ts`'s existing `GATES` shape/order assertions were
updated to include the new "DB security check (RLS)" gate at its correct position — a small,
known, correct change to the gate list.

**A real, more consequential regression was also found and fixed here, not merely a test-list
update**: the first full-suite run after wiring `applySecurity()` into local
`db:dev:setup`/`db:test:setup` failed 6 pre-existing tests across 5 files
(`idempotency-and-transaction-review.test.ts`, `p3-13-cross-role-end-to-end.test.ts`,
`p3-7-billing-pos-cashier-workflow.test.ts`, `p3-8-inventory-procurement-operational-ux.test.ts`,
`package-session-concurrency.test.ts`) — every one of them a duplicate-request/idempotency test for
charges, payments, package sessions, goods receipts, or supplier invoices. Root-caused with an
isolated reproduction script (`scripts/db/security.ts`'s own development, not a permanent
artifact): `src/lib/platform/idempotency.ts`'s `isIdempotencyKeyConflict()` detected a duplicate
claim via `error.meta.driverAdapterError.cause.constraint.fields`, a field `@prisma/adapter-pg`
stops populating the moment RLS is enabled on the table involved — confirmed deterministic by
toggling RLS on/off against the same table and the same duplicate insert three times in a row.
Fixed by matching on `error.meta.modelName === "IdempotencyKey"` instead (present regardless of
RLS/driver state, and exactly as precise given `claimIdempotencyKey()`'s own "always the first
statement in the transaction" guarantee) — see `BACKLOG.md`'s resolved entry for the full
before/after. All 6 originally-failing tests pass again, plus one new direct regression test in
`test/integration/p4-9-1-db-security-rls.test.ts` reproducing the exact failure mode. This was a
real, direct consequence of this batch's own Issue-A work — squarely inside this batch's scope to
fix, not an unrelated finding deferred to `BACKLOG.md`.

## Issue 2 — Hosted Prisma Migration Evidence

### What Actually Happened in P4.9

7 pending migrations were applied against the hosted Supabase database by executing each
migration's raw SQL through Supabase's own management API connection (`apply_migration`), then
manually computing each migration file's SHA-256 checksum locally and inserting a matching row into
`_prisma_migrations` by hand so Prisma's own tracking would agree with what had actually been
applied. This is a real, working way to bring a hosted schema to the correct state when the session
running it has Supabase management-API access but not a direct Postgres credential for that
project — which was this engagement's actual situation. It is **not** the same procedure as running
`npx prisma migrate deploy` against `DIRECT_DATABASE_URL`, which is this project's own documented
production standard (`docs/RELEASE_RUNBOOK.md`, `DEPLOYMENT.md`).

### Corrected Evidence Classification

**PROVEN**, and unchanged by this correction:

- The hosted schema was successfully brought to the current migration state (40/40,
  `prisma migrate status` reports no drift against it).
- Hosted relational data survived the migration process (verified: zero unbalanced journals across
  226, zero overpaid invoices, zero negative-quantity stock batches, exactly one `payroll_run` per
  organization/branch/period after a documented, authorized cleanup).
- The hosted application worked correctly after migration (real production login, real dashboard
  rendering real data, `/api/health` reporting healthy).
- `_prisma_migrations` currently reports a clean, consistent 40-row history.

**NOT YET DIRECTLY PROVEN**:

- The exact command `npx prisma migrate deploy`, executed end-to-end against an isolated hosted
  Supabase database, with `DIRECT_DATABASE_URL` pointed at a real direct/privileged Postgres
  connection for that project.

`P4_9_COMMERCIAL_READINESS_ACCEPTANCE_REPORT.md` has been corrected in place (not rewritten) at
every point that previously claimed or implied the latter — see the "P4.9.1 correction" notes now
present in its Executive Summary, Commercial Acceptance Matrix, Database/Migration section, "P4.8
Conditions" classification, and Final Decision reasoning. The historical record of what actually
happened is preserved throughout; only the characterization of which specific command produced it
was corrected.

### Actual `prisma migrate deploy` Rehearsal

Not performed this batch.

### Why Hosted Migration Execution Remains Unproven

No safe, genuinely isolated hosted Supabase database was available to this batch without
provisioning new billed infrastructure (a new Supabase project/branch) — an action outside this
batch's own narrow scope and not something to do unilaterally without the user's explicit go-ahead,
consistent with the original P4.9.1 command's own instruction (§17): *"If no safe hosted rehearsal
exists: do not force it... That is stronger evidence than inventing another live production
migration."* No fake/unnecessary schema migration was created to manufacture something for
`migrate deploy` to run against, no historical migration file was modified, and the live production
database was not used to rehearse anything destructive or exploratory.

### Required Hosted Migration Rehearsal

Folded into the existing hosted backup/restore go-live condition (already true in spirit in P4.9's
Go-Live Condition 1; now explicit): backup → restore into an isolated target → **real
`prisma migrate deploy` against that isolated target** → `db:security:apply`/`db:security:check` →
runtime-role connectivity check → reconciliation. This is now stated identically in
`docs/FIRST_CLINIC_GO_LIVE_CHECKLIST.md`'s Backup section and `docs/COMMERCIAL_READINESS.md`'s
Required-Before-Go-Live section A.

`scripts/db/upgrade-drill.ts` (the existing local analog of this rehearsal, `npm run
db:upgrade:drill`) was extended with the identical RLS step (backup → restore → migrate status/
deploy → **apply and verify RLS** → runtime-role check → reconciliation) so the local drill and the
still-outstanding hosted rehearsal now describe the same six-step procedure — the hosted version is
the same steps against a hosted target, not a different, undocumented process. Re-run this batch:
**PASSED** — real backup of `his_dev`, restore into an isolated local database, 39/39 migrations
confirmed with none pending, RLS applied and verified (120 tables protected), and reconciliation
clean (18 journals balanced, 1 invoice reconciled, no negative stock) — see Final Regression below.

## Issue 3 — Go-Live Condition Consistency

### Hosted Backup / Restore Policy

**Required before the first real clinic go-live** (upgraded from P4.9's "recommended, not an
absolute blocker" language) — now includes the real `prisma migrate deploy` rehearsal described
above as part of the same procedure, not a separate open item.

### External Monitoring Policy

**Required before the first real clinic go-live.** P4.9's own report already treated this as a
Go-Live Condition; `docs/COMMERCIAL_READINESS.md` previously undercut that by calling it merely
"not yet configured (a pre-go-live condition, not a defect)" without stating plainly that it is
required. Corrected — see `docs/COMMERCIAL_READINESS.md`'s "Required Before The First Real Clinic
Go-Live" section, item B.

### Email Policy

**Conditional**, unchanged in substance from P4.9: required before go-live only if the clinic needs
self-service password reset at launch; otherwise the manual-reset operational procedure suffices
and email remains a post-launch item. Now stated identically in both documents.

### Rollback Policy

**Required before the first HIGH-risk release after go-live, not the initial pilot go-live
itself** — unchanged from P4.9's own reasoning (there is no "prior good state" of the current
codebase to roll back to on the very first deploy), now stated identically in both documents rather
than only in the P4.9 report.

### Staging Policy

**Required before the next HIGH-risk release, not the initial pilot go-live** — unchanged from
P4.9, now stated identically in both documents.

### Documents Updated

- `P4_9_COMMERCIAL_READINESS_ACCEPTANCE_REPORT.md` — corrected in place (migration evidence
  wording, matrix row, P4.8 conditions classification, Final Decision reasoning); a pointer note
  added to its own Go-Live Conditions section directing readers to this document and
  `docs/COMMERCIAL_READINESS.md` as the now-authoritative version. No unrelated section rewritten.
- `docs/COMMERCIAL_READINESS.md` — "Current Limitations" replaced with explicit "Required Before
  The First Real Clinic Go-Live" / "Conditional Before Go-Live" / "Required Before The First
  High-Risk Post-Go-Live Release" / "Other Current Limitations" sections, matching the checklist
  exactly.
- `docs/FIRST_CLINIC_GO_LIVE_CHECKLIST.md` — Database section updated to use the new
  `db:security:apply`/`db:security:check` commands instead of manual SQL; Backup section expanded
  into the full isolated-restore-plus-migrate-deploy-rehearsal procedure and marked REQUIRED BEFORE
  GO-LIVE; Monitoring and UAT sections marked REQUIRED BEFORE GO-LIVE; Go-Live section now requires
  explicit confirmation of all three before the final checklist items.
- `DATABASE.md` — new "Row Level Security" section (placed after the existing "Connection Roles"
  section it complements).
- `docs/RELEASE_RUNBOOK.md` — Default Release Sequence and Migration section updated to include the
  `db:security:apply`/`db:security:check` steps at their correct position.
- `DEPLOYMENT.md` — Deployment Checklist updated with the new RLS provisioning step at its correct
  position (after migrations, before seeding).
- `BACKLOG.md` — no new entries this batch (nothing found that qualified; the three issues this
  batch addressed were the assignment itself, not incidental discoveries).

## Final Regression

All green, run against local Postgres only — never production:

- `npx prisma validate` — valid.
- `npx prisma migrate status` — up to date (39 migration files, no drift), against `his_dev` with
  RLS now applied via `db:dev:setup`.
- `npm run typecheck` — clean.
- `npm run lint` — clean.
- Targeted P4.9.1 tests (`test/integration/p4-9-1-db-security-rls.test.ts`) — **9/9 passing**
  (grew from 8 to 9 after the idempotency-detection regression below was found and a direct
  regression test added for it), run standalone and combined with the updated
  `p4-8-release-safety.test.ts`.
- `npm run test:components` — **12/12**.
- `npm run test` (full integration suite) — **607/607 passing across 63 files** (598 carried from
  P4.9 + 9 new P4.9.1 tests), run twice: once inside `release:check`, once standalone — both clean.
  The first run after wiring RLS into local provisioning failed 6 tests across 5 files (the
  idempotency-detection regression, see Issue 1's Tests section and `BACKLOG.md`) — both
  subsequent full runs, after the fix, passed completely clean.
- `npm run test:e2e` — **21/21**, against a real production build (`next build` → `next start`),
  re-run specifically because this batch's RLS work could plausibly have affected any live
  database interaction.
- `npm run build` — clean, 56 routes.
- `npm run release:check` — **all 8 gates green** (7 from P4.8 + the new "DB security check (RLS)"
  gate): Prisma schema validation, migration drift check, DB security check, TypeScript, Lint,
  Component tests, Integration tests, Production build.
- `npm run db:security:check` — clean against `his_dev` (120 tables, all protected) after
  `db:dev:setup` re-ran with the new `applySecurity()` step wired in.
- `npm run db:upgrade:drill` — **PASSED**, including its new RLS step: real backup of `his_dev` →
  restore into an isolated local rehearsal database → `prisma migrate status`/`migrate deploy`
  (39/39, no pending) → schema/grant verification → **RLS applied and verified (120 tables
  protected)** → reconciliation via the restricted runtime connection (18 journals balanced, 1
  invoice reconciled, no negative stock) — the first time this drill has verified RLS as part of
  its own rehearsal, not just schema and grants.

## Remaining Go-Live Conditions

Unchanged in substance from P4.9, now consistently stated across all three documents (see Issue 3
above): (A) hosted backup + isolated restore + real `prisma migrate deploy` rehearsal — required;
(B) external error monitoring — required; (C) clinic-specific UAT sign-off — required; email —
conditional on self-service reset; rollback drill and dedicated staging — required before the first
HIGH-risk post-go-live release, not the initial pilot.

## P4 Closure Decision

**Can P4 now be formally closed? YES.**

All nine criteria from the original command's own P4 Engineering Closure Definition are met:

1. RLS/security provisioning is reproducible from source control — `prisma/db-setup/apply-rls.sql`
   + `scripts/db/security.ts` + two npm commands, wired into local provisioning and the release
   gate.
2. RLS verification exists — `npm run db:security:check`, read-only, safe in production.
3. Runtime audit restrictions remain intact — explicitly re-verified under RLS this batch, not
   merely assumed.
4. Migration evidence language is corrected — `prisma migrate deploy` is no longer claimed where
   the actual procedure was management-connection SQL plus manual `_prisma_migrations` inserts.
5. Manual `_prisma_migrations` manipulation is explicitly documented as exceptional, not normal
   procedure, in both the corrected P4.9 report and this document.
6. Actual hosted `prisma migrate deploy` execution is explicitly retained as a finite, named
   go-live rehearsal condition (folded into the hosted backup/restore condition) rather than either
   fabricated or silently left inconsistent.
7. Commercial-readiness docs agree on what is required before real clinic go-live — the three
   documents now state the same policy in the same terms.
8. Regression remains clean (see Final Regression above).
9. No new safety blocker exists **as of this report** — one genuinely did exist transiently, within
   this same batch: enabling RLS broke duplicate-request detection on 5 financial/inventory write
   paths (see Issue 1's Tests section). It was caught by this project's own existing regression
   suite before ever being reported as done, root-caused, and fixed within this batch — squarely
   the "immediate risk of financial/inventory corruption" carve-out this batch's own scope rules
   permit fixing directly rather than deferring to `BACKLOG.md`. No other unrelated finding rose to
   that bar.

The commercial decision — a separate question, per this batch's own instruction — remains
**CONDITIONAL GO**, unchanged: documentation consistency alone does not manufacture proof that the
still-open external conditions (hosted backup/restore/migrate-deploy rehearsal, external
monitoring, clinic UAT sign-off) have actually been performed. They have not been performed this
batch, and this report does not claim otherwise.

---

Per this batch's own explicit stop condition: **P4.9.1 is complete.** P4.9.2 (Extended Clinic Data
Import Coverage) does not begin automatically — returning this report for review first.
