# P5.6 Release & Deployment Report

## Status

**RELEASED WITH LIMITATIONS**

## Release

- Version/Phase: P5.6 — SaaS Operations & Customer Provisioning
- Commit SHA: `a15890b23d2f69a2b59846469d8b2b9a1d8ce8ca`
- Branch: `main`
- Deployment environment: **production** (Vercel project `ihs`, target `production`, alias `ihs-chi.vercel.app`)
- Deployment timestamp: `2026-09-26T07:00:33.364Z`
- Deployment result: **SUCCESS** (Vercel deployment `dpl_45LYgVumZRgtHoHMJY7cp8ippmCg`, state `READY`, `githubCommitSha` verified matching)

## Pre-Release Verification

| Check               | Result    |
| ------------------- | --------- |
| Git diff reviewed   | PASS — 4 modified + 7 new files, all P5.6-scoped; `scripts/p53-cleanup.mjs` correctly left untracked (pre-existing, marked "Not part of the repo" in its own header, unrelated to P5.6) |
| P5.6 scope verified | PASS — diff stat matches exactly the accepted P5.6 changeset (regulatory surface, list filters, provisioning review, focused test) |
| Secrets check       | PASS — no `.env`, credentials, or secret values in the diff or any new file; `.env*` remains gitignored except `.env.example` |
| Typecheck           | PASS (`npm run typecheck`, clean) |
| Lint                | PASS (`npm run lint`, 0 errors; 6 pre-existing warnings in unrelated P5.3 E2E spec files) |
| Build               | PASS (`npm run build`, compiles cleanly, all `/platform/*` routes present) |
| P5.6 focused tests  | PASS — 11/11 (`test/integration/p5-6-saas-operations-provisioning.test.ts`) |
| Migration check     | PASS — confirmed no `prisma/schema.prisma` diff, no new migration folders since P5.5-Z; local `prisma migrate status` reports schema up to date; production Supabase migration history confirmed to end at P5.5-Z's own migrations, nothing new pending |
| RLS/security check  | PASS — `npm run db:security:check` (134 tables protected, local); production security advisor shows the same 2 pre-existing, unrelated WARN-level findings as before (function search_path, extension-in-public), zero RLS gaps |

## Post-Deployment Smoke Test

| Area                              | Result    |
| --------------------------------- | --------- |
| Application health                | PASS |
| Platform login                    | PASS |
| Organization list                 | PASS |
| Organization filters              | PASS |
| Provisioning review               | PASS |
| Organization provisioning         | **FAIL** (see Issues) |
| Organization detail               | PASS (verified on the existing pre-P5.1 organization; see Issues for the Regulatory-card caveat) |
| Regulatory configuration          | PARTIAL (see Issues) |
| Tenant isolation                  | PARTIAL (see Issues) |
| Representative application routes | PASS (reachable/correct-redirect only; see Issues) |

### Detail

- **Application health**: `https://ihs-chi.vercel.app` loads, redirects unauthenticated traffic to `/login`, no runtime 500, no console errors, static assets render correctly.
- **Platform login**: signed in as the existing platform operator (`bsha0517@gmail.com` — the account reset earlier this engagement). Redirected correctly to `/platform`.
- **Organization list**: `/platform/organizations` loads; shows the one pre-existing organization ("Avant Health Clinic," predates P5.1, no commercial profile).
- **Organization filters**: `?country=SA`, and the combination `?subscriptionStatus=trial&onboardingStatus=not_started&goLive=onboarding` both execute correctly (correctly return 0 results against the one non-commercial org present, no error, correct URL state, correct dropdown reflection).
- **Provisioning review**: filled a full synthetic organization (`P5.6 Release Smoke Test Clinic`, country SA) after creating one supporting synthetic commercial plan (`smoke-test`, since production had zero plans — a pre-existing, expected first-use requirement, not a P5.6 gap). The Review step rendered the exact correct summary, including the country-driven regulatory preview ("ZATCA: available — not yet configured; FBR/DHA: not applicable for this country").
- **Organization provisioning (FAIL)**: submitting "Provision Organization" failed twice, deterministically, with `Invalid prisma.role.upsert() invocation: Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5434 ms passed since the start of the transaction.` See Issues below.
- **Organization detail**: the existing organization's detail page renders correctly (branches, administrators, commercial-audit empty state). The new `RegulatoryCard` only renders for organizations with a commercial profile (by design — see `page.tsx`'s existing `{!profile ? ... : ...}` branch), and no such organization currently exists in this production database, so the Regulatory card's live rendering was **not** verified against production (it was verified locally and in the provisioning-wizard's pre-organization preview, both confirmed working this session).
- **Tenant isolation**: verified at the platform layer (operator can view/manage the existing organization). Deeper clinic-session cross-organization testing was **not** performed — no clinic-user credentials were available for this production database, and resetting one was outside this release task's authorized scope (unlike the platform-operator reset earlier this engagement, which the user explicitly requested in a separate turn). The underlying isolation code is unchanged by P5.6 and is covered by the pre-existing, passing `p5-1-commercial-saas-foundation.test.ts` suite.
- **Representative application routes**: `/dashboard`, `/patients`, `/appointments`, `/pos`, `/inventory`, `/accounting` all correctly redirect unauthenticated requests to `/login?from=...` with no 500s or console errors. Authenticated content on these routes was not exercised (same credential-availability constraint as above).

