# Backup, Restore & Disaster Recovery

Written in P4.2 (Database Reliability / Backup / Restore / Disaster Recovery). The central principle behind everything here: **a backup that has never been restored is not yet a proven backup.** Every mechanism described below has been exercised for real, locally — see the drill evidence in [P4_2_DATABASE_RELIABILITY_BACKUP_RESTORE_DISASTER_RECOVERY_REPORT.md](../P4_2_DATABASE_RELIABILITY_BACKUP_RESTORE_DISASTER_RECOVERY_REPORT.md)'s Drill Report — not just described.

## Objectives

Prove that clinic data — clinical, financial, inventory, HR, and audit — can be backed up, restored, verified, and recovered after a realistic database failure or deployment accident, without weakening any existing security control (the restricted runtime DB role, audit-log immutability, organization/branch isolation) in the process.

## RPO / RTO

**Recovery Point Objective (how much recent data loss is acceptable):**

| Tier | Target | Basis |
|---|---|---|
| Initial commercial (V1) | **≤ 15 minutes**, contingent on enabling Supabase PITR (Point-in-Time Recovery) | PITR is a paid-tier Supabase capability — this target is only real once it's actually configured on the production project (see "Managed Backups / PITR" below). Without PITR, the RPO degrades to "since the last daily managed backup" (up to ~24h) — document whichever is actually active, never claim 15 minutes if PITR isn't turned on. |
| Later / enterprise | Sub-5-minute, or continuous replication | Requires a higher Supabase tier and/or a streaming-replication architecture — not needed for an initial commercial deployment at the scale P4 targets (200+ staff, single/multi-branch). |

**Recovery Time Objective (how quickly service is restored):**

