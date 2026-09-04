# Release Runbook

P4.8 §28-31, §53, §64-66 — the actionable, commands-first sequence for shipping a release. Use alongside [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) (what to confirm at each stage) and [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md) (why each database-related step exists). This runbook assumes the current architecture: Vercel (application) + Supabase (Postgres) — see [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md) for the full platform rationale.

## Default Release Sequence (Backwards-Compatible Migration)

The safe default — for a migration classified Additive/backwards-compatible per [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md). A specific Transitional/Destructive migration may need a different, explicitly-documented order (that release's own notes file must say so) — there is no universal app-first-vs-db-first rule.

1. Change/maintenance window begins (if this release warrants one — most don't)
2. Verify monitoring/operations health is currently normal (`/admin/operations`, `/admin/system-events`) — know the *before* state
3. Verify a recent backup exists (per this release's risk level — see RELEASE_CHECKLIST.md)
4. Deploy the migration (`prisma migrate deploy`)
5. Confirm migration success (`prisma migrate status`)
6. If the migration added tables, apply/re-verify database security (`npm run db:security:apply` if new tables were added, then `npm run db:security:check` regardless — see [DATABASE.md](../DATABASE.md)'s "Row Level Security" section; §11 below explains why this is a check-then-apply-if-needed step, not folded silently into the migration itself)
7. Deploy the compatible application build
8. Run health/readiness checks (`/api/health`)
9. Run release smoke tests
10. Inspect logs/errors/outbox/accounting exceptions
11. Close the change window

## Prepare

```bash
# On the release commit, locally:
git checkout <release-commit-or-tag>
npm ci
npx prisma generate
npm run release:check
```

`release:check` runs, in order, and stops at the first failure: `prisma validate` → `prisma migrate status` → `db:security:check` (P4.9.1 — RLS, read-only) → typecheck → lint → component tests → integration tests → production build. A required gate failing means **do not proceed** — fix it, re-run.

Then, separately (needs a running server — not part of `release:check`, see [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)'s Post-Deploy Smoke):

```bash
npm run build && npm run start   # or against a staging deployment
npm run test:e2e                 # the P4.7A/P4.7A.1 Playwright suite as release smoke
```

## Backup

Reference: [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md)'s Pre-Deployment Backup Procedure (this is the same procedure, not a second one).

```bash
# Verify the managed backup/PITR is healthy first (Supabase dashboard) —
# free, do this before every deployment regardless of risk.

# For a risky release, an independent logical backup:
BACKUP_SOURCE_DIRECT_URL="<production DIRECT_DATABASE_URL>" \
BACKUP_SOURCE_LABEL="pre_release_v0.9.0" \
npm run db:backup
```

Record the resulting `.dump` filename/location. A failed backup for a risky release means **STOP RELEASE** — see [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md)'s Pre-Release Database Backup section.

## Migration

Rehearse first if this release's risk level calls for it (HIGH-risk always does):

```bash
npm run db:upgrade:drill
```

Then, against production, as its own explicit step — never auto-applied on server boot:

```bash
# DIRECT_DATABASE_URL must point at the owner/direct connection, never the pooler
npx prisma migrate deploy
npx prisma migrate status   # confirm: "Database schema is up to date!"
```

If a new table was added, re-apply the runtime role's grants (idempotent, safe to run every time a migration adds tables):

```bash
psql "<owner connection>" -f prisma/db-setup/p0-06-regrant-new-tables.sql
```

Then verify — and, if the migration added a table, apply — Row Level Security (P4.9.1; idempotent, safe to run every time):

```bash
npm run db:security:check   # read-only; exits nonzero and names any unprotected table
npm run db:security:apply   # only needed if the check above reports a problem — safe to run unconditionally too
npm run db:security:check   # confirm clean
```

**On failure**: see [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md)'s Failure Handling section — stop, inspect `migrate status`, do not blindly rerun, do not hand-edit migration history. A `db:security:check` failure means **do not deploy the application build** until `db:security:apply` closes it and the check passes clean — an application deploy against a database with a newly-unprotected table would ship with that exposure live.

## Application Deployment

```bash
npm run build
npm run start   # or the hosting platform's own start mechanism (Vercel: automatic on deploy)
```

On Vercel: push/merge to the branch the project deploys from, or promote a specific preview deployment to production from the Vercel dashboard/CLI.

## Verification

```bash
curl -s https://<production-host>/api/health
# {"status":"healthy","database":"reachable","timestamp":"...","version":"<commit-sha>","durationMs":N}
```

Then work through [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)'s Post-Deploy Smoke and (if this release's risk level requires it) Reconciliation sections.

## Failure Handling

### Migration failed

See [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md)'s Failure Handling — stop the rollout, do not deploy the application, inspect and resolve the migration state before proceeding.

### Migration succeeded, application deployment failed

If the migration was additive/backwards-compatible, the *previous* application version is still compatible with the new schema — roll back the application (below) and leave the schema change in place. Do not reflexively revert a schema the old app already works with.

### Health check / smoke test fails after deployment

1. Check `/api/health`'s response and server-side logs for the real error.
2. If the application itself is broken (not a data issue): roll back the application (below).
3. If data looks wrong: do not attempt an ad hoc fix — assess whether this is a forward-fix (a small corrective change) or requires the Database Recovery procedure below.

## Application Rollback

**Vercel**: the platform retains previous deployments — redeploy/promote the last known-good deployment from the Vercel dashboard (Deployments → select the previous production deployment → "Promote to Production") or via the Vercel CLI (`vercel rollback` or `vercel promote <deployment-url>`, exact command per Vercel's current CLI — see Vercel's own documentation for the authoritative syntax, not invented here). This is an application-code-only action.

**Application rollback does not roll back the database.** These are always separate operations — see [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md)'s Database Rollback Philosophy. Always verify `/api/health` immediately after any rollback.

## Database Recovery

Reference: [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md) in full — not duplicated here. Summary of the shape:

1. Stop writes / decide on a maintenance window if the situation warrants it.
2. Determine the restore point (which backup/PITR timestamp).
3. Restore from the validated backup (`npm run db:restore` locally-rehearsed shape; production restore is via Supabase's own dashboard restore-to-new-project procedure — see [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md)'s Disaster Recovery Scenarios).
4. Re-verify runtime role grants and audit-log immutability (a direct `UPDATE`/`DELETE` against `audit_log` through the runtime role must still be rejected post-restore).
5. Run [BACKUP_DISASTER_RECOVERY.md](../BACKUP_DISASTER_RECOVERY.md)'s Post-Restore Checklist in full.
6. Confirm application compatibility with the restored data.
7. Reopen service.

## Release Closure

- Every box in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) confirmed by the Release Owner.
- Release notes finalized (`docs/releases/YYYY-MM-DD-vX.Y.Z.md`).
- Git tag pushed (see [RELEASE_VERSIONING.md](RELEASE_VERSIONING.md)).
- `CHANGELOG.md` updated.
- Post-release observation window: no prescribed arbitrary duration — the Release Owner closes the release once the Post-Release checklist shows healthy evidence (errors, latency, login failures, outbox failures, dead letters, accounting exceptions, scheduler health all normal), not after a fixed clock time.
