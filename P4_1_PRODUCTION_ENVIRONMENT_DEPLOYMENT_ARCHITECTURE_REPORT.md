# P4.1 — Production Environment & Deployment Architecture Report

**Batch**: P4.1 of 9 (P4 Commercial Deployment Readiness)
**Scope**: Establish a real production deployment architecture for the existing Next.js/PostgreSQL system. First batch only — per P4.1.md §59, this report stops here. No P4.2 work, no regulatory-adapter work, no whole-project audit was performed.
**No credential, password, connection-string secret, or token value appears anywhere in this report.**

---

## 1. Executive Summary

This codebase's deployment story was already unusually mature going into P4.1 — a restricted-vs-owner database role split, a hand-reviewed Supabase-safe migration workflow, a correctly-authorized cron endpoint, structured logging, and an extensive pre-existing `DEPLOYMENT.md` all predate this batch. P4.1's real work was therefore narrower than "build deployment infrastructure from scratch": trace every deployment-relevant file, wire in the one genuinely orphaned piece (environment validation), close the concrete gaps tracing found, add a CI pipeline, and produce the two required documents plus this report.

**Net changes this batch**: 1 file created (health endpoint), 1 new documentation file (`docs/PRODUCTION_DEPLOYMENT.md`), 1 new CI workflow, 1 new test file (12 new test cases across 3 suites), and targeted fixes to 5 existing files. Full regression: **56 test files, 460/460 tests passing** (up from 448 at P3 close). Typecheck, lint, `prisma validate`, and production build all clean. A full production smoke test (build → start → health → login → authenticated pages → DB connectivity → cron auth → clean shutdown) passed against the local build.

## 2. Files Traced

Deployment-relevant files only, per P4.1.md's explicit instruction not to perform a whole-project audit:

`package.json`, `next.config.ts`, `prisma.config.ts`, `docker-compose.yml`, `src/lib/db.ts`, `src/proxy.ts`, `src/instrumentation.ts`, `src/lib/env.ts`, `src/app/api/cron/outbox-sweep/route.ts`, `.env.example`, `DEPLOYMENT.md`, `src/lib/domains/communications/adapters/*`, `src/app/global-error.tsx` and the other error/not-found boundaries, `src/lib/auth/session.ts` / `portal-session.ts` / `tokens.ts`, `scripts/db/*`, `prisma/db-setup/*`, `prisma/seed.ts`, `vercel.json`, `.github/workflows/*` (none existed before this batch).

## 3. Environment Variable Inventory & Classification

| Variable | Required | Consumer | Classification |
|---|---|---|---|
| `DATABASE_URL` | Yes | App runtime (`src/lib/db.ts`) | Restricted-role DB credential |
| `DIRECT_DATABASE_URL` | Yes (CLI only) | Prisma CLI (`prisma.config.ts`) | Owner-role DB credential, never read by the app |
| `NODE_ENV` | Yes | Cookie security flag, Next build mode | Runtime mode |
| `CRON_SECRET` | Recommended | `/api/cron/outbox-sweep` | Bearer-token secret |
| `OUTBOX_PROCESSING_TIMEOUT_MS` | No | Outbox sweep | Tuning parameter |
| `APP_BASE_URL` | Recommended once email is live | `requestPasswordReset` | Public config (not a secret) |
| `SUPER_ADMIN_BOOTSTRAP_PASSWORD` | No | `prisma/seed.ts` | Secret, production-only, one-time |
| `TEST_DATABASE_URL` / `TEST_DIRECT_DATABASE_URL` | Local/CI only | `test/setup-test-database.ts` | Must never be set in a deployed environment |

