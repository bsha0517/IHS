# Commercial Readiness

What Avant HIS supports today, what it requires to run, and what it deliberately does not yet
claim. Written for a prospective first customer or an internal go/no-go conversation — factual,
not promotional. See `P4_9_COMMERCIAL_READINESS_ACCEPTANCE_REPORT.md` for the underlying evidence
behind every claim here.

## What Avant HIS Supports Today

A jurisdiction-neutral, multi-organization, multi-branch clinic Healthcare Information System
covering: patient registration and 360° record, appointment scheduling and reception/queue,
doctor consultation (vitals, notes with amend-not-overwrite, diagnoses, orders), nursing,
laboratory (order → specimen → result → verification, amendable), radiology (order → report,
amendable), pharmacy dispensing (FEFO, substitution confirmation, stock consequence), point of
sale / billing / payments / refunds, inventory and procurement (PR → PO → GRN → supplier invoice),
finance and accounting (full double-entry GL, trial balance, income statement, balance sheet, cash
flow, AR/AP), HR and payroll (attendance, leave, payroll runs, payslips), asset management, a
built-in reporting and CSV export suite across every operational domain, a guided clinic
onboarding/data-import workflow, role-based access control, organization and branch data
isolation, an immutable audit log and a separate clinical access log, and an operations dashboard
covering scheduler health, the event outbox, and accounting exceptions.

## Deployment Requirements

- A Vercel project (Hobby plan is sufficient for a single small clinic; Pro+ if sub-daily
  scheduled jobs are needed — see below).
- A dedicated Supabase PostgreSQL project — not shared with another tenant's database.
- A transactional email provider, if self-service password reset is required at launch.
- Optionally, an external error monitor (e.g. Sentry).
- See `docs/FIRST_CLINIC_GO_LIVE_CHECKLIST.md` for the complete, actionable setup sequence.

## Recommended First Customer Profile

Based on what has actually been evidenced (see the P4.9 report's Performance and Staging Evidence
sections), the sensible first rollout is:

- A single organization, 1–3 branches.
- An outpatient clinic or small medical center rather than a large multi-department hospital.
- A moderate number of concurrent staff users (the system has been correctness-validated under
  local concurrency up to 200 simultaneous simulated requests, with meaningful latency
  degradation above roughly 50 — see the Capacity Caveat below).
- Pharmacy/Lab/Radiology in use only where the clinic actually operates those services.
- A controlled, supported onboarding rather than a fully self-serve signup.
- One named clinic administrator who owns local setup and day-to-day account management.

## Capacity Caveat

Avant HIS is designed for multi-user clinic operation and has been validated for **correctness**
under high local concurrency (up to 200 simultaneous simulated requests, against a local database,
correctness held throughout — no data corruption, no lost updates). Latency degraded meaningfully
above roughly 50 concurrent requests in that same local test environment. **Final production
capacity depends on the deployed infrastructure** (Vercel plan, Supabase plan/pooler
configuration) and has not yet been measured against a real hosted deployment under load. Do not
quote a specific concurrent-user number as a production guarantee until real hosted load evidence
exists — see the P4.9 report's Production-Unproven Items.

## Current Limitations

- **No dedicated staging environment** distinct from production exists yet for this deployment —
  see the P4.9 report for how this phase worked around that.
- **Production-scale load testing** has not been performed against real hosted infrastructure.
- **External error monitoring** is not yet configured (a pre-go-live condition, not a defect).
- **Hosted backup execution** has been reasoned about but not exercised end-to-end against a real
  hosted restore target within this engagement.
- **Self-service password reset email delivery** depends on a transactional email provider being
  configured — the workflow itself is implemented and tested, but real delivery is
  environment-dependent.
- **Sub-daily scheduled job processing** (outbox retry sweeps at 5-minute cadence) requires a
  Vercel plan above Hobby; Hobby-plan deployments run this on a daily cadence instead.
- A small number of low-severity UI/UX items remain open in `BACKLOG.md` — none block core
  clinical, financial, or security correctness.

## Regulatory Disclaimer

Avant HIS is currently a **jurisdiction-neutral clinic HIS foundation**. It does not implement,
and does not claim, any specific regulatory certification or integration — including but not
limited to DHA, NABIDH, Malaffi, Riayati, NPHIES, ZATCA, FBR, DRAP, PHC, SHCC, IHRA, FHIR, HL7, or
DICOM. Future regulatory phases will add jurisdiction-specific profiles/adapters (UAE, Saudi
Arabia, Pakistan, other GCC) and interoperability/certification work as a separate, later roadmap
item. Do not represent this product as compliant with any named healthcare regulatory framework
until that work is actually done and certified.

Security posture is real but should be described precisely: role-based access control, tenant
(organization) and branch data isolation, an immutable audit log and clinical access log, security
headers, rate limiting, hardened session/password handling, and privacy-conscious design. This is
**not** the same claim as "HIPAA compliant," "DHA compliant," or any other named certification —
none of those have been pursued or obtained.

## Support / Operations Expectations

A first clinic rollout needs, at minimum: a named Release Owner (see `docs/RELEASE_CHECKLIST.md`),
a technical administrator who can perform basic Vercel/Supabase operations, someone who reviews
backup success and the `/admin/operations` dashboard periodically, and an incident contact the
clinic's own administrator can reach. This does not require a dedicated support team or a ticketing
system for a single-clinic pilot.

## Backup / DR Expectations

Database backups, a documented retention recommendation, and a periodic restore-test cadence are
covered in `docs/BACKUP_DISASTER_RECOVERY.md` and `docs/DATABASE_MIGRATION_SAFETY.md`. Regulatory
data-retention *requirements* (as opposed to this project's own technical recommendation) are a
jurisdiction-specific matter for the later regulatory roadmap, not something this document invents.

## Customer Data Ownership / Export

A clinic can obtain its own operational data at any time via the built-in Reports/Export suite
(`/reports`, CSV export across every operational domain, plus dedicated Patient Master, GL, Trial
Balance, Collections, Refunds, Stock Movement, Audit Log, and Clinical Access Log exports) — no
engineering intervention required. This is **data exportability**, not standards-based clinical
interoperability (FHIR/HL7/DICOM) — the two are deliberately distinct claims; only the first is
made today.

## Upgrade Process

Every release follows `docs/RELEASE_RUNBOOK.md`: a single pre-release gate (`npm run
release:check`), database migrations applied separately from and before the application deploy
(`prisma migrate deploy`, never `migrate dev`), migration classification and safety rules per
`docs/DATABASE_MIGRATION_SAFETY.md`, and a documented rollback/recovery path. See
`docs/RELEASE_VERSIONING.md` for the versioning convention and `CHANGELOG.md` for the release
history.
