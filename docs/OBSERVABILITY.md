# Observability Architecture

Written in P4.4 (Observability & Production Operations). Answers "how does this application make its own failures visible" — for "what do I *do* when one of these signals fires," see [docs/PRODUCTION_OPERATIONS_RUNBOOK.md](PRODUCTION_OPERATIONS_RUNBOOK.md). No regulatory-monitoring claim of any kind is made anywhere in this document.

## The Four Layers

**Signal → Context → Action**, not "logs → thousands of lines nobody reads."

| Layer | Answers | Where |
|---|---|---|
| **A — Health** | Is this instance usable right now? | `/api/health` (public, cheap, binary-ish) |
| **B — Metrics / Signals** | What's the current state of each production concern? | `getOperationalHealth()` → `/admin/operations` |
| **C — Logs / Context** | What actually happened, with enough detail to diagnose? | `src/lib/platform/logger.ts`'s structured `log()`, correlated by `x-correlation-id` |
| **D — Alerts / Incident Response** | Something needs a human — what do they do? | The admin dashboard's status badges today; [docs/PRODUCTION_OPERATIONS_RUNBOOK.md](PRODUCTION_OPERATIONS_RUNBOOK.md) for the response; an external provider (§ Error Monitoring Provider below) is recommended, not yet wired up |

Layers are deliberately not conflated: `/api/health` never fails merely because one old dead-letter event exists (see Health vs. Operational Status below) — that's Layer B's job, not Layer A's.

## Health / Readiness

`/api/health` (P4.1, re-verified this phase): unauthenticated, cheap (one `SELECT 1`), returns `{status, database, timestamp, version, durationMs}`. Never patient data, never a connection string, never a stack trace. **Deliberately not expanded this phase** — bloating it with Outbox/backup/auth-abuse checks would violate §5's own "do not make the public health endpoint run expensive operational queries," and would make an unauthenticated endpoint the wrong audience for infrastructure detail anyway (see Admin Operations Workspace below).

`/admin/operations` (new) is the authenticated readiness/operational-health view — see Operational Status Model below.

## Structured Logging

`src/lib/platform/logger.ts`'s `log()` remains the single chokepoint every call site uses (P2, unchanged in shape this phase, extended with two new optional fields):

| Field | Since | Purpose |
|---|---|---|
| `timestamp`, `level`, `event`, `domain`, `operation` | P2 | Core structured shape |
| `correlationId` | P2 | Ties related log lines to one request (see below) |
| `organizationId`, `branchId`, `userId`, `entityId`, `reference` | P2 | Safe identifiers — never a name, note, or record content |
| **`release`** | **P4.4** | Auto-populated on every log line from the same value `/api/health`'s `version` field reports — answers "did failures start after release X?" (§60) without every call site passing it |
| **`errorCategory`** | **P4.4** | One of `AUTHENTICATION`, `AUTHORIZATION`, `VALIDATION`, `DATABASE`, `OUTBOX`, `ACCOUNTING_POSTING`, `BACKUP`, `EXTERNAL_PROVIDER`, `INTERNAL` — a small, fixed classification of failure *type*, independent of `domain` (which subsystem). Optional; most log lines are informational, not failures |
| **`durationMs`** | **P4.4** | Set when a caller already measured timing and it exceeded `SLOW_OPERATION_THRESHOLD_MS` (5000ms) — see Request Duration below |
| `error` | P2 | Normalized `{name, message, stack}`, never a raw unknown value |

**Never logged** (unchanged, re-verified this phase): passwords, password hashes, session tokens, reset tokens, `Authorization` headers, database connection strings, raw clinical note content, raw lab result payloads, full patient records, card data. This logger does not scan/redact field values itself — the discipline is on each call site, matching the file's own long-standing documented approach.

**Log levels**, used consistently: `ERROR` (operation failed, needs investigation — e.g. `outbox.dead_letter`, `outbox.sweep_failed`), `WARN` (degraded but self-healing — e.g. `outbox.handler_failed`, a slow-operation breach), `INFO`/`DEBUG` (lifecycle/diagnostic only — this codebase intentionally does not turn normal patient/business actions into log noise; `AuditLog` is the correct record of business activity, not this logger).

## Correlation IDs

