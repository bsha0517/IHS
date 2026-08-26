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

- **Local development**: `next dev` against a real Postgres database (this project has used a Supabase-hosted instance throughout, not a local/Docker Postgres — see Migrations below for the one real workflow constraint that comes from that).
- **Production**: same Next.js application, `next build && next start` (or a platform that runs those for you — e.g. Vercel, or any Node host). No file storage, SMS/WhatsApp/Email provider, or other external service is wired up yet — see below.

**No file storage adapter exists** — every phase that touched documents (`EmployeeDocument`, `Asset` maintenance/calibration records, patient documents) deliberately stayed metadata-only (see PROJECT_STATUS.md's many "no file storage" Known Issues entries). There is no `STORAGE_DRIVER`/S3 configuration to set because there is no code path that reads one.

**No SMS/WhatsApp/Email provider is connected** — `src/lib/domains/communications/adapters/*` are real, swappable adapter implementations, but only the honest `Null*Adapter`s exist (Phase 12). Connecting a real provider (Twilio, WhatsApp Business API, SES/SendGrid, ...) means implementing a new adapter behind the existing `CommunicationAdapter` interface and swapping it in `resolveAdapter()` — no environment variable currently controls this because there is nothing to configure yet.

## Environment Variables (as actually used — corrected in Phase 14)

```
DATABASE_URL=      # Postgres connection string, required. This project connects through
                    # Supabase's Supavisor pooler (aws-*.pooler.supabase.com:5432).
NODE_ENV=           # development | production, standard Next.js — controls cookie
                    # `secure` flag (src/lib/auth/session.ts, portal-session.ts) among
                    # Next's own build-mode behavior.
```

That's the complete list. `SESSION_SECRET` was named in Phase 0's speculative env var list but is never read anywhere — session/reset tokens are 256-bit `crypto.randomBytes` values (`src/lib/auth/tokens.ts`), hashed with SHA-256 before storage; the token's own randomness is what makes it unguessable, not an HMAC secret, so there was never a code path that needed one. `STORAGE_DRIVER`/`S3_*` were likewise speculative and are unused for the reason above.

Only `DATABASE_URL` and `NODE_ENV` are validated present — `DATABASE_URL` fails Prisma Client construction loudly at import time if missing; there is currently no separate explicit "fail loudly at process boot" check beyond that, since only two variables exist and one (`NODE_ENV`) always has a Next.js-provided default.

## Migrations

`prisma migrate deploy` as an explicit, separate deploy step — never auto-applied on server boot, consistent throughout all 14 phases.

**A real, binding workflow constraint discovered in Phase 3 and re-confirmed through Phase 10, not the originally-planned one**: `prisma migrate dev` does not work cleanly against this Supabase-hosted database — its shadow-database drift detection flags Supabase's own pre-installed extensions (`pgcrypto`, `pg_stat_statements`, etc.) as drift, and `migrate dev --create-only` has been observed to hang indefinitely attempting shadow-database creation. Every migration in this project's history (20 to date) was instead generated via:

```bash
prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

with the "Loaded Prisma config..." noise line stripped, the SQL reviewed by hand, placed into a manually-created `prisma/migrations/<timestamp>_<name>/migration.sql`, and applied with `prisma migrate deploy`. A production deployment against a different (non-Supabase-pooled) Postgres instance may not hit this constraint, but this codebase's own migration history was built entirely through the manual path — reproduce a fresh environment the same way, not via `migrate dev`.

## Database Privileges (Phase 14 hardening — a real finding, not a completed action)

SECURITY.md originally pre-committed that "Phase 14 hardening removes UPDATE/DELETE grants for the app role" on `audit_log`/`clinical_access_log`. Reviewing this in Phase 14 surfaced a real gap in that plan, not an implementation of it: **this deployment has no separate, lower-privileged "app role" to revoke anything from.** `DATABASE_URL` connects as `postgres.<project-ref>` — a Supabase project's owner-equivalent role, the same role every migration in this project's history has run DDL as. Revoking UPDATE/DELETE on any table from that role would break migrations and every other write in the application, not just harden the two audit tables.

The correct fix — **not executed this phase, since it's a live-credential/infrastructure change that needs the user's explicit go-ahead, not something to do silently mid-hardening-pass**:

1. Create a second, lower-privileged Postgres role (e.g. `app_runtime`) via `CREATE ROLE app_runtime LOGIN PASSWORD '...'`.
2. `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime`, then explicitly `REVOKE UPDATE, DELETE ON audit_log, clinical_access_log FROM app_runtime` — insert-only on exactly those two tables, full CRUD everywhere else.
3. Keep migrations running as the current `postgres.*` owner role (unaffected); switch only the running application's `DATABASE_URL` to the new `app_runtime` role's connection string.
4. Verify the app still functions end-to-end against the new role before considering this closed (a wrong grant would surface as a runtime permission error on some write path, not a build-time failure).

Tracked as a Next Action in PROJECT_STATUS.md — deliberately not executed autonomously.

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
2. Set `DATABASE_URL` and `NODE_ENV=production` in the hosting platform's environment configuration.
3. Run `prisma migrate deploy` against the production database as an explicit, separate step — before or during deploy, never automatically on server boot (see Migrations above).
4. Run `npm run db:seed` once, against the fresh production database, to create the permission catalog, default roles, and the initial Super Admin account.
5. **Change the seeded Super Admin password immediately** (`admin@avant.local` / the `prisma/seed.ts`-hardcoded dev password) — this has been a carried-over Next Action since Phase 1 and must happen before any non-local use. There is no forced-password-change-on-first-login flow; this is a manual step.
6. `npm run build` — confirms the production bundle compiles; the same command CI/this build's own verification has run at the end of every phase.
7. Start the app (`npm run start`, or the hosting platform's equivalent).
8. Verify: log in as Super Admin, confirm `/dashboard` renders real data, confirm a representative Server Action (e.g. registering a patient) and the new `/api/reports/export` Route Handler both work against the production database.
9. Apply the database privilege hardening described above (Database Privileges) before considering the deployment "hardened" per this phase's own name — not done automatically as part of this checklist, tracked separately.
10. Decide on and configure real SMS/WhatsApp/Email provider credentials only once a specific provider is chosen — see Environments above; nothing reads a provider credential yet, so there's nothing to set until an adapter is actually implemented.

## Status

Not yet deployed to production. Every environment this build has run in in has been local/CI-style development against a Supabase-hosted Postgres database, verified via `npm run typecheck`, `npm run lint`, `npm run build`, and (as of Phase 14) `npm run test`, plus live browser verification each phase. This document was fully corrected against actual, built reality in Phase 14 — see the Stack section above for what changed from Phase 0's original plan.
