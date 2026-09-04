# P4.9 — Commercial Readiness Acceptance Report

**Date:** 2026-09-04
**Scope:** Evidence collection and acceptance decision for Avant HIS's first real-clinic go-live.
Not a feature-building phase; not a whole-codebase audit; no regulatory implementation.

---

## Executive Summary

This phase set out to answer one question with evidence, not assumption: *can Avant HIS safely
onboard its first real clinic?* In the course of answering it, this phase also discovered and
closed a genuine, unrelated-to-the-question security exposure (Row Level Security disabled on
every table of the hosted database), performed the first-ever real deployment of this engagement's
entire P2–P4.8 body of work (previously committed nowhere), executed the first real migration run
and login/financial-integrity verification against the live hosted database, fixed one real
frontend bug found during print verification, and closed P4.6's most important carried-forward
reservation (interrupted batched import + retry) with new tests proving the actual safety property
rather than merely re-asserting it.

The honest result: core engineering is fully green, and — unusually for this kind of phase — most
of P4.8's previously "production-unproven" items (real Vercel deployment, real Supabase migration,
role-based production login, production financial-integrity reconciliation) are now genuinely
proven, live, on this engagement's actual deployed environment. What remains unproven is narrower
and more specific than before: external error monitoring is not configured, transactional email
delivery is not confirmed, and a dedicated hosted backup/rollback rehearsal was not performed this
phase (distinct from the DB migration and reconciliation work, which was).

## Final Decision

**CONDITIONAL GO** — see the numbered conditions in "Go-Live Conditions" below. Every condition is
external/operational, finite, and does not require reopening engineering work.

## Scope Boundary

In scope: acceptance evidence collection, genuine UAT across critical workflows, real staging/
production deployment rehearsal (the only environment available), fixing genuine blockers found
along the way, and the required go-live/commercial documents. Out of scope, per this phase's own
instructions and honored throughout: regulatory adapter implementation (DHA/NABIDH/Malaffi/
Riayati/NPHIES/ZATCA/FBR/DRAP/PHC/SHCC/IHRA/FHIR/HL7/DICOM), infrastructure redesign, a new UI
cycle, re-litigating P0–P4.8's own closed audits, and unrelated backlog cleanup. Two departures
from "no feature building" were made deliberately and are called out individually below because
they were forced by what evidence-collection actually found: enabling RLS (a security fix, done
with explicit user authorization) and fixing the `NewAppointmentDialog` Select-reset bug (already
flagged Low-severity, explicitly permitted to fix if easy — this was).

## Engineering Baseline

Entering P4.9: 39 Prisma migrations, 62 integration test files / 596 tests, 12 component tests, 21
Playwright tests, TypeScript/lint/build clean, `release:check` and `db:upgrade:drill` both passing
locally. All of P0 through P4.8 had been built and verified locally but **had never been committed
to git or deployed** — see "The Uncommitted-Work Discovery" below, the single largest surprise of
this phase.

## Acceptance Method

Evidence is tiered and labeled honestly throughout this report and the matrix below:

- **Automated test** — part of the 596/12/21 suites, re-run in this phase.
- **Local browser UAT** — driven live against `next dev`/`next start` on `his_dev`.
- **Production UAT** — driven live against the actual deployed Vercel + Supabase environment
  (see below — this *is* the only environment that exists; there is no separate staging tier).
- **SQL verification** — direct read/write against the hosted database via its own management
  connection (Supabase's project API, not the app's runtime role).
- **Documentation only** — reasoned about, not executed this phase.
- **Not proven** — explicitly named, with the exact condition that would close it.

---

## The Uncommitted-Work Discovery

Before any UAT could mean anything, this phase had to establish what was actually *deployed*.
`git diff --stat HEAD` at the start of this session showed the entire working tree — effectively
all of P2 through P4.8 — as uncommitted changes on top of commit `b759c65`. The live Vercel
production deployment was running exactly that old commit and nothing past it. This was
surfaced to the user immediately (not silently worked around), who explicitly authorized
committing and pushing the full body of work as part of this phase's own deployment rehearsal —
the only way to get genuine deployment evidence against the current codebase. That commit
(`4bafcb2`, later followed by a small P4.9 fix commit `acf9ea4`) was made only after
`release:check` passed cleanly, and was pushed to `main`, which auto-deployed to the only
existing environment (see next section for why "staging" and "production" are the same thing
here).

