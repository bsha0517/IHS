# Database Migration Safety

P4.8 §16-25, §44-49, §72 — how a schema/data change is written, classified, sequenced, and rehearsed so a production upgrade is a controlled engineering change, never an improvised one. This is the **discipline** document; [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md) already covers backup/restore/DR mechanics in full and is referenced here rather than repeated, and [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) is the actionable, commands-first sequence this document's rules feed into.

## Production Migration Command

```bash
npx prisma migrate deploy
```

**Never** `prisma migrate dev` against a shared/deployed database — this has been this project's binding rule since Phase 3 (DEPLOYMENT.md's Migrations section): Supabase's shadow-database drift detection doesn't tolerate it, and `migrate dev` is designed for local iteration, not controlled release. Every migration in this project's history was generated via `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, hand-reviewed, and applied with `migrate deploy` — the only two Prisma CLI touchpoints a real deployment ever uses.

`prisma migrate deploy` is never hidden inside application startup (`instrumentation.ts` only validates environment variables — see `src/lib/env.ts` — it never runs a migration) and never runs automatically on the first request. It is always its own explicit, separate step — see [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)'s Migration section for exactly when.

## Migration Ownership — Two Roles, Never Merged

| Role | Connection | Rights | Used by |
|---|---|---|---|
| **Runtime application role** (`his_app_runtime`/`avant_app_runtime`) | `DATABASE_URL` | Full CRUD, **except** `UPDATE`/`DELETE` on `audit_log`/`clinical_access_log` (insert-only immutability) | The running Next.js application, every request |
| **Migration/deployment owner role** | `DIRECT_DATABASE_URL` | DDL rights (schema owner) | Prisma CLI only — `migrate deploy`, `migrate status`, `db seed`, `generate` |

The production app **never** runs as the database owner — this split is already a completed cutover (DEPLOYMENT.md's Database Privileges section), not a plan. Never weaken it to make a migration "easier"; if a new table needs runtime-role access, run `prisma/db-setup/p0-06-regrant-new-tables.sql` (idempotent — bundles the GRANT with the audit-immutability REVOKE, so it can never silently re-open that gap the way a bare copy-pasted GRANT line once did — see DEPLOYMENT.md's own incident writeup).

## Migration Classification

Classify every migration before writing it — most of this project's 39 migrations to date have been Additive; that pattern should continue to be the default, not the exception.

### Additive / Backwards-Compatible

Safe to deploy with no special coordination. Examples: a new nullable column, a new table, a new index, a new enum value appended (never inserted between existing values — see Enum Safety below), a new optional Server Action parameter. **Old and new application code can both run against the resulting schema at the same time** — this is what makes it safe under a rolling/serverless deployment where the old and new build can briefly overlap.

### Transitional

Requires application coordination across more than one release — see Expand/Migrate/Contract below. Examples: a column being backfilled ahead of a future `NOT NULL`, a field being dual-written to an old and new location during a rename, a new required Server Action parameter with a temporary default.

### Destructive / Breaking

Never routine — see §32/the Destructive Migration Requirements section below before writing one. Examples: dropping a column/table, renaming without a compatibility window, changing a field's required-ness or semantics in place, a destructive enum value removal/rename, a data rewrite affecting existing rows.

Do not rewrite this project's historical migrations to fit this classification retroactively — it governs new migrations going forward.

## Expand / Migrate / Contract

The required pattern for any Transitional or Destructive change — not forced onto trivial additive migrations, which ship in one release exactly as they always have.

1. **Release A — Expand.** Add the new schema (column/table) while the application keeps working against the old shape unchanged. Purely additive, safe to deploy alone.
2. **Migrate data.** Backfill/validate — see Data Migration Strategy below. Can happen gradually, outside the request path.
3. **Release B — Switch.** The application begins reading/writing the new schema. The old schema is still present and still valid (untouched), so this release can itself be rolled back to Release A's app code without any database change — the whole point of separating this from Contract.
4. **Release C — Contract.** Only once no deployed code depends on the old schema anymore (confirmed, not assumed), remove it in its own migration.

### Column Rename — Never a Direct `RENAME COLUMN` in Production

A direct rename breaks an old application instance still serving traffic mid-rollout (it reads/writes the old name, which no longer exists). Preferred sequence:

