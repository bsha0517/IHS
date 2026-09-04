# P4.4 — Observability & Production Operations Report

**Batch**: P4.4 of 9 (P4 Commercial Deployment Readiness), following [P4.1](P4_1_PRODUCTION_ENVIRONMENT_DEPLOYMENT_ARCHITECTURE_REPORT.md), [P4.2](P4_2_DATABASE_RELIABILITY_BACKUP_RESTORE_DISASTER_RECOVERY_REPORT.md), and [P4.3](P4_3_PRODUCTION_SECURITY_HARDENING_REPORT.md).
**Objective**: make production failures visible, traceable, actionable, and supportable before real clinics depend on the system.
**No credential, password, token, or connection-string value appears anywhere in this report. No regulatory-compliance claim is made.**

## Executive Summary

Tracing this codebase's existing observability found a solid but incomplete foundation: a structured logger, per-request correlation IDs, a framework-wide error hook, a public health endpoint, and a mature Outbox retry/dead-letter mechanism — all pre-existing (P2/P0-02/P4.1). The concrete gap was durability: none of it answered "is the scheduled sweep actually still running?" or "did last night's backup succeed?" from anything more durable than a single past HTTP response or process exit code. This phase closes that gap with one small, generic heartbeat table, a platform-wide operational-health service built on top of it and the existing Outbox/LoginHistory data, a new admin operations page, and a real GitHub Actions backup schedule — while deliberately not building an APM platform, a metrics database, or distributed tracing.

Every failure state this report describes was **actually simulated** against a real production build — a stale scheduler, a dead-letter event, a stale backup — and confirmed to recover cleanly afterward, not merely described. Full regression: 59 test files, 518/518 passing (up from 503 at P4.3 close — 15 new), typecheck/lint/`prisma validate`/production build all clean.

## Existing Observability Traced