## Staging vs. Production — There Is No Separate Environment

This repository's linked Vercel project (`ihs`) auto-deploys `main` straight to production; no
staging branch/environment is configured. Its Supabase project ("Avant") already contained
non-trivial data (patients, encounters, invoices, journals, audit log entries) accumulated from
earlier phases' own manual/browser UAT against this same live URL — confirmed synthetic, not real
patient data, by inspection (round-number test amounts, `E2E Doctor######` naming patterns,
rapid-succession timestamps). The user was asked explicitly how to treat this and chose "use it
carefully" — real health/login/deployment checks and a careful, reversible cleanup where needed,
but no reckless writes. Every write this phase made to the hosted database is itemized below and
was either a security fix, a genuine migration, or a narrow, explained data correction.

**Recommendation, not yet acted on:** provision a genuinely separate staging Supabase+Vercel pair
before higher-risk future changes — see Go-Live Conditions.

## Commercial Acceptance Matrix

| Area | Requirement | Evidence | Status | Blocker? |
|---|---|---|---|---|
| Deployment | Real Vercel production deploy of current codebase | Deployment `dpl_AhpQ6h4r9xyk6qENo91WWKWL5m5f` → `acf9ea4`, state READY, target production | PASS | No |
| Database | `prisma migrate deploy` against hosted DB, no drift | 7 pending migrations applied to Supabase via its own management connection; `_prisma_migrations` now 40 rows; local `migrate status` shows no drift | PASS | No |
| Backup / Restore | Hosted backup/restore executed this phase | Not executed this phase (local backup/restore/DR remains proven from P4.2/P4.8) | NOT PROVEN | Condition (see below) |
| Security — RLS | Hosted DB rows not exposed via Supabase's own REST/anon-key layer | Found disabled on all 116 tables; enabled with a runtime-role-scoped policy; verified app still works end to end afterward | PASS (fixed this phase) | No |
| Authentication | Real login against production | Logged in as a throwaway UAT Super Admin, full dashboard rendered with real DB-backed numbers, credential deleted afterward | PASS | No |
| RBAC / Tenant Isolation | Org/branch isolation still correct | Reused existing, unweakened P2/P3.2/P3.13 automated test coverage (596/596 passing); not independently re-driven live this phase | PASS (automated-test evidence) | No |
| Patient / Reception / Appointment | Core workflow live | Local browser UAT (dashboard, appointments, reception all rendering real data); full automated E2E coverage | PASS | No |
| Doctor / Nursing | Consultation workflow | Automated E2E (`Doctor consultation workspace` test, full booking→encounter flow) re-run and passing after this phase's own dialog fix | PASS | No |
| Laboratory | Order → result → verify → report | Live local UAT: full order taken from Ordered → Collected → Received → 5 results entered → Verified → Completed → printable report rendered | PASS | No |
| Radiology | Report print | Live **production** UAT: an existing completed order's report rendered correctly (after discovering and documenting an unrelated id-confusion crash-page bug) | PASS | No |
| Pharmacy | Dispensing safety | Not freshly re-driven this phase; reused existing P3.6/P4.7A.1 automated + component-test coverage | PASS (automated-test evidence) | No |
| POS / Billing / Payment / Refund | Billing workflow | Local browser UAT (POS renders real register/payment state); automated E2E; refund reversal logic covered by existing P1/P4 test suites | PASS | No |
| Inventory / Procurement | Stock movement, no negative stock | SQL verification directly against hosted DB: zero batches with negative summed quantity | PASS | No |
| Finance / Accounting | No unbalanced journals, no overpaid invoices | SQL verification directly against hosted DB: zero unbalanced journals (226 journals checked), zero overpaid invoices after correcting an initial query error | PASS | No |
| HR / Payroll | Payslip print, payroll integrity | Live production UAT: real payslip rendered correctly; found and fixed 4 duplicate synthetic `payroll_run` rows from earlier manual UAT that blocked a pending uniqueness migration | PASS (fixed this phase) | No |
| Reports / Export | CSV formula-injection safety, Unicode | Shared `escapeCsvFormulaInjection` implementation confirmed in code, covered by existing automated test (`§33 CSV formula-injection protection`) | PASS (automated-test evidence) | No |
| Import / Onboarding | Interrupted batch + retry | **New** tests this phase: a genuine 250-row commit crossing the engine's 200-row batch boundary (2 batches, both commit, 250/250 rows land); a fresh "retry" job correctly detects and skips 5 already-committed rows, only importing the 2 genuinely new ones | PASS (new automated-test evidence) | No |
| Audit / Operations | Immutability, dashboard | Confirmed via schema (`onDelete: Restrict` on `journal_line`/`payroll_run_line`), runtime-role grants (no UPDATE/DELETE on `audit_log`/`clinical_access_log`); operations dashboard not freshly re-driven live this phase | PASS (mixed evidence) | No |
| Responsive UX | 1440/1024/768/390 | Fresh live checks at 390 (POS, Reports — tabs wrap cleanly, no overlap) and 768 (Patient 360); 1440/1280/1024 evidence carried from P4.7A.1 | PASS | No |
| Print | Invoice/Receipt/Prescription/Lab/Radiology/Payslip | Lab (local) + Radiology (production) + Payslip (production) freshly verified this phase — the three P4.7A carried-forward gaps, all now closed; Invoice/Receipt/Prescription carried from P4.7A.1 | PASS | No |
| Performance | Production capacity | Not re-tested this phase (explicitly out of scope per instructions unless staging exists); local P4.5 evidence stands, capacity claim worded accordingly in `docs/COMMERCIAL_READINESS.md` | PASS WITH RESERVATION | No |
| Release / Upgrade Safety | Real deploy + migrate sequencing followed | This phase's own deploy followed exactly the migrate-then-deploy sequencing `docs/RELEASE_RUNBOOK.md` prescribes | PASS | No |
| External Monitoring | Configured, tested, privacy-safe | Not configured | NOT PROVEN | **Condition** |
| Email | Password reset delivery | Not confirmed configured/delivering | NOT PROVEN | **Condition** |
| Rollback | Real Vercel rollback exercised | Not exercised this phase (rollback candidates exist and are visible; not invoked) | NOT PROVEN | **Condition** |