1. Add the new column (Expand).
2. Dual-write (both old and new) or backfill from old → new (Migrate).
3. Switch the application to read/write only the new column (Switch — Release B).
4. Drop the old column once nothing reads it (Contract — Release C).

No hypothetical rename was implemented in this codebase merely to demonstrate this — this is the documented pattern for when one is genuinely needed.

## NOT NULL Migration Safety

Never ship `ADD COLUMN required_field ... NOT NULL` directly onto a populated table without a default or a backfill already in place. Safe sequence:

1. Add the column **nullable** (Expand).
2. Backfill existing rows (Migrate — see Data Migration Strategy).
3. Validate: `SELECT count(*) FROM "table" WHERE new_column IS NULL` returns `0`.
4. Add the `NOT NULL` constraint in its own migration, once step 3 is confirmed.

## Enum Migration Safety

This project uses native Prisma/PostgreSQL enums throughout (`$Enums.*`).

- **Adding a value**: safe, additive — append it; old application code that doesn't know about the new value simply never produces it, and still handles every value it already knew about.
- **Removing or renaming a value**: never casual once any row could hold it — requires a data migration (update every row using the old value to a valid replacement first) and a compatibility plan for any deployed code that still references the old value by name (a `switch`/lookup table keyed on the enum, TypeScript exhaustiveness checks, a Zod schema). Treat exactly like a Destructive change (below).

## Index Creation Safety

