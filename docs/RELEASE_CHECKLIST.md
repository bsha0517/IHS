# Release Checklist

P4.8 §28, §52, §73-76 — the pre-deploy/deployment/post-release checklist for every Avant HIS release. Pair with [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) for the actual commands each step below runs, and [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md) for the reasoning behind the database-specific steps.

## Release Risk Levels

Classify every release before starting — this determines how much of the checklist below is required.

| Level | Definition | Examples |
|---|---|---|
| **LOW** | UI-only, no schema change, no critical domain behavior touched | A copy fix, a CSS/layout change, a non-breaking UI component swap |
| **MEDIUM** | Backwards-compatible business change and/or an additive migration | A new report, a new nullable column/table, a new optional feature behind existing permissions |
| **HIGH** | Financial/clinical/inventory migration, a data backfill, a destructive schema change, a secret rotation, an infrastructure change | Anything touching `Invoice`/`Payment`/`Journal`/`StockLedgerEntry`/`Encounter`/`Diagnosis`/`Prescription`/`ClinicalOrder` schema, any Destructive migration (see DATABASE_MIGRATION_SAFETY.md), any auth-secret rotation |

**HIGH-risk releases require, in addition to everything below**: a validated pre-release backup (not just "verify the managed backup is healthy" — an independent `npm run db:backup`), a production-like rehearsal (`npm run db:upgrade:drill`, or a real staging deployment where one exists), an explicit migration plan document (this release's own notes file, see [RELEASE_TEMPLATE.md](releases/RELEASE_TEMPLATE.md)), an explicit rollback/recovery plan, targeted post-release reconciliation (Financial/Clinical sections below), and a named Release Owner (see below) who does not close the release until every one of these is confirmed.

## Release Owner

Every production release has a human owner — not a database feature, not automated. The Release Owner personally confirms:

- [ ] Release gates are green (`npm run release:check`)
- [ ] Backup is verified (per this release's risk level)
- [ ] The migration plan (if any) is understood — not just "the migration exists," but what it does and why it's safe
- [ ] Deployment completed
- [ ] Post-deploy smoke passed
- [ ] The release is formally closed (this checklist fully worked through, release notes published)

## Change Assessment

- [ ] Release version decided (`docs/RELEASE_VERSIONING.md`)
- [ ] Risk level classified (above)
- [ ] Schema change? If yes: classified per [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md) (Additive / Transitional / Destructive)
- [ ] Data migration/backfill? If yes: reviewed against Data Migration Strategy in the same doc
- [ ] New/changed environment variable? If yes: classified (required/optional/secret) — see that doc's Environment Variable Changes section
- [ ] Breaking change (schema, API/route, export, import template)? If yes: called out explicitly in this release's own notes
- [ ] Backup required this release? (see Release Risk Levels above)
- [ ] Maintenance window required? (only for a release whose migration/locking behavior genuinely needs one — most releases need none)

## Pre-Release

- [ ] CI green on the release commit (`.github/workflows/ci.yml`)
- [ ] `npm run release:check` green, run locally against this exact commit
- [ ] Migration reviewed by hand (the actual SQL, not just "Prisma generated it") if this release includes one
- [ ] Staging/rehearsal run where required by risk level (`npm run db:upgrade:drill` at minimum; a real staging deployment for HIGH-risk)
- [ ] Backup confirmed per Release Risk Levels above
- [ ] Target environment's variables confirmed present **before** deploying code that requires them (see Environment Variable Changes)
- [ ] Release notes drafted (`docs/releases/YYYY-MM-DD-vX.Y.Z.md`, from [RELEASE_TEMPLATE.md](releases/RELEASE_TEMPLATE.md))

## Deployment

- [ ] Apply the migration (`prisma migrate deploy` against `DIRECT_DATABASE_URL`) — its own explicit step, before the application deploy, never hidden inside app startup
- [ ] Verify the migration succeeded (`prisma migrate status` reports up to date)
- [ ] Deploy the application build (`npm run build` artifact — never an unvalidated dev build)
- [ ] `/api/health` returns `200`/`healthy`
- [ ] Run smoke tests (see Post-Deploy Smoke below)

## Post-Release

- [ ] Errors/logs reviewed (structured logger output, grep for `"level":"error"` since the deploy timestamp)
- [ ] Operational dashboard reviewed (`/admin/operations` — backup/outbox job heartbeats)
- [ ] Outbox state inspected (`/admin/system-events`) — pending/failed/dead-letter counts look normal for this organization's usual volume
- [ ] Accounting exceptions reviewed (`/accounting` exceptions view, if this release touched billing/accounting)
- [ ] Scheduler heartbeat confirmed active (the outbox-sweep cron's last-success timestamp is recent, per its own configured cadence)
- [ ] Critical workflows spot-checked (see Post-Deploy Smoke below)
- [ ] For a HIGH-risk release: targeted reconciliation run (Financial/Clinical Reconciliation sections below)
- [ ] Release closed — release notes finalized, Release Owner confirms every box above

## Post-Deploy Health

Use the existing operational tools — nothing new was built here beyond what P4.1/P4.4 already provide:

- `GET /api/health` — `200`, `{"status":"healthy","database":"reachable",...}`
- A representative critical route loads with a real session (see Post-Deploy Smoke)
- Database reachable (implied by `/api/health`)
- Outbox state (`/admin/system-events`)
- Scheduler heartbeat (`/admin/operations` — the `operational_job_state` heartbeat table `outbox.ts`/`backup.ts` both write to)
- Accounting exceptions (`/accounting`, if relevant to this release)
- Dead-letter state (`/admin/system-events`)

## Post-Deploy Smoke

At minimum, safe **read-only** checks — no destructive transactions needed for a routine release:

1. Staff login succeeds
2. Dashboard renders
3. Reception renders
4. Patient search finds a real record
5. Patient 360 opens
6. Doctor queue/an encounter opens
7. Pharmacy renders
8. POS renders
9. Reports renders

`npm run test:e2e` (the Playwright suite from P4.7A/P4.7A.1) already exercises every one of these routes plus several real interactions (login, patient search, tab-switching, POS register states, Reports category switching) against a running server — run it against the release candidate build (or staging) as the release-smoke step; see [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) for exactly how. For a MAJOR/HIGH-risk release, additionally run the full real workflow (register → book → check in → encounter → dispense → invoice → payment) staging-side before production, the same walkthrough P4.7A.1's own verification used.

## Reconciliation After High-Risk Changes

Not run after every release — risk-based, per the table above.

### Financial Reconciliation (billing/payments/refunds/accounting/inventory changes)

- Every journal balances (debit == credit) for the affected period
- A representative invoice's `paidAmount` matches its `payment_allocation` sum
- Stock ledger reconciles (opening + receipts ± adjustments − consumption = closing) for a representative product/branch
- No negative stock balances

The same checks `scripts/db/upgrade-drill.ts` already runs automatically during migration rehearsal — reuse them post-release too (ad hoc, via `psql`/Prisma Studio, or by pointing the drill's reconciliation queries at the real post-release data) rather than inventing a new set.

### Clinical Reconciliation (encounter/diagnosis/prescription/order/lab/radiology changes)

- A representative Encounter still has its expected relationships intact (Patient, Provider, Diagnoses, Orders, Prescriptions)
- A finalized clinical note is still read-only and still shows its correct locked content (never altered by the validation itself — read-only checks only)
- A representative Lab/Radiology order's status and result data are intact

Do not alter finalized records during this validation — every check here is read-only.

## Backlog Discoveries During a Release

An unrelated issue noticed while working a release goes to `BACKLOG.md` — do not turn a release into another audit. The only exception: fix immediately, regardless of relatedness, if there is immediate risk of patient-data corruption, clinical-record corruption, a security/privacy breach, financial corruption, inventory corruption, or destructive database behavior.
