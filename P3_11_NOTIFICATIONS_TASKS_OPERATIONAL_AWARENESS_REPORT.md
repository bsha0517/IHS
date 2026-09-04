# P3.11 — Notifications / Tasks / Operational Awareness

Resolves P2's explicit backlog item: "Notifications have no read-side UI." Scope: the `Notification` model/domain, existing notification creation paths, task/reminder concepts (none found), navigation/header, role permissions, relevant event handlers, and direct workflow destinations. Per §4, this was not a whole-project audit; unrelated findings were routed to `BACKLOG.md`, and proactive fixes stayed limited to those with immediate realistic risk (none of that severity were found — every fix below is notification-specific).

---

## Existing Notification Architecture Traced

**Schema** (`prisma/schema.prisma`, unchanged this batch — the model was reused exactly as-is, no `NotificationV2`/`Alert`/`InboxMessage`):

```
model Notification {
  id, organizationId, recipientUserId, type (String), title, body,
  referenceType (String?), referenceId (String?),
  status (NotificationStatus: unread | read | archived, default unread),
  createdAt
  @@index([recipientUserId, status])
}
```

- **Recipient model:** a single explicit `recipientUserId` per row — every notification is addressed to exactly one `User`, never a role/team broadcast row. Fan-out (e.g. "notify every admin") is expressed as one row per actual recipient, already the pattern every pre-existing producer used.
- **Organization/branch:** `organizationId` is a real column; there is **no `branchId` column at all** on `Notification`.
- **Type/category:** a free-text `String`, not a Prisma enum — no fixed taxonomy to violate.
- **Read/unread state:** the `status` enum. No separate `readAt` timestamp exists — read state is only ever "unread" vs. "read" (plus the unused `archived`, see below).
- **Source reference:** `referenceType`/`referenceId` — exactly the "sourceType/sourceId" pattern the spec asked to look for. No `actionUrl`/`entityType`/`metadata` fields exist.
- **Retention:** nothing anywhere deletes a Notification automatically. Left exactly as-is.
- **Permissions:** none. No `notification.*` permission code exists in `prisma/seed.ts`'s catalog, and none was added — "can you see this" is answered entirely by "is this addressed to you" (`recipientUserId === session.user.id`), not a role/permission check.
- **`archived` status:** defined since the model's introduction, never set or read anywhere in the codebase — a dormant reserved value, the same "declared but not yet wired" pattern this codebase already has precedent for. Left dormant; not wired this batch (no archive UI was asked for or needed).

---

## Existing Notification Producers

Six real producers existed before this batch, all found via a full-codebase search for `db.notification.create`/`createMany` (the only ways a Notification was ever written):

| Producer (trigger) | Recipient | Referenced by (pre-fix) | Useful? | Noisy? | Duplicate-prone? |
|---|---|---|---|---|---|
| `EmployeeLeaveApproved` handler → appointment conflict | Every Super Admin/Org Admin | `employee`/employeeId | Yes — rare, real conflict | No | No new guard, but naturally idempotent via the `ProviderLeaveBlock` existing-row check already gating the whole handler |
| `LabResultFinalized` handler | Ordering provider's linked User | `clinical_order`/ClinicalOrder id | Yes | No — one per real result | **Yes** — no idempotency guard at all |
| `CriticalLabResultVerified` handler | Ordering provider, or `lab_result.verify` holders as fallback | `lab_order_test`/LabOrderTest id | Yes | No | **Yes** — no guard; also **contained the raw numeric value and abnormal flag in the body** (PHI) and **pointed at an id with no destination page** |
| `ImagingResultFinalized` handler | Ordering provider's linked User | `clinical_order`/ClinicalOrder id | Yes | No | **Yes** — no guard |
| `AppointmentCheckedIn` handler | Provider's linked User | `appointment`/appointment id | Yes | No | **Yes** — no guard |
| `notifyDeadLetter` (outbox.ts, any event reaching `dead_letter`) | Every Super Admin/Org Admin | `outbox_event`/OutboxEvent id | Yes | No — genuine failures only | Naturally safe per-event (atomic claim in `dispatchBatch`/`recoverStaleProcessingEvents` already prevents double-firing for the same transition) |