A plain `CREATE INDEX` takes a table-level lock for its duration — fine at this project's current clinic-scale table sizes (verified/measured, not assumed — see [PERFORMANCE_CAPACITY.md](PERFORMANCE_CAPACITY.md)/PERFORMANCE_BASELINE.md for the volumes this has actually been tested against). At meaningfully larger production scale, a high-volume table's index needs `CREATE INDEX CONCURRENTLY` instead, which does not take that lock — Prisma's own declarative `@@index` cannot express `CONCURRENTLY`; it requires a hand-written migration (the same `migrate diff --script` → hand-edit workflow already used for every migration in this project) with the `CONCURRENTLY` keyword added by hand, and `CONCURRENTLY` cannot run inside a transaction block, so that migration's SQL file needs its statement pulled out of the transaction Prisma wraps migrations in by default (documented in Prisma's own migration-authoring docs when this is actually needed). Not applied retroactively to this project's existing indexes — this is a documented future pattern for when a table's real production volume calls for it, decided with real measurement at the time, not preemptively.

## Data Migration Strategy

A significant backfill is never hidden inside a page request or a Server Action a user happens to trigger. For any backfill non-trivial enough to matter:

- Use an explicit, standalone script (the same `tsx scripts/...` pattern this project's `scripts/db/*.ts` already establish) or controlled raw SQL in its own migration — never something that runs silently the first time some unrelated page loads.
- **Idempotent where practical** — safe to re-run if interrupted, the same discipline every outbox handler already follows (`outbox.ts`'s own doc comment: "MUST be idempotent... a retry system without idempotent handlers is worse than no retry system").
- **Measurable and logged** — print progress for a backfill touching more than a trivial row count, so a human watching it isn't staring at silence.
- **Safe to retry** — a crash or interruption partway through must not corrupt data or require manual cleanup before re-running.
- **Bounded transactions** for a large table — batch the backfill (e.g. 1,000-row pages) rather than one giant transaction that holds locks for the backfill's entire duration.
- **Validated after completion** — a concrete query proving the backfill actually did what it claims (the same pattern `scripts/db/upgrade-drill.ts`'s own reconciliation checks use), not just "the script exited 0."

No generic migration-framework was built for this — not needed at this project's current scale; each backfill script is small and specific, following the pattern above.

## Never Edit an Applied Migration

Once a migration has been applied anywhere shared (`his_dev` counts, not only staging/production — a migration your teammates have already pulled and applied is "shared" too), it is **never edited** — a mistake is corrected by a **new** migration, never by rewriting history. Never delete a historical migration file. Never hand-edit the `_prisma_migrations` table or its checksums as routine practice — Prisma's own `migrate resolve` exists for the rare, genuinely-justified case (documented in BACKUP_DISASTER_RECOVERY.md's Failed `prisma migrate deploy` section), not as a first resort.

## Migration Drift Detection

`npx prisma migrate status` — run as part of every `npm run release:check` (see [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)) and every CI run. Reports whether the target database's applied-migrations history matches exactly what's in `prisma/migrations/` — the first, cheapest signal that something is out of sync (a migration applied by hand outside the normal flow, a migration file edited after being applied, an environment that's behind). `scripts/db/upgrade-drill.ts` (below) is the stronger, real-data version of this same check.

## Migration Rehearsal

**`npm run db:upgrade:drill`** — a real local rehearsal, reusing the exact backup/restore mechanism [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md) already documents and drills (`scripts/db/backup.ts`/`restore.ts`), never a second implementation of pg_dump/pg_restore:

1. Takes a real `pg_dump` of the source database (`his_dev` by default).
2. Restores it into an isolated rehearsal database (`his_restore_test_upgrade_drill` — guarded by the same `assertIsSafeRestoreTarget` naming pattern every restore in this project already requires; there is no override).
3. Runs `prisma migrate status`, then `prisma migrate deploy`, against that real, populated copy — proving the current migration set applies cleanly to real relational data, not just an empty freshly-created database (which `db:dev:setup`/`db:test:setup`/CI already exercise on every run).
4. Verifies the runtime role's grants were correctly re-established and runs representative reconciliation checks (every journal balances, every invoice's paid amount matches its payment allocations, no negative stock balances) against the restored data through the restricted runtime connection — the same class of check [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md)'s own Post-Restore Checklist and Data Corruption Detection sections already name.
5. Cleans up (drops the rehearsal database) unless `UPGRADE_DRILL_KEEP_DATABASE=1` is set.

Hard-guarded against production/staging the same way every other database script in `scripts/db/` is (`assertNotRemoteHost` — refuses anything that isn't the local Postgres cluster; there is no override).

**Honest limitation** (§55/§87): this does not literally "rewind" the schema to an earlier migration checkpoint and replay history — Prisma has no supported down-migration mechanism, and this document's own "never edit an applied migration, forward-fix instead" rule means this project deliberately does not maintain one. The rehearsal instead proves the closest real equivalent: the current migration set applies cleanly to a real, already-migrated, populated copy of an existing database, and that database's own financial/inventory integrity still reconciles afterward. Run it **before** applying a new migration to a shared environment, against a fresh copy that already includes the new migration file, to rehearse that specific migration for real before it ever touches production.

## Failure Handling

### `prisma migrate deploy` fails

1. **Stop.** Do not proceed to deploy application code that expects a schema the migration didn't fully apply.
2. Do not blindly rerun it.
3. Inspect `prisma migrate status` to see exactly what applied and what didn't.
4. Inspect the actual database error.
5. Determine whether the migration partially executed (Postgres DDL is transactional per-statement in Prisma's migration runner for most statement types, but a hand-written migration with `CONCURRENTLY` or multiple statements can leave partial state — check).
6. Use Prisma's own supported resolution (`migrate resolve`) only when the specific situation genuinely justifies it — never a routine step.
7. Restore from backup only when the failure genuinely damaged data, not merely left the schema mid-migration (a schema-only failure is usually forward-fixable with a corrective migration once understood).

Full detail already lives in [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md)'s "Failed `prisma migrate deploy`" section — this is the same procedure, not a second one.

### Migration succeeded, application deployment failed

This is exactly why Expand/Migrate/Contract matters: if the migration that just succeeded was **additive/backwards-compatible**, the *previous* application version should still work correctly against the new schema — it simply never reads the new column/table. In that case:

- Roll back the **application** to the previous known-good version (see Application Rollback in [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)).
- **Leave the additive schema change in place** — do not reflexively "roll back" a schema that the old app is already compatible with; that's an unnecessary, riskier operation for no benefit.
- Investigate the application failure and fix forward.

If the migration was **Transitional/Destructive** (Release B of Expand/Migrate/Contract, where the new app genuinely depends on the new shape and the old app no longer works against it), the situation is more serious — the previous app version is *not* safely re-deployable without also reverting the schema. This is precisely the scenario Expand/Migrate/Contract exists to avoid ever reaching in production; if it happens anyway, treat it as a Destructive-Migration Requirements-level incident (below): assess real impact, prefer forward-fixing the application over reverting the schema when at all possible, and fall back to a validated-backup restore only for genuine data damage.

## Database Rollback Philosophy

Relational schema migrations do not have a magical universal rollback, and this project does not pretend otherwise. No automatic "down" migration is generated or maintained for any of this project's 39 migrations. Preferred recovery, in order of preference:

1. **Forward-fix** — write a new migration that corrects the problem. Almost always the right answer for a schema-only issue.
2. **Restore from a validated backup** — only for genuine data damage/corruption, never as a routine "undo" for an unwanted-but-harmless schema change. See [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md)'s Disaster Recovery Scenarios for the full restore procedure.

## Destructive Migration Requirements

Any migration classified Destructive (above) requires, before it ships — never treated as routine:

- A recent, validated backup (see Pre-Release Database Backup below).
- A staging/rehearsal-DB rehearsal (`npm run db:upgrade:drill`, or a real staging deployment where one exists).
- An explicit estimate of affected tables/rows.
- A compatibility analysis — what currently-deployed code, if any, still depends on the shape being removed/changed.
- A rollback/recovery plan specific to this migration, not a generic "we'll figure it out."
- Validation queries to run after the migration confirming it did exactly what was intended.
- An explicit maintenance-window expectation, if the migration's duration/locking behavior warrants one.

## Pre-Release Database Backup

For any release containing a schema or data migration:

- **Verify** the most recent managed backup/PITR is healthy (free, should happen before every deployment regardless of risk — see [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md)'s Pre-Deployment Backup Procedure).
- For a **risky** release (touches Tier-1 tables, anything destructive-adjacent, anything the deploying engineer isn't fully confident is safe), take an **independent** logical backup first (`npm run db:backup` against the production direct connection) and record its identifier/location.
- A **failed backup attempt** (the command errors, or the resulting `.dump`/`.meta.json` doesn't look right) means **STOP RELEASE** — do not proceed to migrate/deploy without a confirmed-good backup for a risky release.
- "Confirmed good" for a routine release means the artifact exists and its `.meta.json` sidecar shows `status: "completed"` with a plausible size — a full restore-drill rehearsal is not required before every single release (that's the recurring, scheduled drill cadence in [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md)'s Restore Drill Frequency section, not a per-release gate).

## Release Compatibility Rules

These apply to every release, not only ones with a schema migration — a release can break compatibility purely in application code.

### OutboxEvent Backwards Compatibility

**A release must remain capable of safely reading already-persisted `OutboxEvent` payloads until the payload shape they were written under can no longer exist in the table.** `OutboxEvent.payload` is a loosely-typed JSON blob (`src/lib/platform/outbox.ts`'s `writeOutboxEvent`/handler signature: `Record<string, unknown>`) — nothing enforces its shape at read time beyond what each registered handler (`event-handlers.ts`) chooses to destructure. Never assume every row in the table was written by the *current* code: a `pending`/`failed` event can sit for a while (bounded retry + dead-letter, `outbox.ts`'s own `MAX_ATTEMPTS`/`RETRY_DELAYS_MS`), and a handler deployed today may need to process an event a previous release wrote.

When an event payload genuinely needs to evolve:

- Prefer **adding an optional field** — old and new handlers both keep working.
- Add a **version field** to the payload only when a truly incompatible shape change is unavoidable, and branch the handler on it.
- Never remove/rename a field an already-deployed handler destructures without confirming no unprocessed event of the old shape can still be sitting in the table (check `SELECT DISTINCT status FROM outbox_event WHERE event_type = '...'` for pending/failed rows before that release).

Not redesigned this phase — this is the rule the existing design already implies, made explicit.

### Scheduler / Cron Overlap

`processPendingOutboxEvents()` claims each event atomically before processing it (`dispatchBatch`'s conditional `updateMany` on `id` + current `status`) — two overlapping invocations (an old deployment's cron still finishing while a new one starts, or two scheduler triggers overlapping) cannot double-process the same event; a lost race is a silent, safe no-op, not a duplicate action. This DB-backed coordination already exists and is not changed by a release — no new distributed-scheduler infrastructure is needed. A release does need to **verify scheduler configuration survived** whatever changed (a platform migration, a `vercel.json` edit) — see [DEPLOYMENT.md](../DEPLOYMENT.md)'s Outbox Sweep Scheduling and [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md) §7 for the Hobby-tier daily-cron constraint this project has already hit once for real.

### Session / Password / Token Compatibility

Sessions are DB-backed (`Session` table, not a signed cookie whose validity depends on a secret) — a routine release that doesn't touch the auth/session schema or its signing configuration does not invalidate active sessions. Password hashes (`argon2`) and password-reset tokens (SHA-256-hashed `crypto.randomBytes` values, `src/lib/auth/tokens.ts`) are similarly unaffected by an ordinary release. **Do not rotate a session-related secret or change hashing parameters as part of a routine release** — that's a deliberate, separate action with its own plan (it can invalidate every active session or every stored hash at once), never a side effect of shipping an unrelated feature.

### Environment Variable Changes

Classify every new environment variable a release introduces:

- **Required** vs **optional/defaulted** — `src/lib/env.ts`'s Zod schema is the authoritative fail-fast gate (`instrumentation.ts`'s `register()` runs it at real server boot, refusing to serve traffic with a clear "which variable" error — never guess from a downstream failure).
- **Secret** vs **non-secret**.

Order matters — **configure the target platform's environment before deploying code that requires it**, never the reverse:

1. Add/configure the variable in the target platform (Vercel project settings, etc.).
2. Validate it's actually present (redeploy triggers `instrumentation.ts`'s check, or check manually).
3. Deploy the application version that reads it.

Where practical, introduce a new variable as **optional/defaulted first**, then make it required in a later release once every target environment has it configured — this mirrors Expand/Migrate/Contract for environment configuration, not just schema. Never weaken an existing **security-required** variable's validation to make a rollout easier.

### Import / Export Compatibility

- **CSV import templates** (P4.6) are already versioned (`ImportJob`/importer registry — see `docs/CLINIC_ONBOARDING.md`) — a breaking shape change to an import template belongs in a **new template version**, never a silent edit of an existing one; document whether an older template version remains accepted or is explicitly rejected with guidance.
- **Reporting exports** (P4.7, `docs/DATA_EXPORT_DICTIONARY.md`) are, in practice, a customer-facing data contract — avoid casually renaming or removing an export column. Additive columns are safe; a breaking export change belongs in release notes as a Breaking Change, and if exports ever become an externally-integrated contract (a customer's own script parsing them), a versioning scheme for exports specifically would become worth building then — not built now, per this phase's own "do not build a framework speculatively" instruction.

### API / Route / Cached-Asset Compatibility

This is one application (not a versioned public API), but a browser tab open during a deployment can still briefly call the new server with an old client bundle, or vice versa, during rollout. Avoid unnecessary incompatible Server Action/Route Handler request/response shape changes in a single release; if a genuinely breaking one must accompany a database migration, the deployment plan must account for it explicitly (documented per-release in that release's own notes). Next.js/Vercel already fingerprints and versions static assets per build — no manual browser-cache-clearing step is needed or was invented for this; if a specific critical workflow is known to be sensitive to a stale client talking to a new server, note the mitigation in that release's own notes rather than build a generic solution now.

## Backward Compatibility Matrix

Representative patterns — use this to reason about a specific migration, not as an exhaustive list:

| Change | Old App + New DB | New App + Old DB | Deployment Strategy |
|---|---|---|---|
| Additive nullable column | ✅ Works (old app never reads it) | ✅ Works (new app treats it as null/absent) | Single release, no coordination needed |
| New table | ✅ Works (old app never queries it) | ✅ Works, but new app's feature depending on it is unavailable until the table exists | Migrate first, deploy app in either order |
| New enum value (appended) | ✅ Works (old app never produces it) | ⚠️ Works only if old DB's enum type already has the value — if not, new app writing it will error | Migrate (add the value) before deploying the app that can produce it |
| Required new column (no default) | ❌ Breaks (old app's INSERT omits it) | ❌ Breaks (new app expects it to always be present, but old rows lack it) | Never ship directly — use NOT NULL Migration Safety's nullable → backfill → required sequence |
| Dropped column | ⚠️ Works only if old app never reads/writes it | ❌ Breaks if new app still references it somewhere missed | Use Expand/Migrate/Contract — drop only in the Contract release, once nothing depends on it |
| Renamed field (direct rename) | ❌ Breaks (old app reads the old name, now gone) | ❌ Breaks if anything still references the old name | Never a direct rename — see Column Rename above |

## Summary — What Must Never Happen

- `prisma migrate dev` against any shared/deployed database.
- The running application connecting as the schema owner.
- Editing or deleting an already-applied migration file.
- A `NOT NULL` column added to a populated table with no default/backfill.
- A destructive migration shipped without backup + rehearsal + rollback plan.
- A required environment variable deployed after the code that needs it, instead of before.
- A routine release rotating a session/auth secret as a side effect.
