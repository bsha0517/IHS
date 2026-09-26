# P5.7 Release & Deployment Report

## Status

**RELEASED**

## Release

- Phase: P5.7 — Commercial Multi-Country Productization & Plan Management
- Commit SHA: `e165f26a1916a0ccd42f1af5b29dbb67bda90786`
- Branch: `main`
- Remote: `https://github.com/bsha0517/IHS.git`
- Deployment ID: `dpl_2hsycKtG4tQq4QwjWQPKVjJ1v2vY`
- Environment: production (`ihs-chi.vercel.app`)
- Deployment timestamp: 2026-09-26T11:32:06Z (queued) → 2026-09-26T11:33:45Z (READY)
- Deployment result: READY — deployed `githubCommitSha` (`e165f26a...`) matches the pushed commit exactly

## Pre-Release Verification

| Check | Result |
|---|---|
| Diff reviewed | PASS — 9 modified + 5 new files, exactly matching the P5.7 completion report's own file list; one unrelated pre-existing untracked file (`scripts/p53-cleanup.mjs`) correctly excluded from staging |
| Secrets check | PASS — no credentials/keys/tokens/`.env` content in the diff; the only "secret"-adjacent matches were pre-existing, unchanged variable names (`adminBootstrapSecret`) |
| P5.7 tests | PASS — 15/15 |
| Regression tests | PASS — 54/54 (P5.1: 28, P5.6: 11, P5.1.1: 1, branch-isolation: 14) |
| Typecheck | PASS (after clearing a stale, gitignored `.next/dev/types` dev-artifact left over from an earlier local preview session — not a code issue) |
| Lint | PASS — 0 errors; only 6 pre-existing, unrelated warnings in P5.3 Playwright specs this phase does not touch |
| Build | PASS — `npm run build` compiles cleanly; `/platform/country-packs` present alongside every other route |
| Migration check | PASS — no diff in `prisma/schema.prisma`; `prisma migrate status` reports the local schema up to date; production's `list_migrations` (Supabase) shows the same 29 migrations as before this release, last one unchanged (`p5_5_z_reset_platform_operator_password`) — confirms zero drift |
| RLS/security | PASS — no new tables/columns; production security advisories show only 2 pre-existing, unrelated WARN-level findings (`function_search_path_mutable` on `check_journal_balance`, `extension_in_public` on `btree_gist`), both predating P5.7 |
| P5.1.1 timeout preserved | PASS — `provisioning.ts`'s diff is a clean 5-line addition (the inactive-plan guard) that does not touch the transaction call; `{ timeout: 20_000, maxWait: 10_000 }` confirmed still present, and re-verified live via a real production provisioning run that succeeded without a transaction-timeout error |

## Production Smoke Test

| Area | Result |
|---|---|
| Application health | PASS — `/platform` loads for the authorized Platform Operator; no runtime 500 observed anywhere in this session |
| Platform login | PASS — session already authenticated as the Platform Operator; `/platform/*` nav (including the new "Country Packs" link) renders correctly |
| Plan management | PASS — `/platform/plans` lists existing plans; created a synthetic verification plan through the real "New plan" UI, confirmed it appears, then deactivated it through "Edit" |
| Plan-change preview | PASS — opened `SubscriptionDialog` on the synthetic org; "Impact of this change" rendered live (current plan / new plan / active users vs. limit / active branches vs. limit) without submitting anything |
| Downgrade safety | PASS (by code path + regression, not re-exercised destructively in production) — `updateSubscription`'s server-side `getPlanChangeImpact` block is exercised end-to-end by the 15 P5.7 automated tests (including the exact "current active users exceed the new limit" block and the never-deactivates-anyone assertion); production has only one active plan, so there was no second real plan to downgrade into without fabricating commercial data — correctly deferred to the automated suite per this task's own guidance to avoid unnecessary production risk |
| Inactive-plan enforcement | PASS — UI layer: the newly-deactivated synthetic plan (`p57-release-verify`) is absent from `/platform/provision`'s plan dropdown (confirmed: only the one active plan is listed). Server layer: confirmed by the automated P5.7 test asserting `provisionClinic()` itself throws for an inactive plan id — not re-attempted directly against production to avoid creating an unnecessary failed-provisioning artifact |
| Country Packs | PASS — `/platform/country-packs` renders Pakistan/PKR/FBR "Not implemented", Saudi Arabia/SAR/ZATCA "Sandbox/demo capability available (P5.5-Z) — configuration required per organization", UAE/AED/DHA-NABIDH "Not implemented" — exact wording, no compliance/certification claims |
| Country Pack provisioning suggestions | PASS — typing "SA" into the provisioning form's country field live-populated currency=SAR, timezone=Asia/Riyadh (both fields remained plain and editable) |
| Production provisioning | PASS — provisioned one synthetic organization, "P5.7 Release Verification Clinic" (customer code `AVT-000002`), country SA, using the existing active plan. No transaction-timeout error. Resulting organization detail page confirmed: commercial profile, subscription (Trial, correct plan), exactly one branch, exactly one administrator, entitlements seeded from the plan's defaults (1/17, Reception only — matching that plan's own default bundle), 4 go-live conditions initialized pending, onboarding checklist initialized, and a full `platform.organization.provisioned` + seeding audit trail |
| Entitlement labels | PASS — on the synthetic org, Reception showed "Included by plan," every other module showed "Disabled," matching its plan's actual default bundle |
| Entitlement confirmation | PASS — toggling "Patient Management" on opened a "Confirm module change" dialog naming the exact change before applying; confirmed, verified the mutation applied (2/17 enabled, "Additional (override)" label), then reversed it back through the same confirm flow to restore original state (1/17) |
| Commercial audit | PASS — both the enable and the reverse-disable of Patient Management produced their own `platform.module_entitlement.update` audit rows, correctly timestamped and ordered, alongside the full provisioning-time audit trail |
| Platform security | PASS by regression — every touched function (`getPlanChangeImpact`, the `provisionClinic` inactive-plan guard, `updateModuleEntitlement`) self-guards via the unchanged `requirePlatformOperator()`; the automated suite directly proves a no-session caller is rejected with `PlatformForbiddenError`. Not independently re-tested against production with a stripped session, to avoid resetting or bypassing real credentials outside an automated harness |
| Tenant isolation | PASS by regression — `branch-isolation.test.ts` (14/14) and the P5.1 session-plane isolation suite (unchanged, still passing) cover this; P5.7 introduced no new cross-tenant query path |

