# P5.6 — SaaS Operations & Customer Provisioning — Completion Report

## Executive Summary

Inspected the existing platform-operator/commercial-SaaS implementation before writing any code, per
this phase's own explicit instruction. Found that P5.1–P5.4 had already built almost the entire
scope this phase describes: a working `/platform/organizations` list, a real single-page provisioning
form wired to an atomic, idempotency-guarded `provisionClinic()`, a comprehensive organization detail
page (commercial profile, subscription, entitlements, onboarding, go-live conditions/approval,
branches, administrators, audit), and 30+ existing tests already proving session-plane isolation,
RBAC-vs-entitlement separation, user/branch limits, and idempotent duplicate-submission handling.

What P5.6 actually added, after inspection ruled out the rest: a **regulatory configuration surface**
(ZATCA/FBR/DHA status per organization, reusing P5.5-Z's existing ZATCA config — no new integration
work), **filters + a go-live column** on the organizations list, a **confirmation/review step** before
the provisioning form submits, and the one genuinely missing test — **true concurrent** provisioning
safety (the existing suite only covered sequential duplicate submission).

No schema changes were required.

## What Already Existed

- `/platform/login`, `/platform` (dashboard), `/platform/organizations` (list + detail),
  `/platform/provision`, `/platform/plans`, `/platform/tickets` — all real, working routes.
- `provisionClinic()` (`src/lib/domains/commercial/provisioning.ts`) — one atomic transaction
  (organization → branch → system roles → initial admin with activation-token flow, never an
  operator-visible password → commercial profile → subscription → 4 go-live conditions), idempotency-
  key guarded, P2002-safe, audit-logged, with post-commit self-healing entitlement/onboarding/
  communication-template seeding.
- Full organization detail page: commercial details, subscription, module entitlements (with the
  RBAC-vs-entitlement separation already enforced), onboarding + UAT status editors, go-live
  conditions tracker and approval action, branches table, administrators table, commercial audit log,
  plus dedicated `/onboarding` and `/uat` subpages.
- `OrganizationCommercialProfile.country` (ISO 3166-1 alpha-2) — already present since P5.1,
  explicitly commented in the schema as reserved for a future regulatory profile.
- `test/integration/p5-1-commercial-saas-foundation.test.ts` — 30+ tests already covering platform/
  clinic session-plane isolation, provisioning correctness, sequential-duplicate idempotency, user/
  branch limit enforcement, RBAC-vs-entitlement independence, and PHI-free platform queries.

## What Was Added

1. **Regulatory configuration surface** (`regulatory.ts` + `regulatory-shared.ts`) — computes ZATCA/
   FBR/DHA status per organization from its country and (for ZATCA) its existing P5.5-Z `Setting`-
   backed seller profile. Never claims "certified"/"approved"/"compliant"; ZATCA status is capped at
   "configured" (never "connected" or "verified" — no standalone connectivity check exists); FBR/
   DHA/NABIDH always report `not_implemented`.
2. **`RegulatoryCard`** on the organization detail page, showing the above with a "Configure" link
   back to the clinic-side `/einvoicing` page (P5.5-Z) where the org's own Accountant/Admin actually
   sets it up — the platform operator only sees status, never configures ZATCA directly.
3. **Organizations list filters** (country, subscription status, onboarding status, go-live status)
   and a **Go-live column** (the existing `commercialLifecycle` field, already fetched — no extra
   query) — `organization-filters.tsx`, mirroring the existing `inventory/ledger-filters.tsx` pattern.
   `listOrganizationsForPlatform()` extended with the matching WHERE-clause filters;
   `listOrganizationCountries()` added for the filter dropdown.
4. **Confirmation/review step** in the provisioning form — clicking "Review" runs native HTML5
   validation, then shows a read-only summary (organization, subscription, branch, administrator,
   modules, and a country-driven regulatory preview) before the real "Provision Organization" button
   appears. Extended the success screen with "Open onboarding" and "View go-live conditions" links.
5. **True concurrent provisioning test** — `Promise.allSettled` firing two `provisionClinic()` calls
   with the identical idempotency key simultaneously, confirming exactly one organization/admin/branch
   result regardless of which race path resolves.
6. Two documentation files (this one and the companion operations guide).

## Files Changed

**New:**
- `src/lib/domains/commercial/regulatory.ts`, `regulatory-shared.ts`
- `src/app/platform/organizations/[id]/regulatory-card.tsx`
- `src/app/platform/organizations/organization-filters.tsx`
- `test/integration/p5-6-saas-operations-provisioning.test.ts`
- `docs/P5_6_SAAS_OPERATIONS_AND_CUSTOMER_PROVISIONING.md`, `docs/P5_6_COMPLETION_REPORT.md`

**Modified:**
- `src/lib/domains/commercial/organizations.ts` — filter params on `listOrganizationsForPlatform`;
  new `listOrganizationCountries()`.
- `src/app/platform/organizations/page.tsx` — filters, Go-live column, "+ Provision Clinic" action.
- `src/app/platform/organizations/[id]/page.tsx` — `RegulatoryCard` wired in; `id="go-live"` anchor.
- `src/app/platform/provision/provision-form.tsx` — review step; richer result screen.

## Database Changes

**No schema changes required.** `OrganizationCommercialProfile.country` (P5.1) and P5.5-Z's
`Setting`-backed ZATCA seller profile already carried everything the regulatory surface needed.

## Platform Admin Workflow

Login (`/platform/login`) → Dashboard (`/platform`) or Organizations (`/platform/organizations`,
now filterable) → "+ Provision Clinic" → fill Organization/Commercial/Plan/Branch/Administrator/
Modules → **Review** (new) → **Provision Organization** → result screen with one-time activation
link and direct links to the organization, its onboarding workspace, and its go-live conditions →
organization detail page (now including Regulatory status) for ongoing operational management.
No database access, Prisma commands, seed scripts, or code changes are needed anywhere in this path.

