# P5.1.1 Production Provisioning Timeout Fix

## Status

**PASS**

## Original Production Failure

Discovered during the P5.6 production release smoke test. Submitting the provisioning form on
production failed twice, deterministically, with:

```
Invalid `prisma.role.upsert()` invocation: Transaction API error: A query cannot be executed on
an expired transaction. The timeout for this transaction was 5000 ms, however 5434 ms passed
since the start of the transaction.
```

- Prisma's default interactive-transaction timeout is 5000ms.
- The observed production failure occurred at ~5434ms — the transaction's real work took
  slightly longer than the default under this environment's genuine Vercel↔Supabase network
  latency.
- The failing operation was `prisma.role.upsert()`, called from inside `bootstrapSystemRoles()`.
- The transaction rolled back correctly both times — direct database inspection after each
  failed attempt found zero orphaned `organization`, `branch`, or `user` rows.
- The identical code path had already passed dozens of times in local development and the
  automated test suite, both against near-zero-latency Postgres connections, which is why this
  was never caught before a real production run.

## Root Cause

`provisionClinic()` (`src/lib/domains/commercial/provisioning.ts`) wraps its entire provisioning
sequence in one `db.$transaction(async (tx) => { ... })` call with no explicit options, so it used
Prisma's 5000ms default. Inside that transaction: organization create, branch create,
`bootstrapSystemRoles(tx, organization.id)` (which loops over every system role doing an upsert
plus a permission-grant delete/recreate), an admin user create, role/branch-access grants, a
password-reset/activation token, a customer-code count, a commercial-profile create, a
subscription create, and four go-live-condition creates — a genuinely large sequential operation
count for one transaction. Under production's real network round-trip to Supabase, this
consistently took slightly over 5000ms, so Prisma terminated the transaction mid-way through
`bootstrapSystemRoles()`'s own role upserts.

This is exactly the same class of issue already documented and fixed elsewhere in this codebase
(see Fix section) — `provisionClinic()`'s own transaction was simply the one call site that had
not yet received that treatment.

## Fix

- **File changed**: `src/lib/domains/commercial/provisioning.ts` (one line).
- **Previous behavior**: `db.$transaction(async (tx) => { ... })` — Prisma's 5000ms
  default/2000ms `maxWait`.
- **Transaction options added**: `{ timeout: 20_000, maxWait: 10_000 }`.
- **Chosen timeout**: 20,000ms.
- **Chosen maxWait**: 10,000ms.
- **Why these values**: not arbitrary — this is the exact, already-established Avant HIS
  convention for a transaction that needs headroom under real Supabase-pooler latency. The
  identical `{ timeout: 20_000, maxWait: 10_000 }` pair is already used at ~20 other call sites
  across this codebase for precisely this reason, including `posting-service.ts`'s own
  `POSTING_TRANSACTION_OPTIONS` constant (referenced by name in the doc comments of most of the
  others), `src/lib/platform/sequences.ts`'s `nextNumber()`, `src/lib/domains/billing/invoices.ts`'s
  `generateInvoice()`, `src/lib/domains/billing/payments.ts`, `refunds.ts`, `charges.ts`,
  `src/lib/domains/procurement/goods-receipts.ts`, `src/lib/domains/appointments/service.ts`,
  `src/lib/domains/assets/assets.ts`, `src/lib/platform/event-handlers.ts`'s
  `COMMISSION_TRANSACTION_OPTIONS`, and several more. `provisionClinic()`'s own transaction does
  at least as much sequential work as any of these, so reusing this exact, already-battle-tested
  value — rather than inventing a new one — was the correct, minimal choice.
- The transaction **body is otherwise completely unchanged** — same operations, same order, same
  single atomic boundary.

## Safety

- **Atomicity preserved**: confirmed directly in production — a successful provisioning run
  (below) created exactly one complete, consistent record set; no operation was moved outside
  the transaction.
- **Idempotency preserved**: `claimPlatformIdempotencyKey`/`recordPlatformIdempotentResult` calls
  are untouched, still the first and last statements inside the same transaction.
- **Concurrency protections preserved**: no change to how concurrent requests are handled; the
  existing idempotency-key claim mechanism (unique-constraint-backed) is untouched.
- **Tenant isolation unchanged**: verified directly in production — the newly provisioned
  organization and the pre-existing organization have fully distinct IDs, branches, and users
  with zero overlap (see Production Verification).
- **RLS unchanged**: no RLS policy or table-grant script was touched by this fix.
- **No schema changes**: confirmed — `git diff -- prisma/schema.prisma` is empty, no new
  migration folder was created, and this fix required none.

## Tests

