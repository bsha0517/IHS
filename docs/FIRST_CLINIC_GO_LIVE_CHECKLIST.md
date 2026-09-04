# First Clinic Go-Live Checklist

Operator-facing checklist for taking Avant HIS live for one real clinic. Written for whoever
actually performs the go-live (a technical administrator, not necessarily the original
engineering team) — every item names the concrete action, not just the goal.

Cross-references: `docs/RELEASE_RUNBOOK.md` (the release/deploy mechanics), `docs/DEPLOYMENT.md`
(environment setup), `docs/CLINIC_ONBOARDING.md` (the in-app onboarding workflow),
`docs/COMMERCIAL_READINESS.md` (what this product does and doesn't claim),
`P4_9_COMMERCIAL_READINESS_ACCEPTANCE_REPORT.md` (the evidence behind this checklist).

---

## Infrastructure

- [ ] Vercel project created (or reused), linked to the `main` branch of the GitHub repo.
- [ ] Supabase project created (or reused) — dedicated to this clinic, not shared with another
      tenant's database.
- [ ] Confirm Vercel plan supports the scheduler cadence you need (see **Scheduler** below —
      Hobby only allows daily cron; sub-daily needs Pro+).
- [ ] Domain: either the default `*.vercel.app` domain, or a custom domain with DNS pointed at
      Vercel and HTTPS auto-provisioned. Confirm the site loads over `https://` before go-live.

## Environment Variables

Set in Vercel's Project → Settings → Environment Variables (Production). See `.env.example` for
the authoritative list and `docs/DEPLOYMENT.md`'s "Environment Variables" section for the exact
Supabase connection-string format (Supavisor pooler, transaction mode, port 6543 — **not** the
direct/session-mode port 5432 for the runtime connection).

- [ ] `DATABASE_URL` — Supabase pooled connection, restricted runtime role.
- [ ] `DIRECT_DATABASE_URL` — Supabase direct connection, owner role (migrations only).
- [ ] `SESSION_SECRET` (or equivalent auth secret) — unique to this deployment, not reused from
      another project.
- [ ] `CRON_SECRET` — matches what `vercel.json`'s cron entry sends.
- [ ] `RELEASE_VERSION` — optional; if unset, `getReleaseVersion()` falls back to the deployed
      commit SHA, which is fine for most cases.
- [ ] Email provider variables, if self-service password reset is required at launch (see
      **Email** below).
- [ ] External error monitor DSN (e.g. Sentry), if configured (see **Monitoring** below).
- [ ] Confirm no `TEST_DATABASE_URL`/`TEST_DIRECT_DATABASE_URL`/`LOAD_TEST_*` variables are set in
      the production environment — they should not exist there at all.

## Database

- [ ] Supabase project's restricted runtime role created with the exact grants in
      `prisma/db-setup/` (full CRUD everywhere except `UPDATE`/`DELETE` on `audit_log` and
      `clinical_access_log`).
- [ ] Run `npx prisma migrate deploy` against `DIRECT_DATABASE_URL` — never `migrate dev` against
      this database, ever.
- [ ] `npx prisma migrate status` shows "up to date" immediately after.
- [ ] **Row Level Security**: run `npm run db:security:apply` (source-controlled — see
      `DATABASE.md`'s "Row Level Security" section and `prisma/db-setup/apply-rls.sql`; this is no
      longer a manual per-table procedure), then `npm run db:security:check` to confirm every table
      is protected. Optionally cross-check with Supabase's own advisor (`get_advisors`, type
      `security`) that no tables remain flagged.
- [ ] Run the production seed (`npm run db:seed` with `NODE_ENV=production` and, ideally,
      `SUPER_ADMIN_BOOTSTRAP_PASSWORD` set from your own secret manager rather than letting the
      script generate and print one). Capture the bootstrap credential immediately — it is shown
      exactly once.

## Backup — REQUIRED BEFORE GO-LIVE

This entire section is a required prerequisite, not a recommendation — see
`docs/COMMERCIAL_READINESS.md`'s "Required Before The First Real Clinic Go-Live" and
`P4_9_1_COMMERCIAL_READINESS_CORRECTIONS_REPORT.md` for why: as of P4.9/P4.9.1, the actual
`prisma migrate deploy` command has never been executed end-to-end against a real hosted database
(only against local Postgres) — this rehearsal is where that gets proven, not skipped.

- [ ] Confirm Supabase's own backup/PITR settings for this project (plan-dependent) are enabled.
- [ ] Perform one real backup using this project's own tooling (`scripts/db/backup.ts` against a
      Supabase-shaped connection, or Supabase's dashboard/CLI backup for the hosted copy) and
      confirm the artifact exists.
- [ ] Restore that backup into an isolated Supabase branch/project — never the live clinic
      database.
- [ ] Against that isolated restore target, run the real `npx prisma migrate deploy` (and
      `npx prisma migrate status`) — the first genuine end-to-end proof of this exact production
      command against a hosted database.
- [ ] Run `npm run db:security:apply` then `npm run db:security:check` against the same restored
      target and confirm clean.
- [ ] Confirm the runtime role can connect and perform normal DML against the restored target.
- [ ] Re-run the reconciliation checks (no unbalanced journals, no overpaid invoices, no negative
      stock) against the restored data.
- [ ] Know your restore procedure before you need it against the real clinic database —
      `docs/BACKUP_DISASTER_RECOVERY.md`.

## Monitoring — REQUIRED BEFORE GO-LIVE

- [ ] Configure an external error monitor (Sentry or equivalent) and verify one safe test error
      reaches it — confirm the payload carries no clinical note text, diagnoses, prescription
      content, national ID, payment details, passwords, or session tokens (IDs/correlation
      metadata only).
