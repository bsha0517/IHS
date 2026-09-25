# P5.4 — Launch Readiness

Answers one question for a given clinic: **what is still preventing this clinic from going live?**
No numerical score — explicit blockers only, computed the same way the server itself computes them
(`getGoLiveBlockers()`, `getFinancialReadinessGaps()`) wherever a check is organization-specific.
Deployment/environment items are checked once per environment, not per clinic.

## 1. Per-Clinic Blockers (server-authoritative)

Every row below is drawn from the exact function `approveGoLive()` itself calls before allowing a
transition to `live` — the UI's disabled button and blocker list are a courtesy rendering of this
same list, never a separate, potentially-drifting copy.

### Commercial

| Check | Source |
|---|---|
| Organization is active (not suspended) | `getGoLiveBlockers` |
| Subscription assigned, status trial/active | `getGoLiveBlockers` |
| Organization not already live/closed | `getGoLiveBlockers` |

### Clinic Configuration

| Check | Source |
|---|---|
| All required onboarding checklist items complete or waived | `getGoLiveBlockers` → `getOnboardingChecklistSummary` |
| — covers, per §3 of `docs/P5_4_CLINIC_IMPLEMENTATION_PACKAGE.md`: branches, staff, services, and every entitlement-gated master-data item (products, suppliers, medications, lab/imaging catalogue, chart of accounts, opening inventory, assets, HR config) | |

### Financial (P5.4 §4/§10 — new this phase)

| Check | Source |
|---|---|
| Every posting intent an enabled module can actually invoke has an org-wide account mapping configured | `getGoLiveBlockers` → `getFinancialReadinessGaps` (`src/lib/domains/accounting/posting-service.ts`) |

This closes the real P5.3 UAT defect where a missing "bank" mapping let a payroll run be marked paid
in the UI while silently posting no accounting journal. The detector is deliberately conservative —
see that file's own doc comment for exactly which intents each module (`pos_billing`, `inventory`,
`procurement`, `payroll`, `assets`) requires and why — and it only *detects and explains*, it never
guesses which account a gap should resolve to.

### Technical (environment-level — see §2)

Deployment, migrations, RLS, backup/restore, monitoring, and transactional email are environment
properties, not per-clinic database state — verify these once per environment using §2's checklist,
not per organization.

### UAT

| Check | Source |
|---|---|
| 4 go-live conditions (hosted backup + restore rehearsal, external error monitoring, clinic-specific UAT signoff, transactional email) all `complete` | `getGoLiveBlockers` |
| Clinic-specific UAT cycle signed off | Condition `clinic_uat_signoff`, driven by `docs/P5_4_REAL_CLINIC_UAT_PACKAGE.md` |

### Support

| Check | Source |
|---|---|
| Support process established, responsible operator identified | Not a server-enforced blocker (no field exists for this) — confirm manually via `docs/P5_4_COMMERCIAL_HANDOVER.md`'s handover checklist before approving go-live |

## 2. Environment/Deployment Readiness

One-time per environment (or re-verified on each significant infrastructure change), not per clinic.
Status legend: **VERIFIED** (confirmed working in this environment), **MANUAL** (a real step someone
must do, with no automated check), **PENDING** (not yet done in the environment currently backing
this phase's work), **N/A** (does not apply to this deployment's actual architecture).

