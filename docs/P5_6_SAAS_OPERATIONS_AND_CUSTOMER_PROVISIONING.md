# P5.6 — SaaS Operations & Customer Provisioning

## 1. Platform Admin Entry Point

- Login: `/platform/login` (a separate identity plane — `PlatformOperator`, never a clinic `User`).
- Dashboard: `/platform` — organization/onboarding/go-live metrics, "Provision Clinic" primary action.
- Organizations: `/platform/organizations` — list with filters (below) and a "+ Provision Clinic" action.
- Provisioning: `/platform/provision`.
- All linked from the persistent top nav (`platform-topbar.tsx`) on every `/platform/*` page.

## 2. Organization Creation Workflow

`/platform/organizations` lists every tenant with: customer, country, plan, subscription status,
onboarding status, **go-live status** (new — the `commercialLifecycle` field, already fetched, no
extra query), branch/user counts, org status, created date. Filters (new): search, country,
subscription status, onboarding status, go-live status — client-side, URL-driven (mirrors
`inventory/ledger-filters.tsx`'s existing pattern), no new analytics engine.

## 3. Provisioning Flow

`/platform/provision` is a single form (not a multi-page wizard) covering, in order: Organization →
Commercial details (including country) → Plan/subscription → Initial branch → Initial administrator
→ Modules. New in P5.6: a **Review step** — clicking "Review" runs native HTML5 validation
(`form.reportValidity()`), then renders a read-only confirmation summary (organization, subscription,
branch, administrator, modules, and a country-driven regulatory preview) before the real "Provision
Organization" button appears. Reaching the review step never provisions anything by itself.

Submission calls `provisionClinicAction` → `requirePlatformOperator()` → `provisionClinic()`
(`src/lib/domains/commercial/provisioning.ts`, unchanged by this phase) — one atomic transaction
creating Organization → Branch → system roles → initial admin (activation-token flow, no
operator-visible password) → commercial profile → subscription → 4 go-live conditions, followed by
non-transactional, idempotent, self-healing steps (module entitlements, onboarding checklist,
communication templates). See that file's own doc comment for the full reasoning — untouched by P5.6.

## 4. Plan / Entitlement Behavior

Plans (`CommercialPlan`) are selected, not created, during provisioning — plan management lives at
`/platform/plans` (pre-existing, unchanged). A plan's `defaultModuleKeys` pre-check the module
checkboxes; the operator can override per-clinic before submitting. Post-provisioning, entitlements
are edited per-organization on the org detail page's Modules card (`EntitlementsCard`, pre-existing) —
this is genuinely a separate concept from RBAC: **entitlement** = "is this org allowed to use this
module," **RBAC** = "is this user allowed to do this action." Disabling a module never changes what a
granted permission can do, and five core clinical modules (reception/patients/appointments/
clinical/nursing) are never route-blocked regardless of their entitlement flag (`isRouteEnforceable`,
pre-existing, unchanged) — a documented clinical-safety carve-out from P5.1, not something P5.6 alters.

## 5. Branch Limits

Enforced at creation time by existing entitlement-limit checks (`p5-1-commercial-saas-foundation.test.ts`
already proves: exactly-at-limit blocks a new branch; a plan downgrade below current usage never
deletes/deactivates existing branches, only blocks future creation). Provisioning creates exactly one
initial branch — additional branches are added later through the org's own branch-management UI,
subject to the same limit.

## 6. Initial Administrator Activation

No password is ever generated, shown, or logged for the initial administrator. `provisionClinic()`
hashes a random, immediately-discarded secret and issues a `PasswordResetToken` (7-day window) in the
same transaction; the raw activation token is returned to the platform operator **exactly once**, on
the provisioning result screen, as `/reset-password?token=...` — never recoverable afterward, never
persisted anywhere in plain form. If transactional email is not configured (`DEPLOYMENT.md`), the
operator relays this link manually through a secure channel of their choosing — this is the existing,
intended flow; P5.6 did not add or change activation mechanics, only the result screen's action links.

## 7. Regulatory Configuration

New in P5.6: `src/lib/domains/commercial/regulatory.ts` + `regulatory-shared.ts`. A country
(`OrganizationCommercialProfile.country`, pre-existing since P5.1, explicitly reserved for this) maps
to zero or more regulatory integrations:

| Country | Integration | Adapter status |
|---|---|---|
| SA | ZATCA (Saudi e-invoicing) | Real (P5.5-Z) — Integration Sandbox only |
| PK | FBR (Pakistan tax authority) | Not implemented |
| AE | DHA / NABIDH (UAE healthcare) | Not implemented |

ZATCA reuses P5.5-Z's existing organization-level config (`einvoicing/config.ts`'s `Setting`-backed
seller profile, configured at `/einvoicing` by the clinic's own Accountant/Org Admin — **not** by the
platform operator directly; the platform "Regulatory" card shows status and links there). Status
vocabulary is deliberately capped: `not_available` / `not_implemented` / `not_configured` /
`sandbox_configuration_pending` / `sandbox_configured` — never "connected," "certified," "approved,"
or "compliant." This build has no standalone connectivity check for ZATCA (only a real submission
attempt when an actual invoice is issued), and production is always out of scope — the environment is
always reported "sandbox." FBR and DHA/NABIDH always report `not_implemented`; nothing about them is
fabricated as working.

