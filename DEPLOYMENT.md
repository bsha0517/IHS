# DEPLOYMENT.md

Living reference for stack, environment, build, and deployment. Completed in Phase 14 hardening — corrected against what was actually built, not just what Phase 0 planned.

## Stack (as actually built — corrected in Phase 14 from Phase 0's speculative list)

- Next.js 16 (App Router, Turbopack) + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Lucide Icons
- PostgreSQL (Supabase-hosted) + Prisma ORM 7 with driver adapters (`@prisma/adapter-pg`)
- Zod validation, date-fns/date-fns-tz
- argon2 for password hashing
- vitest for the automated test suite (Phase 14)

**Corrected from Phase 0's BLUEPRINT.md §28 stack list**: Recharts, exceljs, and React-PDF were named as planned dependencies but were never actually installed or used.
- Charts (`/analytics`, Phase 13) are plain CSS bars, not Recharts — a deliberate "no unnecessary dependency for six simple bars" call (see ARCHITECTURE.md §17).
- Exports (`/api/reports/export`, Phase 13) are CSV via a small hand-written serializer (`src/lib/domains/analytics/csv.ts`), not exceljs — every "export" feature this build actually implemented needed only CSV, never a native `.xlsx` file.
- Every printable document (prescriptions, invoices, lab/radiology reports) is a plain server-rendered HTML page outside the `(dashboard)` route group, meant for the browser's native print-to-PDF, not React-PDF — no PDF-generation library was ever needed.

If a real deployment later needs richer charts, native Excel export, or programmatically-generated PDFs, add the specific library at that point — don't pre-install speculatively (the standing discipline this whole build has held to; see PROJECT_STATUS.md's many "documented, not built ahead of a real need" decisions).

## Environments

- **Local development**: `next dev` against a local Docker Postgres instance (`his_dev`) — see [LOCAL_DATABASE_SETUP.md](LOCAL_DATABASE_SETUP.md). **Corrected from earlier in this project's history**: local dev and the integration suite both ran against the same shared, remote Supabase-hosted database through P0/P1/P2 — the root cause of this suite's repeated nondeterministic failures, since that database was (and staging/production still are) also reachable by the live Vercel deployment. Local dev/test now run entirely against local Postgres containers instead; see Migrations below for the Supabase-specific workflow constraint that no longer applies locally as a result.
- **Testing**: the integration suite (`npm run test:integration` / `npm run test`) runs against a second, disposable local database (`his_test`), never against `DATABASE_URL`/Supabase — enforced by `test/setup-test-database.ts`, which refuses to run at all if the configured test database looks like it points at Supabase or any other hosted/shared host. **Integration tests must never run against a staging or production Supabase database** — this is the explicit policy, not just an incidental default; see LOCAL_DATABASE_SETUP.md for how it's technically enforced.
- **Production**: same Next.js application, `next build && next start` (or a platform that runs those for you — e.g. Vercel, or any Node host). No file storage, SMS/WhatsApp/Email provider, or other external service is wired up yet — see below.