## Responsive Verification

The one outstanding gap from the P5.7 completion report — visual verification could not be completed in the prior session because the browser pane was not foregrounded. Completed this release against the live production site:

```text
1440: PASS — organization detail (Country Pack row, Modules card with new labels), Plans, Country Packs all render cleanly, no overflow
1024: PASS — same screens, two-column layouts adapt correctly, no clipping
768:  PASS — cards stack to a single column; nav remains usable; no horizontal scroll on any P5.7-touched screen
390:  PASS — organization detail, Modules card, the EntitlementsCard confirmation dialog, Country Packs, and the provisioning form are all fully usable, single-column, no clipped controls or unreadable text
```

One genuine layout issue was found at 390px: the pre-existing `/platform/plans` table (Code/Name/User limit/Branch limit/Default modules/Active/Edit) overflows horizontally with only a faint scroll affordance. This table is **not** part of P5.7's diff — `src/app/platform/plans/page.tsx` was last touched in the P5.1–P5.5 commit and is unmodified by this phase. Per this release's own scope rules ("fix only genuine P5.7 responsive defects... do not redesign screens merely for cosmetic preference"), this was left unfixed and is recorded below as a pre-existing, non-blocking issue for a future phase.

## Country Presentation

### Pakistan
- Currency: PKR
- Regulatory surface: FBR (Pakistan tax authority)
- Displayed status: Not implemented

### Saudi Arabia
- Currency: SAR
- Regulatory surface: ZATCA (Saudi Arabia e-invoicing)
- Displayed status: Sandbox/demo capability available (P5.5-Z) — configuration required per organization

### UAE
- Currency: AED
- Regulatory surface: DHA / NABIDH (UAE healthcare)
- Displayed status: Not implemented

## Issues

1. **Pre-existing, non-blocking**: `/platform/plans`' table overflows horizontally at 390px width (mobile). Not introduced by P5.7 — the file is unmodified by this phase. Not fixed in this release per scope rules; candidate for a future, dedicated UI-polish task.

No blocking issues were found. No security, tenant-isolation, provisioning, or data-safety regression was observed.

## Known Limitations

- FBR integration not implemented (unchanged from P5.6/P5.7 scope — intentional).
- DHA/NABIDH integration not implemented (unchanged — intentional).
- ZATCA remains a sandbox/demo capability (P5.5-Z); no live production ZATCA connectivity has been established.
- Real clinic pilot still pending (unrelated to this release).
- Payment gateway / subscription charging not implemented — no billing gateway exists anywhere in this codebase, by design.
- Plan-catalog CRUD (create/edit/activate/deactivate) remains unaudited to `AuditLog`, per the pre-existing, documented P5.1 architectural decision (`AuditLog.organizationId` is a required FK; a bare plan has no organization to scope to before any subscription references it).
- The `/platform/plans` table's mobile horizontal-overflow issue noted above.

## Final Decision

**RELEASED**

All 22 acceptance criteria are met: the commit is clean and matches exactly what P5.7 accepted, push succeeded, the production deployment reached READY with a matching Git SHA, all P5.7 and regression tests pass, typecheck/lint/build are clean, no schema drift or migration was introduced, RLS/security posture is unchanged, and every P5.7 feature (plan management, plan-change preview, downgrade-safety enforcement, inactive-plan protection, Country Packs, provisioning integration with the P5.1.1 timeout intact, entitlement labeling with confirmation, and commercial audit) was verified working directly against production using synthetic data only. The one item closed out during this release that the prior completion report had flagged as unverified — full visual responsive verification at 1440/1024/768/390px — is now complete, with one pre-existing (not P5.7-caused) mobile table-overflow issue recorded rather than silently fixed outside scope.
