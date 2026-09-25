# Commercial SaaS Operations

How Avant HIS is provisioned, licensed, and operated as a multi-clinic commercial product (P5.1).
Written for whoever runs the platform side of the business day to day — not a clinic's own
Super Admin, and not a developer reading the code for the first time. See
`P5_1_COMMERCIAL_SAAS_FOUNDATION_REPORT.md` for the underlying evidence behind every claim here,
and `docs/COMMERCIAL_READINESS.md` / `docs/FIRST_CLINIC_GO_LIVE_CHECKLIST.md` for what a clinic
itself needs before its data goes live.

## The Core Model

**Organization = commercial clinic/customer tenant.** There is no separate "Tenant" concept —
every `Organization` row created since Phase 1 already was one, and P5.1 did not change that. What
P5.1 added is commercial metadata *about* an Organization, kept in a related model
(`OrganizationCommercialProfile`) rather than inside `Organization` itself, so the core tenant
model, RBAC, and tenant-isolation guarantees every prior phase already proved are completely
untouched.

**`OrgStatus` (active/suspended) and `CommercialLifecycle` (onboarding/live/closed) are separate
fields, on purpose.** `OrgStatus` is the existing, security-critical access switch — a suspended
organization's every session stops working immediately (see Suspension below). `CommercialLifecycle`
is a business-stage label only; it has no access-control effect. Conflating the two would either
weaken the security switch or turn a business label into an accidental kill switch — neither is
acceptable, so they stay separate.

## Platform Operator vs Clinic Super Admin

These are two fully separate identities, with two fully separate session types, on two fully
separate cookies (`his_platform_session` vs `his_session`), backed by two fully separate database
tables (`PlatformOperator`/`PlatformSession` vs `User`/`Session`). A `PlatformOperator` row is never
a `User` row, and vice versa.

- A **platform operator** manages commercial metadata across every clinic: provisioning, plans,
  subscriptions, module entitlements, suspension/reactivation, onboarding/go-live tracking. A
  platform operator has **no** clinic RBAC permissions, no `organizationId`, and cannot view patient
  or clinical data — the platform screens never query a Patient/Encounter/Diagnosis/etc. table at
  all.
- A **clinic Super Admin** is a normal `User` row with the `Super Admin` role, scoped to exactly one
  organization by their session. There is no code path that turns a clinic Super Admin's session
  into a platform session, or lets them reach `/platform/*` at all — `src/proxy.ts` checks the
  `PlatformSession` cookie exclusively for that path prefix, and a staff session cookie is simply
  the wrong cookie name for that check to even look at.

There is **no impersonation feature** ("log in as this clinic") and none is planned for this phase.
A platform operator who needs to see what a clinic user sees must be given real, audited clinic
credentials by that clinic, the same as any other support arrangement — this codebase does not
manufacture one for them.

## Provisioning a New Clinic

Platform → Provision Clinic (`/platform/provision`) walks through one form: organization details →
commercial profile → plan/subscription → initial branch → initial administrator → module selection.
Submitting it runs `provisionClinic()` (`src/lib/domains/commercial/provisioning.ts`), which:

1. Hashes a throwaway, immediately-discarded admin bootstrap secret and generates an activation
   token **before** opening a database transaction (Argon2 hashing is CPU-heavy; it must never run
   inside a transaction — this is the same lesson P4.9.2's user-import work already established).
2. In one atomic transaction: claims an idempotency key (first statement — a duplicate submission of
   the exact same form resolves to the *original* result, never a second organization), creates the
   `Organization`, `Branch`, system roles, the initial admin `User` (with a `PasswordResetToken` for
   activation, never a client-chosen password), the `OrganizationCommercialProfile` (with a
   generated, globally-unique customer code like `AVT-000123`), the `OrganizationSubscription`, and
   four `GoLiveCondition` rows, all seeded `pending`.
3. After the transaction commits: seeds module entitlements from the plan's defaults, and writes a
   `platform.organization.provisioned` audit row.

The one-time activation link (`/reset-password?token=...`) is shown to the operator **exactly
once**, in the success screen — it is never re-displayed, never emailed automatically (P5.1 does
not implement email delivery), and must be relayed to the clinic through the operator's own secure
channel. If entitlement seeding fails after the transaction commits (a genuinely separate, non-
transactional step by design — see the code's own comment), the organization is still fully valid
and usable; every module simply stays at its safe default of enabled until an operator re-runs
`resetEntitlementsToPlanDefaults()` from that organization's detail page.

## Plans and Subscriptions

- **`CommercialPlan`** is a reusable product definition: a code, name, optional user/branch limits,
  and a default module list. Plans are managed at `/platform/plans` — platform-operator-only, not
  audited to `AuditLog` (a bare plan definition has no organization to scope an audit row to; it
  only becomes consequential once a real subscription references it).
- **`OrganizationSubscription`** is a clinic's actual, historical relationship to a plan. Changing a
  clinic's plan **always creates a new subscription row** — nothing is ever mutated in place. The
  "current" subscription is simply the most recent row by `createdAt`. This means a plan change has
  a permanent, queryable history, and nothing about a past subscription period is ever rewritten.
- Per-organization limit overrides (`agreedUserLimit`, `agreedBranchLimit`) live on the subscription
  row, not the plan — a specific clinic's negotiated limits never have to fork a new plan definition.
- **V1 commercial management is entirely manual.** There is no payment gateway, no automated
  billing, no self-service upgrade/downgrade, and no automated subscription-state transition (e.g.
  nothing flips a trial to `expired` on its own when `trialEndsAt` passes) — an operator sets every
  subscription field by hand. See Deferred Commercial Features below.

## Module Entitlements

An entitlement answers "has this org purchased this capability" — a commercial question, layered
**on top of** RBAC, never a replacement for it. Both gates must pass independently: a user with the
right permission still cannot use a disabled module's routes, and enabling a module never grants a
permission a user's role doesn't have.

- Stored as `Setting` rows (`module_enabled:<key>`, reusing the pre-existing `pharmacy_enabled` key
  for the `pharmacy` module specifically — no parallel flag for the same concept), scoped per
  organization. A module with no explicit row defaults to **enabled**.
- Enforced centrally in `src/proxy.ts`, once, for every request under a gated route prefix — there
  is no way to reach a gated page by direct URL that skips this check. The sidebar hides a disabled
  module's nav item too, but that is a UX convenience, not the enforcement boundary.
- **The core clinical spine — reception, patients, appointments, clinical, nursing — is deliberately
  never route-blocked**, regardless of its entitlement flag (`CORE_MODULES` /
  `isRouteEnforceable()` in `src/lib/platform/entitlements-shared.ts`). Disabling one of these only
  removes it from the sidebar; a clinic mid-operation can never be locked out of its own patient
  record or appointment book by an entitlement change. This is a deliberate clinical-safety
  boundary, not an oversight.
- Disabling a module never deletes or hides the data already recorded under it — there is no
  destructive action anywhere in the entitlement system. A disabled module's historical records
  remain in the database exactly as before; whether they remain *reachable* through some other
  still-enabled screen depends on that screen's own code and is not uniformly guaranteed by this
  phase — see Known Limitations.

## Limits (Users, Branches)

`assertWithinUserLimit()` / `assertWithinBranchLimit()`
(`src/lib/domains/commercial/organizations.ts`) are called centrally from `createUser`/`updateUser`
and `createBranch`/`updateBranch`, counting **active** records only. They:

- Block creating a new active user/branch, or reactivating an inactive one, once the organization is
  at or above its effective limit (the subscription's own override, falling back to the plan's
  default, falling back to unlimited).
- **Never** delete, deactivate, or otherwise touch an existing record to enforce a limit — the only
  effect is refusing to create *one more*.
- Are a complete no-op (no query at all) for an organization with no commercial subscription — the
  original pre-P5.1 seed/bootstrap tenant remains fully unrestricted, exactly as it always was.

A **plan downgrade** that leaves a clinic over its new limit is therefore always safe: nothing is
deleted or deactivated by the downgrade itself, the clinic simply cannot create or reactivate
another user/branch until it's back under the new limit (or the limit is raised again).

## Suspension and Reactivation

Reuses the existing, already-proven `OrgStatus` mechanism from P4.3 — there is no second suspension
mechanism anywhere in P5.1. `suspendOrganization()` sets `Organization.status = "suspended"`,
immediately revokes every active session for every user in that organization, and writes a
`platform.organization.suspended` audit row. Because every request re-resolves session validity
from live database state (`getSessionContext()` checks `organization.status` on every call, not
just at login), suspension takes effect for an already-issued session with no logout/login round
trip required — proven directly in `test/integration/p5-1-commercial-saas-foundation.test.ts` and
end-to-end in `test/e2e/platform-provisioning.spec.ts`. Reactivation flips the status back and
writes `platform.organization.reactivated`; nothing about the organization's branches, users,
modules, subscription, or clinical/financial data is touched by either transition.

## Onboarding and Readiness

`CommercialOnboardingStatus` (on `OrganizationCommercialProfile`) is a platform-operator-set,
business-facing label (not_started → in_progress → ready_for_uat → uat → ready_for_go_live → live).
It is **completely separate** from `src/lib/domains/onboarding/readiness.ts`'s own
`getOnboardingStatus()`, which remains the sole, derived-from-actual-configuration authority on
whether a clinic is technically ready to operate — nothing in P5.1 lets an operator manually declare
a clinic "ready" while its real setup (providers, services, branches, imported data, etc.) is
incomplete. A module a clinic doesn't intend to use (e.g. laboratory, if the `laboratory` module is
disabled) does not become a blocking onboarding requirement for that clinic — readiness only asks
for what the clinic actually configured itself to need.

## Go-Live Conditions

The platform organization-detail screen tracks the same four conditions
`docs/FIRST_CLINIC_GO_LIVE_CHECKLIST.md` already defines as required before a real clinic's data
goes live: hosted backup + restore rehearsal, external production error monitoring, clinic-specific
UAT sign-off, and transactional email (conditional — only required if self-service password reset
is needed at launch). This is a **checklist for evidence an operator records**, never a system that
performs or verifies the underlying action itself — marking a condition `complete` is an assertion
by the operator, backed by a free-text `note`, not a live integration check. No condition is ever
pre-marked complete by provisioning; all four start `pending`.

## Commercial Audit

Every commercial mutation — provisioning, plan assignment, subscription change, entitlement change,
suspend, reactivate, onboarding/UAT status change, go-live condition update — writes a row to the
same `AuditLog` table every other domain in this codebase already uses (`action` prefixed
`platform.*`), scoped to the affected organization. No password, token, secret, or PHI is ever
written into an audit payload — only before/after values of the commercial field itself (e.g.
`{ enabled: true }`, `{ status: "suspended" }`).

## Idempotency and Double-Submission

Clinic provisioning claims an idempotency key as the very first statement inside its transaction,
using a dedicated `PlatformIdempotencyKey` table (`operatorId`-scoped, mirroring the existing
`IdempotencyKey` table's exact pattern) — a separate table is necessary because provisioning has no
`organizationId` yet at the moment the key must be claimed. A retried submission with the same key
(a double-click, a browser retry) resolves to the original organization instead of creating a
second one.

## PHI / Privacy Boundary

Every platform screen — dashboard, organization list, organization detail — queries only
`Organization`, `OrganizationCommercialProfile`, `OrganizationSubscription`, `CommercialPlan`,
`Branch`, `User` (name/email/status/last-login only, filtered to administrators), `Setting`, and
`AuditLog` rows whose `action` starts with `platform.`. None of these queries join, select, or
otherwise touch `Patient`, `Encounter`, `Diagnosis`, `Prescription`, `LabOrderTest`, or any other
clinical table — there is structurally no code path for PHI to reach a platform screen.

## Deferred Commercial Features

Explicitly out of scope for P5.1 — do not build these without a separate, deliberate phase:

- Stripe or any other payment-gateway integration; automated subscription billing/dunning.
- A customer-facing billing portal; self-service signup, upgrade, or downgrade.
- Support impersonation ("log in as this clinic").
- Advanced commercial analytics (MRR, churn, cohort reporting).
- Tenant deletion or data-retention automation — commercial "closure" is a logical/inactive state
  only; there is no destructive tenant-deletion path anywhere in this phase.
- A reseller/partner model; white-labeling.
- UAE/Saudi/Pakistan-specific regulatory compliance work; insurance integration; a sales
  CRM/pipeline; marketplace features.

## Known Limitations (read before treating something as fully enforced)

- Module-entitlement route enforcement covers the ~12 optional/add-on modules listed in
  `src/proxy.ts`'s `MODULE_ROUTE_PREFIXES`; the core clinical spine is deliberately never enforced
  (see Module Entitlements above — this is a safety decision, not a gap). Enforcement is at the
  **route** boundary; it does not currently reach into every individual Server Action a disabled
  module's UI might otherwise still expose if a component were reachable some other way. No such
  bypass is currently known, but it has not been exhaustively proven closed for every action in
  every optional module — a genuine PARTIAL, not a NO.
- A disabled module's historical data is never deleted, but this phase does not guarantee every
  *other* screen's cross-references into that data are gated the same way (e.g. a report that joins
  across modules). Treat "disabled" as "hidden from its own workspace and blocked at its own route,"
  not as a data-visibility guarantee everywhere that data could theoretically surface.
- `nextCustomerCode()` generates the next customer code via a simple count+1 inside the provisioning
  transaction. It is protected against a literal duplicate (the column is globally unique, and a
  collision throws a clear, caught error rather than corrupting data), but has not been load-tested
  under many truly concurrent provisioning calls — provisioning is an infrequent, operator-driven
  action, so this has not been treated as a priority for this phase.
- There is no automated subscription lifecycle (trial → expired transition, dunning, etc.) — every
  status change is manual. A trial whose `trialEndsAt` has passed does not automatically stop
  working; the platform dashboard's "Trials Expiring" metric is the only signal an operator gets.

## Manual V1 Commercial Operations — Runbook

- **Provision a new clinic**: Platform → Provision Clinic. Have the plan, initial branch details,
  and initial admin's name/email ready. Capture the one-time activation link shown on success and
  relay it to the clinic through a secure channel — it cannot be recovered afterward.
- **Change a clinic's plan**: Organization detail → Subscription → assign the new plan. This creates
  a new subscription row; the old one is preserved as history.
- **Adjust a clinic's modules**: Organization detail → Modules — toggle individually, or "Reset to
  plan defaults" to re-seed from the current subscription's plan.
- **Suspend / reactivate**: Organization detail → "Suspend organization" (requires a reason) /
  "Reactivate".
- **Track go-live readiness**: Organization detail → Onboarding / Go-Live Conditions — update status
  and record evidence as each condition is actually satisfied.