**Consumers before this batch: none.** No page, component, or server action anywhere ever read a Notification back — confirmed by a full search of `src/app`/`src/components` for the word "notification," which returned exactly one incidental prose mention on `/admin/system-events`. This is the exact P2 backlog gap this batch closes.

---

## Existing Task Architecture

**No Task/Todo/Reminder model exists anywhere in this codebase** — confirmed by a direct schema search (`model Task`, `model Todo`, `model Reminder`, `enum TaskStatus`: no matches). See "Tasks Decision" below for the resulting decision.

---

## Concrete Problems Found

1. **No idempotency guard on any notification-creation path.** All six pre-existing producers wrote directly via `db.notification.create`/`createMany`; an outbox at-least-once redelivery of any of the five event-driven ones (or a repeated dead-letter transition) could create a duplicate. Fixed with shared, reusable idempotent primitives (see "Duplicate/Retry Protection").
2. **A critical lab result notification contained the actual numeric value, unit, and abnormal flag directly in the notification body** — a real PHI leak into a less-access-controlled record than the lab order screen itself. Fixed: the body now only says a critical result needs review; the value stays behind the permission-gated destination.
3. **Two notification types were effectively unroutable.** `lab_result_ready`/`imaging_result_ready` stored `referenceType: "clinical_order"` for BOTH lab and imaging results, with no way to tell which destination (`/laboratory/orders/[id]` vs `/radiology/orders/[id]`) was correct without an extra lookup; `critical_lab_result` stored `referenceType: "lab_order_test"` pointing at a `LabOrderTest` id, and **no page in this application accepts a bare LabOrderTest id** — that notification had no working destination at all. Fixed at the producer: `lab_result_ready`/`critical_lab_result` now use `referenceType: "lab_order"` pointing at the parent `ClinicalOrder` id; `imaging_result_ready` uses `"imaging_order"`.
4. **No read-side UI existed at all** (the P2 backlog item this phase resolves).

---

## Improvements Implemented

- A real Notification Center at `/notifications` (list, unread/read state, category filter, pagination, operational-awareness links).
- A bell icon with a live unread badge in the shared Topbar, server-rendered from one indexed count query.
- Idempotent creation primitives (`createNotificationOnce`/`createNotificationsOnce`) applied to all six pre-existing producers.
- A safe, allowlisted destination resolver (`resolveNotificationDestination`) applied to every notification type, including fixing the two previously-broken/unroutable ones above.
- PHI minimization fix for critical lab results.
- Branch-aware recipient resolution (`resolveBranchPermissionRecipientIds`), reused by two new workflow-notification producers (leave, purchase requests).
- A newly-found branch-isolation gap in `requestLeave` itself (it never verified the target employee's branch was in the caller's authorized scope) — fixed as a small, directly-adjacent correction while wiring the new leave notification into that same function.

---

## Notification Center

