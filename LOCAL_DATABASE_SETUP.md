# Local PostgreSQL Development & Test Database Setup

Local Docker Postgres for `npm run dev` and the integration suite — Supabase remains the hosted Postgres for staging/production only (see [DEPLOYMENT.md](DEPLOYMENT.md)). This replaces the previous setup, where both `npm run dev` and `npm run test` ran against the same shared, remote Supabase database also reachable by the live Vercel deployment — the root cause of this suite's repeated nondeterministic failures (see the concurrency/pagination-test flakes documented across [P2_REMEDIATION_REPORT.md](P2_REMEDIATION_REPORT.md)'s later batches).

One Prisma schema, one migration history, for local dev, local tests, staging, and production alike — no separate schema was created.

## Verified live (2026-08-31)

Full checklist actually run against a real local Docker Postgres, not assumed:

```
Local Postgres:        127.0.0.1:5433 (avant_his_postgres, postgres:16-alpine, healthy)
Dev database:          his_dev — 32/32 migrations applied, grants applied, seeded
Integration test DB:   his_test — 32/32 migrations applied, grants applied, seeded + extra fixtures
Remote Supabase:       NOT USED (no connection made by db:*/test:* scripts)

prisma validate:        valid
prisma migrate status:   up to date (32 migrations, against localhost:5433/his_dev)
typecheck / lint:        clean
db:test:reset:           verified live (drop → 32 migrations reapplied → grants → seed → extra fixtures)
test:integration:        42 files / 273 tests passed, 0 failed, ~79-155s (was ~40 min with 1-2 flakes/run against Supabase)
production build:        clean, all 53 routes compiled
```

Two real bugs found and fixed during this live run, not caught by typecheck/lint (neither needs a database to reproduce, both fixed before this checklist re-ran clean):
1. `scripts/db/*.ts` entry points didn't load `.env` themselves — `npm` doesn't auto-load it the way Next.js/Prisma's own CLI do, so every `requireEnv()` call failed immediately. Fixed by adding `import "dotenv/config"` to each entry point, matching `prisma/seed.ts`'s own existing convention.
2. `db:test:reset` passed `prisma migrate reset --skip-seed`, a flag Prisma 7's CLI doesn't support (errors instead of ignoring it), and — once removed — would have let Prisma's own auto-seed-after-reset run through the *runtime* role before this script had a chance to re-grant it table access. Fixed by removing the flag and pointing that specific internal step at the owner connection instead; the runtime connection still gets its own explicit, separate seed pass immediately after, once grants are back.

Also found, via the very first live run against a freshly built `his_test` (not from reading code): `prisma/seed.ts` alone was missing a second `Branch`, a `Provider`, a `Service`, and a `Product` that 8 test files needed — see "Why `his_test` is seeded" below for the fix (`prisma/test-seed-extra.ts`).

## Prerequisites

- Docker Desktop (or another Docker Engine + Compose v2) installed and running.
- Node dependencies already installed (`npm install`).

## Two local databases, one container

| Database | Purpose |
|---|---|
| `his_dev` | Manual local development — `npm run dev` reads/writes it via `DATABASE_URL`. |
| `his_test` | Disposable, automated-test-only — the integration suite reads/writes it via `TEST_DATABASE_URL`, substituted in automatically. Reset freely; nothing in it is meant to survive. |