- **P5.1.1 focused test** (new): `test/integration/p5-1-1-provisioning-transaction-timeout.test.ts`
  — spies on `db.$transaction` (wrapping, not replacing, the real implementation) to confirm
  `provisionClinic()` actually calls it with `{ timeout: 20_000, maxWait: 10_000 }`, then asserts
  the resulting organization/branch/admin/commercial-profile/go-live-condition rows are exactly
  as expected — proving the fix is present and the transaction body is functionally unchanged,
  without needing the automated suite to wait past 5 seconds to reproduce real production
  latency (per this task's own explicit guidance). **1/1 PASS**, confirmed deterministic across
  repeated runs.
- **P5.1 focused tests** (`test/integration/p5-1-commercial-saas-foundation.test.ts`, unchanged):
  **29/29 PASS** — session-plane isolation, provisioning correctness, idempotency, user/branch
  limits, RBAC-vs-entitlement separation all still hold.
- **P5.6 focused tests** (`test/integration/p5-6-saas-operations-provisioning.test.ts`, unchanged):
  **11/11 PASS** — concurrent provisioning, list filters, regulatory configuration all still hold.
- **Combined**: 41/41 PASS across all three files, confirmed deterministic across two consecutive
  runs.
- **Typecheck**: `npm run typecheck` — clean.
- **Lint**: `npm run lint` — 0 errors (same 6 pre-existing, unrelated warnings in P5.3 E2E spec
  files, untouched).
- **Build**: `npm run build` — compiles successfully.

## Deployment

- Commit SHA: `4b8092949df2cc7add44bf6b04e69566100c9d39`
- Branch: `main`
- Deployment ID: `dpl_HYpa1qRWtY1dvfkXzfJJo4WDceVF`
- Deployment status: `READY`
- Environment: **production** (Vercel project `ihs`, alias `ihs-chi.vercel.app`) — deployed
  commit SHA confirmed matching exactly via the Vercel deployment metadata.

## Production Verification

- **Synthetic organization name**: `P5.1.1 Provisioning Verification Clinic` (country: SA; plan:
  the existing `P5.6 Smoke Test Plan`, reused rather than creating a new one).
- **Provisioning result**: **Succeeded** — "Clinic provisioned — AVT-000001," no expired-transaction
  error, no error of any kind.
- **Approximate duration**: not precisely instrumented server-side, but observed wall-clock time
  from submit to result was on the order of several seconds beyond the old 5-second limit and
  well within the new 20-second ceiling — consistent with the original ~5434ms measurement, now
  safely inside the widened timeout.
- **Organization**: exactly one row (`AVT-000001`, "P5.1.1 Provisioning Verification Clinic",
  country SA, status Active).
- **Branch**: exactly one ("Riyadh P511 Verification Branch," code `RYD-P511-01`, Active).
- **Administrator**: exactly one (name/email as entered, status Active, no password/activation
  token recorded here per this task's own instruction).
- **Commercial profile**: present, customer code `AVT-000001`.
- **Subscription**: present, Trial status, correct plan.
- **Entitlements**: seeded — 1/17 modules enabled (Reception, matching the one module selected
  during provisioning), each recorded individually in the commercial audit log.
- **Onboarding/go-live initialization**: onboarding checklist seeded (0/8 required complete, not
  started); all 4 go-live conditions seeded as pending, none pre-completed.
- **Regulatory Card**: rendered correctly on the organization detail page —
  "ZATCA (Saudi Arabia e-invoicing): Not Configured [Configure]," "FBR (Pakistan tax authority):
  Not Applicable For This Country," "DHA / NABIDH (UAE healthcare): Not Applicable For This
  Country." No "certified"/"compliant"/"approved" language anywhere.
- **Organization filters**: verified against the new organization directly on production —
  `?country=SA` returns exactly it; the combination
  `?subscriptionStatus=trial&onboardingStatus=not_started&goLive=onboarding` also returns exactly
  it.
- **Duplicate/orphan check**: direct database query confirms exactly one organization matching
  this name exists (no duplicate from any retry), and the two organizations now present in
  production (`Avant Health Clinic` and this new one) have fully distinct, non-overlapping
  branch/user sets — 2 branches / 15 users vs. 1 branch / 1 user, zero cross-tenant leakage.

## Remaining Limitations

(Unchanged by this hotfix — carried forward from P5.5-Z/P5.6.)

- FBR (Pakistan) regulatory integration remains not implemented.
- DHA/NABIDH (UAE) regulatory integration remains not implemented.
- ZATCA production connectivity remains not implemented; only the Integration Sandbox surface
  exists.
- ZATCA sandbox credentials remain pending.
- No real clinic pilot exists yet.
- The pre-existing, already-documented integration-test-suite non-determinism (`BACKLOG.md`)
  remains, unrelated to this fix.
- The minor cosmetic browser console warning ("An invalid form control... is not focusable")
  noted in the P5.6 release report remains an open, non-blocking BACKLOG item — it did not
  prevent this verification and was not touched by this hotfix.
- Deeper authenticated clinic-session cross-tenant testing was not performed on production (no
  clinic-user credentials available/authorized for this task) — tenant separation was instead
  verified via direct, read-only database inspection (see Production Verification above) and the
  unchanged, passing `p5-1` test suite.

## Final Decision

**P5.1.1 ACCEPTED**