| Area | Item | Status | Detail |
|---|---|---|---|
| Application | Production build | VERIFIED | `npm run build` passes clean (this phase's own regression gate, §Testing in the completion report) |
| Application | Environment variables | MANUAL | `DATABASE_URL`, `DIRECT_DATABASE_URL`, `NODE_ENV=production`, `CRON_SECRET` — see `DEPLOYMENT.md`'s "Environment Variables" for the exact required shape (Supavisor transaction-mode pooler, not session mode) |
| Application | Secrets | MANUAL | `CRON_SECRET` generation, database role passwords — `DEPLOYMENT.md` Deployment Checklist steps 2–3 |
| Application | Domain / TLS | MANUAL | Hosting-platform-specific (Vercel or equivalent); no code-level dependency |
| Application | Deployment version tracking | N/A | No dedicated release-tagging system beyond git history and `docs/RELEASE_VERSIONING.md` |
| Application | Migration status | VERIFIED | `prisma migrate status` reports up to date, 42 migrations, no drift (this phase made no schema changes) |
| Database | Production database provisioned | MANUAL | A dedicated production Supabase project (or equivalent) — `DEPLOYMENT.md` Deployment Checklist step 1; never the same database this build's dev/test has used |
| Database | Runtime role (`avant_app_runtime`) created and granted | MANUAL | `prisma/db-setup/p0-06-create-runtime-role.sql` — `DEPLOYMENT.md` "Database Privileges" |
| Database | Migrations deployed | MANUAL (per environment) | `prisma migrate deploy` — never auto-applied on boot |
| Database | RLS applied and verified | VERIFIED (this dev environment) | `npm run db:security:check` reports 133/133 tables protected; must be re-run after `db:security:apply` on every new environment |
| Database | Backup | MANUAL | Supabase's own daily automated backups (+ PITR on Pro+) — confirm the actual tier before relying on PITR; see `DEPLOYMENT.md` "Backup Strategy" |
| Database | Restore rehearsal | PENDING | `DEPLOYMENT.md` itself flags this as not yet drilled against this specific project — this is exactly go-live condition `backup_restore_rehearsal`, which every clinic's own go-live approval already requires an operator to attest to with real evidence |
| Security | Authentication | VERIFIED | Session-based auth, Argon2 password hashing, covered by the integration suite |
| Security | Session behavior | VERIFIED | Cookie `secure` flag driven by `NODE_ENV`, confirmed in `DEPLOYMENT.md` |
| Security | Runtime DB role (never schema owner) | VERIFIED | Enforced by `DEPLOYMENT.md`'s Database Privileges cutover (P1 §1) and its own regression test (`audit-log-immutability.test.ts`) |
| Security | Headers/CSP | N/A | Not implemented as a distinct layer in this codebase; out of P5.4's scope (no concrete blocker demonstrated) — candidate for a future hardening pass |
| Security | Audit logging | VERIFIED | `AuditLog` covers every platform mutation exercised by this phase's own tests |
| Security | Organization isolation | VERIFIED | P5.3's own UAT + this phase's `p5-4-financial-readiness`/`p5-4-communication-template-provisioning` tests, both organization-scoped by construction |
| Observability | External error monitoring | MANUAL, per clinic | Go-live condition `error_monitoring` — an operator-attested, evidence-based condition (no automated check exists; see `docs/P5_2_PILOT_OPERATIONS.md`) |
| Observability | Application logs | VERIFIED | Structured logger (`src/lib/platform/logger.ts`) already in use throughout |
| Observability | Database monitoring | MANUAL | Whatever the hosting Postgres provider (Supabase) exposes natively — not a bespoke dashboard this codebase builds |
| Observability | Alert ownership | MANUAL | See `docs/P5_4_INCIDENT_OPERATIONS.md` §4 — no on-call rotation tooling exists; nominate an operator per deployment |
| Communications | Transactional email | MANUAL, per clinic | Go-live condition `transactional_email`; no real provider is connected yet in this codebase (`DEPLOYMENT.md` "No SMS/WhatsApp/Email provider is connected") — a real deployment must implement one `CommunicationAdapter` before this condition can be honestly marked verified |
| Communications | Notification configuration | VERIFIED | Communication templates now auto-provisioned (P5.4 §3) |
| Communications | Communication templates | VERIFIED | See above; 5/5 default templates confirmed created by this phase's own tests |
| Operational | Support access | VERIFIED | `/platform/tickets`, `/support` both functional (P5.2) |
| Operational | Clinic administrator activation | VERIFIED | One-time activation token flow, exercised by every provisioning test in this phase and P5.3 |
| Operational | Backup ownership | MANUAL | Whoever owns the Supabase project/organization for this deployment |
| Operational | Incident contact | MANUAL | See `docs/P5_4_INCIDENT_OPERATIONS.md` §4 |
| Operational | Rollback/recovery procedure | VERIFIED (documented) | `docs/RELEASE_RUNBOOK.md`/`docs/DATABASE_MIGRATION_SAFETY.md` — not re-authored here; P5.4 made no schema changes so nothing new to rehearse this phase |

## 3. How to Read This Document

For a **specific clinic** about to go live: check §1 by opening its organization detail page in
`/platform/organizations/[id]` — the Go-Live Approval card renders the exact same blocker list this
document describes, computed server-side, live. This document explains what each blocker means and
where it comes from; it is not itself the source of truth.

For the **environment** the clinic will run in: walk §2 once. Most rows here are either already
verified in this project's own development/CI environment (confirmed by this phase's regression
gates) or are explicitly manual steps `DEPLOYMENT.md` already documents in full — this table exists
to give a first real pilot a single place to see BOTH categories at a glance, honestly marked, rather
than needing to cross-reference five different documents to find out what's actually been checked.