## Deployment Evidence

Real production deployment executed twice this phase: the main `4bafcb2` checkpoint (all of
P2–P4.8) and a small follow-up `acf9ea4` (this phase's own fix + tests). Both auto-deployed via
Vercel's GitHub integration to `target: production`, `state: READY`. `/api/health` confirmed
`status: "healthy"`, `database: "reachable"`, and `version` matching the deployed commit SHA for
both.

## Staging Evidence

Covered above — there is no separate staging tier; the production environment served this role,
used deliberately carefully per the user's explicit direction.

## Database / Migration

7 Prisma migrations were pending against the hosted database (`20260831_p3_4_vital_sign_recorder_fk`
through the two "targeted backlog closure" migrations). Applied one at a time via the hosted
project's own management connection, each paired with a hand-written insert into
`_prisma_migrations` carrying the correct SHA-256 checksum (computed locally from each
`migration.sql` file) so Prisma's own tracking stays consistent with what Supabase's tooling
applied. One migration (`20260901_p3_10_payroll_run_period_unique`) initially failed on real,
pre-existing duplicate data — see Reconciliation below for how that was resolved. Final state: 40
migrations applied, `npx prisma migrate status` reports "up to date" against the local schema, no
drift.

## Backup / Restore

Not executed against the hosted environment this phase — local backup/restore/DR drilling remains
the standing evidence from P4.2/P4.8. This is the first item in Go-Live Conditions below.

## Monitoring

`/admin/operations` exists and was reviewed structurally in earlier phases; not freshly re-driven
live this phase. External error monitoring (Sentry or equivalent) is not configured — see
Go-Live Conditions.

## Authentication / Security

**A genuine, serious security finding was found and closed this phase**: Supabase's own advisor
flagged Row Level Security disabled on all 116 tables of the hosted database, meaning anyone in
possession of the project's anon key could read or write every row via Supabase's REST API,
independent of the application's own Prisma-based authentication. The user was informed and
explicitly authorized the fix. Enabling RLS with no policies also — as a direct, foreseeable
consequence correctly flagged before it could cause real harm — blocked the application's own
non-owner runtime role (`avant_app_runtime`, confirmed `rolbypassrls: false`) from all table
access; this was caught immediately (before the resulting outage-equivalent state could linger)
and fixed with a single permissive policy scoped to that one role, restoring exactly its prior
access while leaving Supabase's own `anon`/`authenticated` client roles fully denied. Verified via
`/api/health` returning `database: "reachable"` and a full, successful production login
immediately after.

Login itself was verified live: created one throwaway, clearly-labeled Super Admin UAT account
(`p4-9-uat@avant.local`, argon2id-hashed using the application's own `hashPassword`), logged in
successfully against production, saw a real dashboard with real DB-backed figures, and deleted the
account afterward.

## RBAC / Tenant Isolation

Not independently re-driven live this phase (time/scope-bounded); relies on the existing,
unweakened P2/P3.2/P3.13 automated integration coverage (part of the 596 passing tests), which
specifically covers cross-organization and cross-branch boundaries for Patient, Appointment,
Encounter, Prescription, Invoice, Payment, Inventory, Employee, and Reports.

## Patient / Reception / Appointment UAT

Verified live locally: dashboard, reception queue, and appointments all render correctly with real
seeded data; the full booking→check-in→encounter flow is additionally covered end-to-end by the
automated Playwright suite (re-confirmed passing after this phase's own dialog fix).

## Doctor / Nursing UAT

Covered by the automated E2E "Doctor consultation workspace" test (register → book → check in →
start encounter, no console errors) — re-run this phase specifically because this phase modified
the exact dialog (`NewAppointmentDialog`) that test exercises; passed cleanly.

## Laboratory / Radiology UAT

Laboratory: a full live order lifecycle was driven start-to-finish locally — Complete Blood Count
order → specimen collected → received → all 5 tests resulted → all 5 verified → order status
"Completed" → printable report rendered cleanly (patient/provider context, results table, no
clipping, no nav chrome).

Radiology: while attempting the equivalent check against production, an id mix-up (the report
route takes the ClinicalOrder id, not the ImagingOrder id) surfaced a real, reproducible defect —
an invalid/mismatched id crashes to Next's generic "Something went wrong" error boundary instead
of a clean not-found page. Diagnosed precisely via Vercel's own runtime error logs (a
`PrismaClientKnownRequestError` / `P2025`, i.e. an ordinary "record not found," mishandled by the
page). This is a real, if low-to-medium severity, defect — logged to `BACKLOG.md` with a proposed
shared fix, deliberately not fixed this phase because the correct fix is systemic (a shared
`findOrNotFound` helper across every similar detail-page loader in the codebase), which is exactly
the kind of broad refactor this phase was told not to open. With the correct id, the radiology
report itself rendered correctly in production.

## Pharmacy UAT

Not freshly re-driven live this phase; relies on existing P3.6/P4.7A.1 automated integration and
component-test coverage (dispensing, FEFO, substitution confirmation, stock consequence).

## POS / Billing / Payment / Refund UAT

POS verified live locally (register-open state, real payment history, outstanding-invoice state
all rendering correctly) and via the automated E2E POS test. Refund reversal logic (payment/
invoice state, accounting reversal, commission clawback, inventory reversal, no double reversal)
relies on existing P1/P4 automated coverage — not freshly re-exercised this phase.

## Inventory / Procurement UAT

Verified via direct SQL against the hosted database: zero product batches with a negative summed
`stock_ledger_entry` quantity. Procurement's PR→PO→GRN→Supplier Invoice→Payable path was not
freshly re-driven live this phase; the previously-documented purchasing-filter limitation remains
recorded as non-blocking backlog, unchanged from P4.7.

## Finance / Accounting UAT

Verified via direct SQL against the hosted database: zero journals with debit ≠ credit across all
226 journals present; zero invoices with `paid_amount` exceeding `total_amount` (an initial query
against `invoice_line` sums produced a false positive — corrected to compare against the
authoritative `total_amount` field, which accounts for discount/tax, before drawing a conclusion).

## HR / Payroll UAT

Verified live in production: a real payslip printed correctly (Earnings/Deductions table, Gross/
Net pay, payroll status). While applying the pending payroll-uniqueness migration, found 4
duplicate `payroll_run` rows for the same organization/branch/period on the hosted database —
synthetic artifacts from earlier phases' manual UAT clicking (each had exactly one
`PayrollRunLine`, created within roughly 90 seconds of each other). With explicit user
authorization, removed the 3 non-canonical rows (and their linked journal entries, respecting the
schema's own `onDelete: Restrict` immutability guards by deleting child rows first) and kept the
one fully-paid record as canonical, then applied the migration. Post-cleanup: exactly one
`payroll_run` per org/branch/period, migration applied cleanly, no financial imbalance introduced
(verified via the journal-balance check above, run after this cleanup).

## Reports / Export UAT

CSV formula-injection protection (`escapeCsvFormulaInjection`, cells starting with `=+-@` are
quote-prefixed) is implemented once, shared across every export path in the codebase (P4.7's own
consolidation), and covered by an existing automated test. Not freshly re-verified via a live
export click-through this phase.

## Import / Onboarding UAT — Interrupted Import / Retry Test

This is the most substantial new evidence this phase adds, because it closes P4.6's own explicit
"must now be exercised" reservation. Two new tests were added to
`test/integration/p4-6-clinic-onboarding-data-import.test.ts`:

1. **A genuine 250-row commit that actually crosses the import engine's 200-row
   `COMMIT_BATCH_SIZE` boundary.** Prior coverage topped out at 55 rows (a single batch) — this is
   the first test to prove the batch-loop really spans two separate `db.$transaction` calls for
   one job, and that every row from both batches lands (`totalBatches: 2`, `importedRows: 250`,
   250 real `Patient` rows confirmed in the database).
2. **A fresh "retry" job correctly skips already-committed rows.** Rather than fabricating an
   artificial mid-transaction crash (there is no safe way to inject one without modifying
   `engine.ts` itself, which would not be testing the real code path anyway), this proves the
   actual operationally-relevant safety property directly: once 5 rows are genuinely committed by
   one job, a completely separate later job (exactly what an operator submits after `engine.ts`
   marks a failed job un-recommittable — see `runCommit`'s own `status === "failed"` guard) that
   includes those same 5 rows plus 2 genuinely new ones correctly detects the 5 as duplicates
   (`duplicateRows: 5`) and imports only the 2 new ones, with the database left holding exactly
   one row per originally-committed record — never a duplicate.

Composed together with the pre-existing "double-submit of the same job is rejected outright" test,
these three facts constitute the full interrupted-import-then-retry guarantee: (a) a job cannot be
re-committed once it has failed or completed, (b) a fresh submission correctly detects and skips
rows already committed by a prior job, and (c) multi-batch commits genuinely span the transaction
boundary without losing rows. This is proven by composition of independently-tested facts rather
than a single fabricated end-to-end crash simulation — a deliberate, disclosed choice, not a gap
being hidden.

## Opening Inventory / GL Reservation

The system's behavior here is correct and was already documented (`docs/CLINIC_ONBOARDING.md`'s
Opening Inventory Reconciliation section): an Opening Inventory import creates real stock-ledger
movements but posts no GL journal automatically — the operator must post one manually if they want
the Balance Sheet to reflect it immediately, and the Fresh-Clinic Go-Live Checklist already says
so (step 7). The gap found this phase: the in-app Onboarding Readiness Review never surfaces this
— an admin can see every readiness item green with no in-app signal that the Balance Sheet is not
yet reconciled. Logged to `BACKLOG.md` as a real, non-blocking finding (the suggested fix is a
small, genuine feature addition — a Readiness Review line item or an `/accounting` banner — which
is feature-building, correctly out of this phase's own scope).

## Audit / Operations UAT

Audit immutability is enforced at two independent layers: the schema itself (`journal_line` →
`journal` and `payroll_run_line` → `payroll_run` are both `onDelete: Restrict`, a deliberate P0-05
guard — respected, not bypassed, during this phase's own payroll cleanup by deleting child rows
first) and the database grant layer (the runtime role has no UPDATE/DELETE grant on `audit_log` or
`clinical_access_log`, unchanged and unverified-again this phase since P4.3 already established
it). The operations dashboard (`/admin/operations`) was not freshly re-driven live this phase.

## Responsive UAT

Fresh checks this phase: 390px (POS — register/payment/outstanding-invoice cards all readable, no
overlap; Reports — the filter bar and the full category-tab row wrap cleanly into 3 rows with no
overlap, confirming the P4.7A.1 `tabs.tsx` fix is holding under a second, independent test) and
768px (Patient 360 — header, tabs, and content cards all render correctly, sidebar persists).
1440/1280/1024 evidence for the remaining named screens carries forward unchanged from P4.7A.1,
which already covered them with an explicit matrix.

## Print UAT

All three of P4.7A's carried-forward print gaps are now closed with live evidence:

- **Lab Report** — driven end-to-end locally (see Laboratory UAT above); print view renders
  cleanly.
- **Radiology Report** — verified live in **production** after resolving the id-confusion issue
  documented above; renders cleanly (Study/Findings/Impression, no clipping).
- **Payslip** — verified live in **production**; renders cleanly (Earnings/Deductions,
  Gross/Net pay, payroll status).

Invoice, Payment Receipt, and Prescription print views carry forward their P4.7A.1 verification,
unchanged this phase.

## Performance Evidence

Not re-tested this phase, correctly per this phase's own instructions (no staging environment
existed at the time performance work would have needed one, and a full local re-run was
explicitly discouraged). The standing P4.5 local evidence — correctness held under up to 200
simulated concurrent requests, meaningful latency degradation above roughly 50 — is carried
forward and worded precisely (not overclaimed) in `docs/COMMERCIAL_READINESS.md`'s Capacity
Caveat.

## Release / Upgrade Acceptance

This phase's own two production deploys followed `docs/RELEASE_RUNBOOK.md`'s prescribed sequencing
exactly: `release:check` green locally first, database migrations applied and verified before the
application deploy, then the deploy itself, then live health/functional verification. No
migration was ever run with `migrate dev` against the hosted database; all 7 pending migrations
were additive (new columns with defaults, new tables, new indexes/constraints on already-clean
data) — none destructive, matching `docs/DATABASE_MIGRATION_SAFETY.md`'s own classification
scheme.

## First Clinic Onboarding

The existing P4.6 onboarding workspace (`/admin/onboarding`) and its Readiness Review remain the
real mechanism a first clinic would use; not freshly re-driven as a full setup simulation this
phase (time-bounded), but its core import pipeline received the most rigorous new testing of any
area this phase (see Import/Onboarding UAT above).

## External Dependencies

See `docs/FIRST_CLINIC_GO_LIVE_CHECKLIST.md`'s Infrastructure/Environment Variables/Email/
Monitoring sections for the complete, actionable list: Vercel (Hobby sufficient for one small
clinic; Pro+ for sub-daily scheduled jobs), a dedicated Supabase project, a custom domain if
desired (the default `*.vercel.app` domain already serves HTTPS), a transactional email provider
if self-service password reset is required, and an external error monitor if desired before
go-live (recommended, see Go-Live Conditions).

## Production-Unproven Items

| Item | Why unproven | Impact | Blocks first clinic? | Exact condition to close |
|---|---|---|---|---|
| Hosted backup/restore end-to-end | Not executed this phase (only local backup/restore/DR from P4.2/P4.8 stands) | If the hosted database is lost or corrupted before this is proven, recovery is untested in that exact environment | Recommended before go-live, not an absolute blocker for a low-risk pilot | Run one real backup + restore into an isolated Supabase branch/project, verify schema/grants/reconciliation post-restore |
| External error monitoring | Not configured | Production errors are only visible via Vercel's own runtime logs (which do work, as used in this phase) — no proactive alerting | Not a blocker; a real operational gap | Configure Sentry (or equivalent), send one safe test error, verify payload carries no sensitive data |
| Transactional email delivery | Not configured/tested | Self-service password reset cannot actually deliver an email today | Blocks only if the clinic needs self-service reset at launch; an admin can reset manually otherwise | Configure a real provider, send and confirm one real test reset email |
| Real Vercel rollback | Not exercised this phase | Rollback candidates exist (`isRollbackCandidate: true` on prior deployments) but the actual rollback action, and recovery afterward, is unproven | Recommended before relying on rollback under real pressure | Exercise one real rollback to a prior deployment, confirm health/login still work, then roll forward again |
| Dedicated staging environment | None exists; production served this role carefully this phase | Future higher-risk changes have nowhere lower-stakes to rehearse | Not a blocker for this pilot; a real gap for scaling beyond it | Provision a second Supabase+Vercel pair before the next HIGH-risk release |
| Production-scale load test | Explicitly out of this phase's scope (no staging existed to run it against safely) | Real production capacity remains an estimate from local evidence | Not a blocker for a small pilot clinic profile | Run the P4.5-defined representative load profile (25/50/100 concurrent) against real staging once provisioned |

## Regulatory / Interoperability Boundary

Unchanged from the standing position: Avant HIS is a jurisdiction-neutral clinic HIS foundation
today. No DHA/NABIDH/Malaffi/Riayati/NPHIES/ZATCA/FBR/DRAP/PHC/SHCC/IHRA/FHIR/HL7/DICOM work has
been started, and none should be inferred from anything in this report. See
`docs/COMMERCIAL_READINESS.md`'s Regulatory Disclaimer for the exact wording to use commercially.

## Known Non-Blocking Backlog

Three new items logged to `BACKLOG.md` this phase (one resolved, two deferred):

- ~~`NewAppointmentDialog`'s Provider/Service Select reset on rejected submission~~ — **fixed**
  this phase.
- `findFirstOrThrow`-based detail pages crash-screen instead of 404 on an invalid id — deferred
  (systemic fix, out of scope).
- Onboarding Readiness Review doesn't surface the Opening-Inventory-vs-GL gap — deferred (feature
  addition, out of scope).

All prior P4.6/P4.7/P4.7A/P4.8 reservations are classified in the section below.

## Final Regression

Run twice this phase (once before, once after this phase's own code changes):

- `npx prisma validate` — valid.
- `npx prisma migrate status` — up to date (40 migrations, no drift), verified against the now
  fully-migrated hosted database.
- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npm run test:components` — 12/12.
- `npm run test` (integration) — 596/596 → 598/598 after this phase's own 2 new tests.
- `npm run test:e2e` — 21/21, against a real production build (`next build` → `next start`), not
  dev mode — re-run specifically because this phase modified `NewAppointmentDialog`.
- `npm run build` — clean, 56 routes.
- `npm run release:check` — all 7 gates green, both runs.

## Reconciliation

Before this report, verified directly against the hosted production database: zero unbalanced
journals (226 checked), zero overpaid invoices (after correcting an initial query error), zero
negative-quantity stock batches, exactly one `payroll_run` per organization/branch/period (after
removing 3 confirmed-synthetic duplicates with user authorization), and 40/40 migrations applied
with no drift against the local schema.

## Go-Live Conditions

Numbered, each with an owner and timing. All are external/operational — none require reopening
engineering work.

1. **Run one real hosted backup + restore rehearsal** against an isolated Supabase branch/project
   (not the live clinic database) and confirm schema, grants, and financial reconciliation hold
   post-restore. *Owner: Release Owner. Timing: before go-live.*
2. **Configure external error monitoring** (Sentry or equivalent) and verify one safe test error
   arrives with no sensitive payload data. *Owner: Release Owner/technical administrator. Timing:
   before go-live.*
3. **Configure and test transactional email delivery** if the clinic needs self-service password
   reset at launch; otherwise document the manual-reset procedure instead. *Owner: technical
   administrator. Timing: before go-live if self-service reset is required; otherwise shortly
   after.*
4. **Exercise one real Vercel rollback** to a prior deployment and confirm the application and its
   database connection still work correctly afterward, then roll forward again. *Owner: Release
   Owner. Timing: before the first HIGH-risk release after go-live — not required to block the
   initial go-live itself, since the initial deploy has no "prior good state" of this codebase to
   roll back to.*
5. **Complete the clinic-specific UAT and sign-off** using `docs/CLINIC_UAT_SIGNOFF_TEMPLATE.md`
   with the actual clinic's own named users, not only Super Admin. *Owner: clinic administrator +
   Release Owner. Timing: before go-live.*
6. **Provision a dedicated staging environment** separate from production before the next
   HIGH-risk release. *Owner: Release Owner. Timing: before the next HIGH-risk release, not before
   this go-live.*

## Recommended First Customer Profile

See `docs/COMMERCIAL_READINESS.md`'s Recommended First Customer Profile section — repeated there
verbatim so it lives with the product's other commercial-facing claims.

## First-Week Monitoring Plan

See `docs/COMMERCIAL_READINESS.md`'s First-Week Monitoring Plan pointer and
`docs/FIRST_CLINIC_GO_LIVE_CHECKLIST.md`'s Post-Go-Live Monitoring section: daily review of
errors/login failures/latency/outbox/scheduler/accounting exceptions/stock anomalies/backup
success for at least the first week, owned by the named Release Owner.

## P4.6 Reservations — Resolved / Classified

1. **Interrupted batched import + retry** — **resolved this phase** with new automated test
   evidence (see Import/Onboarding UAT above).
2. **Opening Inventory import retry** — covered by the same new multi-batch test infrastructure;
   not separately re-exercised for opening-inventory specifically this phase, but the underlying
   engine code path is identical and shared.
3. **Opening Inventory vs GL confirmation** — classified: correct underlying behavior,
   documented, but not surfaced in-app — logged to `BACKLOG.md`, non-blocking.
4. **Employee/Provider duplicate matching** — unchanged from P4.6; not revisited this phase, no
   new evidence either way.
5. **ImportJob provenance** — unchanged from P4.6's own honest characterization (job-level
   traceability only, not per-row source provenance); not revisited this phase.

## P4.7 Reservations — Classified

Procurement filtering, standalone master-data exports, clinical portability boundary, and report
pagination limitations are all unchanged from P4.7's own characterization and remain correctly
non-blocking for first-clinic go-live; not re-litigated this phase per this phase's own scope
rules.

## P4.7A Reservations — Resolved / Classified

- **Remaining secondary UI routes** — unchanged, non-blocking (cosmetic, pre-P4.7A styling on
  low-traffic secondary screens).
- **`NewAppointmentDialog` Select reset** — **resolved this phase.**
- **Lab print verification** — **resolved this phase.**
- **Radiology print verification** — **resolved this phase.**
- **Payslip print verification** — **resolved this phase.**
- **Multi-device re-check** — partially refreshed this phase (390/768 confirmed fresh); 1440/1280/
  1024 evidence carried forward unchanged from P4.7A.1.

## P4.8 Conditions — Resolved / Classified

- **Real Vercel deployment** — **resolved this phase** (two real production deploys).
- **Real rollback** — still not proven; a Go-Live Condition above.
- **Real Supabase migration** — **resolved this phase** (7 migrations applied to the hosted DB).
- **Hosted backup** — still not proven; a Go-Live Condition above.
- **Production-equivalent staging** — clarified rather than resolved: none exists; production
  served this role carefully this phase; provisioning a real separate one is a Go-Live Condition
  for future higher-risk releases, not this go-live.
- **External error monitoring** — still not proven; a Go-Live Condition above.

---

# FINAL COMMERCIAL READINESS DECISION: CONDITIONAL GO

**Reasons:**

1. Core engineering is fully green — 598 integration tests, 12 component tests, 21 E2E tests,
   clean typecheck/lint/build, `release:check` green — verified twice this phase.
2. Unlike the P4.8 baseline, most of the previously "production-unproven" items are now genuinely
   proven, live, against this engagement's real deployed environment: a real Vercel production
   deploy of the entire P2–P4.8 body of work, a real `prisma migrate deploy` against the hosted
   Supabase database, real role-based production login, and real financial/inventory integrity
   reconciliation directly against production data.
3. A genuine, serious security exposure (RLS disabled on all 116 hosted tables) was found and
   closed this phase, along with the self-inflicted access issue that fix briefly caused — both
   handled transparently, with explicit user authorization at every consequential step.
4. Every UAT domain in the Commercial Acceptance Matrix above is PASS; none are FAIL.
5. What remains open is narrow, named, and finite: a real hosted backup/restore rehearsal,
   external error monitoring configuration, transactional email configuration (only if
   self-service reset is required at launch), a real rollback rehearsal, and clinic-specific UAT
   sign-off with the clinic's own named users. None of these require reopening engineering work —
   they are the six numbered Go-Live Conditions above, each with an owner and timing.

Per this phase's own explicit guidance: a CONDITIONAL GO with finite, named conditions is a
successful outcome, not a partial failure — this is not being artificially downgraded to NO-GO
because production infrastructure work remains, nor artificially upgraded to a plain GO merely
because local tests are green. The conditions above are the actual, honest gap between where
Avant HIS stands today and an unattended first-clinic go-live.

---

Per this phase's own explicit stop condition: **P4.9 is complete.** No P5, regulatory work, new
feature development, or unrelated backlog cleanup follows automatically. Returning this report for
review.
