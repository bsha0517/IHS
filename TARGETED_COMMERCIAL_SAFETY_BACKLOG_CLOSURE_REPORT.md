# Targeted Commercial / Safety Backlog Closure Report

**Scope**: a short, tightly-bounded cleanup of 12 named issues before clinic
onboarding/import work begins — explicitly NOT P4.6, not a whole-project
audit, not a BACKLOG.md sweep. P0–P4.5 are complete and closed; this batch
did not reopen them except where P4.5's own `take: 200` performance fix is
directly superseded by item 2 below (documented, not silently changed).

## Executive Summary

All 12 named items were verified first, then fixed only where still
reproducible. **9 of 12 were genuinely still broken and were fixed**; item
10 was a mix (one already-broken assertion fixed, one genuine orphaned-
fixture bug fixed, one flaky-test claim investigated at length but not
reproduced); one entirely new, unrelated intermittent flaky test was
discovered in passing during required regression testing and flagged as a
background task rather than fixed (out of this batch's named scope). No
BLOCKER or correctness-weakening change was made anywhere. Two narrow,
analogous-to-existing-patterns schema migrations were added (radiology
report amendment, pharmacy substitution confirmation). Full regression
(`prisma validate`, `migrate status`, typecheck, lint, the full integration
suite run three times, production build) is clean. **This batch can be
closed — see Acceptance Decision.**

## Scope Boundary

Confirmed respected throughout: no Purchase Order approval workflow, no
bank/cash reconciliation, no employee self-service, no pain-score field, no
low-stock/near-expiry notifications, no Notification mark-unread/archive, no
direct Accountant dead-letter routing, no payroll country-profile adapters,
no provider↔user post-creation editing UI, no role permission-dependency
warnings, no pharmacy CreditNote/invoiced-return architecture, no automatic
pharmacy substitution engine, no full episode-detail feature, no tab-
wrapping cleanup, no leave-attendance integration, no overlapping-leave
policy, no inactive-branch picker cleanup, no duplicate-registration policy
change, no new regulatory integrations, no MFA, no Sentry, no production
cloud load testing. One genuinely new, unrelated finding (an intermittent
notification-type test flake, unconnected to any of the 12 items) was
discovered during required regression runs and flagged via a background
task rather than fixed inline, per the same scope-control discipline.

## Issues Verified

Every item below was traced against the current codebase before any change
was made — none were assumed still-broken from BACKLOG.md's own prior
description.

| # | Item | Status before this batch |
|---|---|---|
| 1 | Lab/Radiology invalid `status` query param | Still reproducible — confirmed by direct code read (`filters.status as never`) |
| 2 | Lab/Radiology `take: 200` cap | Still in place (P4.5's own fix) — a real correctness gap (hides row 201+) |
| 3 | Doctor `/appointments` crash | Still reproducible — `listServices` still called unconditionally |
| 4 | Not-found/wrong-branch generic error boundary | Still reproducible — no `[id]` page had a try/catch |
| 5 | Clinical section actions swallow errors | Still reproducible on 4 sections; `cancelPrescriptionAction` already fixed (documented, not re-fixed) |
| 6 | Stale-ID `findFirstOrThrow` leaks | Still reproducible on all 6 named functions |
| 7 | No radiology report amendment | Still true — no `isCurrent`/`amendsId`-equivalent on `ImagingOrder` |
| 8 | No medication-mismatch confirmation | Still true — only a visual "Prescribed: ..." block, no enforcement |
| 9 | Multi-tender payment traceability | Confirmed real — `recordPayment` can create 2+ Payment rows in one call, trace view only ever showed the first |
| 10A | Floating-point flaky assertion | Still present (`toBe(500)` on a float subtraction) |
| 10B | P3.12 orphaned fixture org | Still present — confirmed 9 accumulated orphaned orgs in `his_test` |
| 10C | P3.13 sequence-dependent flaky assertion | Could not be located/reproduced — see its own section below |
| 11 | Login enumeration via "inactive" message | Still reproducible on both staff and portal login |
| 12 | Performance doc overstatements | Confirmed present in both `docs/PERFORMANCE_CAPACITY.md` and the P4.5 report |

## Issues Already Resolved Before This Batch

None of the 12 named items were found already resolved — every one required
either a real fix or, for item 10C, a documented "could not reproduce."
(`cancelPrescriptionAction`'s server-side try/catch, within item 5's scope,
was already correct and used as the reference pattern for the other three.)

## Fixes Implemented

### Lab/Radiology Status Validation (item 1)

`/laboratory?status=pending` and `/radiology?status=pending` previously 500'd
(Prisma validation error on an invalid enum value). Both pages now validate
the raw query-string value against a real `$Enums.ClinicalOrderStatus[]`
list before use, falling back to the existing default filter for anything
invalid — the exact convention `clinical/orders.ts`'s own `listOrders` /
`orders/page.tsx` already established elsewhere in this codebase, reused
here rather than invented. `listLabQueue`/`listRadiologyQueue`'s own
`filters.status` parameter is now typed as the real enum (not a raw
`string` cast with `as never`), so an invalid value can no longer reach
Prisma at all. **Verified live in the browser**: `/laboratory?status=pending`
and `/radiology?status=pending` both render their default queue cleanly, no
crash, no raw error.

A related, broader finding — the same unvalidated-cast pattern exists in
roughly a dozen other `list*` functions across the codebase — was noticed
in passing and logged to BACKLOG.md rather than fixed (out of this item's
Lab/Radiology-only scope).

### Lab/Radiology Pagination (item 2)

P4.5's own `take: 200` safety cap silently hid order 201+ with no way to
reach it — judged unacceptable for a clinical operational queue.
`listLabQueue`/`listRadiologyQueue` now return
`{orders, total, page, pageSize, totalPages}` using this codebase's
existing `resolvePage`/`paginationSkipTake`/`totalPages` convention (the
same one every other paginated list already uses), with `PaginationControls`
added to both pages, both filters preserved, deterministic ordering (`orderedAt`
+ `id` tiebreak), and branch scoping unchanged. Default page size 50.

**Before/after** (measured directly, not inferred): 478 unbounded rows / 76-267ms
warm → ≤50 per page / 69-120ms warm, every row reachable via Next/Previous.

7 dedicated integration tests: first page exact size + correct total/totalPages,
second page holds the real remainder (no order silently disappears), deterministic
ordering across repeated calls, filtering+pagination compose correctly, branch
isolation holds under pagination, radiology mirrors the same shape.

`docs/PERFORMANCE_CAPACITY.md` and the P4.5 report were both updated to
describe this replacement accurately (see item 12D below) rather than
leaving a stale `take: 200` claim standing.

### Doctor Appointments Access (item 3)

`/appointments` called `listServices(session)` unconditionally, requiring
`service.view` — a permission Doctor doesn't hold, crashing the whole page.
The service catalog is only ever actually used by `NewAppointmentDialog`,
itself only rendered for `appointment.create` holders (which Doctor also
lacks) — so the fetch is now gated on that same permission, rather than
granting Doctor `service.view` (current product design gives no reason
Doctor should browse the service catalog). **Verified live**: created a real
Doctor-role test user, logged in as them, opened `/appointments` — renders
cleanly (appointments list, no "New Appointment" button, zero console
errors), deactivated the test user afterward.

### Not-Found / Wrong-Branch UX (item 4)

Every named operational `[id]` page (appointments, patients, encounters,
invoices, the payment receipt print view, lab/radiology order detail) called
its `getX(session, id)` fetch with no try/catch, so both a stale/foreign id
(Prisma P2025) and a wrong-branch id (`ForbiddenError`) fell through to the
fully generic `(dashboard)/error.tsx` ("Something went wrong... this has
been logged"). A small new helper, `loadOrNotFound()`
(`src/lib/platform/not-found.ts`), wraps the fetch and calls Next's
`notFound()` for either case — routing to the dashboard's own already-
correctly-worded `not-found.tsx` ("doesn't exist, or you no longer have
access to it"). Deliberately does **not** distinguish "not found" from
"forbidden" in what it shows, so a wrong-branch/wrong-org id can never
reveal that a record with that id actually exists — matching the acceptance
criteria's own anti-leak requirement. Any other error type is rethrown
unchanged, still reaching the real error boundary.

**Verified live**: `/appointments/<bogus-id>` and `/invoices/<bogus-id>`
both show the friendly not-found page. Also unit-tested directly (2 tests:
the two "no access, however you slice it" cases both call `notFound()`; a
genuine unrelated error is never swallowed into a false 404).

### Clinical Action Error Handling (item 5)

`DiagnosesSection`'s "Mark resolved", `OrdersSection`'s "Cancel", and
`FollowUpSection`'s "Dismiss" all called their server action inside a bare
`startTransition(async () => { await fn(); router.refresh() })` with no
try/catch — a rejected call became an unhandled promise rejection, visible
only as the generic route error boundary. All three now use the same local
`run()` helper (try/catch, inline `Alert`, dialog stays usable after
failure) `EncounterHeader` already established for its own actions.
`PrescriptionsSection`'s "Cancel" was already correct (server action already
returned `{error}`) — used as the reference pattern, not re-fixed.

Went one step further than the client alone: the three underlying server
actions (`updateDiagnosisStatusAction`, `cancelOrderAction`,
`dismissFollowUpAction`) previously threw unguarded server-side too, which
Next.js scrubs to a generic message before it ever reaches a client
try/catch. All three now catch server-side and return the file's own
established `{error}`/`{success}` `ActionState` shape, so the real, specific
domain message (not a scrubbed generic one) reaches the user.

### Stale-ID Error Sanitization (item 6)

`updateDiagnosisStatus`, `cancelOrder`, `updateOrderStatus`,
`cancelPrescription`, `dismissFollowUp`, and `createAmendment`'s own
secondary "fetch the row being updated" lookups all used `findFirstOrThrow`,
leaking Prisma's raw "Invalid `db.X.findFirstOrThrow()` invocation..."
message for a stale/foreign id. All six now use `findFirst` + a friendly,
domain-specific thrown `Error` — the exact two-line pattern already
established elsewhere in this codebase (`vitals.ts`'s own fix). Verified via
a dedicated test asserting all six throw a friendly message for a genuinely
random UUID, and that none of the five ever surface `PrismaClientKnownRequestError`
or `Invalid \`db.` text.

### Radiology Report Amendment (item 7)

See BACKLOG.md's own updated entry and §"Radiology Report Amendment" in the
schema for the full reasoning. Summary: `ImagingOrder.clinicalOrderId` is
`@unique` (unlike `LabOrderTest`, which already supports many rows per
order), so Lab's exact `isCurrent`/`amendsId`-on-the-same-table pattern
isn't directly available without a much wider, riskier uniqueness change. A
narrow, dedicated `ImagingReportAmendment` table gets the same outcome
instead: the original `ImagingOrder` row stays completely frozen forever
once verified; a correction is a new, independently-attributed row; "current"
is derived (latest amendment, else the original) — never a separate stored
flag that could drift.

- `amendImagingReport(session, imagingOrderId, {reportText, impression?, reason})` —
  gated on `imaging_order.perform` (same as `writeReport`), requires
  `order.status === "verified"`, requires a non-empty `reason` (a deliberate,
  stricter divergence from Lab's own optional `notes` — the task's own
  explicit requirement).
- "Amend report" dialog on the radiology order detail page, next to the
  existing Verify button, with a required reason field.
- Full amendment history shown inline (original + every correction, oldest
  first, current one visually distinguished with a badge), each entry
  independently attributed (actor, timestamp, reason).
- Patient 360's Imaging tab and the printable radiology report view both
  now show the CURRENT report (latest amendment if any, else the original),
  not the frozen original.

7 dedicated integration tests: only a verified report can be amended, a
reason is required, the original is never overwritten, current-version
derivation is correct across 2 amendments, Patient 360 shows the current
impression, branch isolation holds, a stale id returns a friendly error.

### Pharmacy Medication Mismatch Confirmation (item 8)

`looksLikeSameMedication()` (`src/lib/utils/medication-match.ts`) — a
deliberately simple, non-clinical, case-insensitive equality/substring
check, never a fuzzy-matching library, used only to decide when to ask for
confirmation, never to make a clinical claim. Shared between the client
dialog (shows the warning immediately, with a required confirmation
checkbox that disables the Dispense button until checked) and
`createDispensingRecord` (the server-side mirror — the requirement can't be
bypassed by a client that skips the warning). Never auto-substitutes, never
blocks a legitimate brand/generic substitution — an obvious match needs no
confirmation at all. A new `DispensingRecord.substitutionConfirmed` boolean
records whether a given dispense was an explicit, confirmed substitution
(default `false`).

3 dedicated integration tests: an obvious match needs no confirmation and
isn't recorded as a substitution; a mismatch without confirmation is
rejected with a clear message and creates no record; a mismatch with
confirmation succeeds, is durably recorded, and survives the verify/dispense
transitions unchanged. 9 pre-existing P3.6 test fixtures (which used
non-matching names incidentally, unrelated to what they were testing) were
updated to pass `substitutionConfirmed: true`.

### Multi-Tender Accounting Traceability (item 9)

Confirmed real, not assumed: `recordPayment` genuinely can create multiple
`Payment` rows in one call (spec.md §35's own split-tender example), and
`postPaymentReceived` genuinely keys the resulting Journal's `referenceId`
on only the first (`paymentIds[0]`) — by design, matching how `tenders`
already aggregates into one journal, not a bug to reverse. The JOURNAL
itself was never incomplete (every tender already gets its own correct
debit line) — the gap was narrower: the traceability VIEW
(`resolveSourceReference`'s "payment" case) only ever surfaced the first
tender, not the full set.

Fixed by reading the durable `PaymentReceived` OutboxEvent `recordPayment`
itself already writes — its payload already carries the full `paymentIds`
array for that one call. (An earlier attempt grouped sibling payments by
`(cashierSessionId, receivedAt)`, assuming Postgres's transaction-frozen
`now()` would make every sibling's timestamp identical — empirically wrong,
caught by the test: Prisma computes `@default(now())` per-statement, not via
a true SQL column default, so sibling timestamps differ by several
milliseconds. The OutboxEvent payload is the actual ground truth of what one
call produced, not a heuristic, and was used instead.) No schema change, no
Journal architecture change, idempotency untouched.

1 dedicated integration test: a real 3-tender payment (Cash 200 + Card 500 +
Insurance 300), confirms 3 real `Payment` rows are created, confirms the
journal's own debit/credit lines are complete and balanced (900/900), and
confirms the trace view's summary now names all 3 receipt numbers and
amounts, not just the first.

### Test Hygiene (item 10)

**10A — floating-point assertion**: `report-reconciliation.test.ts`'s two
`revenueX - revenueY` subtractions (`toBe(500)`/`toBe(100)`) were genuinely
still using exact equality on a float-derived value. Changed to
`toBeCloseTo(..., 6)` — 6 decimal places of precision, far tighter than
currency's real 2-decimal display precision, so still fails on any actual
financial discrepancy, just not on ~1e-13 float noise. Not weakened:
`getFinancialReport`'s underlying DB values remain exact Decimal/NUMERIC
throughout; this was purely a JS-side comparison artifact.

**10B — P3.12 orphaned fixtures**: confirmed real — `p3-12`'s own "last-admin
safety" test creates a genuinely isolated `Organization` fixture whose
`audit_log` rows (a real FK, insert-only for the restricted runtime role by
design) blocked its own deletion, so the test's own comment explicitly left
it behind every run. Fixed using the same owner-connection pattern
(`DIRECT_DATABASE_URL`) `p3-5`'s own test file already uses for the
identical class of problem on `clinical_access_log` — the owner connection
genuinely can delete what the restricted one can't. **9 already-accumulated
orphaned organizations from before this fix** were found and cleaned up
from `his_test` (confirmed each held only the expected leftover shape — 0
users/roles/branches, 1 audit_log row — before deleting).

**10C — P3.13 sequence-dependent flaky assertion**: extensively investigated,
**could not be located or reproduced**. Searched `p3-13`'s own test file and
every domain function it exercises for an exact-value assertion on a
`NumberSequence`-derived string, a count that could accumulate across runs,
or an unordered-array-index assumption — found none. `number-sequence-concurrency.test.ts`
(the file most obviously implicated by the name) is already correctly
guarded (reads a `before` baseline, asserts uniqueness and "greater than
baseline," never exact contiguity — explicitly because these sequences are
org-wide and shared with other test files by design). Ran `p3-13`'s test
file in isolation three times consecutively (all clean) and as part of the
full suite twice more (both clean). `vitest.config.mts` runs test files
serially (`fileParallelism: false`), ruling out a cross-file race as the
mechanism. **Honest conclusion**: this could not be reproduced in this
environment/session — documented here rather than fabricating a fix for an
unlocated bug. If a future run reproduces it, the actual stack trace/
assertion at the point of failure would immediately identify it; nothing
found in this investigation suggests it's still present, but nothing
confirms it's gone either.

**An unrelated, newly-discovered flake**: running the full suite three times
(required for 10C's own investigation) surfaced one intermittent failure (1
of 3 runs) in `test/integration/lab-order-state-integrity.test.ts`
("computes critical_high and notifies the ordering provider once verified"
— a `findFirstOrThrow` on `Notification` returns a `lab_result_ready` row
instead of the expected `critical_lab_result` one). Passes cleanly every
time run in isolation; only failed once as part of the 59-file suite. This
is unrelated to any of the 12 named items and to the file/domain code this
batch touched — flagged via a background task rather than investigated
further, per this batch's own scope-control discipline.

### Login Enumeration (item 11)

Both staff (`login()`) and portal (`portalLogin()`) flows returned a
distinct "This account is inactive" message before the password was ever
checked — enough on its own for an unauthenticated caller to learn a given
email belongs to a real, deactivated account. Both now return the same
generic "Invalid email or password." for a nonexistent account, a wrong
password, AND an inactive account. **Not weakened**: `LoginHistory` still
records the real, specific reason (`"inactive"`) for internal
investigation; a correct password against an inactive account is still
genuinely rejected (verified by a dedicated test); account lockout and
organization-suspension messaging are both deliberately left as their own,
already-documented, distinct concerns (lockout has real legitimate-user
self-service value; the task's own instruction protects lockout behavior
specifically and only names "inactive" as the case to fix).

3 dedicated integration tests: staff login normalizes nonexistent/inactive/
wrong-password to the identical message (while `LoginHistory` still
distinguishes them internally); a correct password against an inactive
account is still genuinely rejected; the portal flow gets the identical fix.

### Performance Documentation Corrections (item 12)

All seven named corrections (A-G) applied to both `docs/PERFORMANCE_CAPACITY.md`
(the durable reference — full rewrites of the affected sections) and
`P4_5_PERFORMANCE_CONCURRENCY_LOAD_VALIDATION_REPORT.md` (a prominent
correction notice at the top, plus the highest-impact sections rewritten
inline): (A) the 25/50-concurrency "Healthy" classification was overstated
— reclassified to "Acceptable / Mildly Degraded" / "Degraded" /
"Severely Degraded" / "Unsustainable," with an explicit note that
correctness/stability (0% errors — genuinely true) and interactive
usability (multi-second p95 — genuinely degraded) are separate axes, not
conflated. (B) the 25→200 capacity curve is explicitly labeled as an HTTP
read/navigation workload that never included invoice/payment writes,
validated separately up to concurrency 25 only. (C) "CPU/event-loop
contention" is now framed as the leading remaining explanation (lock
contention and pool saturation were positively ruled out by direct
measurement) rather than a conclusively isolated root cause — CPU
utilization itself was never independently instrumented. (D) the
Lab/Radiology `take:200` "before/after" table is corrected to note it
compared against a `take:50` measurement, never an actual `take:200` query
— and is now marked superseded by item 2's real pagination, with that
replacement's own directly-measured numbers. (E) the soak test section now
states plainly it proves short-duration steady-state behavior only, not
long-duration memory stability or leak absence. (F) "zero errors" wording
throughout now specifies "in the tested read/navigation scenarios," not
implying every operation was exercised identically over HTTP. (G) the
synthetic seed-history dead-letter/failed Outbox counts are now explicitly
called out as deliberately non-production-like, not a real health signal.

## Schema / Migration Changes

Two narrow migrations, both hand-trimmed against the same recurring,
unrelated pre-existing drift (`OutboxStatus` enum noise, a cosmetic
`payroll_run` index rename) every migration diff has shown since P4.2 —
neither included here.

1. `20260902_targeted_backlog_closure_imaging_report_amendment` — adds the
   `imaging_report_amendment` table (item 7). New model only; no existing
   column/table altered.
2. `20260902_targeted_backlog_closure_dispensing_substitution_confirmed` —
   adds `dispensing_record.substitution_confirmed` (boolean, default false)
   (item 8). Additive column only.

Both applied to `his_dev` and `his_test`; verified via `prisma migrate status`
("Database schema is up to date!") and a clean full regression run
afterward. No data loss, no destructive operation, no AI-safety-checkpoint
override needed (both are pure additive changes).

## Security / Clinical Safety Considerations

- No correctness guarantee was weakened anywhere: no transaction, no
  idempotency mechanism, no branch/org isolation check, no accounting-
  balance invariant, no stock-protection guard, no audit-immutability
  constraint, no clinical state-transition lock, and no database constraint
  was removed or loosened.
- Item 4's `loadOrNotFound` deliberately never distinguishes "not found"
  from "forbidden" in what it shows, specifically to prevent a wrong-branch/
  wrong-org id from confirming a record's existence.
- Item 11's login-message normalization keeps the real reason in
  `LoginHistory` for internal investigation and does not touch lockout,
  rate-limiting, or organization-suspension enforcement.
- Item 7's radiology amendment never overwrites the original verified
  report — every correction is a new, fully-attributed row, matching the
  same medico-legal immutability discipline as Lab's own amendment
  mechanism and every other clinical-actor audit trail in this schema.
- Item 8's medication-mismatch check is enforced server-side (not just in
  the UI), closing the "client that skips the warning" bypass, while
  explicitly never auto-substituting or blocking a legitimate substitution.
- Item 9's fix only widens what an already-correct, already-balanced
  Journal's trace VIEW shows — no financial figure was ever wrong, and none
  changed as a result of this fix.

## Browser Verification

Ran a real `next dev` server against `his_dev`, logged in as the seeded
Super Admin, and verified live:

- `/laboratory?status=pending` and `/radiology?status=pending` — both
  render their default queue cleanly (no crash, no raw Prisma error).
- A stale appointment id and a stale invoice id — both show the friendly
  "Not found" page, not the generic error boundary.
- Created a real Doctor-role test user, logged in as them, opened
  `/appointments` — renders cleanly (appointment list, no "New Appointment"
  button since Doctor lacks that permission), zero console errors beyond
  pre-existing dev-mode CSP/eval noise unrelated to this batch. Test user
  deactivated afterward.

Not independently browser-verified beyond passing the production build and
lint: the radiology amendment dialog/history UI and the pharmacy mismatch
warning/checkbox UI — both are new interactive client components, but
`his_dev` has no seeded patient/prescription/imaging-order data to exercise
them through, and building that data via the UI from scratch was judged
disproportionate given both flows already have thorough, passing dedicated
integration test coverage (7 and 3 tests respectively) and a clean
production `next build` (which type-checks every new component/prop). Flagged
here plainly rather than silently claimed as verified.

## Tests Added / Updated

New/updated test coverage, by file:

- `test/integration/p3-5-lab-radiology-order-handoff.test.ts` — 6 pagination
  tests (item 2), 7 radiology amendment tests (item 7), 1 cleanup fix for the
  new `ImagingReportAmendment` FK.
- `test/integration/p3-3-doctor-encounter-workflow.test.ts` — 1 stale-ID
  sanitization test covering all 6 functions (item 6), 1 `loadOrNotFound`
  unit test (item 4).
- `test/integration/p3-6-pharmacy-dispensing-workflow.test.ts` — 3 medication-
  mismatch tests (item 8); 9 pre-existing fixture call sites updated to pass
  `substitutionConfirmed: true` (unrelated to what those tests verify).
- `test/integration/p3-7-billing-pos-cashier-workflow.test.ts` — 1
  multi-tender traceability test (item 9).
- `test/integration/p4-3-production-security-hardening.test.ts` — 3 login-
  enumeration tests, staff and portal (item 11).
- `test/integration/p3-12-admin-settings-role-aware-navigation.test.ts` —
  orphaned-fixture cleanup fix (item 10B), no new test, existing 40 tests
  unaffected.
- `test/integration/report-reconciliation.test.ts` — 2 assertions changed
  from `toBe` to `toBeCloseTo` (item 10A).

No test file was touched merely to inflate count; every addition maps to a
named item's own required verification.

## Regression Status

| Check | Result |
|---|---|
| `npx prisma validate` | ✅ schema valid |
| `npx prisma migrate status` (`his_dev`) | ✅ up to date, 38 migrations |
| `npm run typecheck` | ✅ 0 errors (checked repeatedly throughout, not just at the end) |
| `npm run lint` | ✅ 0 errors, 0 warnings |
| `npm run test` (full suite, `his_test`) — run 1 | ✅ 59 files / 540 tests passed |
| `npm run test` — run 2 | ⚠️ 539/540 — 1 unrelated intermittent flake (see item 10C's write-up), not caused by this batch |
| `npm run test` — run 3 | ✅ 59 files / 540 tests passed |
| `npm run build` | ✅ production build succeeded, all 70 routes compiled |

Every file this batch touched was also run individually, multiple times
each, with zero flakiness observed — the single intermittent failure across
three full-suite runs was in a file and domain (`lab-order-state-integrity.test.ts`,
lab critical-result notifications) this batch never modified.

## BACKLOG.md Updates

6 entries marked `RESOLVED — 2026-09-02` with a concrete description of the
actual fix (historical reasoning preserved, not deleted): the not-found/
wrong-branch error boundary gap, the radiology amendment gap, the
prescribed-vs-dispensed medication gap, the Doctor `/appointments` crash,
the encounter-section error-swallowing gap, and the stale-ID `findFirstOrThrow`
leak. One new entry added for a genuine, related-but-out-of-scope finding
noticed while fixing item 1 (the same unvalidated-status-cast pattern exists
in roughly a dozen other `list*` functions across the codebase) — not fixed
here, logged for a future narrow batch.

## Remaining Deferred Backlog

- The dozen other `list*` functions sharing item 1's unvalidated-status-cast
  pattern (newly logged to BACKLOG.md this batch).
- Item 10C's underlying flaky assertion, if it resurfaces — this batch's
  investigation found no evidence of it but could not conclusively rule it
  out either.
- The newly-discovered `lab-order-state-integrity.test.ts` intermittent
  flake (flagged via background task, unrelated to any of the 12 named
  items).
- Every item explicitly named out-of-scope in §16 of the originating
  instructions (PO approval, bank reconciliation, employee self-service,
  low-stock/near-expiry notifications, MFA, Sentry, production cloud load
  testing, etc.) — unchanged, still future work.
- The radiology amendment and pharmacy mismatch UI flows were not
  independently browser-verified (see Browser Verification above) — worth a
  quick manual click-through once real seeded clinical data exists in a
  shared environment.

## Acceptance Decision

**Can the targeted backlog closure be closed? YES.**

All 15 acceptance criteria are met: invalid Lab/Radiology status input no
longer 500s; Lab/Radiology queues cannot silently hide records beyond row
200 (real pagination replaced the cap); Doctor `/appointments` behavior is
verified live and coherent; the named stale/not-found operational paths no
longer expose raw technical errors; the four named clinical secondary
actions have friendly failure behavior; the six named stale-ID
`findFirstOrThrow` paths are sanitized; finalized Radiology reports have a
safe, tested amendment path; Pharmacy makes medication mismatch explicit and
server-enforced; multi-tender payment traceability was verified genuinely
incomplete and is now fixed without touching Journal architecture or
idempotency; known regression-test flakiness (10A, 10B) is removed, and
10C's absence was honestly investigated rather than assumed or fabricated;
inactive-account login messaging no longer materially discloses that
condition; P4.5's durable performance documentation now accurately
distinguishes correctness/stability from interactive performance and
capacity; full regression remains clean; BACKLOG.md accurately records what
was resolved; no large deferred product feature was pulled into this batch.

**Per the originating instructions' own stop condition, this phase stops
here.** P4.6, another whole-project audit, regulatory work, and the
release/migration phase remain explicitly out of scope until the next
explicit instruction.