**No file storage adapter exists** — every phase that touched documents (`EmployeeDocument`, `Asset` maintenance/calibration records, patient documents) deliberately stayed metadata-only (see PROJECT_STATUS.md's many "no file storage" Known Issues entries). There is no `STORAGE_DRIVER`/S3 configuration to set because there is no code path that reads one.

**No SMS/WhatsApp/Email provider is connected** — `src/lib/domains/communications/adapters/*` are real, swappable adapter implementations, but only the honest `Null*Adapter`s exist (Phase 12). Connecting a real provider (Twilio, WhatsApp Business API, SES/SendGrid, ...) means implementing a new adapter behind the existing `CommunicationAdapter` interface and swapping it in `resolveAdapter()` — no environment variable currently controls this because there is nothing to configure yet.

## Environment Variables (as actually used — corrected in Phase 14, DB connection split added in P1 §1)

```
DATABASE_URL=        # Postgres connection string, required. The RUNTIME connection —
                      # used by the running application (src/lib/db.ts) for every
                      # request. Must point at the restricted `avant_app_runtime` role,
                      # never the schema owner — see "Database Privileges" below.
                      # Must use Supabase's Supavisor pooler in TRANSACTION mode
                      # (aws-*.pooler.supabase.com:6543, with ?pgbouncer=true) — never
                      # session mode (port 5432), which this line incorrectly named
                      # before this correction. Session mode holds one Postgres
                      # connection per pooled client for the client's whole lifetime;
                      # under serverless concurrency (each Vercel function instance
                      # opening its own `pg.Pool`, src/lib/db.ts) that exhausts the
                      # pooler's own connection cap fast — this is exactly what caused
                      # a real production `EMAXCONNSESSION` ("max clients reached in
                      # session mode") outage. Transaction mode returns the underlying
                      # connection to the pooler after each query/transaction instead
                      # of holding it for the client's lifetime, which is what
                      # serverless needs — see src/lib/db.ts's own doc comment.
DIRECT_DATABASE_URL=  # Postgres connection string, required for migrations. The
                      # MIGRATION connection — used only by the Prisma CLI
                      # (migrate/generate/db seed, see prisma.config.ts). Must point
                      # at the schema owner role (has DDL rights the runtime role
                      # intentionally lacks). Never used by the running application.
NODE_ENV=             # development | production, standard Next.js — controls cookie
                      # `secure` flag (src/lib/auth/session.ts, portal-session.ts) among
                      # Next's own build-mode behavior.
CRON_SECRET=          # Optional. Bearer token /api/cron/outbox-sweep requires (P1 §4)
                      # — see "Outbox Sweep Scheduling" below. Unset in local dev; the
                      # route just refuses every request rather than running open.
OUTBOX_PROCESSING_TIMEOUT_MS=  # Optional, default 300000 (5 minutes). How long an
                      # outbox event may sit in "processing" before P1 §3's recovery
                      # presumes it crashed — see src/lib/platform/outbox.ts.

TEST_DATABASE_URL=   # Local development/testing only — never set in a deployed
TEST_DIRECT_DATABASE_URL=  # (staging/production) environment. The integration
                      # suite's own runtime/owner connections to the disposable
                      # `his_test` database — substituted in automatically by
                      # test/setup-test-database.ts, never read by application
                      # code. See LOCAL_DATABASE_SETUP.md.
```

`SESSION_SECRET` was named in Phase 0's speculative env var list but is never read anywhere — session/reset tokens are 256-bit `crypto.randomBytes` values (`src/lib/auth/tokens.ts`), hashed with SHA-256 before storage; the token's own randomness is what makes it unguessable, not an HMAC secret, so there was never a code path that needed one. `STORAGE_DRIVER`/`S3_*` were likewise speculative and are unused for the reason above.

`DATABASE_URL` and `DIRECT_DATABASE_URL` both fail loudly at import/CLI-invocation time if missing — the former via Prisma Client construction in `src/lib/db.ts`, the latter via `prisma.config.ts`'s own datasource resolution. There is currently no separate explicit "fail loudly at process boot" check beyond that.

## Release Process (P4.8)

**A specific release/upgrade — not just a first-time deployment** — now has its own dedicated process: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) (what to confirm), [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md) (the actual commands, in order), and [docs/DATABASE_MIGRATION_SAFETY.md](docs/DATABASE_MIGRATION_SAFETY.md) (migration classification, expand/migrate/contract, rollback philosophy). `npm run release:check` is the single pre-release gate (schema validation, migration drift, typecheck, lint, component tests, integration tests, build — stops at the first failure); `npm run db:upgrade:drill` is a real local migration-rehearsal drill. This section and the Deployment Checklist below remain the authoritative *first-time* production setup steps; the release docs above are what every *subsequent* release follows.

## Migrations

`prisma migrate deploy` as an explicit, separate deploy step — never auto-applied on server boot, consistent throughout all 14 phases.

