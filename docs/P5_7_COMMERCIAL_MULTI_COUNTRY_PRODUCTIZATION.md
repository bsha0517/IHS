# P5.7 — Commercial Multi-Country Productization & Plan Management

## 1. Scope Delivered

A Platform Operator can define Avant commercial plans, see which country regulatory surfaces are
recommended for a clinic, compare and safely change a clinic's plan/subscription, and distinguish
what a customer's *plan* nominally includes from what is *actually* entitled on their organization —
all on top of the plan/subscription/entitlement schema P5.1 already shipped. This is **not** a
regulatory integration phase: no new FBR, DHA/NABIDH, or additional ZATCA capability was built. One
Avant Core codebase, no per-country fork.

Inspection before writing any code found that most of the requested surface already existed from
P5.1/P5.6: plan CRUD (`plans.ts`), plan activate/deactivate, a full plan list/edit UI
(`/platform/plans`), entitlement overrides with audit (`entitlements.ts`), and the subscription
mechanism (`updateSubscription`). What P5.7 actually added, after that inspection ruled out
duplicating any of it:

1. Plan-change **comparison and downgrade-safety** enforcement (`getPlanChangeImpact`), both server-
   side (`updateSubscription` now blocks) and in the `SubscriptionDialog` UI (live preview).
2. Server-side rejection of an **inactive plan** at `provisionClinic()`, plus excluding inactive plans
   from the provisioning form's plan list.
3. A small, static **Country Pack** concept (PK/SA/AE) — currency/timezone defaults and a pointer to
   which regulatory surface is relevant — surfaced as its own read-only platform page, wired into the
   provisioning form's country field as an auto-suggestion, and referenced on the organization detail
   page.
4. **EntitlementsCard** UI enhancement — every module now shows "Included by plan," "Additional
   (override)," or "Disabled," and every toggle requires an explicit confirmation dialog before it is
   applied.
5. Focused tests for all of the above, plus the existing regression suite re-run unchanged.

No schema changes were required.

## 2. Commercial Architecture (unchanged, reused)