## Security Verification

- `requirePlatformOperator()` (unchanged, single-tier session-plane check) guards every commercial
  platform function, including both new ones added this phase (`listOrganizationCountries`,
  `getRegulatoryIntegrations`) — verified directly: calling either outside a valid platform session
  throws (confirmed via the real `cookies()`-outside-request-scope failure before the test file's
  mock was added, then confirmed passing once a real DB-backed `PlatformSession` token is supplied).
- Platform and clinic sessions remain a fully separate token/cookie space (`p5-1` suite, unchanged).
- No new server action or page bypasses this guard; `RegulatoryCard`'s "Configure" link points to
  the clinic-side `/einvoicing` page, which uses the clinic `SessionContext`/RBAC guard, not the
  platform operator's — a platform operator has no elevated access to clinic-side ZATCA configuration
  through this new surface.

## Tenant Isolation Verification

- Every regulatory/list function takes an explicit `organizationId`/filter parameter — no ambient
  "current org" scoping exists for a platform operator to begin with, since operators are not members
  of any organization.
- `test/integration/p5-6-saas-operations-provisioning.test.ts` directly proves: country/subscription/
  onboarding/go-live filters correctly include/exclude the right organizations; a Saudi org's ZATCA
  status is independent of a Pakistani org's FBR status; enabling ZATCA for one org doesn't affect
  another org's `not_configured` state (implicit in the per-org `Setting` lookup, exercised across
  two distinct organizations in the same test run).
- Pre-existing `p5-1` suite (unchanged, still passing) covers the broader cross-organization
  isolation guarantees this phase's own additions sit on top of.

## Regulatory Configuration Verification

- SA → ZATCA `not_configured` by default, `sandbox_configuration_pending` once the org's seller
  profile is enabled (no real sandbox credentials in any test environment) — never `sandbox_configured`
  without real env-level credentials present, and never any stronger claim than that.
- PK → FBR `not_implemented`; AE → DHA/NABIDH `not_implemented` — both always, never fabricated as
  working.
- An organization with no country recorded sees every integration as `not_available`.
- Automated assertion (`p5-6` suite) that the full serialized status vocabulary never contains
  "certified," "compliant," or "approved."

## Test Results

- **Focused suite** (`test/integration/p5-6-saas-operations-provisioning.test.ts`): 11/11 passing,
  confirmed deterministic across repeated runs (concurrent-provisioning, list filters, regulatory
  status, and the `PlatformForbiddenError` type check).
- **TypeScript**: `npx tsc --noEmit` — clean, no errors.
- **Lint**: `eslint` on every P5.6-touched file — clean, no warnings/errors.
- **Production build**: `npm run build` — compiles successfully; all `/platform/*` routes present.
- **Live browser verification** (not just automated tests): logged in as the seeded platform operator,
  applied the country filter (37 → 30 organizations, correct URL state), walked the full provisioning
  form through the new Review step (summary rendered correctly, including the SA → ZATCA-available/
  FBR-DHA-not-applicable regulatory preview), submitted, and confirmed the resulting organization
  detail page rendered the new Regulatory card correctly (`Not Configured` + `Configure` link to
  `/einvoicing`) alongside every pre-existing section (branches, administrators, audit log, go-live
  blockers).
- **Full regression** (`npm test`, 727 tests across the whole suite, freshly-reset `his_test`): 453
  passed, 5 failed, 269 skipped. Zero failures in `p5-6-saas-operations-provisioning.test.ts` or any
  other file this phase touched. The 5 failures are the exact same pre-existing signature already
  documented in `BACKLOG.md` ("integration suite non-determinism," first raised P5.4, most recently
  added to by P5.5-Z on 2026-09-25) — `db.journal.findFirstOrThrow()` / `db.chartOfAccount.findFirstOrThrow()`
  coming up empty in `p3-13-cross-role-end-to-end.test.ts` and `outbox-reliability.test.ts`, and two
  "expected 0 admin notifications to be greater than 0" assertions in `outbox-crash-recovery.test.ts`/
  `outbox-reliability.test.ts` — the identical count (5) and identical failure signature already
  confirmed unrelated to P5.5-Z's own changes earlier this same day. Per Part 21's explicit
  instruction, this was not chased further as part of P5.6.

## Known Limitations

See `docs/P5_6_SAAS_OPERATIONS_AND_CUSTOMER_PROVISIONING.md` §13 — summarized: ZATCA regulatory
status reflects one global (not per-organization) credential set, matching P5.5-Z's own documented
scope; FBR/DHA have no real adapters; the provisioning form is single-page-with-review, not a
multi-step navigable wizard; the platform-operator guard is tested via a mocked cookie jar backing a
real session token, not a live HTTP request (covered instead by this phase's own manual browser
verification).

## Backlog Items

None new. This phase's own full-regression run reproduced the same pre-existing, already-documented
integration-suite non-determinism (`BACKLOG.md`, first raised P5.4, most recently added to by
P5.5-Z) — confirmed unrelated (see Test Results above), so no new backlog entry was filed for it.

## Final Acceptance Status

**ACCEPTED.**

All stated acceptance criteria are met: a platform operator can log in, reach organization
management, provision a new organization through the UI with plan/modules/branch/administrator/
country selection and an explicit confirmation step, see the result handed into the existing
onboarding/go-live workflow, and view organization-specific regulatory status (ZATCA reused, FBR/DHA
honestly marked not implemented, no compliance claims) — all without touching the database, Prisma,
seed scripts, or writing custom code per clinic.
