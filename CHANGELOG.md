# Changelog

All notable changes to Avant HIS are recorded here, starting from the current commercial-readiness baseline (P4.8). Format loosely follows [Keep a Changelog](https://keepachangelog.com/) — grouped by release, most recent first. Versioning follows [docs/RELEASE_VERSIONING.md](docs/RELEASE_VERSIONING.md) (pre-1.0 `0.MINOR.PATCH`).

This file does not reconstruct every phase's own history in exhaustive detail — each phase already has its own `P*_REPORT.md` in the repository root documenting exactly what it did; this file is the release-facing summary going forward, one entry per actual release from this point on. Individual release notes with full detail (schema migrations, env changes, deployment order, rollback considerations) live in `docs/releases/YYYY-MM-DD-vX.Y.Z.md` — see [RELEASE_TEMPLATE.md](docs/releases/RELEASE_TEMPLATE.md).

## [Unreleased]

### Added

- Release safety tooling (P4.8): `npm run release:check` (a single pre-release gate — schema validation, migration drift, typecheck, lint, component tests, integration tests, production build), `npm run db:upgrade:drill` (a real local migration-rehearsal drill reusing the existing backup/restore mechanism), a shared release-version identifier (`src/lib/platform/release.ts`) used identically by `/api/health` and the structured logger.
- Release process documentation: `docs/RELEASE_CHECKLIST.md`, `docs/RELEASE_RUNBOOK.md`, `docs/DATABASE_MIGRATION_SAFETY.md`, `docs/RELEASE_VERSIONING.md`, `docs/releases/RELEASE_TEMPLATE.md`.

### Changed

- `src/components/ui/tabs.tsx`: fixed a `TabsList` height bug that overlapped page content when a tab row wrapped to more than one line at a narrow viewport (P4.7A.1).

## Baseline at P4.8 — What Commercial-Readiness Means Here

Reflects the state this changelog starts tracking forward from — not a release entry itself, a snapshot:

- **Commercial operational workflows** (P0-P3): reception, appointments, patients, clinical encounters, laboratory, radiology, pharmacy, billing/POS, inventory, procurement, finance/accounting, HR/payroll, assets — functionally mature, role-aware, multi-branch, multi-organization.
- **Production infrastructure** (P4.1-P4.5): Vercel + Supabase deployment architecture, database backup/restore/DR tooling and a real drilled procedure, production security hardening (restricted runtime DB role, audit-log immutability, rate limiting, secure sessions), structured logging and an operations dashboard, environment-variable fail-fast validation, load/concurrency validation.
- **Data import & onboarding** (P4.6): a versioned CSV import engine covering the master-data types a new clinic needs to get running.
- **Reporting & export** (P4.7): 12 report categories, CSV export with formula-injection protection and row limits, sensitive-export audit logging.
- **UI/UX design system** (P4.7A/P4.7A.1): a real design-token system and shared primitives, deep workflow-level migration of every critical daily-use staff workspace (Dashboard, Reception, Patients, Patient 360, Appointments, Doctor Consultation, Nursing/Vitals, Pharmacy, POS, Laboratory, Radiology), component and browser-level test coverage.
- **Release safety** (P4.8): the discipline this file's own [Unreleased] section above describes.

Known, deliberately-carried-forward gaps (tracked in `BACKLOG.md`, not hidden): an external error-monitoring provider (e.g. Sentry) is not yet integrated; hosted-production backup has not yet had a real end-to-end run (only local rehearsal); production-equivalent staging for real migration/load rehearsal is not yet provisioned; several secondary UI routes remain on the pre-P4.7A visual baseline; procurement filtering, standalone master-data exports, and full clinical-record portability remain limited. See `P4_8_RELEASE_MIGRATION_UPGRADE_SAFETY_REPORT.md`'s own "Production-Unproven Items" and "P4.9 Entry Conditions" sections for the complete, current list.