Both live in the same `postgres:16-alpine` container (`docker-compose.yml`), each with its own restricted **`his_app_runtime`** role (full CRUD everywhere except `UPDATE`/`DELETE` on `audit_log`/`clinical_access_log` — the exact same privilege model [P0-06](SECURITY.md#5-audit-architecture-specmd-62-vs-63--two-distinct-logs) established for Supabase, reused, not reinvented) plus the `postgres` owner role for migrations.

**Port note**: the container maps to host port **5433**, not Postgres's default 5432 — deliberately, to avoid colliding with a native/other local Postgres a developer's machine may already have running on 5432 (a real collision was found on the machine this was built on, not a hypothetical one). The container's own internal port is still the normal 5432.

## Local development

```bash
# 1. Start Postgres (creates his_dev/his_test + the his_app_runtime role
#    the first time; a plain restart on later runs — data persists in a
#    named Docker volume).
npm run db:local:start

# 2. Apply every Prisma migration to his_dev, grant the runtime role access
#    to the resulting tables, and seed development data (permission
#    catalog, default roles, org/branch, chart of accounts, the initial
#    Super Admin — prisma/seed.ts). Safe to re-run any time a new
#    migration lands.
npm run db:dev:setup

# 3. Run the application as usual.
npm run dev
```

## Testing

```bash
# 1. Postgres already running from above, or:
npm run db:local:start

# 2. Apply the exact same migrations to his_test and grant the runtime
#    role — and seed it too (see "Why his_test is seeded" below).
npm run db:test:setup

# 3. Run the integration suite — always against his_test, never against
#    DATABASE_URL/Supabase (see "How test isolation works" below).
npm run test:integration
```

To start every run from a known-clean database (drops and recreates `his_test`'s schema, reapplies migrations, re-grants, reseeds):

```bash
npm run db:test:reset
```

### Why `his_test` is seeded — and why it needs one file more than `his_dev`

Section 5's own instruction is "do NOT seed... unless tests depend on explicitly documented seed fixtures" — checked, not assumed, and confirmed by an actual first live run against a freshly built `his_test`, not just by reading the test files: every one of this suite's 33 integration test files reads baseline data via `db.<model>.findFirstOrThrow()` rather than creating that baseline itself; only test-specific fixtures (a patient, an invoice, a particular batch, …) are self-created per file.

`prisma/seed.ts` alone (the same script `his_dev` runs) covers most of that baseline — an `Organization`, one `Branch`, the permission/role catalog, a seeded `User`, the default Chart of Accounts, the lab/imaging/communication catalogs. **It does not create a second `Branch`, a `Provider`, a `Service`, or a `Product`** — verified directly by reading the file, not assumed. The old shared Supabase dev database this suite ran against for its entire history had all four anyway, accumulated organically over months of manual browser verification and ad hoc scripts across every P0/P1/P2 batch, so this gap was invisible until `his_test` was built from scratch for the first time: the first real `npm run test:integration` run against it failed 8 files with `findFirstOrThrow` "No record was found" (`Provider`/`Product`) or "Test requires at least 2 seeded branches" — real, reproducible evidence, not a guess.

`prisma/test-seed-extra.ts` closes exactly that gap — a second `Branch`, one `Provider`, one `Service`, one `Product`, idempotent, `his_test`-only (never run for `his_dev`, never touches `prisma/seed.ts` itself). `npm run db:test:setup`/`db:test:reset` both run it automatically, after `prisma/seed.ts`. With it in place, a full, fresh `his_test` build passes all 42 files / 273 tests.

### How test isolation works

`vitest.config.mts`'s `setupFiles` runs `test/setup-test-database.ts` before any test file (and therefore before `src/lib/db.ts`, which reads `DATABASE_URL` at import time) is ever imported. That file:

1. Requires `TEST_DATABASE_URL` and `TEST_DIRECT_DATABASE_URL` to be set — throws immediately, with no test executed, if either is missing.
2. Refuses to proceed if either looks like it points at a hosted/shared database (Supabase, AWS RDS, Neon, Render, Railway, Azure, CockroachDB Cloud — `scripts/db/lib.ts`'s `assertNotRemoteHost`).
3. Confirms the test database is actually reachable, with a clear, actionable error if not (`Is the local Postgres container running? Try: npm run db:local:start`) — never a raw connection-refused stack trace.
4. Only then substitutes `process.env.DATABASE_URL = TEST_DATABASE_URL` and `process.env.DIRECT_DATABASE_URL = TEST_DIRECT_DATABASE_URL` — for this test process only. `npm run dev`/production code is completely unaffected; it never imports this file and keeps reading `DATABASE_URL` exactly as before.

Both `DATABASE_URL` and `DIRECT_DATABASE_URL` are substituted, not just the first — `test/integration/audit-log-immutability.test.ts` opens a second, owner-level connection directly via `process.env.DIRECT_DATABASE_URL` to prove the restricted role genuinely cannot delete the row it just inserted. Leaving that one unsubstituted would have let exactly one test file quietly keep talking to whatever real (possibly Supabase) owner connection a developer's own `.env` has configured for `npm run dev` — the same class of gap this whole task exists to close, just narrower.

There is no other place to accidentally point at the wrong database: `npm run test:integration` and `npm run test` both run `vitest run`, which always loads this bootstrap.

### Concurrency tests

Nothing about this setup serializes or fakes concurrency — `vitest.config.mts`'s `fileParallelism: false` (pre-existing, unchanged) serializes *test files* against each other (so two files never race the same connection pool teardown), not the concurrent operations *within* a test. Appointment double-booking, payment/refund races, inventory overselling, number-sequence generation, package-session consumption, payroll/payment integrity, and outbox processing all still fire real concurrent `Promise.all`/`Promise.allSettled` calls against a real Postgres instance and rely on its actual `EXCLUDE`/unique-constraint/row-lock guarantees — now a local one, with no other environment's traffic able to interleave with them, which is the entire point of this task.

## Production/staging (Supabase)

Unchanged. Supabase remains the hosted Postgres for staging and production — see [DEPLOYMENT.md](DEPLOYMENT.md)'s "Environment Variables"/"Deployment Checklist"/"Database Privileges" sections for the full deployment path (still requires the Supavisor pooler in transaction mode, port 6543, and the same owner/runtime role split, just against a Supabase project instead of local Docker). **The automated integration suite must never run against a staging or production Supabase database** — the test bootstrap above enforces this technically (`assertNotRemoteHost`); this is the explicit policy statement, also recorded in DEPLOYMENT.md.

## Resetting / starting over

```bash
npm run db:test:reset          # his_test only — drop, recreate, reseed
npm run db:local:stop          # stop the container (data persists)
docker compose down -v         # stop AND delete all local data (his_dev + his_test both, irreversible)
```

`db:test:reset` (`scripts/db/test-reset.ts`) has its own independent safety check before doing anything destructive — it refuses to run unless `TEST_DIRECT_DATABASE_URL`'s own database name is literally `his_test` (`assertIsTestDatabase`), on top of the same remote-host check above. `his_dev` and any Supabase database are both structurally impossible targets for it, not just discouraged ones.

## Runtime role details (local)

Reuses the exact privilege model `prisma/db-setup/p0-06-create-runtime-role.sql` established for Supabase, not a second design:

- `prisma/db-setup/local-init.sql` — runs once, automatically, the first time the container starts against a fresh volume. Creates `his_dev`, `his_test`, and the `his_app_runtime` role (fixed local-only password — never reachable outside the container's `127.0.0.1`-bound port, never reused anywhere real).
- `prisma/db-setup/local-grant-runtime-role.sql` — the table-level `GRANT`/`REVOKE` (full CRUD everywhere, `UPDATE`/`DELETE` revoked on `audit_log`/`clinical_access_log`). Runs after migrations, via `npm run db:dev:setup`/`db:test:setup`/`db:test:reset` — safe to re-run any time (GRANT/REVOKE are naturally idempotent), which is exactly what's needed after each new migration adds tables.

This is what lets `audit-log-immutability.test.ts` run entirely locally, with no Supabase credentials of any kind.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | The local Postgres 16 service — localhost-only, persistent named volume. |
| `prisma/db-setup/local-init.sql` | One-time container bootstrap: creates `his_dev`/`his_test` + the `his_app_runtime` role. |
| `prisma/db-setup/local-grant-runtime-role.sql` | Re-runnable table grants/revokes for the runtime role, local counterpart to the existing `p0-06-*.sql` scripts. |
| `scripts/db/lib.ts` | Shared helpers: safety checks, reachability polling, SQL/CLI execution. |
| `scripts/db/local-start.ts` | `npm run db:local:start` |
| `scripts/db/setup-database.ts` | Shared migrate+grant+seed routine (not a script itself). |
| `scripts/db/dev-setup.ts` | `npm run db:dev:setup` |
| `scripts/db/test-setup.ts` | `npm run db:test:setup` |
| `scripts/db/test-reset.ts` | `npm run db:test:reset` |
| `prisma/test-seed-extra.ts` | `his_test`-only extra baseline fixtures (second Branch, Provider, Service, Product) — see above. |
| `test/setup-test-database.ts` | Vitest setup file — the actual `DATABASE_URL`/`DIRECT_DATABASE_URL` → `TEST_*` substitution. |
| `.env.example` / `.env` | `TEST_DATABASE_URL`/`TEST_DIRECT_DATABASE_URL` added; local values now point at Docker Postgres by default; original Supabase values kept as a commented-out reference in `.env` (not committed — `.env*` is gitignored). |