The provisioning wizard's review step shows the same country → integration landscape *before* the
organization exists (using the client-safe `regulatory-shared.ts` constants, since the org has no
`Setting` rows yet to check) — purely informational ("available — not yet configured" / "not
applicable for this country"), never a live status.

## 8. Onboarding Handoff

Unchanged — `CommercialOnboardingStatus` (`not_started → in_progress → ready_for_uat → uat →
ready_for_go_live → live`) and `UatStatus` are edited via the org detail page's existing
`OnboardingCard`/UAT subpage; go-live conditions (4 fixed external prerequisites) via
`GoLiveConditionsCard`; final approval via `approveGoLive()` (re-validates every blocker server-side).
P5.6 adds direct links from the provisioning result screen ("Open onboarding," "View go-live
conditions") so an operator reaches this workflow in one click after provisioning, rather than
building a second onboarding system.

## 9. Security Model

Single-tier `PlatformOperator` authorization (`requirePlatformOperator()` — "does a valid,
non-revoked PlatformSession exist," no permission codes for V1, unchanged). Every commercial
function — including the two new ones this phase adds (`listOrganizationCountries`,
`getRegulatoryIntegrations`) — calls this guard as its own first statement, independent of
`PlatformPageShell`'s page-level redirect. Platform sessions and clinic (`User`) sessions are a
completely separate token/cookie space; a platform token never resolves a clinic `SessionContext`
and vice versa (proven by `p5-1-commercial-saas-foundation.test.ts`, unchanged by this phase).

## 10. Tenant Isolation

Every read/write in `organizations.ts`/`regulatory.ts` is scoped by an explicit `organizationId`
parameter — there is no "list across my org" ambient scoping to accidentally leak, because the
platform operator is not a member of any organization at all. `test/integration/p5-6-saas-operations-provisioning.test.ts`
adds direct coverage for the two genuinely new surfaces (list filters, regulatory status) alongside
the pre-existing `p5-1` suite's broader isolation/limit/RBAC-vs-entitlement proofs.

## 11. Concurrency / Idempotency

`provisionClinic()`'s idempotency-key claim (unchanged) already made a *sequential* duplicate
submission safe. P5.6 adds the one genuinely missing case: a **true concurrent** test —
`Promise.allSettled` firing two `provisionClinic()` calls with the identical idempotency key at the
same time — confirming exactly one organization, one admin user (by email), and one branch (by code)
ever exist afterward, regardless of which internal race path resolves (both succeed identically, or
one succeeds and the other throws a "duplicate submission" error).

## 12. Audit Behavior

Unchanged — every provisioning and lifecycle action already writes to `audit_log` via
`writeAuditLog()`: `platform.organization.provisioned`, `platform.module_entitlement.update`,
`platform.onboarding.created`, `platform.comm_template.seeded`, `platform.go_live.approved`, etc.
Never logs passwords, private keys, tokens, or ZATCA credentials — `newValues`/`oldValues` payloads
are reviewed case by case in the pre-existing code; P5.6 adds no new audited fields containing secrets.

## 13. Known Limitations

- Regulatory status for ZATCA reflects **one global credential set** (P5.5-Z's own documented
  single-tenant scope) — if a second organization also enables ZATCA, both would show the same
  credential-presence status, not independent per-org connectivity. A real multi-tenant certificate
  model is out of scope for this phase (Part 20).
- FBR and DHA/NABIDH have no real adapters — the regulatory surface exists so this can be added later
  without a UI/schema redesign, not because either integration works today.
- The provisioning form is one page with a review gate, not a multi-step wizard with back/forward
  navigation between named steps — matches the existing P5.1 design; adding true multi-step navigation
  was not required to meet the acceptance criteria and was left alone per "do not overbuild."
- No automated test exercises the platform-operator route guard via an actual HTTP request (only via
  a mocked `next/headers` cookie jar backing a real DB-persisted `PlatformSession`) — end-to-end proof
  of the guard exists in the live browser verification performed this phase, not as a committed E2E test.

## 14. Future Work

- A real FBR adapter (Pakistan) and DHA/NABIDH adapter (UAE), following the exact
  `EInvoiceProvider`/`ZatcaEInvoiceProvider` precedent P5.5-Z established.
- Multi-tenant ZATCA credentials (per-organization CSID/secret rather than one global env-var set).
- A true multi-step provisioning wizard with named, navigable steps, if operator feedback shows the
  single-page-with-review form doesn't scale as more fields are added.
- Payment gateway / automated SaaS billing (explicitly out of scope for P5.6, Part 20).
