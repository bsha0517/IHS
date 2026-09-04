# Production Operations Runbook

Written in P4.4 (Observability & Production Operations). For the architecture behind every signal named here, see [docs/OBSERVABILITY.md](OBSERVABILITY.md). This is production-operational readiness only — not a HIPAA-monitoring, DHA-compliance-monitoring, or SOC2-observability claim of any kind.

## Where to Look First

| Question | Where |
|---|---|
| Is the app/DB reachable at all? | `GET /api/health` |
| Full infrastructure status | `/admin/operations` (requires `system_events.view`) |
| This organization's own background events | `/admin/system-events` |
| This organization's own accounting exceptions | `/accounting` (Accounting Exceptions) |
| Structured logs | The hosting platform's log viewer (Vercel, or an adopted error-monitoring provider) — filter by `correlationId`, `release`, `errorCategory` |

## Incidents

### Application unavailable

**Symptoms**: `/api/health` times out or returns nothing; the site itself doesn't load.
**First checks**: Is the hosting platform (Vercel) reporting an outage/deployment failure? Check the platform's own status/deployment dashboard before assuming an application bug.
**Containment**: If a *recent deployment* is the suspect, roll back to the previous known-good deployment immediately (Vercel's own instant-rollback) — see Bad Deployment below for the fuller procedure.
**Diagnosis**: Check the platform's function logs for the deployment in question; check `/api/health` from a second network path to rule out a local/DNS issue.
**Recovery**: Redeploy the known-good build, or wait out a confirmed platform-side outage.
**Verification**: `/api/health` returns `200 healthy`; a real login succeeds; `/admin/operations` loads and shows Database: Healthy.
**Escalation**: If the platform itself is down, this is a hosting-provider incident — escalate to the provider, not an application fix.

### Database unavailable

**Symptoms**: `/api/health` returns `503 unhealthy`; `/admin/operations`'s Database card shows Critical.
**First checks**: Confirm from the Supabase dashboard whether the project is genuinely down, paused (billing), or under maintenance.
**Containment**: Avoid destructive retries or manual database intervention — a real outage resolves on the provider's side, not by application-level action.
**Diagnosis**: Supabase's own status page / project dashboard for the actual cause (maintenance, resource exhaustion, an incident on their end).
**Recovery**: Once Supabase reports the database reachable again, no application action is needed — `/api/health` recovers automatically (it re-checks on every call, nothing sticky).
**Verification**: `/api/health` returns `200`; `/admin/operations` Database card returns to Healthy; specifically re-check Outbox state afterward — an outage during in-flight writes is exactly the crash-recovery scenario the existing `processing`-timeout mechanism already handles (see [docs/BACKUP_DISASTER_RECOVERY.md §Outbox After Restore](BACKUP_DISASTER_RECOVERY.md#outbox-after-restore) for the same reasoning applied to a DB outage instead of a restore).
**Escalation**: A Supabase-side incident lasting beyond a few minutes — escalate per the provider's own support channel; see [docs/BACKUP_DISASTER_RECOVERY.md](BACKUP_DISASTER_RECOVERY.md)'s Disaster Recovery Scenario D (provider/region-level outage) if it becomes a genuine failover decision.

### High application error rate

**Symptoms**: A spike in `runtime.unhandled_request_error` log lines (from `instrumentation.ts`'s `onRequestError`), or user reports of error pages across multiple areas.
**First checks**: Filter logs by `release` — did this start right after a deployment? If yes, treat as Bad Deployment below.
**Containment**: If tied to one specific route/feature, no broad containment needed — a crash in one Server Component doesn't take down the rest of the app (each route segment has its own error boundary).
**Diagnosis**: Group log lines by `errorCategory`/`reference` (route path) to find the common failure; check `/admin/operations` for a correlated Database/Outbox signal.
**Recovery**: Fix-forward or roll back, depending on cause and severity.
**Verification**: Error rate returns to baseline; spot-check the affected route directly.
**Escalation**: If the root cause isn't found within a reasonable window and user impact is ongoing, escalate for a second engineer.

### Outbox scheduler stale

**Symptoms**: `/admin/operations`'s Scheduler card shows Warning (>15 min since last success) or Critical (>30 min).
**First checks**: Is a production scheduler actually configured at all (Vercel Cron on a paid tier, or an external scheduler hitting `/api/cron/outbox-sweep`)? If the Scheduler card has *never* shown a success (`lastSuccessAt: null`), this is a **Not Configured** state, not a runtime failure — see [docs/PRODUCTION_DEPLOYMENT.md §7](PRODUCTION_DEPLOYMENT.md#7-worker--cron--outbox-scheduling).
**Containment**: Business writes are unaffected — the inline `dispatchPendingOutboxEvents()` path (fires synchronously after every write) keeps working regardless of scheduler health; only *retry/recovery* of already-failed or stuck events is delayed.
**Diagnosis**: Check the scheduler's own trigger history (Vercel Cron logs, or the external scheduler's own run history) for why it stopped firing; check `CRON_SECRET` is still correctly configured (a misconfigured secret makes every attempt fail with `401`/`503`, which the heartbeat now correctly records as a failure, not silence).
**Recovery**: Fix the scheduler configuration, or manually trigger a sweep from `/admin/system-events`'s "Sweep now" button as an immediate stopgap (this does **not** update the scheduler heartbeat by design — see [docs/OBSERVABILITY.md](OBSERVABILITY.md#scheduler-heartbeat) — so don't mistake a successful manual sweep for the scheduler being fixed).
**Verification**: The Scheduler card returns to Healthy only once the *automated* trigger succeeds again.
**Escalation**: If the scheduler is confirmed configured correctly but still failing, check for a genuine application bug in `processPendingOutboxEvents()` via the recorded `lastError`.

### Outbox backlog

**Symptoms**: Scheduler card is Healthy, but the Outbox card shows Warning/Critical due to `oldestPendingAgeMs`.
**First checks**: How large is the backlog (`pending` count)? A brief spike after a burst of activity (e.g. a busy morning) is expected and should clear on the next sweep.
**Containment**: None needed unless the backlog is growing unboundedly.
**Diagnosis**: Check `/admin/system-events` for which event types are accumulating and whether they're failing repeatedly (check `lastError` on individual events).
**Recovery**: A manual "Sweep now" clears a transient backlog immediately; a persistently growing backlog points to a handler-level bug — investigate the specific failing event type.
**Verification**: `oldestPendingAgeMs` drops back under the warning threshold after the next sweep.
**Escalation**: A backlog that doesn't clear after a manual sweep — treat as a code-level bug in the relevant event handler, not an infrastructure issue.

### Dead-letter event

**Symptoms**: Outbox card (or Accounting card, if the event type is one that posts to the ledger) shows Critical due to `deadLetter > 0`.
**First checks**: `/admin/system-events`, filter to `dead_letter`, read the event type and `lastError`. If it's an accounting event type, go to `/accounting` (Accounting Exceptions) instead — same underlying table, narrowed view.
**Containment**: A dead-lettered event already notified every Org Admin/Super Admin in-app (`notifyDeadLetter`, unchanged since P0) — confirm that notification was seen, don't assume silence means it didn't fire.
**Diagnosis**: Read the full error via server logs (correlate by the event's own `entityId`/`reference` in the structured log line) — the admin UI intentionally shows only a truncated summary, not a full stack trace (§53's own instruction).
**Recovery**: Fix the underlying cause (a data issue, a downstream dependency problem, a code bug), then retry the specific event from the admin UI (`system_events.retry`/`accounting.post`) — **never retry blindly without understanding why it failed three times already**; a handler must be idempotent (documented in `outbox.ts`) but retrying a genuinely broken input just dead-letters again.
**Verification**: The event's status moves to `completed`; the Outbox/Accounting card returns to Healthy.
**Escalation**: An accounting dead-letter event specifically — treat as HIGH priority (§23): it can mean a real financial transaction (an invoice, a payment, a refund) exists operationally but hasn't reached the ledger yet. Involve whoever owns accounting/finance operationally, not just engineering.

### Accounting posting failure

**Symptoms**: Accounting card shows Warning (failed/retrying, not yet dead-lettered) — the earlier stage of the Dead-Letter Event scenario above.
**First checks**: `/accounting` → Accounting Exceptions, check how many attempts remain before dead-letter (`MAX_ATTEMPTS = 3`).
**Containment**: None yet needed — retries are already scheduled automatically.
**Diagnosis**: Same as Dead-Letter Event — read `lastError`, correlate with server logs.
**Recovery**: If the underlying cause is understood and fixed, the next scheduled retry succeeds on its own; a manual retry is available if urgency warrants not waiting.
**Verification**: Event reaches `completed` before exhausting its retries.
**Escalation**: If retries are about to exhaust (2 of 3 attempts failed) and the cause isn't understood, escalate before it becomes a dead-letter event.

### Backup failed

**Symptoms**: `/admin/operations`'s Backup card shows a `lastError` and the age since `lastSuccessAt` is growing.
**First checks**: Was this the scheduled GitHub Actions run (`.github/workflows/backup.yml`) or a manual `npm run db:backup`? Check the workflow's own run log for the actual `pg_dump` error.
**Containment**: None needed for application availability — a failed backup doesn't affect the running application at all, only future recoverability.
**Diagnosis**: Common causes: the `PRODUCTION_DIRECT_DATABASE_URL` secret is stale/rotated, the direct (non-pooled) connection is temporarily unreachable, or `pg_dump`/target Postgres version mismatch.
**Recovery**: Fix the underlying connectivity/credential issue, re-run the workflow manually (`workflow_dispatch`).
**Verification**: The next successful run updates `lastSuccessAt`; the Backup card returns to Healthy.
**Escalation**: Two or more consecutive failed backups — treat as urgent; recoverability is degrading, not just a one-off blip.

### Backup stale

**Symptoms**: Backup card shows Warning (>26h) or Critical (>48h) despite no explicit failure recorded — the scheduled job itself may not be running at all.
**First checks**: Is `.github/workflows/backup.yml` actually enabled and scheduled for this repository? (GitHub disables scheduled workflows after 60 days of repository inactivity — re-enable under Actions if so.)
**Containment**: None needed for application availability.
**Diagnosis**: Check the workflow's own run history — is it running and failing (see Backup Failed above), or not running at all?
**Recovery**: Re-enable/fix the schedule, or trigger a manual run as an immediate stopgap while investigating.
**Verification**: `lastSuccessAt` updates; Backup card returns to Healthy.
**Escalation**: If backups have never once succeeded in this environment (Backup card shows "Not Configured"), this is a deployment-configuration gap, not an incident — see [docs/BACKUP_DISASTER_RECOVERY.md](BACKUP_DISASTER_RECOVERY.md) and close it before depending on this deployment in production.

### Authentication attack spike

**Symptoms**: Authentication card shows Warning/Critical — an unusual volume of failed logins or throttled IPs in the last 15 minutes.
**First checks**: Is this concentrated on one or a few IPs (credential stuffing / brute force) or spread across many (less clearly an attack — could be a broken client retrying)?
**Containment**: The IP-based rate limiter (P4.3) is already throttling automatically — no manual action is required for it to keep working.
**Diagnosis**: `LoginHistory` (queried via the same signals `/admin/operations` summarizes) shows the pattern; never expose attempted passwords or a per-account enumeration view broadly (§29's own instruction) — this is an aggregate signal, not a forensic dashboard.
**Recovery**: If a specific account is being targeted and is at real risk, an admin can proactively deactivate it (`/admin/users`) pending the account holder confirming their credentials weren't compromised elsewhere.
**Verification**: The failure/throttle rate returns to baseline.
**Escalation**: A sustained, high-volume attack — consider CAPTCHA/challenge as an escalation (documented in [docs/PRODUCTION_SECURITY.md](PRODUCTION_SECURITY.md), not built pre-emptively) or a hosting-provider WAF rule if the platform offers one.

### Bad deployment

**Symptoms**: Errors/failures begin immediately after a deployment; `release` in recent log lines matches the new deployment.
**First checks**: Confirm via `/api/health`'s `version` field (or log `release` values) exactly which deployment is live.
**Containment**: Roll back to the previous deployment immediately (Vercel's own instant rollback) — don't attempt a forward-fix under pressure if a clean rollback is available. See [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)'s Application Rollback / Failure Handling sections for the full procedure, including the additive-migration case where the previous app version stays compatible with the current schema.
**Diagnosis**: Once rolled back and stable, diagnose the bad deployment's actual defect from logs/error monitoring at leisure.
**Recovery**: Fix and redeploy once understood; **never** run `prisma migrate reset` in production to "start clean," ever, under any circumstance (see [docs/BACKUP_DISASTER_RECOVERY.md](BACKUP_DISASTER_RECOVERY.md)'s Migration Policy).
**Verification**: `/api/health` healthy, representative login works, `/admin/operations` shows no new Critical signals, error rate at baseline.
**Escalation**: If the bad deployment already ran a migration that can't be trivially rolled back with the application, follow [docs/BACKUP_DISASTER_RECOVERY.md](BACKUP_DISASTER_RECOVERY.md)'s Scenario B (bad deployment/migration).

### Unknown production error reported by a clinic

**Symptoms**: "The invoice screen gave an error" — see Clinic Support Workflow below for the full intake procedure.

## Clinic Support Workflow

When a clinic reports something like *"the invoice screen gave an error"*:

1. **Collect the timestamp** — as precisely as the reporter can give it.
2. **Collect a safe error/correlation reference** — the `error.digest` shown on-screen if it was a crash (both error boundaries display this as "Reference: ..."), or the `x-correlation-id` response header if support can capture it via browser dev tools.
3. **Identify organization/branch if known** — from the reporter's own account, not by searching patient records.
4. **Search logs** by `correlationId` (if collected) or by `release` + approximate timestamp + `organizationId`.
5. **Identify the release** the failure occurred on (`release` field in the matched log lines).
6. **Inspect the related system event**, if the failure involved a background operation (an invoice posting, a notification) — `/admin/system-events` for that organization.
7. **Resolve or escalate** based on what the logs show.

**Do not** ask support to collect patient clinical details, passwords, reset tokens, or session cookies as part of this flow (§59) — a correlation ID, a safe entity ID (an invoice number, not its content), organization/branch, and a timestamp are sufficient and are what the logging architecture is specifically built to make searchable.

## Deployment Health Check

After every production deployment, verify (extending [docs/PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md)'s existing checklist):

1. `/api/health` returns `200 healthy`.
2. Database reachable (covered by the above).
3. `/admin/operations` loads and shows no new Critical signal.
4. Outbox looks normal (no unexpected backlog/dead-letter spike right after deploy).
5. No new accounting exceptions.
6. Backup state is known (not necessarily fresh immediately post-deploy, but not silently "Unknown" in an environment where it should be configured).
7. A representative login succeeds.
8. No critical error-rate spike in the minutes immediately following deployment.

**Do not** run a full end-to-end clinic workflow (booking → encounter → billing → payment) after every trivial deployment (§61's own instruction) — reserve that for the P4.1-established production smoke test after a genuinely risky release.

## Recovery Signal

Every status above is computed live from raw stored facts against a threshold — never sticky. A scheduler that was Critical returns to Healthy the moment the next scheduled sweep actually succeeds; a backup that failed returns to Healthy the moment the next backup succeeds; a dead-letter event that gets retried and completes clears the Critical Outbox/Accounting status the moment `/admin/operations` is next loaded (no manual "clear alert" action exists or is needed).