`/notifications` — reachable by any authenticated user (no permission gate; ownership is the only relevant check). Shows, per row, using only actual schema fields: unread/read state (a visible "Unread" badge, not color-only), title, body, a category badge (`type`, friendly-labeled), a timestamp (`formatDateTime`), and — where `referenceType`/`referenceId` resolve to a real internal route — a clickable destination. **No `branchId` column exists on `Notification`**, so "branch context" is not shown per-row — shown honestly as absent rather than approximated via an extra per-row lookup (which would also have been a real N+1 risk). Paginated at 50/page (P2/P3's established `resolvePage`/`paginationSkipTake`/`totalPages` convention, `PaginationControls` component reused verbatim). Filters: All/Unread (button toggle) and a Category dropdown populated from the caller's own distinct `type` values (never a hardcoded taxonomy, never advanced search). Sorted newest-first by `createdAt`; no invented priority ranking (none exists in the model). Empty state reads "No notifications requiring your attention." — never styled as an error.

An "operational awareness" section (§53) sits above the list: live count/link cards into existing source-of-truth modules the caller actually has permission to see — pending leave approvals (→ `/leave`), accounting exceptions (→ `/accounting?tab=exceptions`, reusing `listAccountingExceptions`'s own count), low stock products (→ `/inventory`, reusing `listLowStock`), and pending purchase request approvals (→ `/purchasing`). None of these copy records into `Notification` — each is a live count against the real module.

---

## Header / Unread Awareness

A bell icon (`NotificationBell`) sits in the shared `Topbar`, linking to `/notifications`, with a small badge showing the unread count (capped display at "99+"). Entirely server-rendered — no client component, no polling: `getUnreadCount` runs once in the root dashboard layout (`(dashboard)/layout.tsx`) alongside the existing session check, and the count refreshes on every navigation, matching §44's explicit "page refresh, server-rendered unread count" V1 behavior. The accessible name (`aria-label="Notifications, N unread"`) carries the count in words, not just the visual badge (§52). No sidebar nav entry was added — the bell is the sole, deliberately singular entry point, per §8's "do not redesign the header/sidebar."

---

## Read/Unread Lifecycle

- **Mark one read:** `markNotificationRead(session, id)` fetches with `findFirstOrThrow({ id, organizationId, recipientUserId: session.user.id })` — a wrong-owner or wrong-org id fails identically to a genuinely missing one (no existence-leak), matching this codebase's established `assertBranchAccess`-adjacent convention. Only updates if currently `unread` — calling it twice is a harmless no-op, verified by an automated test.
- **Mark all read:** `markAllNotificationsRead(session)` is a single `updateMany` scoped to `(organizationId, recipientUserId, status: "unread")` — never a loop over rows, and structurally incapable of touching another user's notifications (§36).
- **Mark unread:** not built. Schema-trivial to add, but §10 explicitly cautions against building it "merely for symmetry," and no concrete operational need was identified this batch — documented as a deliberate boundary in `BACKLOG.md`, not an oversight.
- **Ownership enforcement:** verified live (a second walkthrough user never saw the first user's notifications) and by an automated test that a cross-user `markNotificationRead` attempt throws and leaves the target row untouched.

---

## Recipient Resolution

Every notification is addressed to a specific `User`, never a vague "role" record (the model has no such shape, and none was invented). Resolution strategy per producer, matching §15/§31's preference order:
- **Explicit single user with a clear owner:** lab/imaging results → the ordering Provider's linked `User`; leave decision → the employee's linked `User`; purchase-request decision → the requester (`PurchaseRequest.requestedBy`, a direct `User` FK).
- **Branch + permission fan-out:** leave-request-submitted → every `leave.approve` holder scoped to the employee's branch; purchase-request-submitted → every `purchase_request.approve` holder scoped to the request's branch. Both reuse one new shared helper, `resolveBranchPermissionRecipientIds`.
- **Org-wide roles (unchanged, pre-existing):** leave/appointment conflict and dead-letter notifications continue going to every Super Admin/Organization Administrator — both genuinely organization-level concerns, not narrowed further this batch.

---

## Branch Isolation

`resolveBranchPermissionRecipientIds` reuses the exact convention `branch-scope.ts` already establishes for reads: only **Super Admin** is treated as org-wide; every other role's reach is exactly its `user_branch_access` rows — enforced server-side at recipient-*generation* time (§16), not filtered after the fact by the Notification Center. Verified by an automated test (a branch-A-scoped approver is returned for a branch-A leave request; a branch-B-scoped approver is not) and live in the browser walkthrough. `Notification` itself carries no `branchId`, so branch correctness lives entirely in which `recipientUserId`s a producer chooses at creation time — there is no way for the read side to "leak" a wrong-branch notification once the recipient list is correct.

---

## Clinical Privacy / PHI Minimization

Explicitly reviewed all three clinical notification producers. `lab_result_ready`/`imaging_result_ready` already matched the spec's own "Lab result ready for MRN ####" preference (patient name + MRN only, "is verified" — no result content) and were left as-is beyond the reference-type/idempotency fixes. `critical_lab_result` was the one genuine violation found — the raw numeric value, unit, and abnormal flag were being interpolated directly into the body; fixed to the same minimal shape ("has a critical {test name} result ({flag}) requiring immediate review"), with the actual value now reachable only through the permission-gated `/laboratory/orders/[id]` destination. Verified by an automated test asserting the notification body never contains the numeric value or unit, live in the browser walkthrough via the automated test's own DB check (a browser-driven critical-result trigger was not re-exercised manually, since it requires the same fixture depth already covered by the automated test — see Browser Verification). Leave/purchase-request notifications were reviewed for the same discipline extended to HR-sensitive (non-clinical) text: neither the leave `reason` nor the rejection `reason` is ever included in a notification body, verified by an automated test.

---

## Notification Destinations

`resolveNotificationDestination` — one hardcoded, allowlisted switch on `referenceType`, producing a route string only from a fixed prefix plus the row's own `referenceId` (never from any stored/free-text URL). Covers every producer this batch touched or added:

| `referenceType` | Destination | Existing page reused |
|---|---|---|
| `appointment` | `/appointments/{id}` | yes |
| `lab_order` | `/laboratory/orders/{id}` | yes |
| `imaging_order` | `/radiology/orders/{id}` | yes |
| `employee` | `/employees/{id}` | yes |
| `leave_request` | `/leave` | yes (no per-request detail page exists — routes to the queue itself, per §12's "do not build duplicate detail screens") |
| `purchase_request` | `/purchasing` | yes (same reasoning — no per-PR detail page exists) |
| `accounting_exception` | `/accounting?tab=exceptions` | yes (P3.9's Accounting Exceptions tab) |
| `outbox_event` (legacy) | `/admin/system-events` | yes — kept resolvable so any pre-P3.11 `his_dev` rows aren't left with a dead link |

An unrecognized/missing `referenceType`/`referenceId` resolves to `null` — the Notification Center renders that row as plain (non-clickable) text rather than a broken link. `isSafeInternalPath` (must start with `/`, never `//`, never contain `://`) is asserted as a defense-in-depth check on every resolved path before it's ever used as a `redirect()`/`Link` target — verified by a unit-style test covering `//evil.com`, `https://evil.com`, and `javascript:` inputs, all correctly rejected. **No destination page's own permission logic was touched** — a notification link never grants access; the destination's existing server-side check remains the only real gate, confirmed live (the leave-decision recipient could open `/leave` because they happened to also hold `leave.approve` in the walkthrough fixture, not because of anything the notification link does).

---

## Workflow Notifications Added or Improved

Existing producers **improved** (idempotency + destination + PHI fixes, no new signal): `lab_result_ready`, `critical_lab_result`, `imaging_result_ready`, `patient_waiting`, `leave_appointment_conflict`, `system_event_dead_letter`.

**New producers added**, each reviewed against "does this duplicate an existing queue":

- **`leave_request_submitted`** (hr/leave.ts, `requestLeave`) → every `leave.approve` holder scoped to the employee's branch. Useful: a genuine "approval requiring attention" signal (§19) — HR/Clinic Manager previously had zero proactive awareness that a request needed action short of periodically opening `/leave`. Not a queue duplicate: the notification *points to* `/leave`, the queue itself remains the one place requests are actually acted on.
- **`leave_decision`** (event-handlers.ts's `EmployeeLeaveApproved` handler, and directly in `rejectLeave`) → the employee's linked `User`, if any. Useful: closes the loop for the person who requested it — the only party with no other way to learn the outcome short of asking. Approval reuses the pre-existing `EmployeeLeaveApproved` outbox event (moved before its own early-return so this fires for every employee, not only Provider-linked ones); rejection is created directly since it has no other side effect needing outbox durability.
- **`purchase_request_submitted`** / **`purchase_request_decision`** (procurement/purchase-requests.ts) — the identical shape and justification as the leave pair above, reusing the same branch-aware recipient helper. §28 was explicit that PO has no approval stage (P3.8) and none was invented; PR's approval stage is real (`purchase_request.approve`, a distinct permission, `approvedBy`/`approvedAt`/`rejectionReason` already on the model) and was the one genuinely supported by current architecture.

**Explicitly considered and NOT built**, with reasoning:
- **Inventory low-stock / near-expiry** — would require new state-tracking infrastructure to deduplicate correctly (§25-27 explicitly permit deferring this). See `BACKLOG.md`.
- **Pharmacy** — no new notification; the existing outstanding-prescription queue already serves this, and no other genuine exception state was found in current architecture (§23 explicitly forbids inventing medication safety alerts).
- **Billing/Cashier** — no per-Charge notification (would duplicate the Cashier workspace); no distinct "failed financial handoff" state exists beyond what Accounting Exceptions already covers, so nothing new was added there either.
- **Accounting exception → Accountant directly** — kept the existing Admin-only recipient list on `notifyDeadLetter` rather than widening it, for a concrete architectural reason (a circular-import risk between `platform/outbox.ts` and `domains/accounting/exceptions.ts` — see `BACKLOG.md`); the operational-awareness link satisfies §29's "may point to Accounting Exceptions" instead.
- **Reception/Appointment conflict/reschedule** beyond the pre-existing leave-conflict notification — no additional exception state was found in the current appointment/reschedule architecture worth a new signal; the existing `leave_appointment_conflict` notification already covers §20's named "provider leave conflict affecting booked appointments" case.

---

## Duplicate / Retry Protection

Two shared primitives (`notifications/create.ts`, imported directly by both `platform/outbox.ts` and `platform/event-handlers.ts` — a dependency-free leaf module, deliberately separate from the richer `notifications/service.ts`, to avoid a circular import through that file's own dependency on `domains/accounting/exceptions.ts`; see that file's doc comment and the matching `BACKLOG.md` entry):

- **`createNotificationOnce`** — single-recipient producers check for an existing row with the same `(recipientUserId, type, referenceType, referenceId)` before inserting.
- **`createNotificationsOnce`** — fan-out producers batch-check existing rows across every intended recipient in one query, then bulk-insert only the missing ones; every entry in one call is asserted to share the same `(type, referenceType, referenceId)` (true for every real caller — a runtime check, not just a convention).

Not a DB-level unique constraint — matches this codebase's own established tradeoff for this shape of idempotency (`referenceType`/`referenceId` are nullable, and application-level check-before-insert is the same pattern `postJournal` already uses for financial-posting idempotency, not a new one invented for this batch).

**Explicitly tested** (automated): the same outbox event delivered twice (`LabResultFinalized`, real end-to-end via `writeOutboxEvent`+`dispatchPendingOutboxEvents`) creates exactly one notification; `createNotificationOnce`/`createNotificationsOnce` called twice with identical input creates exactly one/no-duplicate rows; a fan-out retry that partially overlaps an already-notified recipient only creates the missing rows; marking the same notification read twice is idempotent; mark-all-read racing a concurrent new-notification creation leaves state coherent and never touches another user's rows.

---

## Tasks Decision

**No Task model exists, and none was added.** Confirmed by direct schema search before writing any code (§32). The existing operational work queues (Lab/Radiology orders, Pharmacy's outstanding-prescription queue, Cashier's workspace, HR's leave-request list, Purchasing's Purchase Request/Order tabs, P3.9's Accounting Exceptions) already fully answer "someone must do something" for every domain this batch touched — each already has its own status lifecycle, its own permission gate, and its own list UI. The new Notification Center's job is narrower and complementary: "something happened, here's where to go" — pointing at those exact queues, never re-implementing them. No concrete operational need surfaced during this batch's own trace that isn't already covered by an existing queue plus this batch's new awareness layer, so per §33's own instruction ("do not create it merely because the phase name contains 'Tasks'"), nothing further was built. If a genuine cross-module personal task concept is needed later (e.g., something with no natural home in any existing queue), it remains a real, separately-scoped design exercise — not something this batch's Notification work should absorb.

---

## Security

Explicitly verified, both by automated test and live in the browser:
- **A user sees only their own notifications** — `listNotifications`/`getUnreadCount`/`markNotificationRead`/`markAllNotificationsRead` are all scoped to `session.user.id` as `recipientUserId`, never a client-supplied user id. Live: User B never saw any of User A's fixture notifications after logging in separately.
- **Organization isolation** — every query also scopes to `session.user.organizationId`.
- **Branch relevance during recipient generation** — see "Branch Isolation" above.
- **Internal destination safety** — see "Notification Destinations" above; no open redirect, no external URL ever rendered from notification data.
- **Destination screens remain independently permission-safe** — no destination page's own authorization logic was modified; a notification link is only ever a convenience, never a grant.
- **No PHI leakage** — see "Clinical Privacy / PHI Minimization" above.
- **Admin visibility** — Admin was not given any new broad read access to other users' notification content; the only Admin-facing addition is the pre-existing, unchanged `notifyDeadLetter` recipient list (Super Admin/Org Admin, itself individual `Notification` rows scoped to each specific admin, not a shared view of everyone else's).

---

## Performance / Indexes

- **Unread count:** one `count()` against `@@index([recipientUserId, status])` — exactly the index shape the spec named as a likely-needed pattern, and it already existed. **No new index was added** — the existing composite index already covers both the count query and the status-filtered list query; `organizationId`/`type` filters layer on top of an already-narrow `recipientUserId` scope (one user's own notifications), too small a set to justify a dedicated index. This is a deliberate "no new index" decision, not an oversight — matches §50's "no full P2-style indexing audit."
- **Header:** exactly one query added to the root layout (`getUnreadCount`), no other domain dashboard triggered from there.
- **List page:** two queries (`findMany` + `count`), both narrow and indexed; the operational-awareness links each reuse an already-existing, already-cheap query from their own domain (`listLowStock`, `listAccountingExceptions`, two `count()`s) — no new heavy computation introduced. `listPharmacyQueue` (outstanding prescriptions) was deliberately **not** added to this section because it returns full nested objects, not a cheap count — documented in `BACKLOG.md` as a trivial future addition once a dedicated count function exists.
- **Fan-out creation:** batched existing-row lookup (one query across every recipient) + one bulk `createMany`, never one query per recipient.

---

## Files Changed

**New**
- `src/lib/domains/notifications/create.ts` — idempotent creation primitives (dependency-free leaf module)
- `src/lib/domains/notifications/service.ts` — read side, destination resolver, recipient helper, operational-awareness links
- `src/lib/domains/notifications/labels.ts` — friendly type labels (client-safe, no `"server-only"`)
- `src/components/layout/notification-bell.tsx`
- `src/app/(dashboard)/notifications/page.tsx`, `actions.ts`, `notification-filters.tsx`, `mark-read-button.tsx`, `mark-all-read-button.tsx`

**Modified**
- `src/lib/platform/event-handlers.ts` — 5 producers fixed (idempotency, destination, PHI), leave-decision notification added
- `src/lib/platform/outbox.ts` — `notifyDeadLetter` idempotency fix
- `src/lib/domains/hr/leave.ts` — leave-request-submitted notification, branch check added to `requestLeave`, leave-decision (rejection) notification
- `src/lib/domains/procurement/purchase-requests.ts` — PR-submitted and PR-decision notifications
- `src/components/layout/topbar.tsx` — bell wired in
- `src/app/(dashboard)/layout.tsx` — unread count fetched and passed down
- `test/integration/lab-order-state-integrity.test.ts` — updated 2 assertions to match the corrected `referenceType`/`referenceId` shape (a real pre-existing bug this batch fixed, not a weakened assertion — the test now also asserts the raw value never appears in the body)

**Docs**
- `BACKLOG.md` — 4 new entries

---

## Tests

**New**: 19 (`test/integration/p3-11-notifications-operational-awareness.test.ts`), covering: own-notifications listing and cross-user denial, unread count, ownership enforcement on mark-read (including the untouched-on-failure check), mark-read idempotency, mark-all-read as a single scoped bulk update racing concurrent creation, pagination + unread filter, the full destination-resolver table plus unsafe-path rejection, single- and fan-out idempotent creation (including a partial-overlap retry), branch-aware recipient resolution, dead-letter notification idempotency, leave-request-submitted branch-scoped fan-out with no reason-text leakage, leave-decision notifications for both approval and rejection (reason-free), branch isolation carried into `requestLeave` itself, Purchase Request submitted/approved/rejected notifications, a real end-to-end outbox-driven lab-result notification with duplicate-delivery protection and correct destination, and a critical-lab-result notification proven free of the raw value/unit with the corrected destination.

**Fixed** (not new, not weakened): 2 assertions in `lab-order-state-integrity.test.ts` updated to the corrected, intentional `referenceType`/`referenceId` shape this batch introduced — a genuine bug fix, with an additional PHI assertion added, not a relaxation.

**Total**: 53 test files, **381 tests, 381/381 passing** (362 baseline + 19 new).

---

## Browser Verification

Ran against `his_dev` with two temporary HR-Manager-role fixture users, three fixture notifications, and one fixture employee (linked to the second user) — all created via a temporary setup script and fully removed via a matching cleanup script afterward (confirmed via `git status --porcelain scripts/` showing only the pre-existing untracked `scripts/db/` files remaining).

**Notification Center:** logged in as User A — the bell showed "Notifications, 2 unread" (correct aria-label and badge). Opened `/notifications`: newest-first ordering confirmed, unread/read visually and semantically distinguished (badge + bold text, not color-only). Clicked the one fixture notification with a real destination (`employee`/`referenceType`) — it correctly navigated to the real Employee detail page (P3.10's own page, showing the linked User's system-login row) **and** the bell count dropped from 2 to 1 in the same action. Clicked "Mark read" on a second (destination-less) notification directly — bell count dropped to 0, "Mark all read" button correctly disabled with nothing left unread, empty-adjacent "You're all caught up." copy shown. Switched to the Unread filter — correctly showed "No notifications requiring your attention."

**Workflow awareness:** as User A, submitted a real leave request for the fixture employee via `/leave` — the bell immediately showed 1 unread, and `/notifications` showed a new "Leave Approval Needed" notification with the exact minimal message ("P3.11 Employee requested annual leave (2 day(s), 01 Oct 2026 – 02 Oct 2026)"), and the "Pending leave approvals" operational-awareness count updated live to 1. Approved the request. Logged out, logged in as User B (the employee's linked login) — `/notifications` showed a "Leave Decision" notification ("Your leave request for 01 Oct 2026 – 02 Oct 2026 was approved.") addressed specifically to them, with no reason text and no PHI.

**Security:** confirmed live that User B's notification list contained none of User A's fixture notifications (organization-scoped, same org, still correctly isolated by recipient) — direct confirmation of §47's ownership requirement. Cross-user `markNotificationRead` denial and unsafe-path rejection were verified via the automated test suite rather than re-driven manually in the browser (the same property, exercised more precisely and repeatably there).

**Tasks:** no Task model exists in this codebase; Notifications plus the existing operational work queues were determined sufficient for V1 (see "Tasks Decision" above) — steps 24+ were not fabricated, per §57's own instruction for this case.

---

## Remaining Notifications / Tasks Backlog

Recorded in `BACKLOG.md`, four new entries this batch:
1. Low-stock/near-expiry notifications deliberately deferred — needs new state-transition tracking infrastructure (Low).
2. Accounting dead-letter notifications still Admin-only, not directly pushed to Accountant — architectural (circular-import) reason documented, with a precise fix recommendation (Low).
3. "Mark unread" and the dormant `archived` status remain unbuilt by design, not oversight (Informational).
4. (Carried context, not a new entry) — outstanding-prescriptions was not added to the operational-awareness links section because no cheap count-only query exists yet for it; trivial to add once one does.

---

## Regression Status

- **Prisma validate**: clean (`his_dev`) — no schema changes this batch
- **Migration status**: clean, 34/34 migrations applied on both `his_dev` and `his_test`, no pending migrations
- **TypeScript**: clean (`tsc --noEmit`)
- **Lint**: clean (`eslint`, confirmed via direct exit-code check)
- **Integration tests**: **53 files, 381/381 passing**
  - Host: `localhost`
  - Port: `5433`
  - Database: `his_test`
  - Remote Supabase: **NOT USED**
- **Production build**: clean (`next build`), all 65 routes generated including the new `/notifications` route

Per §61: stopping here. Not beginning P3.12, Admin/Settings/Navigation work, P4, external messaging integrations, or country-specific notification regulation. Awaiting review and explicit instruction to continue.