- [ ] Bookmark `/admin/operations` and know what "normal" looks like for this clinic's data before
      day one (a fresh clinic's operations dashboard will look emptier than a demo/seeded one —
      that's expected, not a fault).

## Scheduler

- [ ] Confirm `vercel.json`'s cron schedule matches your Vercel plan (`0 0 * * *` — once daily —
      on Hobby; every 5 minutes on Pro+). A schedule the plan doesn't support fails the entire
      deployment, not just the cron job.
- [ ] If running on Hobby with daily-only cron, understand the operational implication: stuck
      outbox events or failed background jobs may sit up to 24h before the scheduled sweep
      retries them. Acceptable for a small pilot clinic; upgrade to Pro+ before higher volume.

## Email

- [ ] Decide whether self-service password reset is required for this clinic at launch.
- [ ] If yes: configure a real transactional email provider and send one real test reset email
      before go-live. Password reset "works in code" is not the same claim as "email is
      configured and delivering" — confirm the latter, not just the former.
- [ ] If no (an administrator resets passwords manually for now): document that operational
      procedure for the clinic's Release Owner/administrator.

## Organization Setup

- [ ] Organization identity (`/admin/settings`): legal name, display name, currency, timezone.
- [ ] At least one active Branch.
- [ ] Departments/Rooms if the clinic's workflow needs them.

## Branch Setup

- [ ] Confirm every user's `UserBranchAccess` matches the branches they should actually reach —
      spot-check one Reception and one clinical user.

## Users / Roles

- [ ] Change the Super Admin bootstrap password (captured above) to a real, unique credential —
      do this before any other setup.
- [ ] Create the clinic's real administrator account(s); do not hand out the bootstrap Super Admin
      credential as an ongoing login.
- [ ] Create one user per operational role actually needed at launch: Reception, Doctor, Nurse,
      Lab, Radiology (if used), Pharmacist (if used), Cashier, Inventory/Procurement, Accountant,
      HR. Don't create roles nobody will use yet.

## Providers

- [ ] Create every clinician who will see patients, with correct branch/department assignment and
      a real default appointment duration.
- [ ] Set provider schedules/availability if online or reception booking needs to compute real
      slots.

## Services

- [ ] Create the clinic's actual billable service catalog (consultation types, procedures) with
      real prices and durations — this drives both booking and billing.

## Accounting

- [ ] Chart of Accounts reviewed/customized for the clinic's jurisdiction if needed.
- [ ] Account Mappings configured: Accounts Receivable, Revenue, at least one tender/cash account.
      Inventory Asset + COGS mappings too if Pharmacy or Inventory sale-of-goods is in use.
- [ ] Tax rules configured if applicable.

## Inventory / Pharmacy

- [ ] If Pharmacy is enabled: Medications created/mapped, at least one Supplier, initial Product
      Batches (via Opening Inventory import or manual receiving) with real expiry dates.
- [ ] If Opening Inventory was imported: post the corresponding Manual Journal so the Balance
      Sheet reflects it — the import itself does not do this automatically (see
      `docs/CLINIC_ONBOARDING.md`'s Opening Inventory Reconciliation section, and the known
      backlog item about this not yet being surfaced in-app).

## Initial Data Import

- [ ] If migrating from an existing system: import Suppliers, Products/Medications, Services,
      then Patients, in that order (later imports may reference earlier ones).
- [ ] For any import over a few hundred rows, review the ImportJob summary counts (imported /
      skipped / invalid / duplicate) before considering the import "done" — don't just check that
      it "completed."

## UAT — REQUIRED BEFORE GO-LIVE

- [ ] Run the full synthetic first-clinic workflow once, end to end, with the clinic's own newly
      created users (not just Super Admin): Patient → Appointment → Check-in → Encounter →
      Vitals → Note → Diagnosis → Lab/Imaging Order → Result → Prescription → Dispense → Charge →
      Invoice → Payment → Journal → Patient Timeline → Reports.
- [ ] Have each named role actually log in as themselves and confirm their landing page and
      navigation look right (not just Super Admin clicking through everything).
- [ ] Complete `docs/CLINIC_UAT_SIGNOFF_TEMPLATE.md`, signed by the clinic administrator and the
      Release Owner, and keep it on file — the final Go-Live checkbox below must not be checked
      without this.

## Release

- [ ] `npm run release:check` passes locally against the exact commit being deployed.
- [ ] Follow `docs/RELEASE_RUNBOOK.md`'s Default Release Sequence for the actual deploy.

## Go-Live

Before checking the final box, confirm every one of these three is actually done, not merely
planned — they are required, not recommended (see `docs/COMMERCIAL_READINESS.md`):

- [ ] **A. Backup section above is fully complete**, including the isolated restore + real
      `prisma migrate deploy` rehearsal.
- [ ] **B. Monitoring section above is fully complete** — external error monitor configured and
      test-verified.
- [ ] **C. UAT section above is fully complete** — clinic-specific sign-off on file.

Then:

- [ ] Confirm the deployed release's `/api/health` returns `status: "healthy"`,
      `database: "reachable"`, and a `version` matching the commit you just shipped.
- [ ] Log in as one real (non-Super-Admin) user and confirm the dashboard renders with the
      clinic's own (not demo) data.
- [ ] Announce go-live to the clinic's staff with the support contact from **First-Week
      Monitoring** below.

## Post-Go-Live Monitoring

See `docs/COMMERCIAL_READINESS.md`'s First-Week Monitoring Plan for the specific daily checks
(errors, login failures, outbox, scheduler, accounting exceptions, stock anomalies, backup
success) and who owns them.