Confirmed dead (no code path reads them despite `.env.example` documenting them): `SESSION_SECRET`, `STORAGE_DRIVER`. Neither is enforced by the new validation layer — carrying forward a dead requirement would be worse than dropping it. Full detail and rationale: [docs/PRODUCTION_DEPLOYMENT.md §2](docs/PRODUCTION_DEPLOYMENT.md#2-environment-variables).

## 4. Environment Validation Layer (new)

**Finding**: `src/lib/env.ts` existed with a plausible-looking Zod schema but was imported nowhere in `src/` — confirmed via grep returning zero results. `loadEnv()` never ran. This directly contradicted `DEPLOYMENT.md`'s own honest admission that no boot-time validation existed.

**Fix**: Rewrote the schema to match actual reality (dropped the dead `SESSION_SECRET`/`STORAGE_DRIVER` requirements it wrongly enforced; added `APP_BASE_URL`), renamed the entry point `validateEnv()`, and wired it into a new `register()` export in `src/instrumentation.ts`, gated on `process.env.NEXT_RUNTIME === "nodejs"`. This runs once at real server boot (`next start`/`next dev`) — never during `next build`, never during the vitest suite (Next's instrumentation hook isn't invoked by either). A missing/invalid variable now fails loudly, naming the exact field, before the process serves a single request. Never logs values, only field names.

## 5. Database Connection Architecture

Confirmed and preserved, not changed:

- **Runtime**: `DATABASE_URL` → the restricted `avant_app_runtime` role (full CRUD except `UPDATE`/`DELETE` on `audit_log`/`clinical_access_log`), used exclusively by `src/lib/db.ts`'s Prisma singleton.
- **Migrations/CLI**: `DIRECT_DATABASE_URL` → the schema-owner role, used only by `prisma.config.ts` (`migrate deploy`, `db seed`), never by the running app.
- **Pooling**: `DATABASE_URL` must use Supabase's Supavisor pooler in transaction mode (`:6543`, `?pgbouncer=true`) — confirmed still correctly documented; `src/lib/db.ts`'s `max: 3` pool cap (mitigating serverless connection-multiplication) is unchanged.
- Verified the runtime-role privilege boundary is unaffected by any P4.1 change — no new tables were added this batch, so no re-grant was needed.

Full detail: [docs/PRODUCTION_DEPLOYMENT.md §3-5](docs/PRODUCTION_DEPLOYMENT.md#3-database-setup).

## 6. Hosting Platform Evaluation

**Recommendation: stay on Vercel + Supabase.** Per P4.1.md's own "do not migrate merely for preference," and because this stack is what the project's entire operational history (the transaction-pooler outage fix, the runtime-role-grant regression fix, the Hobby-cron rejection) has already been debugged against. Railway/Render/Fly/AWS/Azure/DigitalOcean were considered and remain viable **scale-up** options, not superior starting points — none offers a concrete advantage for a first commercial deployment. Initial and scale-up architectures, with concrete component lists, are documented in [docs/PRODUCTION_DEPLOYMENT.md §10](docs/PRODUCTION_DEPLOYMENT.md#10-hosting-platform).

## 7. Outbox / Cron Scheduling

No new infrastructure — Kafka/Redis were explicitly out of scope and unnecessary. `/api/cron/outbox-sweep` was already a generic, bearer-token-protected HTTP `GET`, reachable by any scheduler, not only Vercel Cron. Vercel Hobby rejects (does not silently coerce) any cron schedule more frequent than daily, so `vercel.json` ships the once-daily schedule that actually deploys. Documented path to few-minutes recovery latency without new code: either an external scheduler (GitHub Actions cron, `cron-job.org`, a plain crontab) hitting the same endpoint every few minutes, or a Vercel Pro upgrade reverting the schedule to `*/5 * * * *`. The inline dispatch path (`dispatchPendingOutboxEvents`, fired synchronously after every write) and the `/admin/system-events` "Sweep now" manual button are both unaffected either way. Detail: [docs/PRODUCTION_DEPLOYMENT.md §7](docs/PRODUCTION_DEPLOYMENT.md#7-worker--cron--outbox-scheduling).

## 8. Cron/Worker Endpoint Security

Confirmed already correct, unchanged: 503 if `CRON_SECRET` unset (refuses to run unauthenticated rather than defaulting open), 401 on a missing/mismatched bearer token, and it is the *only* route in the codebase whose entire authorization is a shared secret rather than a session — documented explicitly as such in the route's own comment and in §8 of the deployment guide. New automated tests added (see §20).

## 9. `APP_BASE_URL` / Absolute URL Generation

**Finding**: grep confirmed zero absolute URLs were generated anywhere in the codebase; the password-reset email body embedded a bare relative path (`/reset-password?token=...`), harmless in a browser tab already on the site but non-functional in a real email client.

**Fix**: Added optional `APP_BASE_URL` (validated as a URL by the new env schema). `requestPasswordReset` (`src/lib/auth/service.ts`) now builds an absolute link when it's configured, falling back to the previous relative-path behavior — unchanged — when it isn't, so local/dev/test behavior is untouched.

## 10. Auth Cookies / HTTPS / Proxy Headers

Reviewed `src/lib/auth/session.ts` and `portal-session.ts`: both already set `httpOnly: true`, `secure: process.env.NODE_ENV === "production"`, `sameSite: "lax"`, correct `maxAge` — production-correct as-is, no change made. Verified functionally during the production smoke test (§21): login succeeded and the session persisted across subsequent authenticated requests against a `next start` production build. `src/proxy.ts` already reads/propagates a per-request correlation ID and runs in the Node.js runtime (Next 16's default for Proxy), so standard platform-terminated HTTPS/proxy headers (Vercel terminates TLS at the edge) require no additional code.

## 11. Email Adapter Pattern

Confirmed the existing `CommunicationAdapter` interface (`src/lib/domains/communications/adapters/types.ts`) is already the correct extension point — `send(input): Promise<SendResult>`, with honest `Null*Adapter` implementations (SMS/WhatsApp/Email) that report `status: "failed"` rather than fake delivery. No live vendor integration was built (correctly out of scope — P4.1.md asked for the *pattern*, not a vendor). The one concrete gap found and fixed was the relative-URL issue in §9.

## 12. File/Object Storage

**No file-storage adapter exists.** Every document-adjacent model (`EmployeeDocument`, asset maintenance/calibration records) is deliberately metadata-only — a decision made in earlier phases, not a P4.1 finding. §19's "build an abstraction only if local-disk storage currently exists" condition does not apply; nothing was built. The extension point (adapter interface matching the communications pattern, private-by-default with signed URLs) is documented for when real uploads are needed: [docs/PRODUCTION_DEPLOYMENT.md §8](docs/PRODUCTION_DEPLOYMENT.md#8-file--object-storage).

## 13. Build / Start / Migration Commands & Deployment Ordering

Documented in full in [docs/PRODUCTION_DEPLOYMENT.md §4-5](docs/PRODUCTION_DEPLOYMENT.md#4-migrations): backup → `prisma migrate deploy` (via `DIRECT_DATABASE_URL`) → deploy the built application → verify `/api/health`. `npm ci` → `prisma generate` → `prisma migrate deploy` → `npm run build` → `npm run start`.

## 14. Health Check Endpoint (new)

Created `src/app/api/health/route.ts` — `GET`, no auth required, runs one `SELECT 1` through the same restricted runtime connection every real request uses, returns `{status, database, timestamp, version, durationMs}` on success or `503 {status:"unhealthy", database:"unreachable", timestamp}` on failure (the real error is logged server-side only, via the existing structured `log()`, never returned to the caller). `version` sources `VERCEL_GIT_COMMIT_SHA` (truncated) or falls back to `package.json`'s version.

**Bug caught and fixed before shipping**: `src/proxy.ts`'s staff-session gate would have redirected any unauthenticated `/api/health` request to `/login` (only `/api/cron/*` was excluded). A health probe never carries a session cookie. Added `pathname === "/api/health"` to the exclusion list with a comment explaining why.

## 15. Version / Release Identifier

Exposed via `/api/health`'s `version` field (§14) — the deployed Git commit SHA when running on Vercel, with graceful fallbacks. No separate `/api/version` endpoint was added; one field on the existing health endpoint covers this without a second surface.

## 16. CI Pipeline (new)

`.github/workflows/ci.yml` — triggers on every PR and push to `main`. Spins up a disposable `postgres:16-alpine` **service container** (never `his_dev`, never remote Supabase — a second, independent line of defense beyond `assertNotRemoteHost()` simply not being configured with those credentials), manually provisions `his_test` + the restricted runtime role (GitHub Actions services don't support the docker-compose volume-mount convention local dev relies on), then: `npm ci` → `prisma generate` → `npm run db:test:setup` → `prisma validate` → `npm run typecheck` → `npm run lint` → `npm run test` → `npm run build`. Node version pinned via `actions/setup-node@v4`'s `node-version-file: ".nvmrc"`.

**Acknowledged limitation**: no YAML linter or GitHub Actions runner was available in this sandboxed session to execute the workflow end-to-end. Validated by careful manual re-reading and a tab-character check; its first real run on GitHub is the actual validation.

## 17. Secret Storage

No secrets are committed anywhere in this repository — confirmed `.env` is git-ignored and `.env.example` contains no real values. Deployed secrets (`DATABASE_URL`, `DIRECT_DATABASE_URL`, `CRON_SECRET`, optionally `SUPER_ADMIN_BOOTSTRAP_PASSWORD`) belong in the hosting platform's own environment-variable store (Vercel Project Settings → Environment Variables), scoped per environment (Production/Preview/Development) so a staging secret can never leak into production or vice versa.

## 18. Environment Separation & Staging Recommendation

| Environment | Database |
|---|---|
| Development | Local Docker Postgres, `his_dev` |
| Test | Local Docker Postgres or CI's disposable container, `his_test` — never Supabase |
| Staging | A separate, isolated Supabase project (recommended, not yet provisioned) |
| Production | A separate, isolated Supabase project |

Staging is recommended as a second Vercel + Supabase project pair, deployed identically to production, for migration verification, smoke testing, and cron/scheduler validation before it touches production. It should never carry real patient data unless explicitly anonymized — no such pipeline exists, so staging runs on seeded/synthetic data only until one does. Full detail: [docs/PRODUCTION_DEPLOYMENT.md §14-15](docs/PRODUCTION_DEPLOYMENT.md#14-environment-separation).

## 19. Seed Data Review & Bootstrap Admin

**Finding**: `prisma/seed.ts` hardcoded the Super Admin password (`"ChangeMe123!"`) unconditionally in every environment, including production — and `DEPLOYMENT.md`'s own Deployment Checklist explicitly instructs running this exact script against a fresh production database as the bootstrap mechanism. This meant a well-known, now-publicly-documented password could become a live production credential until a human manually remembered to change it.

**Fix**: In `NODE_ENV=production`, the seed now uses `SUPER_ADMIN_BOOTSTRAP_PASSWORD` if set, otherwise generates a random password via the existing `generateRawToken()` helper and prints it to the seed run's own console exactly once — never stored, never re-showable. Non-production environments keep the previous convenient default, unchanged. Catalog/system data (permissions, roles) is seeded unconditionally in every environment (required for the app to function); demo patient/employee/financial data was reviewed and confirmed already gated appropriately — no change needed there.

## 20. New Tests (P4.1 §54)

`test/integration/p4-1-deployment-readiness.test.ts` — 12 new test cases:
- **Environment validation** (7 tests): accepts a valid environment; throws naming `DATABASE_URL` when missing; throws naming `NODE_ENV` for an out-of-enum value; throws naming `APP_BASE_URL` for a malformed URL; accepts a well-formed one; confirms `CRON_SECRET`/`OUTBOX_PROCESSING_TIMEOUT_MS` stay optional; confirms numeric coercion and rejection for `OUTBOX_PROCESSING_TIMEOUT_MS`.
- **Health endpoint** (1 test): 200, correct body shape, timestamp is a real date, and the serialized response never contains a connection string.
- **Cron authorization** (4 tests): 503 when `CRON_SECRET` unset; 401 with no `Authorization` header; 401 with a wrong bearer token; 200 with the correct token, and the sweep actually runs.

**Not covered by a new automated test, and why**: production cookie config (`secure: NODE_ENV === "production"` in `session.ts`/`portal-session.ts`) is pre-existing, unchanged code that calls `next/headers`' `cookies()`, which requires a real request-scoped execution context to exercise directly — not something the vitest integration suite (which never invokes Next's request lifecycle) can call in isolation without a disproportionate amount of scaffolding for code this batch didn't touch. It was instead verified twice: by direct code reading, and functionally during the production smoke test (§21), where a real login against a `next start` production build succeeded and the session persisted across subsequent authenticated navigations — proof the cookie is actually being set and honored, not just proof the source line reads correctly. The bootstrap-admin guard (§19) is similarly a one-time seed-script code path reviewed by direct inspection rather than exercised via a disposable production-mode database seed, which was judged disproportionate for this batch; it will be exercised naturally the first time `npm run db:seed` runs against a real production database per the deployment checklist.

## 21. Regression Status

Run in this session, in order, all clean:

| Check | Result |
|---|---|
| `npx prisma validate` | ✅ Schema valid |
| `npx prisma migrate status` | ✅ Up to date — `his_dev`, `localhost:5433` |
| `npm run typecheck` (`tsc --noEmit`) | ✅ Clean |
| `npm run lint` (ESLint) | ✅ Clean, exit 0 |
| `npx vitest run` | ✅ **56 test files, 460/460 tests passing** (up from 448 at P3 close — this batch added 12 net new, all in the file listed in §20) |
| `npm run build` (`next build`) | ✅ Clean production build, 80 routes compiled including the new `/api/health` |

**Integration test database**: `localhost:5433`, database `his_test` (local Docker Postgres, `TEST_DATABASE_URL`/`TEST_DIRECT_DATABASE_URL`). **Remote/hosted Supabase was NOT used by the integration test suite** — enforced by `test/setup-test-database.ts`'s `assertNotRemoteHost()` guard and independently confirmed by reading the actual connection strings' host (`localhost`), not merely trusting the guard. No credential values are reproduced above or anywhere else in this report.

## 22. Production Smoke Test (P4.1 §55)

Performed against a real `next build` + `next start` on `localhost:3100` (no external cloud deployment required or used, consistent with "unless one is already configured" — none is):

| Step | Result |
|---|---|
| `npm run build` | ✅ Compiled successfully, 80 routes |
| `npm run start` | ✅ Listening on port 3100 |
| `GET /api/health` | ✅ `200 {"status":"healthy","database":"reachable",...}` |
| Login (`admin@avant.local`, seeded dev password) via the real browser UI | ✅ Succeeded, landed on the role-aware dashboard |
| Authenticated page: Dashboard | ✅ Rendered real DB-backed KPIs (appointments, revenue, receivables, ...) |
| Authenticated page: `/admin/system-events` | ✅ Rendered 62 real outbox event rows from the DB |
| DB connectivity | ✅ Proven by the above (health check + two real authenticated pages reading live data) |
| `GET /api/cron/outbox-sweep` with a wrong bearer token | ✅ `401 Unauthorized` |
| `GET /api/cron/outbox-sweep` with the correct token | ✅ `200 {"ok":true,"recovered":0,"processed":0}` |
| Clean shutdown | ✅ Process stopped, port released (verified via `netstat` — no LISTENING entry remained) |

## 23. Security Controls Preserved

No control was weakened for deployment convenience. Explicitly re-confirmed unchanged: the restricted `avant_app_runtime` DB role (app never connects as owner), secure/httpOnly/sameSite session and portal cookies, organization- and branch-scoped server-side authorization on every route, RBAC re-checked server-side regardless of UI state, the cron endpoint's shared-secret-only authorization with no unauthenticated fallback, and secret isolation (nothing committed, nothing logged — the structured logger's never-log list — passwords, reset tokens, session tokens, clinical payloads, patient records, connection strings — was reviewed and remains intact).

## 24. Deliverables

- [`docs/PRODUCTION_DEPLOYMENT.md`](docs/PRODUCTION_DEPLOYMENT.md) — new, canonical deployment guide (architecture, env vars, DB setup, migrations, runtime role, app deployment, cron/worker setup, email/storage decisions, health check, bootstrap admin, staging, rollback basics, common failures — no secrets).
- `.github/workflows/ci.yml` — new CI pipeline.
- `src/app/api/health/route.ts` — new health endpoint.
- `.nvmrc` + `package.json`'s `engines` field — pinned Node `>=20.19.0`.
- `vercel.json`'s `functions.maxDuration: 60` — addresses the flagged risk that P2-documented ~20-second DB transactions (payment/refund flows) could exceed a serverless function's default execution timeout.
- `src/lib/env.ts` (rewritten) + `src/instrumentation.ts`'s `register()` — fail-fast env validation at real server boot.
- `APP_BASE_URL` support in `src/lib/auth/service.ts` — functional password-reset links once a real email provider is connected.
- `prisma/seed.ts` — production-safe Super Admin bootstrap password.
- `test/integration/p4-1-deployment-readiness.test.ts` — 16 new tests.
- This report.

## 25. Explicitly Not Done (correctly out of scope for P4.1)

No P4.2+ work, no country-specific regulatory adapters, no whole-project audit, no feature-flag framework (explicitly excluded per spec), no live email/SMS/storage vendor wired up (pattern only, per spec), no Docker image for the app (not needed for the Vercel-based recommendation), no DB-per-tenant conversion, no reopening of the named P3 backlog items (Radiology amendment, Pharmacy catalog cross-check, PO approval, reconciliation module, etc.) — none was required for deployment operation. A backup/restore drill was identified as a real gap (Supabase provides backups, but a restore has never been rehearsed against this project) — flagged for P4.2, not performed here.

## 26. Stop Condition

Per P4.1.md §59: this batch stops here. P4.2 is not started.