**A real, binding workflow constraint discovered in Phase 3 and re-confirmed through Phase 10, not the originally-planned one**: `prisma migrate dev` does not work cleanly against a Supabase-hosted database — its shadow-database drift detection flags Supabase's own pre-installed extensions (`pgcrypto`, `pg_stat_statements`, etc.) as drift, and `migrate dev --create-only` has been observed to hang indefinitely attempting shadow-database creation. Every migration in this project's history (32 total, as of the P2 remediation pass's conclusion) was instead generated via:

```bash
prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

with the "Loaded Prisma config..." noise line stripped, the SQL reviewed by hand, placed into a manually-created `prisma/migrations/<timestamp>_<name>/migration.sql`, and applied with `prisma migrate deploy`. This constraint is specific to Supabase's shadow-database behavior — it applies to staging/production (still Supabase-hosted) but not to the local `his_dev`/`his_test` Postgres containers [LOCAL_DATABASE_SETUP.md](LOCAL_DATABASE_SETUP.md) introduced, which are plain Postgres with no such quirk. `npm run db:dev:setup`/`db:test:setup` still use `migrate deploy` (never `migrate dev`) regardless, for consistency with the one workflow this project's entire migration history was built and tested through — reproduce a fresh environment the same way.

## Database Privileges (P0-06, closed for real in P1 §1 — 2026-08-27)

Phase 14's hardening pass found a real gap: `SECURITY.md` had pre-committed that hardening would remove UPDATE/DELETE grants for "the app role" on `audit_log`/`clinical_access_log`, but this deployment had no separate, lower-privileged role to revoke anything from — `DATABASE_URL` connected as `postgres.<project-ref>`, the schema owner, the same role migrations ran DDL as. Revoking UPDATE/DELETE on any table from the owner role would be a silent no-op in PostgreSQL (an owner's privileges can't be revoked from itself), not a real restriction. The P0 remediation pass created the correct fix; the P1 pass executed the cutover:

1. **Create the restricted role** (one-time, per environment): run `prisma/db-setup/p0-06-create-runtime-role.sql` connected as the current owner role. Replace `__PASSWORD__` with a freshly generated secret (`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`) — never reuse a password across environments. This creates `avant_app_runtime` with `SELECT, INSERT, UPDATE, DELETE` on every table, then explicitly `REVOKE UPDATE, DELETE ON audit_log, clinical_access_log` — full CRUD everywhere, insert-only on exactly those two tables.
2. **Split the connection strings**: set `DATABASE_URL` to the new `avant_app_runtime` role's connection string (the running application) and `DIRECT_DATABASE_URL` to the existing owner role's connection string (Prisma CLI/migrations only) — see Environment Variables above and `prisma.config.ts`.
3. **Verify before trusting it**: the full test suite (84 tests, including `test/integration/audit-log-immutability.test.ts`'s live proof of INSERT/SELECT succeeding and UPDATE/DELETE failing against `audit_log` through the actual runtime connection) and a live browser session (login, dashboard, completing an encounter) were both run against the new `DATABASE_URL` with no regressions, and `prisma migrate status`/`prisma migrate deploy` were confirmed working against `DIRECT_DATABASE_URL`.

**This is now a completed cutover, not a documented plan** — every environment deploying this application (including production, when provisioned) must follow steps 1-2 above; a fresh environment that only sets `DATABASE_URL` to an owner-role connection string is running with the pre-P1 gap re-opened. If new tables are added in a future phase, run `prisma/db-setup/p0-06-regrant-new-tables.sql` (idempotent) so the restricted role can access them — PostgreSQL does not retroactively grant privileges on tables created after the script last ran.

**A real regression, not a hypothetical one — P1 Batch 8, 2026-08-27**: that migration's two new tables (`accounting_period`, `idempotency_key`) genuinely failed with `permission denied` against the running application's `avant_app_runtime` connection until the grant was re-applied. The fix was applied as a bare copy of `p0-06-create-runtime-role.sql`'s `GRANT ... ALL TABLES` line only — which re-grants UPDATE/DELETE on *every* table, including `audit_log`/`clinical_access_log`, silently undoing the REVOKE that script applies right after that same GRANT. This genuinely reopened the audit-log immutability fix (§5/§6, P0-06) for a real window, not just in theory — `test/integration/audit-log-immutability.test.ts` failed in that same batch's own subsequent full-suite run (`UPDATE`/`DELETE` against `audit_log` succeeding where they must reject), which is what caught it. Fixed by re-running the REVOKE, verified by that test file passing again plus a direct standalone check against both tables. **`p0-06-regrant-new-tables.sql` now exists specifically so this can't happen again** — it bundles the GRANT and the REVOKE in one script; never copy just the GRANT lines out of the main script by hand.

## Outbox Sweep Scheduling (P1 §3/§4, 2026-08-27)

Every write that produces a domain event calls `dispatchPendingOutboxEvents(organizationId)` inline, immediately after its own transaction commits (ARCHITECTURE.md §15) — this is the primary, low-latency delivery path and needs no scheduling. But it only ever looks at *that write's own organization*, so nothing re-checks a `failed` event whose `nextRetryAt` has since arrived, or recovers an event stuck in `processing` because the process that claimed it died mid-handler (a killed serverless invocation, an OOM, a deploy that terminated an in-flight request) — unless something else calls `processPendingOutboxEvents()` (`src/lib/platform/outbox.ts`), the organization-agnostic sweep. **A production deployment must schedule this to run periodically** — without it, a crash-stuck event or a `failed` event whose retry window has opened just sits there until an admin happens to click "Sweep now" on `/admin/system-events`.

**This project ships a working Vercel Cron configuration** (`vercel.json`) hitting `GET /api/cron/outbox-sweep` once daily:

```json
{ "crons": [{ "path": "/api/cron/outbox-sweep", "schedule": "0 0 * * *" }] }
```

**Corrected 2026-08-28**: this was originally shipped as `*/5 * * * *` (every 5 minutes), matching `OUTBOX_PROCESSING_TIMEOUT_MS`'s own 5-minute recovery window (see below). That is a real, empirically-confirmed deployment blocker on the Hobby plan, not a theoretical one — Vercel does not "silently coerce" a too-frequent cron to its daily allowance as this doc previously (incorrectly) claimed; it **rejects the deployment outright**, before any build even starts ("Hobby accounts are limited to daily cron jobs. This cron expression would run more than once per day."). This is exactly what happened to this project's first deploy attempt after the P1 pass: the GitHub commit status showed `Vercel: Failure — Deployment failed` with no deployment object ever created. Changed to `0 0 * * *` (once daily, ±59 min per Vercel's own Hobby scheduling-precision note) to keep deployments working on Hobby; see point 2 below for what this means for recovery latency.

Setup:

1. Set `CRON_SECRET` in the deployment's environment variables (`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`) — Vercel automatically attaches it as `Authorization: Bearer <CRON_SECRET>` on every cron-triggered request to this project, which is what the route checks against (`src/app/api/cron/outbox-sweep/route.ts`). Without it set, the route returns `503` rather than running unauthenticated — there is no fallback "open" mode.
2. On the **Hobby tier** (as this project currently runs), the sweep can only run once daily — a crash-stuck or retry-eligible event may sit for up to ~24h before the scheduled sweep catches it (the inline `dispatchPendingOutboxEvents` path and the manual "Sweep now" admin fallback, both described below, are unaffected and still fire immediately). **Upgrade to Pro** (or any plan allowing once-per-minute cron precision) and change `vercel.json`'s schedule back to `*/5 * * * *` to restore 5-minute recovery latency in production.
3. **Why 5 minutes was the original target**: matches `OUTBOX_PROCESSING_TIMEOUT_MS`'s own 5-minute default (see that constant's doc comment in `outbox.ts`) — a stuck event becomes eligible for recovery and gets swept up on roughly the same cadence, without the sweep running so often it's pointless overhead for a bounded, idempotent batch job. Once on a plan that supports it, restoring that cadence is a one-line `vercel.json` change (point 2 above).

**Not on Vercel, or don't want to use Vercel Cron?** `processPendingOutboxEvents()` is a plain, dependency-free async function — call it from any scheduler that can run a Node process or hit an HTTP endpoint on an interval (a system cron entry running a small script that imports it directly, a different platform's scheduled-jobs feature, a self-hosted task runner). No Kafka/RabbitMQ/dedicated worker process is needed or was added — this stays within the existing modular-monolith architecture (ARCHITECTURE.md §1), the same "no unnecessary infrastructure" discipline already applied to the outbox's original design (§15) and the communications engine (§13).

**Manual/admin fallback**: `/admin/system-events` has a "Sweep now" button (gated on `system_events.retry`, same permission as retrying a single event) that calls the identical `processPendingOutboxEvents()` function synchronously — useful for an admin who doesn't want to wait for the next scheduled run, and a real (not merely theoretical) third way to trigger the sweep, alongside cron and any other scheduled job.

## Backup Strategy

This project runs on Supabase-hosted Postgres, which provides the actual backup mechanism in production — this section documents how to use what the platform already provides, not a bespoke backup system built by the app.

- **Automated backups**: Supabase takes daily automated backups on all paid tiers, and Point-in-Time Recovery (PITR, continuous WAL archiving) is available as an add-on for Pro-tier-and-above projects, giving restore granularity down to a specific point in time rather than only to the last daily snapshot. Confirm which tier this project's Supabase organization is on before relying on PITR specifically — the free tier does not include it.
- **Retention**: governed by the Supabase project's plan (daily backups typically retained 7 days on Pro, longer on higher tiers) — configure/verify retention in the Supabase dashboard under Database → Backups, not in this codebase.
- **What's backed up**: the entire Postgres database (every table in this schema) — there is no separate file-storage system to back up alongside it (see Environments above: no file storage adapter exists yet).
- **Restore procedure**: from the Supabase dashboard, Database → Backups → select a backup or PITR timestamp → restore to a new project (Supabase does not restore in-place onto a live project). After restoring, re-point `DATABASE_URL` at the restored project's connection string. **This procedure has not been drilled/rehearsed against this specific project** — spec.md §35 (Backup strategy) names "restore drill" as good practice; treat an actual rehearsal (restore to a scratch project, verify data, confirm the app boots against it) as a real Next Action before this is relied on in a genuine incident, not something this documentation alone satisfies.
- **Migrations are part of recoverability, not just backups**: because every schema change in this project lives in `prisma/migrations/*` under version control, a completely fresh database can be rebuilt to the current schema via `prisma migrate deploy` even independent of a Postgres-level backup — this is a second, independent recovery path for schema (not data).

## Deployment Checklist

Concrete, project-specific — not generic Next.js deployment advice:

1. Provision a production Postgres database (or a separate production Supabase project — do not deploy against the same database this build's development/testing has been running against).
2. Run `prisma/db-setup/p0-06-create-runtime-role.sql` against the new database (connected as its owner role) to create `avant_app_runtime` with a freshly generated password — see Database Privileges below. Do this **before** step 3, since step 3 needs both connection strings.
3. Set `DIRECT_DATABASE_URL` (the owner role, for migrations) and `DATABASE_URL` (the new `avant_app_runtime` role, for the running application) and `NODE_ENV=production` in the hosting platform's environment configuration — never set `DATABASE_URL` to an owner-role connection string.
4. Run `prisma migrate deploy` against the production database as an explicit, separate step — before or during deploy, never automatically on server boot (see Migrations above). This uses `DIRECT_DATABASE_URL`.
5. Run `npm run db:seed` once, against the fresh production database, to create the permission catalog, default roles, and the initial Super Admin account. This runs through `DATABASE_URL` (the restricted role) — fine, since seeding is DML (creates/upserts rows), not DDL.
6. **Change the seeded Super Admin password immediately** (`admin@avant.local` / the `prisma/seed.ts`-hardcoded dev password) — this has been a carried-over Next Action since Phase 1 and must happen before any non-local use. There is no forced-password-change-on-first-login flow; this is a manual step.
7. `npm run build` — confirms the production bundle compiles; the same command CI/this build's own verification has run at the end of every phase.
8. Start the app (`npm run start`, or the hosting platform's equivalent).
9. Verify: log in as Super Admin, confirm `/dashboard` renders real data, confirm a representative Server Action (e.g. registering a patient) and the new `/api/reports/export` Route Handler both work against the production database — this exercises `DATABASE_URL`/the restricted role end-to-end, per Database Privileges below.
10. Decide on and configure real SMS/WhatsApp/Email provider credentials only once a specific provider is chosen — see Environments above; nothing reads a provider credential yet, so there's nothing to set until an adapter is actually implemented.

## Status

Every environment this build has run in has been local/CI-style development against a Supabase-hosted Postgres database, verified via `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run test`, plus live browser verification each phase. This document was fully corrected against actual, built reality in Phase 14 — see the Stack section above for what changed from Phase 0's original plan. **The P1 remediation pass (P1 §1, 2026-08-27) cut this project's own local/dev database connection over to the two-role split described in Database Privileges above** — the current `.env` in this environment already reflects it; a fresh environment or a not-yet-provisioned production database must follow the Deployment Checklist's steps 2-3 to reach the same state. **The P1 remediation pass concluded 2026-08-28** (Batch 10, final synthesis and sign-off) — nothing in this document changed as a result of that final batch beyond this note and the migration count above; see [P1_REMEDIATION_REPORT.md](P1_REMEDIATION_REPORT.md) for the full record and this document's own Deployment Checklist/Database Privileges/Outbox Sweep Scheduling sections for every manual step a real deployment still needs (none newly introduced by P1; all were already documented before this pass, most already exercised by it).