| Tier | Target |
|---|---|
| Initial commercial (V1) | Critical DB incident: restore and verify within a few hours (not a legal SLA — an internal operational target). A logical restore of a database this size (see the drill's real ~450KB dump — trivial today, but this number will grow with real production data and the RTO should be revisited as it does) takes minutes; the bulk of the RTO budget is verification (post-restore checklist below) and decision-making (which restore point, whether to fail over), not the restore command itself. |
| Later / enterprise | Under an hour, with a documented, rehearsed runbook and a designated on-call owner. |

## Data Criticality

**Tier 1 — critical, must recover** (drawn from the actual Prisma schema, not invented): `Patient` and its clinical satellites (`Encounter`, `VitalSign`, `Diagnosis`, `Prescription`, `ClinicalOrder`, lab/imaging results), `Episode`, `Appointment`, `Charge`, `Invoice`/`InvoiceLine`, `Payment`/`PaymentAllocation`, `Refund`, `Journal`/`JournalLine` (accounting), `StockLedgerEntry`/`ProductBatch` (inventory), procurement records (`PurchaseOrder`, `GoodsReceipt`, `SupplierInvoice`, `SupplierPayment`), `PayrollRun` history, `AuditLog`, `ClinicalAccessLog`.

**Tier 2 — operational**: `Notification`, `Lead`, communications metadata, `UserBranchAccess`/session state, `NumberSequence`.

Both tiers live in the same PostgreSQL database and are recovered together by the mechanism below — there is no separate backup path per tier. The distinction matters for prioritizing *verification* effort after a restore (Tier 1 gets the reconciliation checks in the Post-Restore Checklist; Tier 2 is covered by the same restore but isn't independently reconciled).

## Backup Layers

Layered, not single-provider-dependent (§8's "an independent logical backup should not share one failure domain with production"):

- **Layer A — Managed PostgreSQL backups**: Supabase's own provider-managed scheduled backups (daily on paid tiers).
- **Layer B — Point-in-Time Recovery**: Supabase PITR, where the project's tier and configuration support it — see "Managed Backups / PITR" below for what's actually confirmed vs. still a requirement to configure.
- **Layer C — Independent logical backup**: `pg_dump` (custom format), run and stored independently of the Supabase project itself — see "Independent Logical Backup" below.
- **Layer D — Pre-deployment backup**: a backup taken immediately before a risky production migration/deployment — see "Pre-Deployment Backup Procedure" below.

## Managed Backups / PITR

**Confirmed, real production capability (not yet exercised in this session):** Supabase provides daily automated backups on paid tiers, with Point-in-Time Recovery as a Pro-tier-and-above add-on (retention window depends on the specific plan). This is the **primary** recovery mechanism for a real production incident — it's provider-managed, requires no custom tooling, and (with PITR enabled) supports the ≤15-minute RPO target above.

**What this phase adds on top, and why it's still needed even with PITR available:** an *independent* logical backup (Layer C) that doesn't depend on the Supabase project remaining intact or accessible at all — see §8's "independent backup principle." PITR protects against "I need an earlier point in this same project"; the logical backup protects against "this Supabase project itself is unavailable, deleted, or its billing lapsed."

**Explicitly not claimed**: Supabase PITR has **not** been exercised in this project — no PITR restore has been performed against any Supabase project, staging or production. What *was* tested for real is the local logical backup/restore mechanism below. Do not read anything in this document as evidence PITR itself has been validated; it is a documented **provider capability and production requirement**, not yet a proven procedure for this project. Configuring and drilling PITR against a real staging Supabase project is a concrete item in the Remaining Reliability Backlog.

## Independent Logical Backup

**Mechanism**: [`scripts/db/backup.ts`](../scripts/db/backup.ts) (`npm run db:backup`) — a `pg_dump` wrapper, custom format (`-Fc`, supports selective/flexible `pg_restore`), run against the **direct/owner connection only** (never the transaction pooler — `assertNotPooledConnection` refuses a pooled connection string before any dump is attempted; see §9's own reasoning: Supavisor's transaction-mode pooler doesn't support the session-level guarantees `pg_dump` needs).

- **Output**: a timestamped `<label>_<ISO-timestamp>.dump` file plus a `<file>.meta.json` sidecar recording timestamp, database identifier, PostgreSQL version, migration count, filename, and size — **never a credential or connection string**.
- **Portability**: dumped with `--no-owner --no-acl` (§28) — the dump doesn't hardcode role names, since a restore target's role names may legitimately differ from the source's (e.g. a future environment using a different runtime-role name). Grants are reapplied explicitly after restore instead (see "Runtime Role / Grants After Restore" below), reusing the existing grant script rather than trusting a role-name match baked into the dump.
- **Execution environment**: the real target is `pg_dump` installed directly on whatever host performs the backup (a small scheduled job, a CI runner, an ops workstation). Set `DOCKER_EXEC_CONTAINER` (e.g. `avant_his_postgres`) to instead run the identical `pg_dump` binary via `docker exec` — used for local development and for the drill in this session, where the Postgres client tools live inside the docker-compose container rather than on the host. Same tool, same output format, different process boundary only.
- **Never in git**: `/backups/`, `*.dump`, `*.dump.meta.json` are gitignored.
- **Production destination (not yet wired up, correctly out of scope for P4.2 per §8)**: local/CI disk is sufficient for the drill; a real production backup should land somewhere independent of the Supabase project itself (S3, R2, Azure Blob, or equivalent) — a concrete Remaining Reliability Backlog item, not built this phase since §8 explicitly says not to wire a cloud storage provider "unless needed for this phase."

## Backup Security

Production backups contain patient, clinical, financial, and HR/payroll data — treated as sensitive as the live database itself:

- **Encryption at rest**: required for any persisted backup destination (a cloud object store with server-side encryption, or an encrypted volume) — not yet configured since no cloud destination is wired up yet (see above).
- **Encryption in transit**: `pg_dump`/`pg_restore` connections use the same TLS the application's own `DATABASE_URL`/`DIRECT_DATABASE_URL` already require against Supabase.
- **Restricted access**: backup files and their storage location must be accessible only to infrastructure/ops roles — never to application-level Organization Admins (see "Backup Access Control" below).
- **Credentials**: `pg_dump`/`pg_restore` read the database password via the `PGPASSWORD` environment variable only — never placed on the command line (so it never appears in process listings or shell history) and never printed to any log or metadata file.
- **Retention/deletion**: see Retention Policy below; deleting an old backup is a routine retention action, not an incident.
- **No homemade cryptography**: if/when backup files are encrypted at rest, use the storage provider's own server-side encryption (S3/R2/Azure Blob native encryption) — never a custom encryption scheme.
- **Local test backups**: filesystem protection (the gitignore rules above, and the local machine's own OS permissions) is acceptable for drill/dev backups — they contain only synthetic drill fixture data, never real patient data.

## Retention Policy

Practical V1 recommendation (not a complicated retention engine — none is built, per §12):

| Category | Retention |
|---|---|
| PITR window (once configured) | Per Supabase plan (commonly 7 days on entry Pro tiers, longer on higher tiers) |
| Daily managed backups | Per Supabase plan default |
| Independent logical backup — daily | 14 days |
| Independent logical backup — weekly | 8 weeks |
| Independent logical backup — monthly | 12 months |
| Pre-deployment backup | Until the next successful deployment is confirmed stable (minimum 7 days) |

Enforced manually/by a simple scheduled cleanup once a real backup destination exists — no retention automation was built this phase (§12: "do not implement a complicated retention engine unless one already exists").

## Backup Automation

`npm run db:backup` is a script today, not yet an automatically scheduled job — scheduling it (e.g. a nightly CI/ops job calling it against production, landing output at the independent destination above) is a Remaining Reliability Backlog item, tracked separately from Supabase's own already-automatic managed backups. §41's future monitoring requirement (a failed scheduled backup must never fail silently) applies once this is scheduled — not built this phase, per §41's own "P4.4 will handle broader observability."

## Restore Architecture

**Mechanism**: [`scripts/db/restore.ts`](../scripts/db/restore.ts) (`npm run db:restore`) — drops and recreates the target database clean, `pg_restore`s the given `.dump` file into it (`--no-owner --no-acl`, matching the backup's own flags), then reapplies the restricted runtime role's table grants by reusing the existing [`prisma/db-setup/local-grant-runtime-role.sql`](../prisma/db-setup/local-grant-runtime-role.sql) — the same script local dev/test setup already uses, not a second copy of the same GRANT/REVOKE logic (§27).

## Restore Safety Guards

**This is the most important safety property in this document.** A restore is destructive to whatever database it targets — `assertIsSafeRestoreTarget` ([`scripts/db/lib.ts`](../scripts/db/lib.ts)) refuses to run against anything whose name doesn't match `his_restore_test` (optionally suffixed), and explicitly, unconditionally blocks `his_dev`, `his_test`, `postgres`, and any name containing "prod" — **regardless of any other check**. There is **no override flag, no environment variable, no force switch**. `test/integration/p4-2-backup-restore-safety.test.ts` proves this directly, including that a plausible-looking override env var does nothing.

A real incident restore into production or staging is a deliberate, out-of-band procedure a human runs by hand, following the Disaster Recovery Scenarios below — never this automated guard's job to permit.

## Actual Backup / Restore Drill

Performed for real, locally, in this session — not simulated, not mocked. Full results, exact figures, and the reconciliation evidence are in [P4_2_DATABASE_RELIABILITY_BACKUP_RESTORE_DISASTER_RECOVERY_REPORT.md](../P4_2_DATABASE_RELIABILITY_BACKUP_RESTORE_DISASTER_RECOVERY_REPORT.md)'s Drill Report section. Summary: an isolated `his_dr_drill` database was created, migrated, and seeded; a relationally-connected fixture (patient, appointment, encounter, invoice, partial payment, inventory receipt + adjustment, 3 balanced accounting journals, audit log rows) was built through this codebase's own real domain functions (the same ones the integration test suite calls); a real `pg_dump` backup was taken; the data was then genuinely destroyed (a stock ledger row deleted, a clinical access log row deleted via elevated access — proving the runtime role structurally cannot do this itself — and a patient's name corrupted); a real `pg_restore` recovered it into an isolated `his_restore_test_p42drill` database; every count, every specific fixture ID, the patient's financial balance, the inventory closing balance, and every journal's debit/credit balance matched the pre-destruction baseline exactly; the restricted runtime role's grants were confirmed re-established (a direct attempt to `UPDATE audit_log` through that role was rejected); and the actual production application was booted against the restored database and its dashboard, patient list, and receivables page all rendered the correctly-restored (not corrupted) data.

## Runtime Role / Grants After Restore

`pg_dump --no-owner --no-acl` means a freshly restored database has **no table-level grants for the restricted runtime role at all** until `restore.ts`'s grant-reapplication step runs. This was not a theoretical concern this phase — it was empirically verified in the real drill: immediately after restore, a raw `UPDATE audit_log` issued through the restricted role's own connection was rejected (`permission denied for table audit_log`), the exact guarantee P0-06 established, confirmed intact after a real restore, not merely re-run from the original setup.

**Ownership/ACL decision (§28)**: `--no-owner --no-acl` was chosen deliberately over including ownership/ACL statements in the dump, because a restore target's role names are not guaranteed to match the source's — reapplying grants explicitly via the existing, already-correct grant script is both more portable and avoids maintaining ownership semantics inside the dump file itself.

## Restore Verification

Every restore (drill or real) should confirm, in order:

1. `npx prisma migrate status` (via the actual Prisma CLI, pointed at the restored database's direct connection) reports the schema up to date — **never** `prisma migrate dev` against a restored database (§20).
2. Required PostgreSQL extensions are present (`btree_gist`, confirmed as this schema's one non-default requirement — used for an appointment-overlap exclusion constraint; ships with `postgres:16-alpine`'s contrib modules, confirmed present after restore in the real drill).
3. Row counts for every Tier-1 table match the pre-restore baseline exactly.
4. Specific fixture/record IDs are individually confirmed present.
5. Patient financial reconciliation (Charges → Invoice → Payment → outstanding balance) matches baseline — not just "the row exists," the actual balance.
6. Inventory reconciliation (opening + receipts ± adjustments − consumption = closing, compared against the summed Stock Ledger) matches baseline.
7. Accounting reconciliation: every restored Journal still balances (`SUM(debit) = SUM(credit)`), matching baseline sums exactly.
8. Audit Log rows survived, and the restricted runtime role is confirmed still unable to `UPDATE`/`DELETE` them.
9. `NumberSequence` rows survived; one throwaway UUID-keyed insert (cleaned up immediately) confirms no primary-key collision. (See "Sequences / Identity" below for why this project's schema makes native Postgres sequence collisions a non-issue.)
10. If practical, the real application boots against the restored database (through the restricted runtime role) and at minimum `/api/health`, login, one patient page, and one financial page all work correctly.

## Sequences / Identity

Every primary key in this schema is a client-generated UUID (`@id @default(uuid())`) — there is **no native PostgreSQL `SERIAL`/`IDENTITY` column anywhere in the schema** (confirmed by inspection: no `autoincrement()` usage exists). Human-facing sequential numbers (invoice numbers, payment receipt numbers, journal numbers, MRNs, etc.) are generated by this codebase's own `NumberSequence` table via a concurrency-safe atomic `UPDATE ... RETURNING` (`src/lib/platform/sequences.ts`) — an application-level mechanism, not a database sequence object. This means the classic "restored database's sequence counter is behind, causing a collision on the next insert" failure mode that native Postgres `SERIAL` columns are vulnerable to **does not apply to this schema at all**: UUID primary keys cannot collide by construction, and `NumberSequence`'s `currentValue` restores exactly like any other row. The drill still verified this directly: `number_sequence` rows were confirmed present post-restore, and one throwaway record was successfully inserted and cleaned up to prove no collision in practice, not just in theory.

## Outbox After Restore

A restored database may contain `OutboxEvent` rows whose status reflects the exact moment the backup was taken — `pending`, `processing` (crashed mid-flight), `completed`, or `dead_letter`. **Do not blindly replay everything** after a restore:

- `completed` events must never be re-dispatched — most consumers are idempotent (this codebase's own outbox architecture assumes retries are possible, and P3.13 fixed a real payment-journal idempotency gap on exactly this class of concern), but "assume idempotent" is not the same as "safe to deliberately replay in bulk," especially once real external side effects exist (below).
- `processing` events crossing the restore boundary should be treated the same way the existing crash-recovery mechanism already treats a stuck `processing` event — recoverable once the configured processing timeout elapses (`OUTBOX_PROCESSING_TIMEOUT_MS`), the same mechanism `test/integration/outbox-crash-recovery.test.ts` already proves, not a new post-restore-specific code path.
- `pending`/`failed` events are exactly what the normal sweep (`/api/cron/outbox-sweep`, or the manual "Sweep now" button) already exists to process — no special restore handling needed, run it after any restore precisely because it's already the right tool.
- Recommended immediate post-restore action: inspect `/admin/system-events` before assuming normal cron cadence will "catch up" silently, particularly after a production incident restore where the lost-write window (§33) needs to be understood before deciding whether to also resolve/dead-letter anything that references data that no longer exists post-restore.

## External Side Effects

Today's external integrations are limited (every SMS/WhatsApp/Email adapter is a `Null*Adapter` reporting `status: "failed"` rather than faking delivery — see P4.1's Communications section). This matters for disaster recovery specifically because **a database restore rewinds internal state while any real external system (once connected) stays ahead of it** — an email actually sent, an insurance claim actually submitted, a tax invoice actually filed cannot be un-sent by restoring the database. This is an important future DR consideration once real providers are connected (P4 does not build regulatory/external integration recovery now) — flagged here so it isn't forgotten when those integrations land.

## Disaster Recovery Scenarios

### Scenario A — Accidental destructive operation (e.g. important records removed unexpectedly)

1. Stop or restrict further writes if the destructive operation might still be running (e.g. a runaway script).
2. Determine the incident time as precisely as possible.
3. Choose the recovery path: PITR (if configured, closest RPO) or the most recent logical backup.
4. Restore to an **isolated** database first — never directly over production.
5. Verify using the Restore Verification checklist above.
6. Decide on cutover: promote the restored copy, or extract and reapply only the specific lost records if that's less disruptive than a full cutover.
7. Document the lost-write window (the gap between the incident and the restore point) for anyone who needs to know what may need manual re-entry.

**Never restore blindly over production immediately** — always verify in isolation first.

### Scenario B — Bad deployment / migration damages production

1. Stop the deployment immediately.
2. Preserve current DB state (do not compound the problem with further writes).
3. Determine whether the migration was additive/backward-compatible (per the Migration Policy below) — if so, the fastest fix may be rolling the *application* back to the previous build while leaving the DB schema as-is.
4. If the migration itself caused data damage (not just an incompatible app version), restore/PITR only when actually necessary, verified in isolation first as in Scenario A.
5. Redeploy the known-good application build.
6. **Never** run `prisma migrate reset` in production, ever, under any circumstance — it drops and recreates the entire schema.

### Scenario C — Managed database temporarily unavailable

1. `/api/health` correctly reports `unhealthy` — this is the intended, honest behavior, not a bug to work around.
2. Avoid destructive retries or manual intervention that assumes the outage is permanent.
3. Monitor the provider's own status.
4. Once connectivity recovers, verify `/api/health` returns to `healthy`, then specifically inspect Outbox state (`/admin/system-events`) — an outage during in-flight writes is exactly the crash-recovery scenario the existing `processing`-timeout mechanism already handles, but it's worth confirming directly rather than assuming.

No automatic multi-region failover exists or is claimed — this is a manual recovery procedure for V1, matching what's actually configured today.

### Scenario D — Provider/region-level outage

For an initial V1 deployment, manual recovery is an acceptable target (not automatic failover, which isn't configured):

1. Retrieve the independent logical backup from its (future) off-Supabase-project storage location.
2. Provision a new PostgreSQL deployment (a new Supabase project, or an alternative provider if the outage is Supabase-wide and prolonged).
3. Restore the logical backup.
4. Reapply the runtime role and its grants (the same procedure this document already covers).
5. Update the application's `DATABASE_URL`/`DIRECT_DATABASE_URL` secrets to point at the new deployment.
6. Redeploy/restart the application.
7. Run the full Post-Restore Checklist before declaring recovery complete.

### Scenario E — Database credential compromise

1. Rotate the compromised credential immediately (a new password for the affected role).
2. Update the secret in the hosting platform's environment variable store.
3. Revoke/expire the old credential explicitly, don't just stop using it.
4. Verify the application reconnects successfully with the new credential.
5. Review audit logs and any available connection/access logs for what the compromised credential was used for during the exposure window.
6. If the compromised credential was the **owner/direct** role (not the restricted runtime role), treat severity as higher — that role has full DDL rights and could have altered schema, not just data.

Never log a replacement credential anywhere — the same "never log secrets" discipline this codebase already applies everywhere else (structured logger's own never-log list).

## Production Migration Recovery

### Migration Policy

- Prefer additive changes (new nullable columns, new tables) over changes that immediately break currently-deployed application code.
- Never ship a migration that drops or renames a column/table still read by the currently-deployed application version — this matters more with serverless/rolling deployments, where old and new application code can briefly run concurrently.
- Backfill data in a separate step from the schema change that introduces the need for it.
- Destructive cleanup (actually dropping an old column) happens in a later migration, once no deployed code reads it anymore.

### Never Modify Applied Migrations

Once a migration has been applied to any shared environment (staging or production), it is never edited — a mistake is corrected by a **new** migration, never by rewriting history. This preserves Prisma's own migration-history integrity and matches this project's existing migration workflow (`migrate diff` → hand-review → `migrate deploy`, documented in DEPLOYMENT.md).

### Failed `prisma migrate deploy`

1. Stop the deployment — do not proceed to deploy application code that expects a schema the migration failed to fully apply.
2. Inspect Prisma's migration state (`prisma migrate status`) to understand exactly what applied and what didn't.
3. Do not repeatedly rerun a failing migration blindly, and do not manually hand-edit the `_prisma_migrations` table as a routine practice — only use Prisma's own supported resolution commands (`migrate resolve`), and only when the specific situation genuinely justifies it.
4. If the failure actually damaged data (not just left the schema mid-migration), restore from backup/PITR following the scenarios above rather than trying to hand-repair it.

## Data Corruption Detection

Practical indicators worth watching for (not a generalized data-quality engine — none is built this phase, per §47):

- Trial Balance no longer balances for a period that was previously closed/verified.
- Stock Ledger reconciliation (opening + receipts ± adjustments − consumption ≠ closing) fails for a product/branch.
- An Invoice references payment allocations that don't sum to its `paidAmount`.
- A clinical record's expected parent relationship (Encounter without a valid Patient, etc.) is missing — should be structurally impossible given this schema's foreign keys, but worth naming as a signal if ever observed.
- A migration or constraint failure during a routine operation that previously worked.
- An unexpected row-count drop in a Tier-1 table between two points where nothing should have deleted data.

P4.4 (per the P4 roadmap) may later automate detection of some of these; this phase documents the indicators, not a monitoring platform.

## Post-Restore Checklist

Mandatory, in order, after any real restore:

- [ ] Database reachable (`/api/health` returns `healthy`)
- [ ] `prisma migrate status` reports the schema coherent and up to date
- [ ] Runtime role grants reapplied and verified (a direct `UPDATE`/`DELETE` against `audit_log`/`clinical_access_log` through the runtime role is rejected)
- [ ] Health endpoint healthy (redundant with the first item, kept as an explicit separate check since it's the actual production smoke-test step)
- [ ] Authentication works (a real login succeeds)
- [ ] The organization record(s) exist and look correct
- [ ] A representative patient record opens correctly
- [ ] A representative encounter opens correctly
- [ ] A representative invoice/payment opens correctly, with the correct balance
- [ ] Stock balance for a representative product is correct
- [ ] A representative journal is balanced
- [ ] Outbox state inspected (`/admin/system-events`) — understand what's pending/dead-lettered before assuming normal cadence will silently catch up
- [ ] The outbox sweep scheduler is confirmed active/re-enabled if it was paused during the incident
- [ ] Any configured email/SMS/other integration is confirmed reachable (once one is actually connected — none is as of P4.1/P4.2)

## Backup Access Control

Recommended separation of duties: performing a backup, performing a restore, configuring/triggering PITR, and rotating database credentials are **infrastructure-administration actions**, not Healthcare-Information-System actions. An Organization Admin role inside the HIS application (RBAC-scoped to their organization's clinical/financial data) should **not** automatically gain infrastructure backup/restore/credential-rotation access merely by virtue of that role — these actions belong to whoever holds the hosting platform (Vercel/Supabase) account access, a deliberately smaller and separately-managed set of people/service accounts.

## Auditability of DR Operations

Production backup/restore operations should generate infrastructure-level records (who initiated, when, backup identifier, restore target, success/failure) — the backup script's own `.meta.json` sidecar already captures backup-side facts (timestamp, size, migration count, status); a restore's own record should be kept the same way (or in whatever infrastructure/ops logging the hosting platform provides, e.g. Supabase's own project activity log). This is deliberately **not** the same table as the application's own `AuditLog`/`ClinicalAccessLog` (§40) — those exist for HIS-level clinical/financial accountability inside one organization's data; DR operations are infrastructure-level and operate on the whole database, a different concern entirely, kept in a different place.

## Backup Monitoring

Not built this phase (§41, correctly deferred to P4.4's broader observability work) — documented here as a **future requirement**, once backups are actually scheduled in production:

- Confirm each scheduled backup actually completed (not just "the job ran," but the `.meta.json`'s `status: "completed"` and a plausible size).
- Alert if a scheduled backup fails, or simply never runs.
- Track backup age — alert if the most recent successful backup is older than expected.
- Track the date of the last successful restore drill (see below) — a backup mechanism that hasn't been drill-tested recently is a real gap, not a false alarm.

## Restore Drill Frequency

Restore testing must be **recurring**, not a one-time P4.2 activity:

- **Monthly or quarterly** at minimum once in production, run `npm run db:dr:drill` (or an equivalent drill against a copy of real, appropriately-isolated data once volumes grow beyond what a synthetic fixture meaningfully exercises).
- Before any major infrastructure change (a Postgres version upgrade, a hosting platform migration, a significant schema change).
- After any change to the backup/restore scripts themselves, or to the runtime role's grant script.
- Track the date of the last drill (see Backup Monitoring above) so "we haven't actually tested this in months" is visible, not silent.

## Pre-Deployment Backup Procedure

Updates P4.1's deployment ordering ([docs/PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md)'s deployment steps) with an explicit, risk-based backup step:

1. Verify the latest managed backup/PITR is healthy (check the Supabase dashboard) — this is free and should happen before every deployment, not just risky ones.
2. For a **risky** release (a migration touching Tier-1 tables, a destructive-adjacent change, anything the deploying engineer isn't fully confident is safe), take an independent pre-deployment logical backup (`npm run db:backup` against production's direct connection) and record its identifier.
3. Run the migration (`prisma migrate deploy`).
4. Deploy the application.
5. Run the production smoke test (P4.1's own procedure, still current).
6. Retain the pre-deployment backup per the Retention Policy above (minimum 7 days, until the release is confirmed stable).

**Not every deployment needs its own dedicated backup** — a low-risk, additive-only change relying on Supabase's own PITR coverage is a reasonable, documented risk-based call; forcing a manual backup before every trivial deployment would make deployment unnecessarily expensive for no real safety gain (§43's own instruction).

## Responsibilities

| Action | Who |
|---|---|
| Routine managed backups | Automatic (Supabase) |
| PITR configuration | Infrastructure owner (one-time setup, reviewed periodically) |
| Independent logical backup — scheduling | Infrastructure owner |
| Restore drills | Infrastructure owner, on the schedule above |
| Production restore execution | Infrastructure owner only — never delegated to an in-app Organization Admin role |
| Credential rotation | Infrastructure owner |
| Backup/restore script maintenance | Whoever maintains the codebase (`scripts/db/*.ts`) |

## Limitations

Stated plainly, per §58's own instruction not to claim untested capability:

- **Supabase PITR has not been tested.** It is a real, recommended production capability — not yet exercised against any Supabase project in this project's history.
- **No production backup destination is wired up yet.** The independent logical backup mechanism is real and drill-tested locally; where a real production backup file actually lands (S3/R2/Azure Blob) is not yet decided or built.
- **No backup scheduling automation exists yet.** `npm run db:backup` is a real, working script; nothing calls it on a schedule in production yet.
- **No backup monitoring/alerting exists yet** — deferred to P4.4 per §41.
- **The restore drill used synthetic fixture data**, not a copy of real production-scale data — appropriate for proving the *mechanism* works correctly (which it does, exactly), but restore *duration* at real production data volumes has not been measured and should be revisited as the database grows.
- **Multi-tenant restore restores every organization at once** — see below.

## Multi-Tenant Restore Consideration

This architecture uses multiple organizations in one shared database (by design, preserved throughout P4 — see P4.1's Hosting Platform section). A full database restore therefore restores **every organization's data simultaneously** — there is no mechanism to restore one customer's data in isolation without affecting every other tenant sharing that database. For a single-incident, single-tenant data-loss scenario in a genuinely multi-tenant production deployment, a full restore may be the wrong tool entirely (it would roll back every other tenant's more-recent data too). **Tenant-level export/import tooling is a real future need once multiple paying customers share one production database — explicitly not built in P4.2.**