## Issues

### Issue 1 — Organization provisioning times out on production (pre-existing, not introduced by P5.6)

- **Severity**: High (blocks the primary P5.6 capability), but **not a P5.6 regression** — the failing code (`provisionClinic()`'s `db.$transaction(...)` call and `bootstrapSystemRoles()`) is unchanged, pre-existing P5.1 code. P5.6 added no new code to the provisioning transaction itself.
- **Impact**: `provisionClinic()`'s transaction has no explicit `{timeout, maxWait}` override, so it uses Prisma's 5000ms default. Under this production environment's real Vercel↔Supabase round-trip latency, the transaction's sequence of writes (organization, branch, `bootstrapSystemRoles()`'s role upserts, admin user, role/branch-access grants, password-reset token, commercial profile, subscription, 4 go-live conditions) takes slightly over 5000ms, so `prisma.role.upsert()` fails partway through with an expired-transaction error. Reproduced twice, back to back, with near-identical timing (~5434ms both times) — this is a deterministic, steady-state issue, not a one-off cold-start blip.
- **Data integrity**: **Confirmed safe.** Queried the production database directly after both failed attempts — zero orphaned `organization`, `branch`, or `user` rows in either case. The transaction's atomicity held exactly as designed; a failed provisioning attempt leaves no partial data.
- **Whether blocking**: Blocks the "Platform Operator can provision a new organization" acceptance criterion on production specifically (the identical code path was exercised successfully many times against local dev Postgres this session and in P5.1's own passing test suite — this only manifests under real Supabase network latency, which local dev and the CI-style test database never reproduce).
- **Action taken**: None — per this release task's explicit scope ("Do NOT reopen P5.1–P5.5," "Do not modify unrelated modules"), this is pre-existing P5.1 code and was not modified. Reported here rather than fixed.
- **Recommended minimum next action** (a P5.1-scope fix, out of scope for this release): add an explicit extended `{ timeout, maxWait }` option to `provisionClinic()`'s `db.$transaction(...)` call in `src/lib/domains/commercial/provisioning.ts`, matching the exact precedent already established elsewhere in this codebase for the same reason (`src/lib/platform/sequences.ts`'s `nextNumber()` and `posting-service.ts`'s `POSTING_TRANSACTION_OPTIONS`, both widened past Prisma's defaults specifically for real Supabase-pooler latency).

### Issue 2 — Minor cosmetic console warnings during the failed provisioning retry (P5.6 code, non-blocking)

- **Severity**: Low, cosmetic only.
- **Impact**: When the review-step's hidden (`hidden` attribute) form fields exist alongside a `type="submit"` button, the browser logs `An invalid form control with name='...' is not focusable` console warnings during native constraint-validation on submit. No functional effect observed — the server action fired correctly both times regardless (confirmed via network request inspection), and no user-visible error resulted from this specific warning.
- **Whether blocking**: No.
- **Action taken**: None (documented as BACKLOG-level, not fixed mid-release per "do not manufacture fixes merely to make the release look cleaner").

## Known Limitations

- FBR (Pakistan) regulatory integration is not implemented — configuration surface only.
- DHA/NABIDH (UAE) regulatory integration is not implemented — configuration surface only.
- ZATCA production connectivity is not implemented; only the Integration Sandbox surface exists (P5.5-Z).
- ZATCA sandbox credentials remain pending (no real ZATCA account was available as of P5.5-Z; unchanged by this release).
- No real clinic pilot exists yet (P5.5 remains BLOCKED for that separate reason).
- The pre-existing, already-documented integration-test-suite non-determinism (`BACKLOG.md`) remains, unrelated to this release.
- Organization provisioning currently fails on this production environment (Issue 1 above) — a pre-existing P5.1 defect surfaced by this release's own smoke testing, not introduced by P5.6.

None of the above are described as defects of the P5.6 release itself except where explicitly noted (Issue 1, surfaced but not caused by P5.6).

## Final Release Decision

**RELEASED WITH LIMITATIONS**

The P5.6 code is deployed to production, builds cleanly, passed every pre-release quality gate, and its own new capabilities (organization list filters, the provisioning review step, and the regulatory-configuration data model/preview) are verified working. However, the end-to-end "provision a new organization" happy path — the phase's central acceptance criterion — currently fails on this production environment due to a pre-existing P5.1 transaction-timeout issue that this release's own smoke test surfaced for the first time (never reproduced against local dev or the test database, both far lower-latency than production Supabase). No data corruption or security exposure resulted; the transaction rolled back cleanly both times. A minimal, precedented fix is identified above as the next action, out of this release task's own explicit scope to perform.
