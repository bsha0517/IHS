# P5.2 — Pilot Clinic Operations

How Avant HIS takes a commercially-provisioned clinic (P5.1) through onboarding, UAT, go-live
approval, and ongoing platform support. Written for whoever runs the platform side of the
business day to day. See `docs/COMMERCIAL_SAAS_OPERATIONS.md` for the P5.1 commercial foundation
this phase builds on, and `P5_2_COMPLETION_REPORT.md` for the evidence behind every claim here.

## Architecture

P5.2 adds no new tenant model and no new identity plane — it extends the existing two-plane
architecture P5.1 established:

- **Clinic Application Plane** (`(dashboard)` routes, `Session`/`User`, RBAC via `can()`/`assertCan()`)
  gains one new page: `/support` (a clinic's own support-ticket list/detail), gated by a new,
  narrow permission (`support_ticket.manage`) — nothing else about this plane changes.
- **Platform Operations Plane** (`/platform` routes, `PlatformSession`/`PlatformOperator`) gains
  three new workspaces under an organization's own detail page — Onboarding, Pilot UAT, and a
  go-live approval action — plus a platform-wide Support Tickets section.

Every new domain function that mutates platform data takes the acting operator's id as an
**explicit parameter** rather than resolving it internally via `requirePlatformOperator()` — a
deliberate departure from P5.1's own convention (where every mutator resolves the operator via
Next's request-scoped `cookies()` internally). The reason is testability: a function that depends
on `cookies()` cannot run in an integration test at all (P5.1 discovered and documented this
limitation for its own functions). Every new P5.2 platform function is instead called from a
Server Action or a page's own data loader that resolves `requirePlatformOperator()` **itself**
first — the real authorization check still happens on every request, at the same layer, just
factored so the underlying logic is unit-testable. See `entitlements.ts`, `organizations.ts`,
`support-tickets.ts`, `pilot-uat.ts`, and `onboarding-checklist.ts` for the pattern.

## Onboarding Workflow

`/platform/organizations/[id]/onboarding` — a manually operator-tracked implementation-project
checklist. This is deliberately **not** the same thing as `readiness.ts`'s own derived technical
readiness (untouched by this phase, still the sole authority on "does the system actually have
configuration X"). The onboarding checklist answers "has the human implementation project done Y" —
an operator-editable project-management artifact, not a system-state mirror.

- A fixed, code-defined catalog (`ONBOARDING_CHECKLIST_ITEMS` in
  `src/lib/domains/commercial/onboarding-checklist.ts`) covers Organization, Branches, Users, and
  Operational Configuration items — every item maps to a real, already-existing Avant HIS screen
  or workflow (Services, Products, Suppliers, Medications, Lab/Imaging catalogues, Packages,
  Payors, Chart of Accounts, Opening Inventory, Assets, HR). No invented requirement.
- An "operational configuration" item only appears for an organization whose real module
  entitlements make it relevant — a clinic with the pharmacy module disabled is never shown
  "configure the medication formulary."
- Each item supports status (`not_started`/`in_progress`/`blocked`/`completed`/`waived`), an owner
  label, a due date, notes, an evidence reference, and records who completed it and when.
  **Waiving** a mandatory item is allowed (some items genuinely don't apply to every pilot) but is
  always an explicit, audited operator action with its own note — never a silent bypass.
- Seeded automatically at provisioning time, and idempotently re-synced on the workspace's own
  first load each visit (so a later entitlement change picks up newly-relevant items without ever
  resetting existing progress). `ensureOnboardingChecklist()`'s seed insert uses
  `skipDuplicates: true` specifically because the organization detail page calls it twice
  concurrently in the same `Promise.all` (once directly, once via `getGoLiveBlockers()`) — a real
  race an E2E run against a freshly-provisioned organization caught directly (both concurrent
  calls computing the same "missing" catalog items and colliding on the unique constraint); the
  audit-write for a genuine first seed is gated on the actual insert count, not the pre-read
  snapshot, so a racing loser can never double-write the `platform.onboarding.created` row.

## Go-Live Workflow

P5.1's four go-live conditions (hosted backup/restore rehearsal, external error monitoring,
clinic UAT/signoff, transactional email) are **preserved exactly** — same codes, same evidence-only
philosophy (never the external system itself, never a secret). P5.2 adds:

- A `blocked` status (alongside the existing `pending`/`complete`/`not_applicable`) — a condition
  actively obstructed (e.g. a failed restore rehearsal) can now be represented distinctly from
  "not yet attempted."
- "Who verified it, when" — the organization detail page resolves `completedByOperatorId` to a
  real operator email for display.
- **Controlled go-live approval** (`approveGoLive()` in `commercial/organizations.ts`): a platform
  operator can move an organization's `commercialLifecycle`/`onboardingStatus` to `live` only when
  `getGoLiveBlockers()` — the exact same function the UI reads to render its own blocker list —
  returns an empty array. That function checks: every go-live condition is `complete` or
  `not_applicable`; the organization is not suspended; a subscription exists in `trial`/`active`
  status; every *required* onboarding checklist item is `completed` or `waived`. The approval
  itself records the approving operator, a timestamp, and free-text notes, and writes a
  `platform.go_live.approved` audit row. **Server-side validated, always** — the "Approve go-live"
  button is disabled in the UI when blockers exist, but that's a UX courtesy: calling
  `approveGoLive()` directly with unmet conditions is rejected identically (`GoLiveNotReadyError`),
  proven by a dedicated integration test and a dedicated E2E failure-path test.

## Support Workflow

A lightweight platform support-ticket system (`SupportTicket`/`SupportTicketNote`) — not a
helpdesk replacement, no live chat, no SLA engine, no external ticketing integration (all
explicitly out of scope for this phase).

- **Platform side** (`/platform/tickets`): full read/write across every organization's tickets —
  create, assign, change status, add notes (internal or customer-visible).
- **Clinic side** (`/support`, gated by the new `support_ticket.manage` permission): a clinic user
  can create and view **only their own organization's** tickets, and reply — every reply always
  lands as a customer-visible note (a clinic user has no way to write an internal note; that field
  doesn't exist on the clinic-facing input type at all). A clinic reply to a resolved/closed
  ticket automatically reopens it.
- **The security boundary that matters most here**: `SupportTicketNote.visibility` decides what a
  clinic can ever see, enforced **in the database query itself** (`getSupportTicketForClinic()`
  filters `visibility: "customer"` at the Prisma query, not in a UI conditional) — an internal note
  is never fetched into memory on the clinic-facing code path at all. Proven directly: a dedicated
  integration test creates both an internal and a customer-visible note on the same ticket and
  asserts the clinic-facing read returns only the latter.
- Ticket numbers (`SUP-000123`) are generated via a new, genuinely platform-wide
  `PlatformNumberSequence` mechanism (`nextPlatformNumber()` in `platform/sequences.ts`) — **not**
  the existing, always-organization-scoped `NumberSequence`. This exists because
  `SupportTicket.ticketNumber` is globally unique (a real support desk references "SUP-000123"
  standalone), and reusing the org-scoped mechanism would have every organization's counter
  independently start at 1 — a real bug this phase's own integration test caught directly (two
  different organizations' first tickets both generating "SUP-000001" and colliding on the unique
  constraint) before it ever reached a live environment.
- No PHI is ever required by a ticket; both the platform and clinic-side forms explicitly say so
  in their own copy ("do not include patient names, MRNs, diagnoses...").

## UAT Workflow

`/platform/organizations/[id]/uat` — a repeatable pilot checklist, explicitly **not** a clinical
claim or a regulatory certification (stated directly in the page's own copy). One `PilotUat` row
per test cycle (cycle label, tester name — free text, since a pilot tester is very often clinic
staff, not necessarily a `User`/`PlatformOperator` row); `PilotUatScenario` rows record individual
pass/fail results across the real clinic workflow areas the P5.2 command names: reception, doctor,
inventory, billing, finance, lab/radiology/pharmacy where enabled, multi-user, multi-branch, and
security. Completing a cycle records a result (`in_progress`/`passed`/`failed`), blockers, and
notes; **signing off** is a separate, explicit step (`signedOffByOperatorId`/`signedOffAt`) —
recording a result is not the same as a human having reviewed and accepted it.

## Platform Operations Dashboard

`/platform` now also surfaces open/unassigned support-ticket counts and a cross-organization
recent-activity feed (`platform.*` audit rows only, joined with the organization's display name —
never clinical content, exactly the same PHI boundary every other platform screen already respects).
The organization detail page gained an "Operations" summary card: active users/limit, active
branches/limit, enabled modules, onboarding-checklist completion, and links into the three new
workspaces.

## Security Boundaries

- **Platform isolation**: unchanged from P5.1 — `/platform/*` checks the `PlatformSession` cookie
  exclusively; a clinic Super Admin's staff session simply cannot resolve one.
- **Tenant isolation**: unchanged from P5.1/P4.3 — every clinic-facing query scopes by
  `session.user.organizationId`. P5.2's own additions (checklist, tickets, UAT) all carry
  `organizationId` directly and follow the identical convention, verified not to leak between
  organizations by a dedicated integration test (a support ticket created for Organization B is
  neither readable nor listed for an Organization A session, even by direct ticket id).
- **PHI minimization**: every new platform screen queries only `Organization`,
  `OnboardingChecklistItem`, `SupportTicket`/`SupportTicketNote`, `PilotUat`/`PilotUatScenario`,
  `GoLiveCondition`, and `AuditLog` rows scoped to `platform.*` actions — none of these tables, or
  any query against them, ever touches `Patient`/`Encounter`/`Diagnosis`/etc.
- **Entitlement enforcement — the P5.1 carry-forward item this phase closed**: P5.1 documented that
  commercial module entitlement was enforced at the route boundary (`proxy.ts`) but never
  independently at the Server Action layer — meaning a disabled module's mutation could still be
  invoked directly (a stale client bundle, a replayed request) as long as the caller held the RBAC
  permission. This phase audited all 18 gated `actions.ts` files (every `"use server"` file under
  an optional/add-on module) and added `assertModuleEnabled(session.user.organizationId, moduleKey)`
  as the first real check inside each file's own `requireSession()` helper — one call site per
  file, since every action in a given file belongs to exactly one module. See "Entitlement
  Enforcement" below for the full detail.

## Entitlement Enforcement

`assertModuleEnabled(organizationId, moduleKey)` (`src/lib/platform/entitlements.ts`) is the one
new chokepoint: it mirrors `proxy.ts`'s own core-clinical-spine carve-out exactly (reception,
patients, appointments, clinical, nursing are never blocked, for the identical clinical-safety
reason), and throws `ModuleDisabledError` — a clear, user-facing message — for every other module
when disabled. It is called from the local `requireSession()` helper already present in every one
of these 18 files, so every mutating action in that file is automatically covered by one line
changed:

```
laboratory, radiology, pharmacy, inventory, purchasing(→procurement), accounting(→finance),
expenses(→finance), employees/attendance/leave/commissions(→hr), payroll, assets,
admin/onboarding(→imports_onboarding), pos/invoices/payors/claims(→pos_billing)
```

Deliberately **not** applied to reads — P5.1 already guarantees a disabled module's historical
data stays readable; disabling a module hides it from navigation and blocks *new* mutations,
never existing data. RBAC and entitlement remain fully independent controls, proven directly: a
session with the right permission but a disabled module fails at `assertModuleEnabled`; a session
with the module enabled but the wrong permission fails at `assertCan` — neither ever substitutes
for the other.

A structural regression test (`test/integration/p5-2-pilot-clinic-operations.test.ts`) reads each
of the 18 files' actual source and asserts the import and the exact call are present — a future
edit that accidentally removes the check fails a test immediately, not silently. A live E2E test
additionally exercises the real-world scenario this exists for: a clinic admin has a mutation form
already open in the browser, a platform operator disables that module mid-session, and submitting
the now-stale form is rejected by the Server Action itself with the `ModuleDisabledError` message,
never a raw crash.

**Two genuine defects this E2E test itself caught, both fixed this phase (not merely proven absent
by the test — the test's first several runs failed against real bugs before these fixes landed):**

1. In every one of the 18 gated files, `requireSession()` called `assertModuleEnabled()` **before**
   the function's own `try { ... } catch (e) { return { error } }` block that every other domain
   error already goes through — so a thrown `ModuleDisabledError` propagated uncaught out of the
   Server Action entirely, crashing to Next's generic error boundary instead of the intended
   graceful inline message. Fixed by moving the `requireSession()` call to be the first line
   *inside* each function's existing try block (18 files, ~99 functions touched; a small number of
   simple void-returning actions with no pre-existing error handling were deliberately left
   unchanged — they had no graceful error path before this fix either, so leaving them alone
   introduces no new regression).
2. `proxy.ts`'s own route-level module-entitlement redirect (P5.1) applied to *every* request under
   a gated prefix, including a Server Action's own POST — but a raw HTTP redirect is not a valid
   response to a Server Action call; the browser's fetch followed it to the redirect target's own
   unrelated POST handler and received a response the calling code couldn't parse ("An unexpected
   response was received from the server"), again crashing the page. Fixed by exempting requests
   carrying a `next-action` header from that redirect — page navigation is unaffected, and the
   Server Action's own `assertModuleEnabled()` (now fixed per #1) is the authoritative check for
   actions, exactly as this phase's design already intended.

## Operational Runbook

The practical sequence for onboarding a new pilot clinic, in order. Steps marked **(manual)** have
no automated trigger in this codebase — a human platform operator performs them directly.

1. **Provision organization** — `/platform/provision` (P5.1, unchanged).
2. **Configure commercial plan/subscription** — assigned during provisioning, adjustable afterward
   from the organization detail page.
3. **Configure entitlements** — module selection during provisioning; adjustable afterward.
4. **Configure branch** — the initial branch is created during provisioning; additional branches
   via the clinic's own Admin → Settings.
5. **Activate administrator** — the clinic admin uses the one-time activation link shown once at
   provisioning to set their real password. **(manual)** relaying that link to the clinic through
   a secure channel is the operator's own responsibility; nothing in this codebase emails it.
6. **Configure/import master data** — services, products, suppliers, medications, lab/imaging
   catalogues, packages, payors, opening inventory — via the clinic's own existing screens and the
   P4.6 onboarding/data-import workflow. **(manual)** the clinic (or an implementation team member
   acting on their behalf) does this work; nothing in this phase automates it.
7. **Configure users/providers** — via the clinic's own Admin → Users / Providers screens.
8. **Configure opening inventory** if applicable — via the existing onboarding/data-import
   workflow (P4.6), if the inventory module is entitled.
9. **Validate accounting configuration** — chart of accounts and default account mappings, via the
   clinic's own Accounting screens, if the finance module is entitled.
10. **Perform internal verification** — track progress against the Onboarding Workspace checklist.
    **(manual judgment)** an operator decides an item is genuinely done.
11. **Begin clinic UAT** — start a cycle from the Pilot UAT workspace.
12. **Record UAT results** — per-scenario pass/fail as the pilot walkthrough proceeds.
13. **Resolve blockers** — fix whatever the UAT cycle surfaced; start a new cycle if needed.
14. **Verify go-live conditions** — mark each of the four conditions complete/not-applicable with
    real evidence. **(manual)** — each condition's underlying action (a restore rehearsal, a
    monitoring test error, a UAT signoff, a test transactional email) happens outside this
    codebase; the platform only records that it happened.
15. **Platform operator approves go-live** — `approveGoLive()`, rejected server-side if anything
    above is still incomplete.
16. **Activate LIVE status** — the same action as step 15; `commercialLifecycle`/`onboardingStatus`
    both move to `live` atomically.
17. **Begin post-go-live monitoring** — the organization detail page's Operations summary and the
    platform dashboard's recent-activity feed are the ongoing visibility surface; open support
    tickets are the primary signal something needs attention.

## Known Limitations

- **Server Action entitlement enforcement covers mutation paths, not every possible cross-module
  UI surface.** No bypass is known or suspected (RBAC independently gates every domain function
  regardless of entitlement state), and this was the specific, narrow scope this phase's own
  command asked for ("a targeted audit," not a full application audit) — logged as a P5.1
  carry-forward item, now closed for the 18 gated mutation surfaces; a genuinely new gated module
  added in a future phase needs the same one-line treatment repeated.
- **Support tickets have no notification mechanism.** The existing clinic notification system
  (`Notification`/`recipientUserId`) is strictly per-`User`, and a `PlatformOperator` cannot be a
  notification recipient under the current schema — an operator learns about a new/updated ticket
  by checking the dashboard or the tickets list, not a push notification. Out of this phase's
  explicit scope (no live chat, no complex SLA/notification engine).
- **Onboarding checklist "required" status is fixed per catalog item, not per-clinic negotiable.**
  A real pilot might have contractual reasons a normally-required item is optional for one specific
  clinic — today that's handled by the operator marking it `waived` with a note, not by editing
  the requirement itself.
- **No automated go-live-condition verification.** Every condition is operator-attested evidence,
  never a live integration check against the actual external system (a real backup/restore
  rehearsal, a real Sentry test event, etc.) — stated explicitly here and in the UI's own copy, not
  silently implied to be more than it is.
- The three items P5.1 already flagged and this phase's own command said NOT to automatically
  address remain exactly as they were: `nextCustomerCode()`'s concurrency behavior, automated
  subscription lifecycle transitions, and cross-module historical-data reachability after a module
  is disabled. Responsive behavior at 1440/1024/768/390 for the newly-added screens was verified
  directly against a running dev server this phase (see the completion report) — two real layout
  issues were found (a stat-grid text wrap at 768px, an action-button row and stat-grid overflow
  at 390px on the organization detail page's new Operations card) and fixed.