Traced end-to-end: `src/proxy.ts` generates (or forwards, if a caller already supplied one) an `x-correlation-id` on every request, attaches it to the request headers so downstream Server Components/Actions/Route Handlers can read it via `getCorrelationId()`, and sets it on the response. `instrumentation.ts`'s `onRequestError` — Next's own framework-wide catch-all for any uncaught error in Server Component rendering, a Route Handler, or a Server Action — reads it back off the request and includes it in the structured log line. This means: incoming request → correlation ID generated → propagated through Server Action/domain operation via `getCorrelationId()` → present in the log line for any explicit `log()` call *and* the framework-wide catch-all, without a distributed-tracing framework — a stable per-request ID is enough for V1 (§8's own instruction).

**Response header** (verified over real HTTP this phase, not just code inspection): `x-correlation-id` is present on the actual HTTP response the browser receives, confirmed via `curl -i` against a real `next start` build — see the report's Browser/Production Walkthrough. Support staff can ask "what did the page show?" and separately capture this header (via browser dev tools) or the Next-generated `error.digest` (see below) to locate the matching server log line.

## User-Facing Error Reference

Already implemented (Phase 14, predates P4.4, re-verified this phase): both error boundaries (`src/app/global-error.tsx`, `src/app/(dashboard)/error.tsx`) display `error.digest` — Next's own generated identifier for a caught Server Component/rendering error, which also appears in the corresponding server log line — as "Reference: `<digest>`". Never a stack trace, Prisma error, SQL, or filesystem path. **Not changed this phase**: a friendly, expected validation error a Server Action returns (e.g. "Invalid email or password.") is not a crash and correctly has no reference ID — §10's own instruction is to leave those unchanged.

## Error Categories

See the Structured Logging table above (`errorCategory`). Applied at the highest-value points this phase touched: the Outbox's own dead-letter/retry/stale-recovery logging (`OUTBOX`), the cron sweep's own failure path (`OUTBOX`), and left as an available field for future call sites — not retrofitted onto every existing log line in the codebase, matching §12's "do not build an enormous error taxonomy."

## Database Operational Signals

`/api/health`'s own `SELECT 1` round-trip is the primary reachability signal (Layer A). `/admin/operations`'s Database card re-runs the same cheap check and reports its duration (Layer B). **Deliberately not duplicated further**: CPU, memory, storage, connection-pool saturation, and PITR/replication state are Supabase/provider-level metrics — this application does not attempt to reimplement them. Production operators should look to:

- **Supabase Dashboard** → Database → for connection count, CPU/memory, storage.
- **Supabase Dashboard** → Database → Backups → for PITR/replication state.

## Request Duration

Lightweight, not a performance-testing framework (P4.5's own scope). `SLOW_OPERATION_THRESHOLD_MS` (5000ms, `logger.ts`) is the shared threshold; the cron sweep route logs a `WARN` (`outbox.sweep_slow`) if a full sweep exceeds it. This is a severe-degradation tripwire, not a latency budget — no optimization work was performed based on it (§17's own instruction; P4.5 owns that).

## Outbox Operational Signals

`getOperationalHealth()`'s `outbox` section: `pending`, `processing`, `failedRetrying`, `deadLetter` counts (one bounded `groupBy` query, platform-wide — see Operational Status Model for why not per-organization) and `oldestPendingAgeMs` (one indexed `findFirst`). All reused from the existing `OutboxEvent` table (P0-02/P1) — no new queue system.

## Scheduler Heartbeat

**The concrete gap this phase closes.** Before P4.4, the cron endpoint returning `200` once proved nothing about whether the *next* scheduled invocation ever happens — there was no durable trace at all. `OperationalJobState` (new table, key `"outbox_sweep"`) is written by the cron route itself (`src/app/api/cron/outbox-sweep/route.ts`), on both success and failure, via `recordJobAttempt()`. **Deliberately only the cron route writes it** — not `processPendingOutboxEvents()` itself, and not the admin "Sweep now" manual-trigger button — so the heartbeat answers "is the *scheduled* job actually firing," not "did someone manually intervene recently" (a manual sweep masking a broken schedule would be a false sense of security). Thresholds: Warning past 15 minutes since the last success, Critical past 30 minutes — tuned to the documented 5-minute expected cadence (see [docs/PRODUCTION_DEPLOYMENT.md §7](PRODUCTION_DEPLOYMENT.md#7-worker--cron--outbox-scheduling)).

## Dead-Letter Monitoring

Any `dead_letter` Outbox event drives `outbox.status` (and therefore `overallStatus`) straight to Critical — zero tolerance, matching §21's "should not silently accumulate." The existing `notifyDeadLetter()` in-app notification (P0.md §11, unchanged) still fires independently at the moment an event actually dead-letters; the operations dashboard is the durable, always-current view of "is there one right now," not a replacement for that immediate notification.

## Accounting Exceptions Monitoring

`getOperationalHealth()`'s `accounting` section filters the same `OutboxEvent` table to `ACCOUNTING_EVENT_TYPES` (reusing the exact list `src/lib/domains/accounting/exceptions.ts` already defines — imported, not duplicated) and reports `failedPostingEvents`/`deadLetterPostingEvents` as platform-wide counts. Status: Critical on any dead-letter accounting event (§23's "new accounting event enters dead-letter" = highest severity, because these can create ledger-vs-operational divergence), Warning if failed/retrying events exist without yet reaching dead-letter. The page links to `/accounting` (this organization's own exceptions workspace, pre-existing, P3.9) for drill-down — no second accounting-error queue was built.

## Backup Monitoring

`OperationalJobState`, key `"backup"` — written by `scripts/db/backup.ts` itself (`writeBackupHeartbeat()`, a raw parameterized upsert via the same `pg` connection already open for metadata queries, into the database *being backed up* — so a production backup run writes its own heartbeat directly into production, which the running app then reads). Recorded on both success (filename, size, Postgres version, migration count — never a full path or a credential) and failure (a truncated, sanitized error message). A missing row (no backup has ever run in this environment) reports `configured: false`, status `Unknown` — never a false `Healthy`. Staleness thresholds: Warning past 26 hours, Critical past 48 hours, matching the documented daily-backup cadence ([docs/BACKUP_DISASTER_RECOVERY.md](BACKUP_DISASTER_RECOVERY.md)).

## Authentication Abuse Monitoring

`getOperationalHealth()`'s `authentication` section queries `LoginHistory` (P4.3) for the last 15 minutes: failed staff logins, failed portal logins, and IP-throttled attempts (`reason: "ip_throttled"`), all via the existing `(ip, channel, createdAt)`/`(emailAttempted, createdAt)` indexes — no new index needed. Thresholds are aggregate, not per-attempt (§30's own "do not alert on every failed login"): Warning at ≥25 combined failures or any throttled attempt in the window, Critical at ≥75 failures or ≥5 throttled attempts. Never exposes an attempted password or which specific accounts were targeted — counts only.

## Operational Status Model

Four levels only (§36): **Healthy**, **Warning**, **Critical**, **Unknown**. `Unknown` is distinct from `Healthy` — used specifically when a signal has never recorded any state (an unconfigured backup job, a scheduler that's never run) so an absence of data is never displayed as if it were a clean bill of health (§49/§50's own explicit instruction). A section's overall status is computed live from raw stored facts (timestamps, counts) against the thresholds above — never itself stored as a status.

**Deliberately platform-wide, not organization-scoped** — the one real architectural decision this phase made and is worth stating plainly: `/admin/system-events` (P0-02) and `/accounting/exceptions` (P3.9) each show *one organization's own* business queue, correctly scoped by `session.user.organizationId` like every other domain query in this codebase. `getOperationalHealth()` is a different kind of thing — the Outbox sweep, the cron scheduler, and the backup job are each ONE shared mechanism serving every organization in this single database, with no natural per-tenant instance to scope to. Showing a bare count ("23 pending events," "2 accounting dead-letter events") reveals nothing about *which* organization's data those are — no name, no financial amount, no patient content — so this was judged safe to show platform-wide under the same `system_events.view` permission that already gates the per-org pages, rather than inventing a new "platform operator" role/permission this codebase's RBAC model has no other concept of (every existing role, including "Super Admin," is itself an organization-scoped role name — there is no cross-tenant identity anywhere else in this application to reuse instead).

## Admin Operations Workspace

`/admin/operations` (new) — extends the existing System Events sidebar section rather than redesigning Administration (§34). Seven cards: Application, Database, Outbox, Scheduler, Accounting, Backup, Authentication — each a status badge plus one line of plain-language explanation and a last-updated/last-success timestamp where relevant, linking to the org-scoped detail pages (`/admin/system-events`, `/accounting`) rather than duplicating their tables. No decorative charts. Gated on `system_events.view`, `force-dynamic` rendered (always current, never a stale cached snapshot of infrastructure state).

## Error Monitoring Provider

**Recommended, not integrated this phase** — stated precisely, per §70: this is "integration-ready," not "production monitoring active." No Sentry (or equivalent) account/DSN exists in this environment to configure and verify against, and claiming an integration that was never actually exercised would violate this very report's own "never claim untested capability" discipline (the same discipline P4.2 applied to Supabase PITR).

**The integration point already exists and needs no further plumbing**: `src/instrumentation.ts`'s `onRequestError` hook is exactly where a provider's Next.js SDK (Sentry's in particular) plugs in — replace or supplement its `log()` call with the provider's own capture call. `src/lib/platform/logger.ts`'s own `log()` is the second, narrower integration point for a provider transport instead of `console.*`. Both were documented as extension points since P2; this phase adds nothing to that plumbing beyond confirming it's still the right hook.

**Recommended provider**: Sentry (broad Next.js App Router support, source-map upload, release tagging all first-class). Setup path, when actually adopted:

1. `npm install @sentry/nextjs`, run its setup wizard (creates `sentry.client.config.ts`/`sentry.server.config.ts`/`sentry.edge.config.ts` and wraps `next.config.ts`).
2. **Privacy** (§40, mandatory before enabling, not optional hardening): disable request-body capture, strip `Authorization`/`Cookie` headers, disable Session Replay in any authenticated clinical route — Sentry's `beforeSend`/`sendDefaultPii: false` and `Sentry.replayIntegration()`'s own masking options cover this; never capture a raw clinical note, lab result, or patient record — use the existing safe identifiers (`entityId`, `organizationId`) this logger already carries, not record content.
3. **Release tagging** (§41): set `release` from the same value `/api/health`'s `version` already reports (`VERCEL_GIT_COMMIT_SHA`) so a regression can be attributed to a specific deployment.
4. **Source maps** (§42): private upload only (Sentry's build-time upload step, authenticated via an auth token) — never publish source maps publicly.
5. **Environment tag**: `production`/`staging`/`development`, matching `NODE_ENV`.

Until adopted, structured `console.error`/`console.warn` output (captured by whatever the hosting platform's own log aggregation provides — Vercel's own log drain, at minimum) remains the production error-visibility mechanism, per Log Search below.

## Privacy / PHI Protection

Applies to every surface this phase touches, restated here as one checklist:

- `/admin/operations` and `getOperationalHealth()`: counts and timestamps only — verified by an automated test asserting the serialized summary contains no `@` (no email address) and only the documented top-level keys.
- The scheduler/backup heartbeat's `lastError`: truncated to 500 characters, sourced from `Error.message` (never a raw payload, request body, or clinical value) — the same discipline the logger's own `error` field already applies.
- `LoginHistory`-derived authentication signals: counts only, never an attempted password, never which specific account was targeted beyond an aggregate number.
- No monitoring surface added this phase is reachable without authentication and the `system_events.view` permission, except `/api/health` itself, unchanged from P4.1 and still PHI-free.

## Log Retention

Application (operational) logs, `AuditLog`, and `ClinicalAccessLog` are three separate things with three separate retention expectations — restated for clarity, not redefined:

- **Operational logs** (this document's own subject): retention is whatever the hosting platform's log aggregation provides — Vercel's own log retention window by default, or an external provider's (Sentry, Datadog, ...) retention plan if one is adopted. Not promised indefinitely by this application.
- **`AuditLog`/`ClinicalAccessLog`**: business/security records, insert-only, retained per this organization's own data-retention policy — a separate, longer-lived concern from operational logs, unaffected by whatever the operational-log retention window is.

## Log Search

Production operations must be able to search by `correlationId`, `release`, `userId`, `organizationId`, and `errorCategory` — every one of these is now a top-level field in every structured log line (see Structured Logging above), so any log-aggregation tool that can filter structured JSON fields (Vercel's own log viewer, or an external provider) already supports this without a custom search UI (§56's own instruction not to build one when the hosting platform provides it).