`Organization` → `OrganizationCommercialProfile` (country, lifecycle, onboarding/UAT status) →
`OrganizationSubscription` (one row per plan-change event, history preserved — never mutated in
place) → `CommercialPlan` (code, name, active, userLimit, branchLimit, defaultModuleKeys — no price
field, by design; §36's "no pricing" constraint). Module entitlements are `Setting`-table-backed, keyed
`module_enabled:<key>`, default-enabled-unless-explicitly-disabled, and fully independent of RBAC — a
disabled module never touches what a granted permission can do, and the five core clinical modules
(reception/patients/appointments/clinical/nursing) are never route-blocked regardless of entitlement
(P5.1's clinical-safety carve-out, untouched).

## 3. Plan Management

`/platform/plans` (pre-existing, unmodified UI) lists every `CommercialPlan` and lets an operator
create or edit one via a shared `PlanDialog`, including an `active` toggle. A plan is **never hard-
deleted** — `plans.ts` only ever exposes create/update, and `updatePlan` can only flip `active`, never
remove a row. Deactivating a plan already in use by existing subscriptions leaves every historical
`OrganizationSubscription` row referencing it untouched and fully valid (verified in
`p5-7-commercial-multi-country-productization.test.ts`).

New this phase: an inactive plan is excluded from `/platform/provision`'s plan dropdown (`page.tsx`
filters `listPlans()` to `active === true`), **and** `provisionClinic()` itself now throws if called
with an inactive plan's id — the exclusion is enforced server-side, not just by the form omitting the
option.

Plan CRUD remains deliberately **not** written to `AuditLog` — a plan definition, before any
organization subscribes to it, has no `organizationId` to audit against (`AuditLog.organizationId` is
a required, non-nullable FK), and a plan by itself has no PHI/financial impact on any tenant. This is
the same, already-documented P5.1 decision; P5.7 did not change `AuditLog`'s schema to force a fit —
see §9 (Known Limitations) for what this means against the letter of the original audit requirement,
and why the four other, org-scoped audit requirements are unaffected.

## 4. Plan vs. Organization Entitlements, and Entitlement Overrides

A plan's `defaultModuleKeys` is only ever a *default bundle* — provisioning seeds an organization's
actual entitlement rows from it once, at creation. After that, the organization's entitlements are
independent: `updateModuleEntitlement()` (pre-existing, fully audited via `writeAuditLog` with the
module key, actor, old value, and new value) is the only way they ever change again, and "Reset to
plan defaults" (pre-existing) re-seeds from the *current* subscription's plan on demand.

New this phase: `EntitlementsCard` (`src/app/platform/organizations/[id]/entitlements-card.tsx`) now
computes, per module, whether it is in the org's *current* plan's `defaultModuleKeys` and labels each
row accordingly — "Included by plan" (enabled, in the plan default), "Additional (override)" (enabled,
not in the plan default), or "Disabled" (off, whether or not the plan defaults it on). Clicking any
checkbox no longer applies immediately — it opens a confirmation dialog naming exactly what will
change ("Disable Pharmacy for this organization — this overrides the current plan's default, which
includes this module.") before `updateModuleEntitlementAction` runs. The underlying audited mutation
itself is unchanged.

## 5. Country Packs

`src/lib/domains/commercial/country-packs-shared.ts` defines exactly three: PK, SA, AE — each with a
currency, a default timezone, and the regulatory surface(s) relevant to that country, reusing
`regulatory-shared.ts`'s existing `COUNTRY_INTEGRATIONS` map rather than duplicating it. This is
deliberately small and static, not a regulatory configuration engine:

| Country | Currency | Default timezone | Regulatory surface | Actual status |
|---|---|---|---|---|
| Pakistan (PK) | PKR | Asia/Karachi | FBR | Not implemented |
| Saudi Arabia (SA) | SAR | Asia/Riyadh | ZATCA | Sandbox/demo capability available (P5.5-Z) — configuration required per organization |
| United Arab Emirates (AE) | AED | Asia/Dubai | DHA/NABIDH | Not implemented |

`/platform/country-packs` is a new, read-only platform page listing these. The provisioning form's
country field now auto-suggests the matching pack's currency/timezone into the (still editable) plain
inputs, and the review step's regulatory-preview section is labeled with the Country Pack's name when
one matches. The organization detail page's Commercial Details card now shows a "Country Pack" row
tying the org's own country to the matching pack (or "No pack defined for this country" for any
country outside PK/SA/AE). None of this claims certification, compliance, or approval anywhere —
verified by an automated string check against the pack data itself.

## 6. Provisioning Integration

`provisionClinic()` itself is functionally unchanged except for the inactive-plan guard (§3) — it
still reuses P5.1.1's `{ timeout: 20_000, maxWait: 10_000 }` transaction options unmodified (re-
verified directly in `p5-7-commercial-multi-country-productization.test.ts` via the same
`vi.spyOn(db, "$transaction")` pattern P5.1.1's own test uses), still seeds module entitlements from
the selected plan's defaults post-commit, and still issues an activation token rather than any
operator-visible password. Country Packs only ever influence two plain, editable form fields
(currency, timezone) before submission — provisioning's own input contract (`ProvisionClinicInput`)
was not changed.

## 7. Upgrade/Downgrade Safety

`getPlanChangeImpact(organizationId, newPlanId, overrides?)` (new,
`src/lib/domains/commercial/organizations.ts`) is a read-only preview, reusing the same
`db.user.count`/`db.branch.count`(active-only)/`getModuleEntitlements` calls the rest of the file
already uses for limit enforcement — no second usage-counting mechanism. It returns the current vs.
new plan, active user/branch counts against the new effective limit (plan's own limit, or an explicit
per-organization override), and which modules the new plan's defaults would add or remove relative to
the org's *current* entitlements (informational only — it never itself changes an entitlement).

`updateSubscription()` calls this before creating the new `OrganizationSubscription` row and throws
`SubscriptionLimitError` if `blocked` is true — e.g. *"Cannot apply this plan — current active users
(2) exceed the new limit (1). Reduce active users or select a higher limit before changing plans."*
Blocking never deactivates a user or branch to "make room" — the operator must reduce usage or choose
a higher limit first (verified: active user count is unchanged after a blocked attempt). An upgrade
(or any change the new/overridden limit accommodates) still creates a fresh subscription row,
preserving history exactly as before.

`SubscriptionDialog` (`src/app/platform/organizations/[id]/subscription-dialog.tsx`) now calls a new,
read-only `getPlanChangeImpactAction` server action every time the selected plan or either limit
override changes, and renders the same comparison inline — current plan, new plan, active users/new
limit, active branches/new limit, and which modules would be added/removed — disabling "Save" and
showing the block reason(s) whenever the preview reports `blocked`. The server-side check in
`updateSubscription` is the actual enforcement; the UI never relies on itself alone.

## 8. Security

Every function this phase added or touched self-guards via the existing, unchanged
`requirePlatformOperator()` chokepoint — `getPlanChangeImpact`, the inactive-plan check inside
`provisionClinic`, and the already-audited `updateModuleEntitlement`/`updateSubscription` it calls
into. No new route or server action bypasses this. Verified directly: calling
`updateModuleEntitlement` with no platform session (the mocked cookie jar returning no token) throws
`PlatformForbiddenError`, the same guard error every other commercial platform function throws.

## 9. Tests

New: `test/integration/p5-7-commercial-multi-country-productization.test.ts` — 15 tests covering plan
create/duplicate-code rejection, deactivate-but-never-delete + historical-subscription survival,
inactive-plan rejected by `provisionClinic`, entitlement override audit (both enabling a non-default
module and disabling a plan-default one), the clinic/no-session caller being rejected,
`getPlanChangeImpact`'s read-only added/removed-module reporting, downgrade blocked when active users
exceed the new limit (and that it never silently deactivates anyone), an upgrade succeeding and
preserving subscription history, an explicit per-organization override limit un-blocking an otherwise-
blocked change, the PK/SA/AE Country Pack data itself (currency/timezone/regulatory-surface mapping,
case-insensitive lookup, no compliance-claim wording), and a full provisioning run confirming the
P5.1.1 timeout options and plan-default entitlement seeding both still hold. All 15 pass.

Regression (unchanged behavior, re-run in full): `p5-1-commercial-saas-foundation.test.ts` (28),
`p5-6-saas-operations-provisioning.test.ts` (11), `p5-1-1-provisioning-transaction-timeout.test.ts`
(1), `branch-isolation.test.ts` (14) — 54/54 passing.

## 10. Known Limitations

- Plan CRUD (create/edit/activate/deactivate) is still not written to `AuditLog`, for the same reason
  documented in `plans.ts` since P5.1: `AuditLog.organizationId` is a required FK and a bare plan
  definition has no organization to scope to. This phase deliberately did not alter that schema to
  force a fit. Every plan-change action that *does* affect a real organization — subscription/plan
  changed, entitlement override, regulatory configuration — remains fully audited, unchanged.
- Country Packs cover exactly PK/SA/AE, matching the three countries P5.5-Z/P5.6's regulatory surface
  already recognizes. Adding a fourth country means adding one more static entry, not a schema or
  architecture change.
- `getPlanChangeImpact`'s module added/removed comparison is informational only — it does not itself
  apply any entitlement change; an operator who wants entitlements to match the new plan's defaults
  still uses the pre-existing, separate "Reset to plan defaults" action.
- As with P5.6/P5.1.1, `requirePlatformOperator()` is exercised in tests via a mocked `next/headers`
  cookie jar backing a real, DB-issued `PlatformSession` token, not a live HTTP request — covered
  instead by manual browser verification against the local dev server.