Per §3's scope boundary — not a whole-project audit. Confirmed already in place and left unchanged in shape: `src/lib/platform/logger.ts` (structured `log()`, one chokepoint, documented never-log list), `src/proxy.ts` (per-request `x-correlation-id` generation/propagation), `src/instrumentation.ts` (`onRequestError` — Next's framework-wide catch-all, already reading the correlation ID off the request), both error boundaries (`global-error.tsx`, `(dashboard)/error.tsx` — already display `error.digest` as a user-facing reference, Phase 14), `/api/health` (P4.1, already safe/minimal), `src/lib/platform/outbox.ts` (P0-02/P1 — retry schedule, stale-processing recovery, dead-letter transition, all already logging), `/admin/system-events` (P0-02 admin visibility), `src/lib/domains/accounting/exceptions.ts` (P3.9's narrowed accounting view over the same Outbox table), `LoginHistory` (P4.3, now with a `channel` discriminator and a supporting index), `scripts/db/backup.ts` (P4.2, metadata sidecar but no durable success/failure signal), `src/app/api/cron/outbox-sweep/route.ts` (P4.1/P4.3, bearer-token-protected, constant-time comparison). Version/release metadata (`VERCEL_GIT_COMMIT_SHA`) was already exposed via `/api/health`.

## Observability Architecture

Four layers, kept distinct (§4): **A — Health** (`/api/health`, unchanged in shape), **B — Metrics/Signals** (`getOperationalHealth()` → `/admin/operations`, new), **C — Logs/Context** (the existing structured logger, extended with two fields), **D — Alerts/Incident Response** (the dashboard's status badges today; an external provider documented as recommended, not integrated). Full detail: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

## Health / Readiness

`/api/health` re-verified unchanged and still correct: unauthenticated, one `SELECT 1`, `{status, database, timestamp, version, durationMs}`, no patient/secret data. **Deliberately not expanded** — a separate authenticated view (`/admin/operations`) carries the heavier operational detail instead, per §6's own instruction not to bloat the public health check.

## Structured Logging

`LogFields`/`LogRecord` extended with two new optional fields, both additive (no existing call site changed shape): `release` (auto-populated on every log line from the same version derivation `/api/health` already uses — no call site needs to pass it) and `errorCategory` (a fixed nine-value union: `AUTHENTICATION`, `AUTHORIZATION`, `VALIDATION`, `DATABASE`, `OUTBOX`, `ACCOUNTING_POSTING`, `BACKUP`, `EXTERNAL_PROVIDER`, `INTERNAL`). Applied at the Outbox's own existing log points (`OUTBOX` category) and the cron sweep's new failure path. The documented never-log list (passwords, hashes, tokens, connection strings, clinical content, card data) was re-verified, not changed.

## Correlation IDs

Traced end-to-end and **verified over real HTTP, not just code reading**: `curl -i` against a running production build shows `x-correlation-id` present on both a normal `/api/health` response and a cron-sweep response. `onRequestError` already reads it back off the request for the framework-wide catch-all log line. No distributed-tracing framework was built — a stable per-request ID, already present, is confirmed sufficient for V1.

## Error Classification

Nine categories (see Structured Logging above) — deliberately not an "enormous taxonomy" (§12). `domain` (subsystem) and `errorCategory` (failure type) are independent, complementary fields, not a redundant pair.

## Request / Operation Failure Visibility

Unchanged mechanism (`onRequestError`), re-confirmed still firing correctly and now carrying `release` on every line via the logger's own auto-population. The cron route's `GET` was wrapped in an explicit `try/catch` this phase — previously an unhandled `processPendingOutboxEvents()` throw would have produced a bare framework 500 with no heartbeat recorded at all; now every invocation, success or failure, durably records its outcome before responding.

## Database Operational Signals

`/api/health` and `/admin/operations`'s Database card both reuse the same cheap `SELECT 1` — no new DB telemetry code was written. [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md#database-operational-signals) explicitly documents that CPU/memory/storage/connection-pool/replication metrics belong to the Supabase dashboard, not this application, per §14's own instruction not to duplicate provider telemetry.

## Outbox Operational Signals

`getOperationalHealth()`'s `outbox` section: one bounded `groupBy` (pending/processing/failed/dead-letter counts) plus one indexed `findFirst` (oldest pending event age) — reusing the existing `OutboxEvent` table exactly as it already exists, no new queue system. Verified live against real data during the walkthrough (see Failure Simulations).

## Scheduler Heartbeat

**The concrete gap this phase closes.** New `OperationalJobState` table (one migration, hand-trimmed of unrelated pre-existing drift the same way P4.2/P4.3's migrations were), written exclusively by the cron route (`src/app/api/cron/outbox-sweep/route.ts`) via `recordJobAttempt()` — deliberately **not** written by the admin "Sweep now" manual button, so the heartbeat answers "is the *scheduled* job firing" specifically, not "did someone intervene manually" (a manual sweep masking a genuinely broken schedule would be a false sense of security — this was a real design decision, not an oversight). Thresholds: Warning >15min, Critical >30min since last success, tuned to the documented 5-minute expected cadence. **Verified via a real, unmocked HTTP call**: `curl` against the running cron endpoint with the correct bearer token produced a `200`, and the resulting database row was confirmed via direct SQL to have `last_success_at` set to that exact moment.

## Dead-Letter Monitoring

Any `dead_letter` Outbox event drives `outbox.status` (and `accounting.status`, if the event type posts to the ledger) straight to Critical — zero tolerance, per §21. **Verified via a real, isolated fixture**: a `dead_letter`-status `OutboxEvent` row was inserted directly (event type `P44WalkthroughFixture`, clearly labeled, never touching real business data), the operations page was reloaded and confirmed to show Outbox: Critical, then the fixture was deleted and the page reloaded again to confirm a clean return to Healthy.

## Accounting Exceptions Monitoring

`getOperationalHealth()`'s `accounting` section imports and reuses `ACCOUNTING_EVENT_TYPES` directly from `src/lib/domains/accounting/exceptions.ts` (P3.9) — never a duplicated list, per §22's own "do not create a second accounting error queue." Status: Critical on any dead-letter accounting event (§23 — highest severity, ledger-vs-operational divergence risk), Warning on failed/retrying-but-not-yet-dead-lettered. Links to the existing `/accounting` exceptions workspace for org-scoped drill-down.

## Backup Monitoring

`OperationalJobState`, key `"backup"`, written by `scripts/db/backup.ts` itself via a raw parameterized upsert (`writeBackupHeartbeat()`) into the database *being backed up* — so a real production backup run's heartbeat lands directly in production, exactly where the running app's own `/admin/operations` reads it. Recorded on **both** outcomes: success (filename, size, Postgres version, migration count — matching the existing `.meta.json` sidecar's own safe fields, never a full path or credential) and failure (a truncated, sanitized error message) — closing §27's explicit "a failed backup must create a safe operational error signal, never silently succeed." A missing row reports `configured: false`, status `Unknown` — **verified this is not a false Healthy**: `/admin/operations` in this local environment (where no backup has run against `his_dev`) correctly shows Backup: Unknown throughout this phase's own walkthrough, exactly as §49/§50 require.

## Backup Scheduling Status

**Explicitly distinguished per §70's own instruction — never conflate "implemented" with "deployment-configured":**

- **Implemented** (real, tested code): the heartbeat-writing code in `scripts/db/backup.ts`, verified via the P4.2 drill and this phase's own read-side tests; the new `.github/workflows/backup.yml` GitHub Actions workflow file (daily cron + manual `workflow_dispatch`, installs `postgresql-client`, runs the exact same `npm run db:backup` already drilled).
- **Deployment configuration required, not yet done**: the workflow needs a real `PRODUCTION_DIRECT_DATABASE_URL` repository secret before it does anything — it fails closed with an explicit error message if that secret is absent, rather than silently skipping or reporting false success. No production Supabase project or GitHub repository secret exists in this development environment to configure and verify end-to-end; the workflow's own header comment states this exactly.
- **Destination**: GitHub Actions' own artifact storage (14-day retention) is the practical V1 destination — a real, independent-of-Supabase location (§8's "independent backup principle"), explicitly documented as not equivalent to a dedicated S3/R2 bucket, with that remaining the recommended graduation path in [docs/BACKUP_DISASTER_RECOVERY.md](docs/BACKUP_DISASTER_RECOVERY.md).

## Authentication Abuse Monitoring

`getOperationalHealth()`'s `authentication` section queries `LoginHistory` (P4.3) over a 15-minute window: failed staff logins, failed portal logins, throttled attempts — all via the existing `(ip, channel, createdAt)` index, no new index needed (§67 — inspected, found already sufficient). Aggregate thresholds only (Warning ≥25 failures or any throttle, Critical ≥75 failures or ≥5 throttles), never per-attempt alerting (§30), never an attempted password or a broad per-account enumeration view (§29).

## Operational Status Model

Four levels exactly (§36): Healthy, Warning, Critical, Unknown — no status is ever stored directly, every one is computed live from raw timestamps/counts against the documented thresholds. **The one real architectural decision this phase made**: `getOperationalHealth()` is deliberately platform-wide, not organization-scoped, unlike every other domain query in this codebase — because the Outbox sweep, the cron scheduler, and the backup job are each genuinely one shared mechanism, with no per-tenant instance to scope to, and because this application's RBAC model has no cross-tenant identity to gate a "platform operator" view on even if one were wanted (every role, including "Super Admin," is itself organization-scoped). Every value surfaced is a bare count or timestamp — verified by an automated test asserting the serialized summary contains no `@` character (no email) and only the documented top-level keys.

## Admin Operations Workspace

`/admin/operations` (new route) — extends the existing System Events sidebar section (§34), gated on the same `system_events.view` permission already protecting `/admin/system-events` rather than inventing a new one (§51). Seven cards (Application, Database, Outbox, Scheduler, Accounting, Backup, Authentication), each a status badge, one plain-language line, and a link to the relevant org-scoped detail page where one exists. No decorative charts. `force-dynamic` — always current, never a stale cached snapshot.

## Alert Severity / Thresholds

Consolidated in [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) and [docs/PRODUCTION_OPERATIONS_RUNBOOK.md](docs/PRODUCTION_OPERATIONS_RUNBOOK.md): scheduler (15min/30min), backup (26h/48h), outbox backlog age (10min/30min), dead-letter (any = Critical), authentication (25/75 failures, 1/5 throttles). CRITICAL/WARNING/INFO framing (§43) applied consistently across the runbook's own incident entries.

## Error Monitoring Provider Decision

**Not integrated — stated precisely as "integration-ready / recommended," never "active"** (§70, §39). No Sentry account/DSN exists in this development environment to configure and genuinely verify against; claiming an untested integration would violate this project's own established "never claim untested capability" discipline (the same standard applied to Supabase PITR in P4.2). The exact, already-existing integration points (`instrumentation.ts`'s `onRequestError`, `logger.ts`'s `log()`) are documented, along with the precise setup path and required privacy configuration, in [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md#error-monitoring-provider).

## Privacy / PHI Protection

Every new surface this phase adds was checked: `/admin/operations` shows counts/timestamps/status only (automated test, see Tests Added); the backup/scheduler `lastError` field is truncated to 500 characters and sourced only from `Error.message`, never a raw payload; authentication signals are counts, never an attempted password or per-account detail beyond an aggregate; nothing new is reachable without both authentication and `system_events.view`. Documented privacy requirements for a future error-monitoring provider (disable request-body/session-token/cookie capture, no default Session Replay in clinical routes) are specified in advance, in [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md#privacy--phi-protection), even though no provider is active yet.

## Production Incident Runbook

[docs/PRODUCTION_OPERATIONS_RUNBOOK.md](docs/PRODUCTION_OPERATIONS_RUNBOOK.md) — twelve incidents, each with symptoms/first checks/containment/diagnosis/recovery/verification/escalation: application unavailable, database unavailable, high error rate, scheduler stale, outbox backlog, dead-letter event, accounting posting failure, backup failed, backup stale, authentication attack spike, bad deployment, and an unknown production error reported by a clinic (with the full clinic support intake workflow, §58/§59). Concise by design — no incident entry exceeds what an on-call engineer needs to start acting.

## Failure Simulations

Performed for real against a running `next start` production build, using isolated fixture data only, all cleaned up afterward — not described, not mocked:

| Scenario | Action | Result | Cleanup / Recovery Verified |
|---|---|---|---|
| **A — Stale scheduler** | Backdated the real `outbox_sweep` heartbeat's `last_success_at` to 40 minutes ago via direct SQL | `/admin/operations` immediately showed Scheduler: **Critical**, overall status: **Critical** | Restored to "now"; reloaded; Scheduler returned to **Healthy** |
| **B — Dead-letter event** | Inserted one isolated `outbox_event` row, `status='dead_letter'`, event type clearly labeled `P44WalkthroughFixture` | `/admin/operations` immediately showed Outbox: **Critical** (1 dead-letter) | Deleted the fixture row; reloaded; Outbox returned to **Healthy** |
| **C — Stale backup** | Inserted an `operational_job_state` row for key `"backup"` with `last_success_at` 50 hours in the past | `/admin/operations` immediately showed Backup: **Critical** ("Last successful backup: 2d ago") | Deleted the fixture row; reloaded; Backup returned to **Unknown** (correctly — no real backup has run in this environment, so "Unknown," not "Healthy," is the honest post-cleanup state) |

No destructive action touched real development data — every fixture was clearly labeled, isolated, and removed before the walkthrough concluded, confirmed via a direct database recount.

## Browser / Production Walkthrough

Against a real `next start` build (`npm run build` clean beforehand):

1. `curl -i /api/health` — `200`, `x-correlation-id` present, all P4.3 security headers present, no secrets.
2. `curl -i /api/cron/outbox-sweep` with the correct bearer token — `200`, `{"ok":true,"recovered":0,"processed":0}`, `Cache-Control: no-store`, `x-correlation-id` present.
3. Direct SQL confirmed the real sweep above wrote a durable `operational_job_state` row with the exact timestamp of the call.
4. Logged in as `admin@avant.local` via the real browser UI.
5. `/admin/operations` loaded, rendered all seven cards correctly, zero console errors, CSP not violated.
6. `curl -i /admin/operations` with no session cookie — `307` redirect to `/login?from=%2Fadmin%2Foperations`, confirming the route is protected exactly like every other admin page.
7. Three failure simulations (above), each observed live in the browser, each recovered and re-verified.

No external cloud deployment was used or required.

## Files Changed

**Created**:
- `prisma/migrations/20260901_p4_4_operational_job_state/` — one hand-trimmed migration
- `src/lib/platform/operational-state.ts` — heartbeat write/read helpers
- `src/lib/platform/operational-health.ts` — the operational-health service
- `src/app/(dashboard)/admin/operations/page.tsx` — the new admin page
- `.github/workflows/backup.yml` — the production backup schedule (deployment configuration required — see Backup Scheduling Status)
- `docs/OBSERVABILITY.md`
- `docs/PRODUCTION_OPERATIONS_RUNBOOK.md`
- `test/integration/p4-4-observability-operations.test.ts` — 15 new tests
- This report

**Modified**:
- `prisma/schema.prisma` — `OperationalJobState` model
- `src/lib/platform/logger.ts` — `release` (auto-populated), `errorCategory`, `durationMs` fields; `SLOW_OPERATION_THRESHOLD_MS` constant
- `src/lib/platform/outbox.ts` — `errorCategory: "OUTBOX"` added to its three existing log calls (no behavior change)
- `src/app/api/cron/outbox-sweep/route.ts` — heartbeat recording (success and failure), slow-sweep warning, explicit error handling around `processPendingOutboxEvents()`
- `scripts/db/backup.ts` — `writeBackupHeartbeat()`, called on both success and failure paths
- `src/components/layout/nav-config.ts` — "Operations" sidebar entry

## Tests Added / Updated

`test/integration/p4-4-observability-operations.test.ts` — 15 new tests: `OperationalJobState` heartbeat semantics (success/failure recording, error truncation, upsert-not-duplicate — 4 tests), `getOperationalHealth()` status-threshold calculation (permission gate, scheduler unknown/healthy/warning/critical, backup unconfigured/warning, dead-letter driving outbox and accounting to critical, no-PHI structural assertion — 8 tests), and the cron route's own heartbeat recording (a valid sweep updates it, an unauthorized request does not — 2 tests, using the real route handler and a real `NextRequest`, not a mock). Deliberately does not re-test Outbox dispatch/retry/dead-letter mechanics themselves (already covered by `outbox-reliability.test.ts`, `outbox-crash-recovery.test.ts`, `outbox-concurrency.test.ts`) or P4.3's login-history/rate-limit mechanics — only this phase's new read side over them.

## Regression Status

| Check | Result |
|---|---|
| `npx prisma validate` | ✅ Schema valid |
| `npx prisma migrate status` | ✅ Up to date — `his_dev`, `localhost:5433`, 36 migrations |
| `npm run typecheck` (`tsc --noEmit`) | ✅ Clean |
| `npm run lint` (ESLint) | ✅ Clean |
| `npx vitest run` | ✅ **59 test files, 518/518 tests passing** (up from 503 at P4.3 close — 15 net new, all in this batch's own test file) |
| `npm run build` (`next build`) | ✅ Clean production build, `/admin/operations` confirmed in the route list |

**Integration test database**: `localhost:5433`, database `his_test` (local Docker Postgres). **Remote/hosted Supabase was NOT used** anywhere this phase. All failure-simulation fixtures were created in and removed from `his_dev`, confirmed via a direct post-cleanup recount (`operational_job_state`: 1 row — the real `outbox_sweep` heartbeat; zero fixture `outbox_event` rows remaining). No credential value is reproduced anywhere in this report.

## Remaining Operations Backlog

- **Production backup scheduling requires deployment configuration** — the GitHub Actions workflow exists and is correct; it needs a real `PRODUCTION_DIRECT_DATABASE_URL` secret before its first real run.
- **No external error-monitoring provider is integrated** — documented as recommended (Sentry), with the exact setup/privacy path specified, not built this phase.
- **No independent object-storage backup destination** — GitHub Actions artifacts are the practical V1 destination; S3/R2/Azure Blob remains the recommended graduation path (unchanged from P4.2's own backlog).
- **Restore-drill scheduling remains a documented runbook entry, not an automated recurring job** — matching P4.2's own explicit "do not automate restore drills against production."
- **CAPTCHA/WAF remain documented escalation options, not built** — unchanged from P4.3's own backlog, restated here only because the Authentication Attack Spike runbook entry references them.

None of these were silently dropped — every one is named in this report and in the relevant doc's own Limitations-equivalent section.

## P4.4 Acceptance Decision

Checked against every §73 criterion:

1. Health endpoint remains safe and functional — ✅ (re-verified unchanged)
2. Correlation IDs are usable operationally — ✅ (verified over real HTTP, not just code)
3. Unexpected server errors are safely logged — ✅ (`onRequestError` re-confirmed, cron route now explicitly wrapped)
4. Outbox backlog is visible — ✅ (`/admin/operations`, live-verified)
5. Dead-letter events are visible — ✅ (live-simulated, Critical, recovered)
6. Scheduler last-success/heartbeat is durable and visible — ✅ (real HTTP call → real DB row, verified)
7. Scheduler staleness can produce Warning/Critical state — ✅ (live-simulated)
8. Accounting exceptions are included in operations visibility — ✅ (reuses the existing event-type list, live-verified via the dead-letter simulation)
9. Backup success/failure/freshness can be represented operationally — ✅ (live-simulated stale state; heartbeat-writing code verified in the underlying script)
10. Missing/unconfigured production backup destination is not falsely shown as Healthy — ✅ (`configured: false` / status `Unknown`, observed as the actual state throughout this phase's own local walkthrough)
11. Authentication abuse has basic operational visibility — ✅ (aggregate counts, reusing P4.3's own indexed table)
12. Operations workspace is protected — ✅ (same permission as System Events; unauthenticated access confirmed redirected)
13. Operational summaries contain no PHI/secrets — ✅ (automated structural test + manual visual confirmation during the walkthrough)
14. Practical incident runbook exists — ✅ (12 incidents, symptom-to-escalation)
15. At least a few failure states are actually simulated — ✅ (three: scheduler, dead-letter, backup — each live, each recovered)
16. Regression suite remains clean — ✅ (518/518, typecheck/lint/build all clean)

No scheduler can silently stop with zero detectable signal (a missing heartbeat is itself the signal — `Unknown`, not `Healthy`). No dead-letter accounting event can silently accumulate (zero-tolerance Critical). No backup failure can silently go unnoticed (both outcomes recorded; missing entirely reads as `Unknown`, never `Healthy`). No operational page exposes PHI/secrets. Production errors remain traceable via `correlationId`/`release`/`errorCategory`.

# Can P4.4 be closed?

## YES

Per §75's explicit stop condition: stopping here. Not beginning P4.5, performance/load testing, onboarding/data import, release-candidate work, regulatory work, or another whole-project audit without further instruction.
