# P4.8 — Release / Migration / Upgrade Safety Report

**Date:** 2026-09-04
**Scope:** Establish a repeatable, documented release discipline — versioning/release identification, a pre-release gate, migration classification and rehearsal, backup-before-migration, failure/rollback/recovery procedures, release notes/changelog, and post-deploy validation — so a production upgrade is a controlled engineering change, never an improvised one.

---

## Executive Summary

This phase traced the actual, already-built release path (§ Current Release Architecture) and found it substantially sound: `prisma migrate deploy` (never `migrate dev`) as an explicit, separate step; a genuinely separated runtime/owner database-role split; a real, previously-drilled backup/restore mechanism (P4.2); fail-fast environment validation (P4.1); a health endpoint distinguishing liveness from readiness (P4.1). What was missing was the **discipline layer on top**: a single command proving a release candidate is safe to ship, a documented migration-classification scheme with concrete safe patterns (NOT NULL, enum, rename, expand/migrate/contract), a real local upgrade-rehearsal drill, a release-notes/changelog convention, and an explicit release-risk model tying all of the above together with a human owner. This phase built exactly that layer, reusing — never duplicating — the substantial P4.1-P4.5 foundation.

New this phase: `npm run release:check` (a single pre-release gate: schema validation → migration drift → typecheck → lint → component tests → integration tests → production build, stopping at the first failure — proven for real during this phase's own release simulation, where it caught a genuine bug in its own first draft, §Release Simulation), `npm run db:upgrade:drill` (a real local migration-rehearsal drill reusing the existing backup/restore mechanism, proven to pass against a real copy of `his_dev`), a shared release-version identifier (`src/lib/platform/release.ts`) used identically by `/api/health` and the structured logger, five new release-process documents, `CHANGELOG.md`, a release-notes template, and 12 new focused tests for this tooling.

**Can P4.8 be closed? YES** — see the Acceptance Decision.

---

## Scope Boundary

In scope, and touched: Prisma migration discipline and rehearsal, release gating, CI, health/version identification, production-safety guards, release documentation (checklist/runbook/migration-safety/versioning/changelog), release compatibility rules (Outbox/scheduler/session/env/import/export).

Out of scope, not attempted: no infrastructure redesign (no Kubernetes, no microservices, no feature-flag platform, no blue/green infrastructure), no regulatory work, no UI changes beyond what release tooling itself required, no whole-codebase audit, no unrelated backlog cleanup. The one UI-adjacent fix this phase made (§ Files Changed) was strictly a release-tooling side effect (see Files Changed) — not a UI phase.

---

## Current Release Architecture (as traced, before any change)

1. **Build**: `npm ci` → `npx prisma generate` → `next build`. No speculative build steps.
2. **CI**: `.github/workflows/ci.yml` — on every PR/push to `main`, spins up a disposable Postgres service container, sets up `his_test` + the restricted runtime role, then `prisma generate` → `db:test:setup` → `prisma validate` → `typecheck` → `lint` → `test` (integration) → `build`. Never touches `his_dev` or Supabase.
3. **Migrations applied**: `prisma migrate deploy`, always — `prisma migrate dev` is explicitly documented as unsafe against a Supabase-hosted database (shadow-database drift false-positives, observed hangs) and is never used past local development. Every one of this project's 39 migrations was generated via `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, hand-reviewed, then applied with `migrate deploy`.
4. **DB URL used by the runtime application**: `DATABASE_URL` — the restricted `avant_app_runtime`/`his_app_runtime` role (full CRUD except `UPDATE`/`DELETE` on `audit_log`/`clinical_access_log`).
5. **DB URL used by the Prisma CLI**: `DIRECT_DATABASE_URL` — the schema-owner role, DDL rights, never read by the running application.
6. **Production seed**: `npm run db:seed` (`tsx prisma/seed.ts`), run once against a fresh database through the restricted runtime connection (seeding is DML, safe through that role). In `NODE_ENV=production`, generates a random bootstrap Super Admin password (printed once) rather than the well-known local-dev default.
7. **Vercel deploy start**: a normal `next build`/`next start`-shaped deployment; migrations are **not** run automatically on boot — `instrumentation.ts`'s `register()` hook only validates environment variables (fail-fast), it never runs a migration.
8. **Migration failure**: no automated handling existed beyond "the deploy step errors" — this phase's docs (§ below) now give this an explicit, documented procedure, building on the already-existing guidance in `BACKUP_DISASTER_RECOVERY.md`.
9. **App deploy succeeds, DB migration failed**: previously undocumented as a distinct scenario — now explicit in `DATABASE_MIGRATION_SAFETY.md`'s Failure Handling.
10. **DB migration succeeds, app deploy fails**: previously undocumented as a distinct scenario — now explicit, with the Expand/Migrate/Contract rationale for why the previous app version usually stays compatible.
11. **Application rollback**: Vercel's own instant-rollback-to-previous-deployment — already referenced in `PRODUCTION_DEPLOYMENT.md`'s Rollback Basics; now given its own actionable section in `RELEASE_RUNBOOK.md`.
12. **Database rollback**: none exists, by design — this project never generates down-migrations; recovery is forward-fix or restore-from-backup, already the documented philosophy in `BACKUP_DISASTER_RECOVERY.md`, now cross-referenced from the new release docs rather than restated.
13. **Backup before release**: documented (`BACKUP_DISASTER_RECOVERY.md`'s Pre-Deployment Backup Procedure) but not tied to an explicit release-risk model — now is (`RELEASE_CHECKLIST.md`'s Release Risk Levels).
14. **Health check after deployment**: `GET /api/health` — a cheap `SELECT 1` through the real runtime connection, already existed, already correct; reused unchanged (see Health Endpoint below).
15. **Release version in logs**: already existed (`VERCEL_GIT_COMMIT_SHA` truncated, falling back to `npm_package_version`) but computed independently in two places (`logger.ts` and `/api/health`) — consolidated into one shared module this phase (`src/lib/platform/release.ts`), behavior-identical, now impossible for the two to silently drift apart.

**Conclusion of the trace**: the mechanics were already sound and had already survived real incidents (the Supabase transaction-pooler outage, the runtime-role-grant regression, the Vercel Hobby-cron rejection — all documented, all fixed). What this phase adds is the discipline and rehearsal layer that turns "the mechanics work" into "a release is a repeatable, gated, documented procedure."

---

## Release Risk Model

Three levels — LOW (UI-only, no schema/critical-behavior change), MEDIUM (backwards-compatible business change and/or additive migration), HIGH (financial/clinical/inventory migration, data backfill, destructive schema change, secret rotation, infrastructure change). Full definitions, required extra steps for HIGH, and the Release Owner responsibility in `docs/RELEASE_CHECKLIST.md`.

---

## Versioning / Release Identification

`docs/RELEASE_VERSIONING.md`: pragmatic pre-1.0 `MAJOR.MINOR.PATCH` (patch = safe fix, minor = backwards-compatible feature/additive migration, major = deliberately breaking, reserved even pre-1.0). `package.json`'s `"version"` is the source of truth for semver; `getReleaseVersion()` (`src/lib/platform/release.ts`) is the runtime identifier (`VERCEL_GIT_COMMIT_SHA` → optional `RELEASE_VERSION` → `npm_package_version` → `"unknown"`), now used identically by `/api/health`'s `version` field and every structured log line's `release` field — verified live: a real `npm run build && npm run start` reported `"version":"0.1.0"` from `/api/health` (§ Release Simulation). Git tagging convention (`vN.M.P`) documented as a deliberate, manual operator action — nothing in this repository pushes a tag automatically.

---

## CI / Release Gates

`npm run release:check` (`scripts/release/check.ts`) — the single pre-release verification command: Prisma schema validation → migration status (drift check) → TypeScript → lint → component tests → integration tests → production build, in that order, stopping at the first failure and printing a clear pass/fail summary. No "warning but deploy anyway" path exists for any of these — a failing gate exits nonzero and the script says so explicitly. E2E (`npm run test:e2e`) is deliberately excluded from this gate (it needs a live server this script doesn't manage) and instead runs as its own release-smoke step against a real built server — see Release Sequence.

`.github/workflows/ci.yml` updated: **component tests now run on every PR/push** (`npm run test:components` — cheap, jsdom-only, no database). Playwright was evaluated for CI inclusion and deliberately kept out, documented inline in the workflow file itself: it needs a live server and real browser time, and would trade CI speed/reliability for coverage `npm run test` and the build step already substantially provide at the CI layer — it remains a release-candidate/staging step (`RELEASE_RUNBOOK.md`), not a PR gate.

---

## Database Migration Discipline

`docs/DATABASE_MIGRATION_SAFETY.md` — the full discipline document. Summary of what's new/newly explicit:

- **Migration ownership**: the runtime/owner role split, restated concisely with the real regression this project already hit once (a bare copy of the GRANT statement silently re-opening the audit-immutability REVOKE) as the cautionary example.
- **Migration classification**: Additive/Transitional/Destructive, with concrete examples for each — governs new migrations going forward; historical migrations were not retroactively reclassified.
- **Never edit an applied migration** — restated from `BACKUP_DISASTER_RECOVERY.md`, cross-referenced not duplicated.
- **Migration drift detection**: `prisma migrate status`, now a standing gate in `release:check` and CI, plus the stronger real-data version below.

## Migration Compatibility Strategy

- **NOT NULL safety**: nullable → backfill → validate (`count(*) WHERE x IS NULL = 0`) → constrain. Never `ADD COLUMN ... NOT NULL` directly onto a populated table.
- **Enum safety**: appending a value is safe/additive; removing/renaming one is treated as Destructive (data migration + compatibility plan required).
- **Index safety**: a plain `CREATE INDEX` is fine at this project's current measured table sizes; `CREATE INDEX CONCURRENTLY` (via a hand-written migration, since Prisma's declarative schema can't express it) is documented as the pattern for when real production volume calls for it — not applied retroactively.
- **Column rename**: never a direct `RENAME COLUMN` in production — add new, dual-write/backfill, switch, drop old, each its own release.

## Expand / Migrate / Contract

Documented as the required pattern for Transitional/Destructive changes (Release A: expand schema, keep old app compatible → migrate/backfill data → Release B: switch app to new schema → Release C: contract, remove old schema only once nothing depends on it) — not forced onto trivial additive migrations. This is also the reasoning behind the "migration succeeded, app deploy failed" failure-handling rule: an additive Release A migration keeps the *previous* app version compatible, so rolling back the app alone (leaving the schema in place) is the normal, safe response — never reflexively "roll back" a schema the old app already works with.

## Data Migration Strategy

Backfills must be explicit scripts or controlled SQL — never hidden in a page request. Required: idempotent where practical, measurable/logged, safe to retry, bounded transactions for large tables, validated after completion with a concrete query. No generic migration framework was built — each backfill stays small and specific, following `scripts/db/upgrade-drill.ts`'s own reconciliation-query pattern as the model for "validated after completion."

---

## Backup Before Release

Builds directly on `BACKUP_DISASTER_RECOVERY.md`'s existing Pre-Deployment Backup Procedure — not duplicated, tied explicitly to the new Release Risk Levels: every release verifies the managed backup/PITR is healthy (free); a HIGH-risk or otherwise "risky" release additionally takes an independent `npm run db:backup` and records its identifier. A failed backup for a risky release means **STOP RELEASE** — stated explicitly in `DATABASE_MIGRATION_SAFETY.md`.

---

## Migration Rehearsal

**`npm run db:upgrade:drill`** (`scripts/db/upgrade-drill.ts`) — new this phase. Reuses `scripts/db/backup.ts`/`restore.ts` exactly as already drilled in P4.2 (no second pg_dump/pg_restore implementation):

1. Real `pg_dump` of `his_dev`.
2. Restore into an isolated rehearsal database (`his_restore_test_upgrade_drill`) — guarded by the exact same `assertIsSafeRestoreTarget` naming pattern every other restore in this project already requires, with no override.
3. `prisma migrate status` then `prisma migrate deploy` against that real, populated copy — the actual rehearsal: does the current migration set apply cleanly to real relational data, not just an empty database (already covered elsewhere by `db:dev:setup`/`db:test:setup`/CI).
4. Verifies the runtime role's grants were correctly re-established and Postgres extensions are present.
5. Runs reconciliation checks (every journal balances; every invoice's paid amount matches its payment-allocation sum; no negative stock balances) through the restricted runtime connection against the real restored data.
6. Cleans up (drops the rehearsal database).

**Honest limitation, stated in the script's own header and in `DATABASE_MIGRATION_SAFETY.md`**: this does not literally rewind to an earlier migration checkpoint — Prisma has no supported down-migration mechanism, and this project's own "forward-fix, never edit an applied migration" rule means none is maintained. This is the documented fallback the phase spec itself allows: a real rehearsal against a real, populated, already-migrated copy of an existing database, proving the closest honest equivalent.

---

## Upgrade Drill (Real Run)

Executed for real against a local copy of `his_dev` (39 migrations, real relational data from this engagement's own P4.7A.1 walkthrough — patients, appointments, encounters, invoices, payments, journals, stock ledger entries):

```
[1/5] Backup: 518,550 bytes, 39 migrations captured
[2/5] Restore into his_restore_test_upgrade_drill: success
[3/5] prisma migrate status: "Database schema is up to date!"
      prisma migrate deploy: "No pending migrations to apply."
[4/5] Extensions OK (plpgsql, btree_gist). Applied migrations: 39.
[5/5] Reconciliation:
      [OK] Every journal balances — 18 journal(s) checked, all balanced.
      [OK] Every invoice.paidAmount matches its payment_allocation sum — 1 invoice(s) checked, all reconciled.
      [OK] No negative stock balances — none found.
Cleanup: rehearsal database dropped.
RESULT: PASSED
```

This is a real, evidenced local upgrade rehearsal (§21 acceptance item) — not a description of what one would look like.

---

## Production Safety Guards

Reused, not rebuilt: `assertNotRemoteHost` (blocks Supabase/AWS/Neon/Render/Railway/Azure/CockroachDB host fragments — a blocklist by design, catching an accidental remote-credential paste), `assertIsTestDatabase`/`assertIsLoadTestDatabase` (exact-name allowlists for `his_test`/`his_load_test`), `assertIsSafeRestoreTarget` (only `his_restore_test*`-named databases accepted, `his_dev`/`his_test`/anything containing "prod" explicitly blocked, no override), `assertNotPooledConnection` (backup/restore must use a direct connection, never the transaction pooler). `db:upgrade:drill` reuses every one of these unmodified — no new guard logic was written, no existing guard was weakened. 12 new tests (§ Tests Added) exercise the specific new usage (the drill's own rehearsal-database name) plus the release-gate script's own shape.

---

## Release Sequence

Documented in `docs/RELEASE_RUNBOOK.md`: prepare (checkout + `release:check`) → backup (risk-based) → migration (`migrate deploy`, verify `migrate status`) → application deployment (`build` + `start`/platform deploy) → verification (`/api/health` + smoke) → release closure. The "there is no universal app-first/db-first rule" instruction is honored explicitly — the default sequence above is for backwards-compatible migrations; a Transitional/Destructive migration's specific release plan (documented in that release's own notes file) may need a different order, stated as such.

---

## Failure Handling

`DATABASE_MIGRATION_SAFETY.md`'s Failure Handling section, cross-referencing `BACKUP_DISASTER_RECOVERY.md`'s existing "Failed `prisma migrate deploy`" procedure rather than restating it: stop, don't blindly rerun, inspect `migrate status` and the real DB error, determine partial-execution, use `migrate resolve` only when genuinely justified, restore from backup only for real data damage. The distinct "migration succeeded, app deploy failed" case is now explicit (§ Migration Compatibility Strategy above).

---

## Application Rollback

Vercel's own instant-rollback/promote-previous-deployment mechanism — documented conceptually (this phase does not invent CLI syntax Vercel doesn't actually support; `RELEASE_RUNBOOK.md` points at the dashboard action and notes the CLI equivalent exists per Vercel's own current documentation). Explicitly, repeatedly stated as **application-only** — never implies a database rollback.

---

## Database Recovery

Not duplicated — `RELEASE_RUNBOOK.md`'s Database Recovery section is a short pointer into `BACKUP_DISASTER_RECOVERY.md`'s full Disaster Recovery Scenarios and Post-Restore Checklist, which already cover this in complete, previously-drilled detail (P4.2).

---

## Outbox / Scheduler Compatibility

New, explicit rule in `DATABASE_MIGRATION_SAFETY.md`: **a release must remain capable of safely reading already-persisted `OutboxEvent` payloads until that payload shape can no longer exist in the table.** `OutboxEvent.payload` is loosely-typed JSON; nothing enforces a schema at read time beyond what each handler chooses to destructure, and the bounded retry/dead-letter design means an old-shaped event can genuinely still be sitting in the table when a new release's handler runs. Documented preference: add optional fields, add a version field only for a genuinely incompatible change, never remove/rename a field an already-deployed handler reads without confirming no old-shaped row remains. Scheduler overlap is already safe by construction (`dispatchBatch`'s atomic conditional claim) — restated, not re-engineered; a release must simply verify scheduler configuration itself survived any platform change (the Vercel Hobby daily-cron constraint already documented elsewhere is referenced, not re-solved).

---

## Environment Variable Changes

`DATABASE_MIGRATION_SAFETY.md`'s Environment Variable Changes: classify every new variable (required/optional, secret/non-secret); configure the target platform **before** deploying code that reads it, never the reverse; prefer optional-then-required over a single required introduction where practical; never weaken an existing security-required variable. `RELEASE_VERSION` (this phase's own new optional variable) was added to `src/lib/env.ts`'s schema as the first real example of this classification in practice.

---

## Import / Export Compatibility

Documented, not re-engineered: CSV import templates are already versioned (P4.6) — a breaking shape change belongs in a new template version, with older-version acceptance/rejection stated explicitly. Reporting exports (P4.7) are, in practice, a customer-facing data contract — additive columns are safe, a breaking export change is a release-notes Breaking Change, and a formal export-versioning scheme is named as a future build-when-actually-needed item, not built speculatively now.

---

## Release Notes / Changelog

- `docs/releases/RELEASE_TEMPLATE.md` — the per-release notes template (version, risk level, owner, user-visible changes classified Feature/Fix/Security/Database/Operational/UI-UX/Breaking, schema/data migrations, environment changes, deployment order, rollback considerations, known issues, post-release validation).
- `CHANGELOG.md` — created fresh, starting from the current commercial-readiness baseline (P4.8) rather than reconstructing every historical phase's commit history; an `[Unreleased]` section already lists this phase's own additions, plus a "Baseline at P4.8" snapshot naming what "commercial-readiness" actually covers today and the known, deliberately-carried-forward gaps.

---

## Post-Deploy Health / Smoke

`/api/health` reused unchanged — already correct (a cheap `SELECT 1` through the real runtime connection, `200`/`healthy` or `503`/`unhealthy`, version identifier included, no sensitive internals exposed). Serves both liveness (process responding) and readiness (database reachable) in one endpoint — no separate container-style liveness/readiness probes were built, since this deployment target (Vercel) has no need for them. `RELEASE_CHECKLIST.md`'s Post-Deploy Smoke names the representative critical-route checklist (login, Dashboard, Reception, patient search, Patient 360, Doctor queue/encounter, Pharmacy, POS, Reports) and explicitly reuses `npm run test:e2e` (the P4.7A/P4.7A.1 Playwright suite) as the release-smoke mechanism — no second E2E framework was built, per the phase's own explicit instruction.

---

## Reconciliation After High-Risk Changes

`RELEASE_CHECKLIST.md`'s Reconciliation section — risk-based, not run after every release. Financial (journal balance, invoice/payment-allocation reconciliation, stock-ledger reconciliation, no negative stock) reuses the exact queries `scripts/db/upgrade-drill.ts` already runs automatically during rehearsal. Clinical (representative Encounter relationships intact, a finalized note still read-only with correct content, a representative Lab/Radiology order's status/result data intact) is explicitly read-only — never alters a finalized record during validation.

---

## Tests Added / Updated

`test/integration/p4-8-release-safety.test.ts` — 12 new tests, deliberately narrow (the real proof is running the tools for real, §§ Upgrade Drill / Release Simulation, not a mock of either):

- 3 tests: the upgrade drill's rehearsal-database name (`his_restore_test_upgrade_drill`) passes the existing `assertIsSafeRestoreTarget` guard, while `his_dev`/`his_test`/anything containing "prod" still correctly fail.
- 2 tests: the drill's source-connection guard (`assertNotRemoteHost`) still rejects a Supabase-looking host and accepts localhost.
- 3 tests: `release:check`'s own gate list — contains exactly the required gates, in the documented order, with no placeholder/no-op gate, and the cheap checks (schema validation, migration drift) run before the expensive ones (build).
- 4 tests: `getReleaseVersion()`'s full resolution order (`VERCEL_GIT_COMMIT_SHA` → `RELEASE_VERSION` → `npm_package_version` → `"unknown"`).

---

## Files Changed

**New**: `scripts/release/check.ts`, `scripts/db/upgrade-drill.ts`, `src/lib/platform/release.ts`, `docs/RELEASE_CHECKLIST.md`, `docs/RELEASE_RUNBOOK.md`, `docs/DATABASE_MIGRATION_SAFETY.md`, `docs/RELEASE_VERSIONING.md`, `docs/releases/RELEASE_TEMPLATE.md`, `CHANGELOG.md`, `test/integration/p4-8-release-safety.test.ts`.

**Changed**: `src/lib/platform/logger.ts` / `src/app/api/health/route.ts` (both now call the shared `getReleaseVersion()` instead of independently duplicating the same derivation), `src/lib/env.ts` (added optional `RELEASE_VERSION`), `package.json` (added `db:upgrade:drill`/`release:check` scripts), `.github/workflows/ci.yml` (added component tests to CI, documented why Playwright stays out), `DEPLOYMENT.md` / `docs/PRODUCTION_DEPLOYMENT.md` / `docs/PRODUCTION_OPERATIONS_RUNBOOK.md` (cross-references to the new release docs — no content removed or restated).

**Note on `src/components/ui/tabs.tsx`**: this file shows as modified in the working tree from the immediately-prior P4.7A.1 phase (its `TabsList`/`TabsTrigger` height fix), not from any change made during this P4.8 phase — listed in `CHANGELOG.md`'s `[Unreleased]` section for completeness since no release/changelog entry existed for it before now, not re-touched here.

---

## Regression Status

All against `his_dev`/local Postgres — never Supabase/production:

| Check | Result |
|---|---|
| `npx prisma validate` | ✅ Schema valid |
| `npx prisma migrate status` | ✅ Up to date, 39 migrations, no schema changes this phase |
| `npm run typecheck` | ✅ Clean |
| `npm run lint` | ✅ Clean |
| `npm run test:components` | ✅ 12/12 |
| `npm run test:e2e` | ✅ 21/21 (run against a real `npm run build && npm run start` production server — not `next dev`) |
| `npm run test` (integration, run 1 — inside `release:check`) | ✅ 62 files, 596/596 |
| `npm run test` (integration, run 2 — standalone) | ✅ 62 files, 596/596 — repeatable |
| `npm run build` | ✅ Exit 0, all ~70 routes compiled |
| `npm run release:check` | ✅ All 7 gates pass, end to end |
| `npm run db:upgrade:drill` | ✅ Passed — see Upgrade Drill above |

596 = the pre-P4.8 583 baseline + P4.7A.1's own 1 new regression guard + this phase's 12 new release-safety tests.

**A real bug this phase's own tooling caught in itself**: the first draft of `scripts/release/check.ts` imported `dotenv/config` at module scope. Since `.env` sets `NODE_ENV="development"` explicitly, and `dotenv.config()` does not override an already-unset-but-about-to-be-defaulted variable the way Vitest's own "default `NODE_ENV=test`" behavior needs, that early load silently propagated `NODE_ENV=development` into every child process `release:check` spawns via `runStep` — including the `npm run test` gate, which then ran with the wrong `NODE_ENV` and failed one real assertion (`test/integration/p4-1-deployment-readiness.test.ts`'s own "accepts the real test environment as-is" check). Root-caused (confirmed by running the same test file standalone, which passed cleanly with `NODE_ENV` correctly defaulting to `test`), fixed by removing the unnecessary `dotenv/config` import from `check.ts` (every gate it spawns already loads its own environment correctly on its own), and verified via a second full `release:check` run — all 7 gates green, 596/596. This is exactly the kind of release-tooling-self-test this phase's own §84/§86 ask for, and it worked.

---

## Production-Unproven Items

Stated honestly, not converted into evidence this phase does not have:

- **Real Vercel deployment** of this exact release process has not been performed — every step above was proven locally/against `his_dev`, matching this whole engagement's own "local/CI only, never remote" discipline.
- **Real Supabase migration** (`prisma migrate deploy` against an actual Supabase-hosted database, this specific migration set) has not been run — the local rehearsal (`db:upgrade:drill`) is the closest available proxy; Supabase's own shadow-database quirks (already documented) are a known difference from local Postgres.
- **Hosted backup integration** — `db:backup`/`db:restore` are proven locally and via the P4.2 DR drill; a real end-to-end run against a production Supabase project's actual backup workflow has not happened (carried from P4.2/P4.4, restated here since it's a release-readiness gap too, not just a DR-readiness one).
- **Production-equivalent staging** for a true migration/load rehearsal has not been provisioned (carried from P4.1/P4.5) — `db:upgrade:drill` is a genuine local rehearsal, not a substitute for staging-level rehearsal against comparable infrastructure.
- **Actual application rollback in Vercel** for this project has not been exercised for real (no production deployment exists yet to roll back from) — documented conceptually, per Vercel's own supported mechanism, not fabricated.
- **A real external error monitor** (Sentry or equivalent) is not integrated — `logger.ts`'s own extension-point design accommodates one without a rewrite when it's added, but its absence means production error visibility today is log-aggregation-only.

---

## P4.6 Reservations

Carried forward, not fixed this phase: batched-import partial completion, interrupted-Opening-Inventory-and-retry (explicitly named as a P4.9 UAT item), Opening Inventory vs. GL confirmation, Employee/Provider duplicate-matching weakness, ImportJob provenance limitations.

## P4.7 Reservations

Carried forward, not fixed this phase: procurement filtering, standalone master-data exports, clinical portability, report pagination limitations.

## P4.7A Reservations

Carried forward, not fixed this phase: the ~15 remaining secondary UI routes, the `NewAppointmentDialog` Select-reset UX papercut (found during P4.7A.1's own E2E work), representative Lab/Radiology/Payslip live print verification (named explicitly as a P4.9 UAT item), and a broader multi-device/responsive re-check under P4.9.

---

## P4.9 Entry Conditions

Named explicitly, per this phase's own instruction, as what a future commercial-go-live phase must still establish — not started here:

1. A real external error-monitoring provider integrated (Sentry or equivalent).
2. A real, end-to-end hosted-backup run against an actual production-shaped Supabase project (not just the local mechanism this phase and P4.2 have proven).
3. Production-equivalent staging provisioned, and this phase's own `db:upgrade:drill`/`release:check`/release-smoke sequence run against it for real, at least once, before the first real commercial production deployment.
4. A real Vercel production deployment exercised at least once, including a real application rollback, so "Vercel rollback" moves from documented-conceptually to proven-for-real.
5. The remaining ~15 secondary UI routes and the three unverified print routes from P4.7A/P4.7A.1, if commercially relevant before go-live.
6. The `NewAppointmentDialog` Select-reset UX papercut, if worth fixing before real staff depend on it daily.

---

## Acceptance Decision

**Can P4.8 be closed? YES.**

The release path was traced honestly before anything changed, and the trace confirmed the existing foundation (P4.1-P4.5) was already sound — this phase's job was the discipline and rehearsal layer, and that layer is now real: a single gate command that genuinely stops a bad release (proven against itself, catching a real bug in its own first draft), a real local upgrade-rehearsal drill that passed against actual relational data with real reconciliation checks, a documented and concrete migration-classification/compatibility scheme (not generic advice — NOT NULL/enum/rename/index patterns specific to this Prisma+Postgres stack), explicit failure/rollback/recovery procedures that correctly separate application rollback from database recovery, a release-notes/changelog convention, and a full release simulation (`release:check` → build → production start → health check → Playwright smoke against the real production build) that completed successfully end to end. Every required regression check is clean, twice for the integration suite. Production-unproven items are named explicitly, not glossed over, and folded into concrete P4.9 entry conditions rather than left implicit.

Per this phase's own explicit instruction: **P4.9, regulatory architecture, another UI cycle, another whole-project audit, and unrelated backlog cleanup are NOT started.** This report is returned for review.
