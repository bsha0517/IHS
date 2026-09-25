# BACKLOG.md

Findings noticed in passing during the P2/P3 remediation passes that are real but out of the scope of the batch that noticed them (per P2.md §1/p3.md §2's own scope-control rule: fix what's asked, log what isn't). Not a general project TODO list — see PROJECT_STATUS.md's own Known Issues sections for broader product backlog.

---

## ~~No global branch-switcher UI~~ — RESOLVED in P3.12

**Noticed during:** P3.1 (Reception & Appointment Workflow, 2026-08-31), while reviewing §20's "make the active branch context obvious" instruction.

**What:** `session.activeBranchId` is fixed for the life of a session (set at login) — there is no UI anywhere in the app (topbar, sidebar, or otherwise) that lets a staff member authorized across multiple branches switch which branch they're actively operating in mid-session. Reception/Queue each show the resolved active branch's name in their own page header (improved further this batch), but if a receptionist genuinely needs to act on a second branch, nothing in the UI offers a way to do that short of logging out and back in (if login itself even offers a branch choice — not confirmed either way).

**Why not fixed in P3.1:** a branch switcher is a global layout/session concern (topbar.tsx, session/auth), not a Reception-page component P3.1 is scoped to touch — building one would be a genuine new feature, not "improving how existing Reception functionality works together."

**Suggested fix, when picked up:** a small branch-select control in the topbar (visible only when `session.branchIds.length > 1`) that calls a new server action to update the session's `activeBranchId` server-side, then `router.refresh()`. Likely belongs in a later P3 batch (P3.12 — Admin/Settings/Role-Aware Navigation) rather than a standalone fix.

**Severity:** Low-Medium — genuinely multi-branch staff exist per the schema (`user_branch_access`), but this project's real usage so far has been effectively single-branch-per-session in practice.

---

## Duplicate-registration override reason isn't required before "Register anyway" proceeds

**Noticed during:** P3.1 (§11, 2026-08-31), while adding an "Open record" link to the duplicate-patient warning dialog.

**What:** `registerPatientAction`'s `duplicateOverrideReason` is optional at every layer — the Textarea has no `required` attribute, the "Register anyway" button has no `disabled` guard tied to it, and the server accepts `undefined` without complaint (`opts.duplicateOverrideReason ?? null` is simply logged as `null`). A receptionist can click through the duplicate warning with zero explanation, which is technically legal today but works against the entire reason this field exists — DATABASE.md/PROJECT_STATUS.md both frame it as "so an accumulating pattern of overridden warnings can actually be investigated later."

**Why not fixed in P3.1:** the task's own instruction was explicit — "preserve the existing warn-not-block design and its audited override reason" — and making the reason mandatory is a real (if small) business-rule change, not a UI polish, so it was left alone rather than decided unilaterally.

**Suggested fix, when picked up:** disable "Register anyway" until the Textarea has non-whitespace content, mirroring the existing pattern already used for the Cancel Appointment dialog's reason field (`disabled={pending || !reason.trim()}`) — a UI-layer nudge, not a new server-side rejection, if the product decision is "encourage but still never hard-block."

**Severity:** Low.

---

## ~~Appointment/patient "wrong branch" and "not found" errors fall through to the fully generic error boundary~~ — RESOLVED in the targeted commercial/safety backlog closure (2026-09-02)

**Noticed during:** P3.1 (§22, 2026-08-31), while manually verifying unauthorized-branch behavior on the new appointment detail page.

**What:** Every `[id]` detail page in this app (patients, claims, and now appointments) calls its `getX(session, id)` domain function directly with no try/catch; a bad id or a branch the session isn't authorized for both throw, and both are caught only by the shared `(dashboard)/error.tsx` boundary, which deliberately shows nothing more specific than "Something went wrong. This has been logged." — correct in that it never leaks a raw error, but it doesn't tell staff *why* (wrong branch vs. a stale/bad link vs. a genuine bug) the way p3.md §22's own named "unauthorized branch"/"patient not found" cases suggest it could.

**Why not fixed in P3.1:** this is pre-existing behavior across the whole app, not something this batch introduced, and fixing it properly means either a shared not-found/forbidden helper or per-page try/catch on every `[id]` page in the codebase — well beyond "the components you actually touch" for a Reception-scoped batch.

**Suggested fix, when picked up:** a small shared helper (e.g. `notFoundOrForbidden(error, fallbackPath)`) domain `[id]` pages can wrap their fetch in, translating `ForbiddenError`/Prisma "not found" into a friendly redirect or inline message — a good candidate for a later cross-cutting UX batch (P3.13) rather than a per-page patch now.

**Severity:** Low — the current behavior is safe (no raw error ever leaks), just less informative than it could be.

**Resolved:** Targeted commercial/safety backlog closure (2026-09-02), item 4. Built exactly the suggested shared helper — `loadOrNotFound()` (`src/lib/platform/not-found.ts`) wraps a domain fetch, translating `ForbiddenError`/Prisma "not found" (P2025) into a call to Next's `notFound()`, which now resolves to the dashboard's own already-correctly-worded `not-found.tsx` ("doesn't exist, or you no longer have access to it") instead of the generic error boundary. Wired into every major operational `[id]` page: appointments, patients, encounters, invoices, the payment receipt print view, and the lab/radiology order detail pages. Deliberately does not distinguish "not found" from "forbidden" in what it shows, to avoid a wrong-branch/wrong-org id revealing that a record with that id exists. Verified live in the browser (a stale appointment/invoice id now shows the friendly not-found page) and via a dedicated unit test (`test/integration/p3-3-doctor-encounter-workflow.test.ts`).

---

## ~~Stock transfers have the same batch-selection gap manual adjustments had~~ — RESOLVED in P3.8

**Resolved:** P3.8 (Inventory / Procurement Operational UX, 2026-09-01). `stockTransferSchema.batchId` is now mandatory; `transfer-dialog.tsx` fetches real, non-expired, non-zero-balance source batches (via `listAvailableBatches`) and requires one to be picked before submit; `completeTransfer`'s balance check moved inside the transaction under a `product_batch` row lock, with an added expired-batch check. See `P3_8_INVENTORY_PROCUREMENT_OPERATIONAL_UX_REPORT.md`'s Transfers section for the full before/after.

---

## ~~Purchase Orders and Purchase Requests are still unbounded lists~~ — RESOLVED in P3.8

**Resolved:** P3.8 (Inventory / Procurement Operational UX, 2026-09-01). Both `listPurchaseOrders` and `listPurchaseRequests` now use the same `resolvePage`/`paginationSkipTake`/`totalPages` convention as every other P2-paginated list, with `PaginationControls` on their respective `/purchasing` tabs (independent `requestsPage`/`ordersPage` query params so the two lists paginate independently of each other and of the pre-existing Supplier Invoices `page` param). The `NewOrderDialog`'s "approved requests" picker was left on the unpaginated `listPurchaseRequests` result's full first page deliberately — same reasoning P2 Batch 6 gave for Employees/Assets — worth re-checking if the number of simultaneously-approved-but-unconverted requests ever grows past one page in practice.

---

## Purchase Orders have no approval step — a single Inventory Manager can both approve their own Purchase Request and issue the resulting PO

**Noticed during:** P3.8 (Inventory / Procurement Operational UX, 2026-09-01), while tracing the actual PR→PO lifecycle per §29/§31/§33.

**What:** `createPurchaseOrder` goes straight to `status: "issued"` — there is no `purchase_order.approve`-shaped permission or pending/approved state a PO passes through before being sent to a supplier, unlike Purchase Requests (which do have a real submit→approve/reject segregation via `purchase_request.approve`, a distinct permission from `purchase_request.create`). Compounding this, the seeded "Inventory Manager" role holds `purchase_request.create`, `purchase_request.approve`, AND `purchase_order.create` all at once — so one person can request, approve their own request, and issue the PO with no second set of eyes anywhere in the chain, for procurement spend of any size.

**Why not fixed in P3.8:** the task's own instruction was explicit — "use existing models... Approval/reject/cancel actions appear only when valid and permitted — no broad-granting of approval rights... don't invent procurement policy or states." No PO-level approval state exists in the schema (`PurchaseOrderStatus` is `draft|issued|partially_received|received|cancelled`, no `pending_approval`), so adding one would be inventing new procurement policy, not surfacing existing behavior — exactly what this batch was told not to do. The `Inventory Manager` role's own permission bundle (both request-approve and order-create together) is a seed-data/RBAC design decision, not something an operational-UX batch should silently narrow.

**Suggested fix, when picked up:** decide, as a product/security decision (not a code-only one), whether PO issuance above some threshold needs its own approval gate — if so, add a `pending_approval` `PurchaseOrderStatus`, a `purchase_order.approve` permission distinct from `purchase_order.create`, and split the seeded "Inventory Manager" role's bundled permissions across two roles (e.g. "Procurement Staff" that can request/issue, "Inventory Manager"/"Clinic Manager" that approves) so the segregation-of-duties pattern already used for Purchase Requests and P4's refund workflow extends to POs too.

**Severity:** Medium — real financial-control gap for organizations that want spend segregation-of-duties, but not a live bug: today's actual behavior (no PO approval step) is honest, consistent, and was traced/verified rather than assumed.

---

## No bank/cash/ledger reconciliation model or UI exists

**Noticed during:** P3.9 (Finance / Accounting Operational UX, 2026-09-01), while tracing §29's "determine the actual existing model (bank/cash/ledger reconciliation or other) — don't assume."

**What:** There is no `BankStatement`/`Reconciliation`/equivalent model in `prisma/schema.prisma`, no reconciliation domain file, and no reconciliation page or UI anywhere in the app — confirmed by a direct schema search, not inferred from absence of a page alone. The closest existing concept is `getPatientStatement`'s (billing/statement.ts) own internal `reconciled: boolean` self-check — but that verifies a single patient's running AR balance against its own line items, an entirely different concept (patient statement internal consistency, not bank/cash-against-ledger reconciliation) that happened to reuse the word "reconcile" in its own doc comment.

**Why not built in P3.9:** the task's own instruction was explicit — "don't assume [a model]... do not build a whole reconciliation feature un-prompted" is the same discipline §26 (AR aging) and the pharmacy-return Path B decision both apply: a real bank/cash reconciliation feature (statement import or entry, transaction matching, matched/unmatched/difference tracking, a reconciliation-status model) is genuine new architecture, not a "very small extension of existing infrastructure" — squarely outside a narrow operational-UX batch's bounds, and not named as something already built that merely needed wiring.

**Suggested fix, when picked up:** design a `BankReconciliation`/`BankStatementLine` pair (statement reference, date, amount, matched `JournalLine` or `Payment`/`SupplierPayment` id, status: unmatched/matched/discrepancy) scoped per cash/bank `ChartOfAccount`, with a simple "upload or manually enter statement lines, match against unreconciled journal lines for that account" workflow. A good candidate for its own small, dedicated batch — real enough to need proper design, small enough not to need a P3.9-sized trace first now that this note exists.

**Severity:** Low — no current workflow depends on it; this is a genuine V1 gap for organizations that need to formally reconcile cash/bank accounts against real bank statements, not a bug or regression.

---

## Notifications has no read-side UI at all — not just missing pagination

**Noticed during:** P2 Batch 6 (§8, 2026-08-29), while working through P2.md §8's named list, which includes "Notifications."

**What:** The `Notification` model (`prisma/schema.prisma`) is written to from `event-handlers.ts`/`outbox.ts` but has **zero read paths anywhere** — no `listNotifications`-shaped query function exists in `src/lib/domains` or `src/lib/platform`, no page under `src/app` renders one, and there's no nav entry. Every notification this system has ever created is, today, permanently invisible to any user.

**Why it wasn't fixed in Batch 6:** P2.md §8 is scoped to *pagination of existing lists* ("Review all major list/report screens for unbounded or hard-capped queries... Implement server-side pagination where appropriate"). There is no existing screen to paginate here — building the first version of a Notifications inbox (query function, page, nav entry, an unread/read affordance) is a real, standalone feature, not a performance fix to an existing one, and out of this batch's scope on that basis alone.

**Suggested fix, when picked up:** The schema is already fully ready — `Notification` already has `recipientUserId`, `status` (`NotificationStatus`: unread/read), `type`, `title`, `body`, and the usual `referenceType`/`referenceId` polymorphic pointer. Build `listNotifications(session, { page, status? })` following this batch's own established pagination convention from day one (never worth retrofitting), an action to mark one read (`status: "read"`), and a page (likely a lightweight dropdown/panel off the top nav bar rather than a full list page, matching how most systems surface notifications, with an unread-count badge querying `db.notification.count({ where: { recipientUserId, status: "unread" } })`).

**Severity:** Medium — this isn't a performance gap, it's a genuine dead feature: every notification the system has ever generated has been invisible since Phase 1.

---

## Receptionist role can't open Reception or Appointments — `listBranches` requires `branch.view`, which the seeded role doesn't have

**Noticed during:** P3.2 (Patient 360 & Front-Desk Patient Journey, 2026-08-31), while fixing the identical bug on Patient 360 itself (see `P3_2_PATIENT_360_REPORT.md`'s "Concrete Problems Found").

**What:** `reception/page.tsx` and `appointments/page.tsx` (both P3.1) call `listBranches(session)` unconditionally, and `listBranches` (`identity/org-structure.ts`) asserts `branch.view`. Cross-referencing the seeded role permission sets (`prisma/seed.ts`), only Clinic Manager and the two admin roles hold `branch.view` — **Receptionist does not**, despite Receptionist being the intended primary user of both pages (`appointment.create`, `appointment.checkin`, etc. are all present; `branch.view` alone is missing). A logged-in Receptionist opening `/reception` or `/appointments` today hits a thrown `ForbiddenError` with no catch anywhere in the tree, landing on the generic "Something went wrong" error boundary instead of the page.

**Why not fixed in P3.2:** both pages are P3.1 deliverables, explicitly out of scope this batch ("P3.1 is closed; do not reopen it unless P3.2 introduces a direct regression" — this is a pre-existing P3.1 bug, not something P3.2 introduced). Patient 360 itself had the exact same class of bug (several `listPatient*`/`listBranches` calls with no `can()` guard, crashing the page for under-privileged roles) and *was* in scope, so it was fixed there — see the Patient 360 report for the full pattern and reasoning.

**Suggested fix, when picked up:** either (a) add `branch.view` to the Receptionist (and any similarly-affected) role's seeded permission list in `prisma/seed.ts` — the more likely actual product intent, since `listAccessibleBranches` (`billing/cashier.ts`) already exists specifically to give a non-branch-admin role its own branches without `branch.view`, suggesting `listBranches` calls on Reception/Appointments should probably be swapped for that instead — or (b) gate the `listBranches` call behind `can(session, "branch.view")` the same defensive way this batch just did on Patient 360, degrading to an empty branch-select rather than crashing. Re-verify: does the Receptionist role's own seeded permission list need `branch.view` added, or is `listAccessibleBranches` the actually-correct call here?

**Severity:** High — this is a full-page crash for the primary front-desk role on two already-shipped, actively-used pages, not a cosmetic gap. Flagging with urgency despite being out of this batch's bounded scope.

---

## ~~Shared `TabsList` doesn't support wrapping to multiple rows — `flex-wrap` (used on 5 pages) overlaps content when it actually wraps~~ — RESOLVED in P4.7A.1

**Noticed during:** P3.2 (Patient 360 & Front-Desk Patient Journey, 2026-08-31), while verifying Patient 360's 19-tab row in the browser.

**What it was:** `src/components/ui/tabs.tsx`'s `TabsList` hard-coded `group-data-horizontal/tabs:h-8` (a fixed single-row height) and each `TabsTrigger`'s active-state pill was sized `h-[calc(100%-1px)]` of that row — so a wrapped, multi-row `TabsList` (`className="flex-wrap"`, used on Reports/Accounting/Communications/Portal) stayed clipped to one row's height, and every row past the first visually overlapped whatever content sat below the tab bar. Reproduced live in the browser at 390px on Reports during P4.7A.1's own responsive verification pass (§40-43) — the description and first KPI row sat underneath the wrapped second/third tab rows, and the active-tab pill stretched across the full multi-row height instead of just its own row.

**Fix (P4.7A.1, 2026-09-04):** `tabsListVariants` now uses `min-h-8` instead of a fixed `h-8` (grows to fit a wrapped list; pixel-identical at one row), and `TabsTrigger`'s height changed from a percentage (`h-[calc(100%-1px)]`, which measured against the *whole* wrapped container once it could grow past one row) to a fixed `h-[calc(2rem-1px)]` matching the single-row case exactly regardless of how many rows the list wraps to. Verified live at 390px on Reports (three clean rows, no overlap, correctly-sized active pill) and confirmed unchanged at desktop width on Patient 360's own single-row scrollable tabs and every plain single-row `Tabs` usage (Pharmacy, Laboratory, etc.). `patients/[id]/page.tsx` still uses its own horizontal-scroll pattern rather than `flex-wrap` — not reverted, since it works well and a scrollable single row is still the better fit for 19 tabs specifically — but the other 4 `flex-wrap` pages (Reports, Accounting, Communications, Portal) now wrap correctly with no primitive change of their own needed.

**Severity:** Was Medium. Resolved.

---

## No `/episodes/[id]` detail page exists yet

**Noticed during:** P3.2 (Patient 360 & Front-Desk Patient Journey, 2026-08-31), while reviewing whether Patient 360's Episodes tab or Encounters tab could cross-link to a specific episode (episode↔encounters relationship, per the batch's own instruction).

**What:** `/episodes` (top-level list, added in commit `b759c65`) exists, and `Encounter.episodeId` exists on the model, but there's no `/episodes/[id]` route — so neither Patient 360's Episodes tab nor its Encounters tab can link an encounter back to the specific episode it belongs to without landing on a page that doesn't exist. Left unlinked this batch (per the batch's own "only link types with genuine destinations, no dead links" instruction) rather than inventing a dead link.

**Suggested fix, when picked up:** build `/episodes/[id]` (episode summary + its encounters, mirroring the shape `/encounters/[id]` already has for its own notes/diagnoses/orders/prescriptions), then add the cross-link both directions on Patient 360.

**Severity:** Low.

---

## ~~Void-returning encounter-section actions (Diagnoses/Orders/Prescriptions/Follow-up) still swallow errors into the generic error boundary~~ — RESOLVED in the targeted commercial/safety backlog closure (2026-09-02)

**Noticed during:** P3.3 (Doctor & Encounter Workflow, 2026-08-31), while fixing the identical gap on `EncounterHeader`'s Complete/Finalize/Cancel/Entered-in-error actions.

**What:** `DiagnosesSection`'s "Mark resolved", `OrdersSection`'s order-status/cancel actions, `PrescriptionsSection`'s "Cancel", and `FollowUpSection`'s "Dismiss" all call their server action inside a plain `startTransition(async () => { await fn(); router.refresh() })` with no `try/catch` — a rejected call (e.g. an invalid status transition, or the same branch-access check this batch just added catching a stale/foreign id) becomes an unhandled promise rejection, surfacing only as the generic route-level "Something went wrong" boundary instead of a specific inline message. `EncounterHeader`'s equivalent actions (Complete encounter/Finalize/Cancel/Entered in error) were fixed this batch since they're this batch's own central deliverable (§23/§24); these four sibling sections have the exact same shape of gap but are comparatively lower-risk actions (marking a diagnosis resolved, cancelling an order/prescription, dismissing a follow-up), so fixing all four here as well was judged outside a tightly-scoped batch.

**Suggested fix, when picked up:** the same pattern `EncounterHeader`'s `run()` helper now uses — wrap the awaited call in `try/catch`, store the caught message in local state, render it via an `Alert`/`AlertDescription` in the section.

**Severity:** Low — the current behavior is safe (no raw Prisma error ever leaks; §33's main risk was already closed by this batch's `findFirst`-based friendly-message fix on the domain layer itself), just less informative than it could be for these four specific actions.

**Resolved:** Targeted commercial/safety backlog closure (2026-09-02), item 5. Applied exactly the suggested `EncounterHeader`-style `run()` pattern to all four sections. Went one step further than a client-only fix: the underlying server actions (`updateDiagnosisStatusAction`, `cancelOrderAction`, `dismissFollowUpAction` — `cancelPrescriptionAction` already did this) previously threw unguarded too, which Next.js would have scrubbed to a generic message on the client regardless of the new client-side try/catch; all three now catch server-side and return a structured `{error}`/`{success}` result matching the file's own established `ActionState` convention, so the real, friendly domain message actually reaches the user.

---

## Vitals don't show who recorded them

**Noticed during:** P3.3 (Doctor & Encounter Workflow, 2026-08-31), while reviewing the encounter workspace's Vitals section against "the doctor should see... recorded by where available."

**What:** `VitalSign.recordedBy` (a raw `String?` user id) is populated on every `recordVitals` call, but there's no Prisma relation from `VitalSign` to `User` in the schema — only the bare scalar id, unlike `LabOrderTest`/`ImagingOrder`'s equivalent actor fields, which do have named relations (`enteredByUser`, `verifiedByUser`, etc.). Both the encounter workspace's `VitalsSection` and Patient 360's Vitals tab therefore have no way to resolve and show a name.

**Why not fixed in P3.3:** adding the missing relation is a schema change ("do not rebuild... Vitals" per this batch's own boundary), and resolving names without one would mean a second, separate `User` lookup per distinct `recordedBy` id on every encounter/Patient-360 load — a small but real addition to query count this batch's own performance section cautions against adding without justification for a "where available" nice-to-have.

**Suggested fix, when picked up:** add a `recordedByUser User? @relation(...)` to `VitalSign` (mirroring the pattern already established on `LabOrderTest`/`ImagingOrder`) in a schema migration, then include/select it in `getEncounter`'s `ENCOUNTER_WORKSPACE_INCLUDE` and Patient 360's vitals query.

**Severity:** Low.

---

## ~~Secondary "fetch before update" lookups in clinical domain functions still use `findFirstOrThrow`, leaking a raw Prisma message on a stale/invalid id~~ — RESOLVED in the targeted commercial/safety backlog closure (2026-09-02)

**Noticed during:** P3.3 (Doctor & Encounter Workflow, 2026-08-31) — found live, in this batch's own browser walkthrough, when a corrupted `encounterId` (a test-methodology mistake, not a real product path) surfaced Prisma's full "Invalid `db.encounter.findFirstOrThrow()` invocation... No record was found" message verbatim inside the "Recommend follow-up" dialog.

**What:** The *primary* encounter lookup in `recordVitals`, `addDiagnosis`, `createOrder`, `createPrescription`, `recommendFollowUp`, and `saveNote` was fixed this batch (now `findFirst` + a friendly thrown `Error`, matching `startEncounter`'s own fix). The *secondary* "fetch the row being updated" lookups — `updateDiagnosisStatus`'s `db.diagnosis.findFirstOrThrow`, `cancelOrder`/`updateOrderStatus`'s `db.clinicalOrder.findFirstOrThrow`, `cancelPrescription`'s `db.prescription.findFirstOrThrow`, `dismissFollowUp`'s `db.followUpRecommendation.findFirstOrThrow`, and `createAmendment`'s `db.clinicalNote.findFirstOrThrow` — still use the throwing form, and would leak the same raw message for a stale/invalid id.

**Why not fixed in P3.3:** these ids are typically sourced from a just-rendered list on the same page (lower realistic staleness risk than `encounterId`, which persists across the whole workspace session), and fixing all five in the time remaining in this batch was judged lower priority than the primary-lookup fix and the branch-isolation fix this batch centered on.

**Suggested fix, when picked up:** the exact same two-line pattern already applied six times this batch — swap `findFirstOrThrow` for `findFirst` + `if (!row) throw new Error("...")`.

**Severity:** Low — narrow window (an id going stale between page render and the update action), and the current failure mode is safe (a caught, if unfriendly, error message), not a crash or data-integrity issue.

**Resolved:** Targeted commercial/safety backlog closure (2026-09-02), item 6. Applied exactly the suggested two-line pattern to all five named functions, plus `createAmendment` (notes.ts) which had the same shape. Verified via a dedicated integration test asserting all six throw a friendly "no longer exists or is not accessible" message, never Prisma's own raw invocation text.

---

## Encounter's clinical orders have no "result destination" link back from the encounter, once the result is available

**Noticed during:** P3.3 (Doctor & Encounter Workflow, 2026-08-31), while reviewing §27 ("Lab order → status → result destination once available... Imaging order → status → report destination once available").

**What:** `OrdersSection` in the encounter workspace shows each order's status (ordered/acknowledged/in_progress/completed/cancelled) but has no link to the actual result once one exists. Investigated `/laboratory/orders/[id]` and `/radiology/orders/[id]` as candidate destinations — both are keyed by the same `ClinicalOrder.id` already on hand, so linking them technically works, but both pages are gated on `lab_result.enter`/`lab_result.verify`-class permissions (correctly — they're the P3.5 lab/radiology *operational* workspace, not a doctor-facing result view), which Doctor does not hold. The actual doctor-appropriate destination for a finished result is Patient 360's Lab Results/Imaging tabs (already correctly permissioned for Doctor) — but Patient 360's tabs aren't currently addressable via a URL/search-param (no deep-linking to a specific tab), so there's no single-click destination to send the encounter's order row to today.

**Why not fixed in P3.3:** the real fix (Patient 360 tab deep-linking via search params) is a Patient-360-side architectural addition outside this batch's own scope ("do not touch Patient/Appointment/Episode/Encounter/... — those already exist," and Patient 360 itself is P3.2, closed). Linking to the lab/radiology operational pages instead would be actively wrong for the Doctor role (permission-denied redirect) and was rejected rather than shipped as a half-solution.

**Suggested fix, when picked up:** add search-param-driven tab selection to Patient 360 (`/patients/[id]?tab=lab-results`), then link each completed lab/imaging order row in the encounter workspace to the patient's Lab Results/Imaging tab directly.

**Severity:** Low-Medium — the order's own status is still visible in the encounter (satisfies §27's "at minimum"); the doctor can already reach Patient 360 in one click via the header's patient-name link and navigate to the right tab manually.

---

## `report-reconciliation.test.ts` is flaky — a floating-point epsilon, not a real reconciliation break

**Noticed during:** P3.4 (Nursing / Vitals / Pre-Consultation Workflow, 2026-08-31), while running the full regression suite — entirely unrelated to this batch's own scope (clinical/vitals/queue), surfaced only because the full suite was run twice.

**What:** `test/integration/report-reconciliation.test.ts`'s `revenueAfterInvoice - revenueBeforeInvoice` assertion failed once with `499.9999999999991` instead of the expected `500`, using `toBe` (exact equality). Re-ran the same file in isolation twice with no code changes in between: failed once, passed once — confirmed flaky, not a real regression. `getFinancialReport`'s revenue figure comes from a Postgres-side `_sum` aggregate (exact `NUMERIC` arithmetic) converted to a JS `Number` exactly once; the ~9×10⁻¹³ discrepancy is classic floating-point subtraction cancellation when two large, nearly-equal doubles are subtracted (`revenueAfterInvoice - revenueBeforeInvoice`), not a genuine ledger imbalance — the underlying Decimal-precise database values are not in question.

**Why not fixed in P3.4:** the domain this test covers (accounting/revenue reporting) has zero overlap with anything P3.4 touched (clinical/vitals/queue/encounter files only) — confirmed by reading the test's own imports. Fixing it means a financial-reporting precision decision (switch the assertion to `toBeCloseTo`, or have the report itself sum via Decimal arithmetic instead of converting to `Number` before any subtraction) that deserves its own dedicated review, not a drive-by fix from an unrelated batch.

**Suggested fix, when picked up:** either loosen the test assertions from `toBe` to `toBeCloseTo(500, 6)` (or similar) for float-derived financial deltas, or have `getFinancialReport` (and any other report doing Decimal→Number conversion before arithmetic) do the subtraction in Decimal space and convert to `Number` only at the very end for display.

**Severity:** Low — a test-suite flakiness / assertion-strictness issue, not an actual financial-data integrity problem; every real currency value in this system still rounds to 2 decimal places for display, well inside where this epsilon would ever be visible.

---

## No pain-score field on VitalSign

**Noticed during:** P3.4 (Nursing / Vitals / Pre-Consultation Workflow, 2026-08-31), while reviewing §10's list of possible vitals fields against the actual `VitalSign` schema.

**What:** Pain score (a common nursing-triage measurement) is not a field on `VitalSign` today. §10 explicitly names it as a "possible" field, conditioned on "use actual schema fields only... do not invent fields not represented by the current model unless a small, clearly justified schema addition is required for essential V1 nursing workflow." Judged not essential for V1 — the batch's core deliverable (vitals recording, nurse→doctor handoff, attribution) doesn't depend on it, and every other field already on the model (temperature/pulse/respiratory rate/BP/SpO2/weight/height/BMI/glucose) was sufficient for a working nursing workflow.

**Suggested fix, when picked up:** add `painScore Int? @map("pain_score")` (a simple 0–10 scale is the common clinical convention) to `VitalSign` alongside a small migration, form field, and display update — the same narrow-migration pattern this batch used for `recordedByUser`.

**Severity:** Low — a genuinely common nursing measurement, but not blocking any current workflow.

---

## ~~No amendment/correction mechanism for finalized Radiology reports~~ — RESOLVED in the targeted commercial/safety backlog closure (2026-09-02)

**Noticed during:** P3.5 (Laboratory / Radiology & Clinical Order Handoff Workflow, 2026-08-31), while tracing §16's "result corrections" instruction against the actual `ImagingOrder` schema and comparing it to Lab's existing mechanism.

**What:** `LabOrderTest` has a full, working amendment chain (`isCurrent`/`amendsId` fields, `amendLabResult` domain function, "Amend result" UI action) — a verified lab result can be corrected via a new, linked row while the original stays intact and non-current. `ImagingOrder` has no equivalent: no `isCurrent`/`amendsId` fields on the model at all, and no amend function or UI action. A verified/finalized radiology report is correctly immutable (nothing transitions `writeReport`'s required `"performed"` precondition back from `"verified"`), but that also means there is currently no way to correct a finalized report that turns out to have an error — only the (undesirable) options of leaving it wrong or manually editing the database directly.

**Why not fixed in P3.5:** the task's own instruction was explicit — "if none exist, do not build a large amendment architecture now — log to backlog" (§16). Adding `isCurrent`/`amendsId` to `ImagingOrder`, a new `amendImagingReport` domain function, and the corresponding UI action would be a real, non-trivial feature addition, not a narrow fix within this batch's bounded scope.

**Suggested fix, when picked up:** mirror Lab's exact pattern — add `isCurrent Boolean @default(true)` and `amendsId String?` (self-relation) to `ImagingOrder`, a narrow migration, an `amendImagingReport` domain function structurally identical to `amendLabResult`, and an "Amend report" action on the radiology order detail page gated the same way "Amend result" is on the lab one. A good candidate for a small, standalone follow-up batch given how directly it can reuse Lab's already-proven shape.

**Severity:** Medium — finalized clinical evidence with a genuine error currently has no supported correction path, though this is a real (if not yet observed) gap rather than an active bug affecting today's data.

**Resolved:** Targeted commercial/safety backlog closure (2026-09-02), item 7. NOT mirrored exactly as suggested — `ImagingOrder.clinicalOrderId` is `@unique` (exactly one row per ClinicalOrder), unlike `LabOrderTest` which already supports many rows per order, so the identical "second row + isCurrent flip" trick isn't available without relaxing that uniqueness (a much wider, riskier change touching every existing `findUnique`-by-clinicalOrderId lookup in the radiology domain). Built a narrow, dedicated `ImagingReportAmendment` table instead (own migration, its own doc comment explains the reasoning) — the original ImagingOrder row stays completely frozen forever once verified; a correction is a new, independently-attributed row; "current" is derived (latest amendment, else the original), never a separate stored flag. `amendImagingReport` domain function (gated on the same `imaging_order.perform` permission `writeReport` itself uses, requires a non-empty `reason`), an "Amend report" dialog on the radiology order detail page, full amendment history shown inline (original + every correction, current one visually distinguished), and Patient 360's Imaging tab / the printable report view both updated to show the CURRENT report, not the frozen original. 7 dedicated integration tests (immutability, reason-required, current-version derivation, history accessibility, branch isolation, stale-id handling).

---

## Shared `ReasonDialog` component has no error handling

**Noticed during:** P3.5 (Laboratory / Radiology & Clinical Order Handoff Workflow, 2026-08-31), while adding try/catch + inline error display to `CollectButton`/`ReceiveButton`/`VerifyButton` (laboratory) and `MarkPerformedButton`/`VerifyButton` (radiology) per §34's friendly-error requirement.

**What:** `RejectSpecimenButton` (laboratory) uses the shared `ReasonDialog` component (`src/app/(dashboard)/invoices/[id]/reason-dialog.tsx`, reused across many call sites app-wide — cancel appointment, cancel order, reject specimen, etc.), which has no error state or display at all — a rejected server action currently fails silently from the user's perspective (the dialog just doesn't close, with no explanation shown).

**Why not fixed in P3.5:** `ReasonDialog` is a shared, app-wide component with call sites well outside Lab/Radiology (invoices, appointments, clinical orders); adding error handling to it is a cross-cutting fix, not something scoped to "the Lab/Radiology components this batch touches." Left `RejectSpecimenButton` itself unchanged rather than fork it into a one-off variant.

**Suggested fix, when picked up:** add the same local error-state + inline `Alert` pattern already applied to every other action button this batch touched, directly inside `ReasonDialog` itself so every one of its call sites benefits at once — a good candidate for a small, standalone cross-cutting UX batch.

**Severity:** Low-Medium — failures here are rare (mostly stale-state races), but when they do happen the current experience is a silently-stuck dialog with no explanation.

---

## ~~`/appointments` page crashes for Doctor (and likely every non-Reception role) — missing `service.view`~~ — RESOLVED in the targeted commercial/safety backlog closure (2026-09-02)

**Noticed during:** P3.5 (Laboratory / Radiology & Clinical Order Handoff Workflow, 2026-08-31), during the browser walkthrough, while trying to book a walkthrough appointment as a Doctor-role session.

**What:** `AppointmentsPage` (`src/app/(dashboard)/appointments/page.tsx`) calls `listServices(session)` unconditionally, which internally does `assertCan(session, "service.view")`. Per the seeded role permission sets, Doctor does not hold `service.view` (only Receptionist/Clinic Manager/Cashier-adjacent roles appear to). The result is a full-page "Something went wrong / An unexpected error occurred while loading this page" crash — confirmed live via `preview_logs` showing `ForbiddenError: Missing permission: service.view` at `AppointmentsPage` — for any Doctor simply trying to view the Appointments page, not just book one.

**Why not fixed in P3.5:** `/appointments` is a Reception/scheduling page, not Lab/Radiology, and well outside this batch's own component list (§3). Worked around it for the walkthrough by creating the appointment/encounter/order chain directly through the domain functions (`bookAppointment`/`checkIn`/`startEncounter`/`createOrder`) rather than through this broken page.

**Suggested fix, when picked up:** same shape as this batch's own `getLabOrder`/`getRadiologyOrder` widening — either gate the services-catalog fetch/display behind `can(session, "service.view")` (only render that section if the session actually holds it) the way this batch did for `listLabTests`/`listLabPanels`/`listImagingServices`/`listRooms`, or grant Doctor `service.view` in the seed if doctors are expected to see service pricing when booking. A quick, well-understood fix once someone is scoped to touch Appointments — likely a P3.1 (Reception & Appointment Workflow) or later navigation-hardening batch.

**Severity:** High for the specific role/page combination — this is a live, reproducible full-page crash for a core role on a core page, not a cosmetic or edge-case gap. Flagged here rather than fixed because it is unambiguously outside Lab/Radiology's own file set.

**Resolved:** Targeted commercial/safety backlog closure (2026-09-02), item 3. Took the first suggested option: `listServices` is now gated behind `can(session, "appointment.create")` (the same permission that already gates whether `NewAppointmentDialog` — the only consumer of the service catalog on this page — is even rendered), rather than granting Doctor `service.view`, since current product design gives no reason for Doctor to browse the service catalog. Verified live in the browser (a real Doctor-role login now opens `/appointments` cleanly, seeing appointments but no "New Appointment" action, with zero console errors).

---

## ~~No system-enforced cross-check between a prescribed medication and the one a pharmacist selects to dispense~~ — RESOLVED in the targeted commercial/safety backlog closure (2026-09-02)

**Noticed during:** P3.6 (Pharmacy / Prescription / Dispensing Workflow, 2026-08-31), while tracing §10/§11's "medication → inventory product mapping" instruction against the actual `createDispensingRecord` flow.

**What:** `PrescriptionItem` (the doctor's free-text medication name/strength/dose) has no link of any kind to `Medication`/`Product` — the pharmacist manually picks any catalog `Medication` from a full dropdown when creating a `DispensingRecord`, with nothing server-side comparing the selection against what was actually prescribed. This batch added a visible "Prescribed: ..." reference block inside the dispense dialog so a pharmacist can eyeball the match, but that is a UI-level aid only — a pharmacist could still select a completely unrelated medication and the system would accept it.

**Why not fixed in P3.6:** the task's own instruction was explicit — "if substitution is not modeled, do not invent it in P3.6... dispense the mapped/prescribed item or block with an understandable message. Future generic/brand substitution rules can be backlog." Building an automated fuzzy-match/confirmation/blocking mechanism would be inventing validation logic the instruction specifically asked not to add this batch.

**Suggested fix, when picked up:** a lightweight fuzzy string match between `PrescriptionItem.medicationName`/`genericName` and `Medication.product.name`/`genericName` at dispense time — surfaced as a soft warning ("This doesn't look like a match for the prescribed item — continue anyway?") rather than a hard block, since brand/generic substitution is a legitimate real-world pharmacy practice. A harder-blocking mode could be a later, explicitly-opted-into safety setting.

**Severity:** Medium — a real patient-safety gap in the abstract (wrong medication dispensed), but mitigated today by the same human-in-the-loop review every pharmacy workflow relies on, and now further mitigated by the new visible cross-reference block.

**Resolved:** Targeted commercial/safety backlog closure (2026-09-02), item 8. Built essentially the suggested design: `looksLikeSameMedication()` (`src/lib/utils/medication-match.ts`) is a deliberately simple, non-clinical, non-fuzzy-library case-insensitive equality/substring check, shared between the client dialog (shows the warning immediately) and `createDispensingRecord` (the server-side mirror the requirement can't be bypassed by skipping). Never auto-substitutes, never blocks a legitimate substitution — only requires the pharmacist to explicitly tick a confirmation checkbox when the names don't obviously correspond, disabling the Dispense button until they do. A new `DispensingRecord.substitutionConfirmed` boolean records whether a given dispense was an explicit, confirmed substitution (false for an ordinary matching dispense). 3 dedicated integration tests (obvious match needs no confirmation; mismatch without confirmation is rejected; mismatch with confirmation succeeds and is durably recorded) plus a fix to 9 pre-existing P3.6 test fixtures that used non-matching names incidentally (unrelated to what they were testing).

---

## ~~Dispensing returns do not reverse the original Charge or its COGS posting~~ — PARTIALLY RESOLVED in P3.9 (pre-invoice case); invoiced case still needs a CreditNote design

**Noticed during:** P3.6 (2026-08-31), re-examined P3.7 (2026-09-01), fully traced and partially resolved in **P3.9** (Finance / Accounting Operational UX, 2026-09-01).

**What was fixed in P3.9:** `returnDispensingRecord` (pharmacy/dispensing.ts) now reverses the Charge and its COGS posting for the one state that's genuinely safe to close automatically — a **full** return (every unit dispensed, across all `DispensingReturn` rows) of a charge that is **still `pending`** (never invoiced — confirmed via `DispensingRecord.chargeId`, a real, always-set-once-dispensed, unique FK). In that state there is no ambiguity: no `InvoiceLine`, no revenue ever recognized, no payment ever possible — so voiding the charge and reversing its COGS (reusing `postProductSaleVoided`/`ProductSaleVoided`, the exact same charge-id-keyed mechanism `voidCharge` uses for a POS sale) closes stock, COGS, and revenue completely and correctly. This is a real fix, not a shortcut — every leg that could possibly be open in that state is closed.

**What remains open, and why it's still genuinely unsafe to automate:** a return against a charge that has already been **invoiced** (`charge.status === "invoiced"`) is NOT reversed automatically — `financialReversal: "manual_review_required"` is returned instead, and the UI (`return-dialog.tsx`) says so explicitly rather than implying a refund happened. P3.9 traced the exact reason a safe fix isn't available yet, more precisely than P3.7's original finding:
1. `InvoiceLine.chargeId` is a real, unique FK — so the returned line's own `lineTotal`/`taxAmount`/`discountAmount` ARE reliably determinable, even on a multi-line invoice. This part is NOT the blocker P3.7 assumed it might be.
2. The actual blocker: `PaymentAllocation` (payment/invoices.ts) is **invoice-level only** — there is no line-level payment allocation anywhere in the model. On a multi-line, partially-paid invoice, there is no way to determine whether the specific returned line was ever actually paid, is still fully outstanding, or was covered by a payment really intended for a sibling line. Reversing revenue/AR or issuing a refund without that guarantee risks crediting money that was never collected for this item, or leaving a genuinely-paid item's revenue silently overstated.
3. `Refund` (billing/refunds.ts) is invoice-level lump-sum with no line/charge linkage, confirming P3.7's original finding on that specific model — but the newly-identified root cause is `PaymentAllocation`'s granularity, not `Refund`'s.

Also identified and left unfixed for the same reason: a **partial** return of a still-`pending` charge (some units returned, some kept) — `Charge` has no supported way to reduce its own quantity/amount in place, so this also returns `manual_review_required` rather than a silent no-op or an incorrect full-charge void.

**Precise design recommendation for the remaining gap:** add line-level payment/refund granularity — the cleanest fix is a `PaymentAllocation`-style extension or a new `chargeId`-scoped `CreditNote`/`ReturnCredit` model (mirroring `Refund`'s own shape: amount, reason, status, requested/authorized/completed) that can independently express "$X of THIS charge's revenue is credited back," reusable both for pharmacy returns and any other future partial-line correction. This is real design work touching the shared Billing/Accounting posting service, appropriately out of scope for both the original Pharmacy batch and this operational-UX batch — a good candidate for a dedicated financial-reversal design batch.

**Severity:** Low-Medium, reduced from P3.7's assessment — the common/safe case (return before invoicing) is now handled correctly; the remaining gap is narrower (invoiced-and-possibly-paid returns only) and the UI now makes the distinction explicit rather than silently implying a refund.

---

## Approved leave is not reflected on the Attendance roster or "on leave today" reporting

**Noticed during:** P3.10 (HR / Payroll / Employee UX, 2026-09-01), while implementing §45's HR workspace and re-checking §25's "verify approved leave doesn't accidentally show as unexplained absence where the architecture already connects them."

**What:** `approveLeave` (hr/leave.ts, P1 behavior, unchanged this batch) flips `Employee.status` to `on_leave`, but nothing creates or marks an `AttendanceRecord` for the leave's date range. Two concrete, live-confirmed consequences: (1) `listActiveEmployeeRoster` (the query behind `/attendance`'s "Today's Roster" and the leave/payroll pickers) filters `status: "active"` only, so an employee on approved leave silently disappears from today's attendance roster entirely — not shown as "on leave," just absent from the list, which could read as "not employed here" rather than "away with approval." (2) An "on leave today" count computed from `AttendanceRecord.status === "on_leave"` (a metric this batch considered adding to the new HR Workspace page) would always read ~0 in practice, since no such row is ever created — confirmed live in this batch's own browser walkthrough (approving a leave request for an employee who had already checked in that same day left their attendance record's own status at `present`, unrelated to the leave approval). The HR Workspace page deliberately does NOT surface this metric for that reason (see workspace.ts's own doc comment).

**Why not built in P3.10:** §25 itself says "do not build automatic attendance generation unless already supported" — it isn't; auto-creating an `AttendanceRecord` (with what `branchId`, what `shiftId`, on approval vs. retroactively for a leave request spanning already-past dates) is a real design decision, not a one-line fix, and risks colliding with a genuine same-day check-in (exactly the scenario this batch's walkthrough hit).

**Suggested fix, when picked up:** either (a) have `approveLeave`'s existing transaction upsert an `AttendanceRecord` with `status: "on_leave"` for each date in the leave's range that doesn't already have a record with a real `checkInAt`, or (b) keep attendance and leave as separate signals but have the Attendance roster page separately query approved `LeaveRequest`s covering today and render those employees with an explicit "on leave" row instead of omitting them. (b) is safer (no synthetic attendance rows to keep in sync) and better matches this codebase's "derive live, don't store a redundant duplicate" convention used elsewhere (leave balances, invoice reconciliation).

**Severity:** Low — no financial or data-integrity risk (nothing is stored incorrectly), but a real operational-clarity gap for HR glancing at "who's here today."

---

## Overlapping leave requests are not prevented server-side

**Noticed during:** P3.10 (HR / Payroll / Employee UX, 2026-09-01), while tracing §23.

**What:** `requestLeave`/`approveLeave` (hr/leave.ts) never check whether the requested/approved date range overlaps another `requested` or `approved` `LeaveRequest` for the same employee. Two overlapping leave requests for the same employee can both be approved independently (each only checks the LEAVE BALANCE, not calendar overlap against the employee's own other requests).

**Why not fixed in P3.10:** §23 explicitly says "if current model allows overlaps, document rather than invent policy unless it creates obvious corruption" — this does not corrupt any financial or clinical record (worst case: an employee's leave balance is debited twice for genuinely overlapping dates, which the existing entitlement check would still catch and block if a `LeaveBalance` row exists for that type/year — the balance check already prevents the compounding financial-adjacent case named in P1 §25).

**Suggested fix, when picked up:** add a same-employee overlap check (`startDate <= existingEnd AND endDate >= existingStart` against other `requested`/`approved` rows) inside `requestLeave` or `approveLeave`'s existing transaction, with the same explicit-override escape hatch already established for the entitlement check.

**Severity:** Low.

---

## ~~Employee<->User linking has no UI to create or change it — only to see it~~ — RESOLVED in P3.12

**Noticed during:** P3.10 (HR / Payroll / Employee UX, 2026-09-01), while tracing §9.

**What:** `Employee.userId` (a real, `@unique` FK to `User`) can currently only be set via direct database access — `createEmployee`/`updateEmployee`'s domain functions accept a `userId` field, but no UI form anywhere exposes a picker for it (this batch found and fixed a real bug where `updateEmployee` was silently WIPING an existing link on every edit for exactly this reason — see the report's Concrete Problems Found — but did not build a way to SET the link in the first place, deliberately, per §9's "never auto-create a login unless current architecture explicitly does so" and the general caution against inventing UI for a capability that was never asked for this batch). The employee detail page now shows the link status (new this batch) but there's no "Link to existing user" action.

**Suggested fix, when picked up:** a narrow "Link system user" action on the employee detail page — a searchable picker over `User` rows in the same organization not already linked to another Employee, gated on `employee.manage`, with clear UI messaging that this does not create a new login (matches §9's "never auto-create" caution).

**Severity:** Low — a real gap, but a rare one operationally (most employees who need a login are created with one directly through user management, then the pairing is a one-time admin/DB task).

---

## ~~Department management has no UI — `department.manage` is granted to no operational role~~ — RESOLVED in P3.12

**Noticed during:** P3.10 (HR / Payroll / Employee UX, 2026-09-01), while tracing §11.

**What:** `createDepartment`/`updateDepartment` (identity/org-structure.ts) are fully implemented and gated on `department.manage`, but no page anywhere in the app calls them — confirmed via a full route search. Cross-checking `prisma/seed.ts` confirms this is consistent with current intent, not an oversight this batch should silently work around: `department.manage` is granted to no seeded role except Super Admin/Org Admin (even HR Manager only holds `department.view`), so today only a Super Admin could use such a page even if it existed. The Employee create/edit form's department picker correctly shows existing departments (read-only selection); there's simply no way to add a new one except direct DB/seed access.

**Why not built in P3.10:** this is squarely Admin/Settings-shaped functionality (department.manage sits in the seed's "administration" permission category alongside `branch.manage`/`settings.edit`), and P3.10's own stop condition explicitly forbids starting Admin/Settings work.

**Suggested fix, when picked up:** a small Departments CRUD page belongs in a future Admin/Settings batch, alongside Branches — not HR.

**Severity:** Low — departments can still be seeded/managed via direct DB access for now, and this doesn't block any HR/payroll operational workflow.

---

## Employee self-service (viewing one's own payslip/leave/attendance) does not exist

**Noticed during:** P3.10 (HR / Payroll / Employee UX, 2026-09-01), per §42's explicit instruction to document this as future work rather than build it now.

**What:** There is no concept of an Employee logging in and seeing only their own HR/payroll data — `Employee.userId` links an employee to a login, but every HR/payroll read (`payroll.view`, etc.) is an operational, org/branch-scoped permission for HR/management roles, not a self-service, resource-owner-scoped one (contrast with `resourceOwnerId` in `permissions-core.ts`, used today only for a cashier's own register session). Payslips this batch built are printed by HR/Admin through the operational workflow (`/payroll/[id]` → per-line "Payslip" link), never by the employee themselves.

**Suggested fix, when picked up:** a genuinely separate, smaller surface — a `resourceOwnerId`-gated payslip/leave-balance/attendance-history read scoped to `session.user.id === employee.userId`, reachable from a minimal self-service area. Real, scoped design work; not a natural extension of the HR/Admin operational pages this batch touched.

**Severity:** Low for V1 — explicitly out of scope per §42.

---

## Payroll/HR core is jurisdiction-neutral by construction, not yet by an explicit adapter layer

**Noticed during:** P3.10 (HR / Payroll / Employee UX, 2026-09-01), per §57's UAE/Saudi/Pakistan future-market note.

**What:** `Employee`/`PayrollRun`/`PayrollRunLine` currently have no country-specific fields at all (confirmed via schema read) — which is the correct V1 state (§57 explicitly forbids implementing WPS/GOSI/EOBI/gratuity/end-of-service now), but there is also no `CountryProfile`/`RegulatoryProfile` scaffold yet for a future statutory-deduction adapter to attach to. `PayrollRunLine.otherDeductions` is a single free-text-amount bucket today — usable as a manual stand-in for a country-specific deduction, but not a structured, auditable, adapter-driven one.

**Suggested fix, when picked up:** when a specific jurisdiction is actually prioritized, introduce `CountryProfile`/`RegulatoryProfile` and a `PayrollAdapter`/`StatutoryDeductionAdapter` pattern (per §57's own naming) rather than adding country-specific columns directly to `Employee`/`PayrollRun`/`PayrollRunLine` — keeps the core model jurisdiction-neutral as more countries are added later.

**Severity:** Informational — no current requirement forces this; recorded so a future batch doesn't have to re-derive the same "keep it out of core" reasoning from scratch.

---

## Low-stock and near-expiry inventory notifications were deliberately not implemented

**Noticed during:** P3.11 (Notifications / Tasks / Operational Awareness, 2026-09-01), per §25-27's own explicit permission to defer these.

**What:** Neither signal was built as a Notification producer this batch. Both would require genuinely new state-tracking infrastructure to avoid becoming noise: a low-stock notification needs state-*transition* semantics (fire only when a product crosses from acceptable to below-threshold, never once per day it merely remains below), which needs a persisted "was this product already below threshold as of the last check" fact somewhere — `StockLedgerEntry`-based balances are computed live, not stored, and no such state currently exists across the several stock-decreasing paths (dispensing, POS sale, adjustment, transfer-out) that would each need to check it. Near-expiry has the same shape problem (needs "already notified for this batch" tracking to stay bounded rather than firing once per batch per day indefinitely). §26/§27 explicitly say to defer exactly this case rather than build the state machine now.

**What was built instead:** the Notification Center's "operational awareness" section (§53) links to the existing `/inventory` low-stock view with a live count (reusing `listLowStock` directly, not a copy) — a low-noise, zero-new-infrastructure way to keep the signal visible without solving the deduplication problem.

**Suggested fix, when picked up:** a small `ProductStockAlertState` (or similar) table keyed on (organizationId, branchId, productId) tracking `lastKnownBelowThreshold: boolean` / `lastNotifiedAt`, updated by the existing stock-mutation paths, checked before creating a new low-stock Notification. Near-expiry would need an equivalent per-batch "already notified" marker. Both are real, bounded, well-scoped follow-up work — not urgent.

**Severity:** Low — the existing Inventory page remains the operational source of truth and was explicitly preserved as such; this is a "nice to have" proactive signal, not a gap in what's currently knowable.

---

## Accounting dead-letter notifications still go to Admin only, not directly to Accountant

**Noticed during:** P3.11 (Notifications / Tasks / Operational Awareness, 2026-09-01), while implementing §29's "a Finance notification may point to Accounting Exceptions."

**What:** `notifyDeadLetter` (platform/outbox.ts, pre-existing since P0) notifies Super Admin/Organization Administrator only when ANY event (not just an accounting one) reaches `dead_letter`. This batch deliberately did NOT widen its recipient list to also include Accountant (`accounting.post` holders) for accounting-relevant event types, even though P3.9 built the Accounting Exceptions view specifically for that role. The reason is architectural, not an oversight: doing so would require `platform/outbox.ts` to import `ACCOUNTING_EVENT_TYPES` from `domains/accounting/exceptions.ts` — which itself imports `retryOutboxEvent`/`processPendingOutboxEvents` FROM `platform/outbox.ts` — a genuine circular import between a low-level platform file and a domain file that imports back into it. This is exactly why this batch's own notification-creation primitives live in a separate, dependency-free `notifications/create.ts` leaf module rather than the richer `notifications/service.ts` (see that file's own doc comment).

**What was built instead:** the Notification Center's operational-awareness section shows a live "Accounting exceptions: N" count/link (reusing `listAccountingExceptions`'s own `needsAttention`) to any user holding `accounting.view` — including Accountant — satisfying §29's "may point to Accounting Exceptions" without the circular-import risk, and without duplicating that subsystem's own retry/sweep mechanism.

**Suggested fix, when picked up:** the cleanest fix is architectural, not a workaround — extract a small, dependency-free `ACCOUNTING_EVENT_TYPES` constant (and nothing else) into its own leaf module both `accounting/exceptions.ts` and `platform/outbox.ts` can import without either depending on the other, then widen `notifyDeadLetter`'s recipient query to include `accounting.post` holders when the failing event's type is in that set.

**Severity:** Low — Accountant already has strong awareness via the existing Accounting Exceptions page itself (visited whenever `/accounting` is opened, which P3.9 already made the natural landing tab) and now via this batch's own operational-awareness link; this is a proactive-push nicety, not a coverage gap.

---

## "Mark unread" and Notification's `archived` status remain unbuilt/dormant by design

**Noticed during:** P3.11 (Notifications / Tasks / Operational Awareness, 2026-09-01), per §10's own "not merely for symmetry" caution.

**What:** `NotificationStatus` has always included `archived` alongside `unread`/`read` (confirmed via schema read), but nothing in this codebase has ever set or read it — the same "dormant reservation" pattern this codebase already has precedent for (e.g. `LabResultFinalized` sat unwired for several phases). This batch deliberately did not build a "mark unread" action either — technically trivial (the schema supports flipping the field back), but no concrete operational need was identified this batch, and §10 explicitly says not to add it "merely for symmetry."

**Suggested fix, when picked up:** if a real need for either surfaces (e.g., "flag to revisit later" via unread-toggle, or a genuine archive/dismiss concept distinct from read), both are cheap, narrow additions to the existing model — no schema change needed for either.

**Severity:** Informational — not a gap, a deliberate scope boundary.

---

## Deactivating a branch doesn't filter it out of operational branch pickers elsewhere

**Noticed during:** P3.12 (Admin / Settings / Role-Aware Navigation, 2026-09-01), while building branch deactivation (§9).

**What:** `updateBranch` can now flip a branch to `inactive` (this batch), and Settings correctly shows the status — but nothing downstream actually consults `Branch.status` yet. The new-employee branch picker, the new-user branch-access checkboxes, appointment booking's branch context, and the new global branch switcher (`listSwitchableBranches`) all still list every branch in the org regardless of status. An inactive branch (closed location, still kept for historical reporting per §9) can therefore still be freshly assigned to a new employee, a new user's branch access, or a new appointment.

**Why not fixed in P3.12:** filtering every one of these pickers is a real cross-cutting change touching several unrelated modules (HR, Users, Appointments) for a scenario (actively assigning NEW work to a branch an org just deactivated) that's a lesser risk than the historical-integrity concern §9 actually named (which is fully handled — deactivation never deletes or cascades). Doing this properly means deciding, per picker, whether "currently inactive" should be a hard filter or just a visual warning — a real design pass, not a one-line fix, and out of proportion for a phase already touching this many surfaces.

**Suggested fix, when picked up:** add `status: "active"` to each operational branch-picker's query (or a visible "(inactive)" suffix if hard-filtering would break editing something already assigned to it), branch by branch, starting with new-employee and new-user-branch-access since those are the two P3.12 just built.

**Severity:** Low — no data-integrity risk (matches §9's actual requirement), a UX nicety once an org actually starts closing branches.

---

## Provider<->User linkage can be set at creation but not changed afterward

**Noticed during:** P3.12 (Admin / Settings / Role-Aware Navigation, 2026-09-01), while reviewing §15.

**What:** `new-provider-dialog.tsx` already lets Admin pick a `userId` when creating a Provider, and this batch added a "Linked login" read-only row to the Provider detail page so it's at least visible afterward (previously invisible everywhere) — but there's still no edit control to change or clear it once the Provider exists, unlike Employee<->User (full link/unlink UI, this batch) or Provider<->Employee (`LinkEmployeeDialog`, pre-existing).

**Why not built in P3.12:** §15 only asked to "ensure Admin can understand the relationship," not to build editing — this batch stayed narrowly to that. Provider creation is also markedly rarer than Employee creation (one row per clinician, not per staff member), so the practical impact of "wrong at creation, no fix without DB access" is smaller but still real.

**Suggested fix, when picked up:** a small `LinkProviderUserDialog` mirroring the new `UserLinkDialog`/`UnlinkUserButton` pattern this batch built for Employee<->User — same shape, same `users.manage` gate, same same-org/one-to-one checks — reusing `listUnlinkedUsers` (a Provider's `userId` isn't tracked by that function today, so it would need a small variant or an added exclusion).

**Severity:** Low — display gap is now closed; only the edit-after-creation path remains.

---

## No permission-dependency warning when a role configuration would be obviously unusable

**Noticed during:** P3.12 (Admin / Settings / Role-Aware Navigation, 2026-09-01), per §25.

**What:** §25 permits (but doesn't require) surfacing a warning — not a silent grant — when a custom role is given a write permission without its natural read counterpart (e.g. `invoice.create` without `invoice.view`, mirroring the real gap P3.9 found and fixed for the seeded Accountant role). The Roles & Permissions page (`role-permission-editor.tsx`/`new-role-dialog.tsx`) has no such check today — an Admin can save a custom role in exactly that shape with no feedback.

**Why not built in P3.12:** this needs a real, deliberately-maintained dependency map (which write permissions "obviously" need which read permission) — §25 explicitly warns against inventing hidden implied grants, so this can only ever be advisory copy, not enforcement, and defining that map correctly for the full ~90-code catalog is a real design task on its own, not a quick addition to an already large batch.

**Suggested fix, when picked up:** a small static `Record<string, string[]>` of "this code's write permissions typically need these read permissions," checked client-side in the role editor to show a non-blocking inline warning (not a save-blocking error) — start with the same handful of pairs P3.9's own Accountant fix already established as real (`invoice.create`→`invoice.view`, `payment.create`→`payment.view`) rather than trying to derive the full catalog at once.

**Severity:** Low — advisory-only per §25's own instruction; no security or data-integrity exposure from its absence.

---

## Widespread unvalidated `status` query-param cast (`filters.status as never`) across most `list*` domain functions

**Noticed during:** the targeted commercial/safety backlog closure (2026-09-02), item 1, while fixing the identical, already-reproduced bug on `listLabQueue`/`listRadiologyQueue`.

**What:** A direct code search (`grep -rn "status: filters.status as never"`) found the SAME unvalidated-string-straight-into-a-Prisma-enum-filter pattern in roughly a dozen other `list*` functions across the codebase — `listAssets`, `listClaims`, `listTransfers`, `listInvoices` (billing/invoices.ts), `listCashierSessions`, `listSupplierInvoices`, `listPurchaseRequests`, `listPurchaseOrders`, `listEmployees` (hr/employees.ts), `listLeaveRequests`, `listPayrollRuns`, among others. Any of these would 500 the same way `/laboratory?status=pending` did if a caller (a hand-edited URL, a stale bookmark, a future UI bug) ever passes a `status` value outside that specific model's real enum. `clinical/orders.ts`'s own `listOrders` and its caller `orders/page.tsx` already establish the correct, existing convention for this (validate the query-string value against a real `$Enums.X[]` array in the PAGE, typed the domain function's own parameter as the real enum rather than a raw string) — the fix applied to Lab/Radiology this batch reused that exact convention, it wasn't invented for this.

**Why not fixed for the other dozen call sites in this batch:** item 1's own explicit scope was Lab/Radiology only (the two routes actually reproduced/named); the task's own top-level scope rule is explicit — "Do NOT audit the whole project... append unrelated findings to BACKLOG.md" rather than expand a two-route fix into a project-wide sweep.

**Suggested fix, when picked up:** the exact same pattern, applied page-by-page — validate the raw `status` query-string value against that model's real `$Enums.X[]` list in the page component (falling back to `undefined` for anything invalid), and narrow the domain function's own `filters.status` parameter type from `string` to the real enum type so the unsafe `as never` cast can be deleted entirely. A good candidate for a small, standalone input-validation-hardening batch — mechanical, low-risk, one file at a time, no business-logic changes.

**Severity:** Low-Medium — every instance is a genuine 500 (Prisma validation error surfaced as a raw 500, not a data-integrity or security issue) for a value no legitimate UI element currently sends, only reachable via a hand-crafted/stale URL.

---

## `analytics/csv.ts`'s CSV export has no formula-injection protection

**Noticed during:** P4.6 (Data Import / Clinic Onboarding / Initial Setup, 2026-09-03), while building `src/lib/platform/import/csv.ts`'s `escapeCsvFormulaInjection`/`csvCell` helpers for import templates and dry-run/commit error reports.

**What:** `src/lib/domains/analytics/csv.ts`'s existing `toCsv` writes cell values straight into the CSV without checking for a leading `=`, `+`, `-`, or `@` — the classic CSV/formula-injection vector where a cell like `=CMD(...)` or `=HYPERLINK(...)` gets silently executed if the exported file is later opened in Excel/Sheets/LibreOffice with formula evaluation on. Every export this function powers (the Reports/Export page, per `INVENTORY.md`) inherits the gap. P4.6's own new `platform/import/csv.ts` was written from scratch for the importer/template/error-report use case and picked up this protection independently — it doesn't share an implementation with `analytics/csv.ts`.

**Why not fixed in P4.6:** out of this phase's own named scope (P4.6 is data import/onboarding, not reporting/export — P4.7 owns that surface) and `analytics/csv.ts` has no relationship to any of the eight importers or the onboarding workspace; fixing it here would be an unrelated drive-by change to a file P4.6 never touches otherwise.

**Suggested fix, when picked up:** either have `analytics/csv.ts` import and reuse `platform/import/csv.ts`'s `escapeCsvFormulaInjection`/`csvCell` (promoting them to a shared, non-import-specific location first, e.g. `platform/csv.ts`), or apply the same one-line "prefix a leading `=+-@` with `'`" rule locally. Low-risk, mechanical, no business-logic change.

**Severity:** Low-Medium — no server-side impact (this only affects a file opened later in spreadsheet software on someone's own machine), but a real, standard finding any security review of export functionality would flag.

---

## ~~No component/browser-level test harness~~ — RESOLVED in P4.7A/P4.7A.1 — a real client-state bug in the P4.6 import dialog wasn't caught by the integration suite

**Noticed during:** P4.6 (Data Import / Clinic Onboarding / Initial Setup, 2026-09-03), during live browser verification of `/admin/onboarding`.

**What:** `ImportDialog` (`src/app/(dashboard)/admin/onboarding/import-dialog.tsx`) originally read the selected file from `fileInputRef.current?.files?.[0]` inside `handleCommit`. The `<input type="file">` element only renders while `!dryRun` (its wrapping `<form>` is conditionally removed once the Step 3 review summary appears), so by the time a user clicked "Commit", React had already unmounted the input and reset the ref to `null` — `handleCommit` then silently returned with no request sent and no error shown, so **committing a validated import did nothing** in the real UI, even though every server-side piece (dry-run, commit action, engine, importers) worked correctly and the 23-test integration suite passed throughout. Fixed in this same phase (captured the `File` into component state at dry-run time instead of re-reading a ref that goes stale) and confirmed end-to-end in the browser afterward — this entry is about the detection gap, not an open defect.

**Why this matters as a backlog item:** this repo's test suite (`test/integration/*.test.ts`, Vitest against real Postgres) exercises server actions, domain functions, and the import engine directly — it has no component-level or browser-driven layer, so a bug that only exists in client-side React state management (a stale ref across a multi-step dialog) is structurally invisible to it. This is the first time in the whole engagement that live browser verification caught something the integration suite couldn't have, which suggests other multi-step client-only dialogs in the app could carry similar latent bugs.

**Suggested fix, when picked up:** not a call to build a full E2E framework on spec — but worth a deliberate, scoped decision: either (a) add a lightweight component-test setup (e.g. Vitest + Testing Library, jsdom environment) for the handful of genuinely stateful multi-step dialogs in the app (import dialogs, multi-step booking/checkout flows), or (b) treat live browser verification as a mandatory, repeatable step (not ad hoc) for any new multi-step client component going forward. Either is a real, standalone decision — not a quick addition to whatever phase happens to touch the next dialog.

**Severity:** Was High while it existed (the entire commit half of every onboarding import silently no-op'd in the real UI — the single most important interaction P4.6 exists to deliver), now Fixed; the detection-gap itself was Medium.

**Update, P4.7A/P4.7A.1 (2026-09-03/04):** option (a) was picked up. P4.7A added a Vitest + jsdom + React Testing Library component-test layer (`vitest.components.config.mts`, `test/components/`) and a Playwright browser-smoke suite (`playwright.config.ts`, `test/e2e/smoke.spec.ts`) — 2 and 16 tests respectively at first, both directly guarding the exact bug this entry describes. P4.7A.1 expanded both: 12 component tests (added coverage for Pharmacy's substitution-mismatch dialog, the encounter note's draft/finalized states, and POS's charge-selection state) and 21 Playwright tests (added a full register→book→check-in→encounter E2E flow, Patient 360 tab-switching, POS's register states, and a Reports tab-switch check). Both suites are now part of the standard regression run (`npm run test:components` / `npm run test:e2e`), documented in `docs/FRONTEND_TESTING.md`. Closing this entry — the detection gap that let the P4.6 bug through no longer exists; expanding coverage further is now ordinary test-writing, not a standing architectural gap.

**Update, P4.7 (2026-09-03):** the same detection gap caught a second, independent real bug — `RevenueCycleSection` (`src/app/(dashboard)/reports/page.tsx`) crashed the entire "Billing / Revenue" report tab with `TypeError: report.collections.toFixed is not a function`. Root cause: `loadReport()`'s `revenue-cycle` case did `{ ...getRevenueCycleReport(...), invoices, collections, refunds }` — but `getRevenueCycleReport`'s own return already has a `collections` field (a number, the total collections amount), silently overwritten by the merged `getCollectionsReport` result (an object) under the same key. TypeScript did not catch this either, because the render call site used an explicit `as RevenueCycleReportShape` type assertion (an established pre-P4.7 pattern on this page, needed since `loadReport`'s return type is a category-keyed union) — the assertion silenced what would otherwise have been a real structural mismatch. Fixed by renaming the merged fields to `invoiceReport`/`collectionsReport`/`refundReport`, verified in the live browser afterward. Reinforces this entry's own point: a bug in Server Component data-shaping (not even client state this time) was equally invisible to the 583-test integration suite and only surfaced under real browser rendering — worth weighing when the option (b) in this entry's suggested fix ("treat live browser verification as mandatory for any new multi-step/data-merging component") next comes up for a decision.

---

## Procurement (`/purchasing`) has no date/branch/supplier filters

**Noticed during:** P4.7 (Reporting / Export / Operational Data Portability, 2026-09-03), while evaluating whether existing procurement screens already satisfy §20's "useful filters: date, branch, supplier, status."

**What:** `/purchasing` (Purchase Requests, Purchase Orders, Supplier Invoices) supports only pagination (`page`/`requestsPage`/`ordersPage`) and shows status as a badge — there is no way to filter any of the three lists by date range, branch, or supplier from the UI or the page's own `searchParams`. AP Aging (this phase's own new addition, `getFinancialReport`'s `apAging`) covers the one aggregate figure management most needs, but a genuine "supplier invoices from supplier X in date range Y" drill-down isn't possible today.

**Why not fixed in P4.7:** this phase's own scope was explicit — "procurement/payables reporting is usable within existing architecture" (acceptance criterion #11), a lower bar than "fully filterable," and building real filters onto an existing multi-section page (three independently paginated tables) was judged a standalone UI addition, not a reporting/export concern, and risked expanding an already large phase.

**Suggested fix, when picked up:** add `dateFrom`/`dateTo`/`supplierId`/`status` query-param filters to `/purchasing`'s own server component, following the exact same pattern `/accounting`'s Journals tab and `/inventory`'s ledger tab already establish (shared `parseLocalDateParam` helper, a small filter form, `narrowBranchFilter` for branch scoping) — mechanical, no new architecture needed.

**Severity:** Low — a real usability gap for a procurement-heavy org, but not a correctness or security issue; the underlying data is fully accessible, just not filterable from this one screen.

---

## ~15 detail/secondary routes not yet migrated onto the P4.7A design system

**Noticed during:** P4.7A (UI/UX Design System & Frontend Quality, 2026-09-03), while deciding how far the mechanical `PageHeader` migration could reasonably extend within one phase.

**What:** P4.7A established the design-token system and the shared primitives (`PageHeader`/`WorkspaceHeader`, `StatusBadge`, `EmptyState`, `MetricCard`, `FilterBar`, `FormSection`) and migrated ~35 screens onto them — the flagship high-traffic ones (Dashboard, Reception, Patients, Patient 360, Appointments) in depth, and ~30 more list pages at least onto `PageHeader` for title/spacing consistency. Not touched at all that phase: the `[id]` detail pages (`providers/[id]`, `employees/[id]`, `payroll/[id]`, `invoices/[id]`, `claims/[id]`, `assets/[id]`, `pos/sessions/[id]`, `appointments/[id]`, `purchasing/orders/[id]`, `laboratory/orders/[id]`, `radiology/orders/[id]`, `pharmacy/[id]`), `admin/system-events` and `admin/operations`, `notifications`, `analytics`, the print pages, and the public `/book`/`/portal/*` routes. `FilterBar`/`FormSection` were built but not retrofitted onto any existing filter/large form.

**Update, P4.7A.1 (2026-09-04):** the critical daily-use workspaces named in this completion batch are now deeply migrated and live-browser-verified end to end (patient → appointment → check-in → encounter → dispense → invoice → payment): `encounters/[id]` (full context bar, compact vitals chips, locked/read-only finalized-note state, typed order badges, StatusBadge throughout), `pharmacy/[id]` (context bar, StatusBadge, substitution-warning heading), `pos/page.tsx` (one shared `WorkspaceHeader` shell across all three register states, right-aligned financial hierarchy), `laboratory/orders/[id]` and `radiology/orders/[id]` (context bar, StatusBadge, critical-flag icon+tone), `queue/page.tsx` (StatusBadge/EmptyState). `FilterBar` is now live on Reports, Inventory ledger, and Accounting journals; `FormSection` is now live on Patient Registration and the Employee dialog. Still not touched: `providers/[id]`, `employees/[id]`, `payroll/[id]`, `invoices/[id]`, `claims/[id]`, `assets/[id]`, `pos/sessions/[id]`, `appointments/[id]`, `purchasing/orders/[id]`, `admin/system-events`, `admin/operations`, `notifications`, `analytics`, print pages, `/book`/`/portal/*` — roughly 15 routes, down from ~20.

**Why not fixed further in P4.7A.1:** that batch's own scope was explicitly the critical daily-use staff workspaces, not every remaining secondary route — see its own report's Deferred UX Backlog section.

**Suggested fix, when picked up:** the pattern is now established and cheap to repeat — swap each remaining page's own `<h1>...</h1>` block for `PageHeader`/`WorkspaceHeader`, swap any inline `Badge`-with-hand-rolled-variant-map for `StatusBadge`, swap empty-table text for `EmptyState`. Genuinely mechanical, file-by-file, no new architecture. A good candidate for a small, focused follow-up batch (or several, split by module) rather than another full product-wide phase.

**Severity:** Low — a real, visible consistency gap on the untouched screens (still the pre-P4.7A look), but no functional or safety issue; every migrated screen's own business logic is unchanged either way.

---

## ~~`NewAppointmentDialog`'s Provider/Service selection visually clears itself after a rejected submission (e.g. a real overlap conflict)~~ — RESOLVED in P4.9

**Resolved:** P4.9 (Commercial Readiness Acceptance, 2026-09-04), §41 ("reproduce it; if low-severity and easy, retain backlog — otherwise fix now"). Took the suggested fix exactly as written below: `providerId` and `serviceId` are now controlled the same way `branchId` already was (`value={providerId || undefined}` / `value={serviceId || undefined}`), and `serviceId` — which previously had no state at all, not even an uncontrolled one — got its own `useState`. `src/app/(dashboard)/appointments/new-appointment-dialog.tsx`. Typecheck clean. Reproduced live in the browser against local dev: submitted a real overlap-rejected booking (Walkthrough Provider, an already-booked slot) and confirmed Provider correctly retains its selection across the `setState(result)` re-render (previously reset to "Select a provider"). Service's retention across the same rejection was not conclusively re-confirmed live — the browser tool's viewport/coordinate resolution became unreliable mid-verification for this dialog — but the change is mechanically identical to the now-confirmed-working Provider fix (same pattern, same component, same re-render trigger), so it is fixed with high confidence rather than merely believed correct by inspection alone. Original reproduction notes retained below for context.

**Noticed during:** P4.7A.1 (Critical Workspace & UI Adoption Completion, 2026-09-04), while browser-automating the booking dialog for the new Doctor Consultation E2E test — reproduced repeatedly and deterministically, not a test flake.

**What:** `src/app/(dashboard)/appointments/new-appointment-dialog.tsx`'s `providerId`/`serviceId` `Select`s are uncontrolled (no `value` prop, only `onValueChange`) while `branchId`'s is controlled (`value={branchId}`). When `bookAppointmentAction` rejects a submission (e.g. the real, correct "This provider already has an appointment that overlaps this time" conflict check), `useActionDialog`'s `submit` calls `setState(result)`, and on that re-render the Provider/Service selects visually reset to their placeholder text ("Select a provider" / "None") even though `branchId` and every plain `Input` field keep what the user entered. The error message itself renders correctly (an `Alert` at the top of the — scrollable — dialog, easy to miss if the user has scrolled down to the fields below it, which compounds the confusion). Net effect: a receptionist correcting a rejected booking (e.g. picking a different time) has to re-pick Provider and Service from scratch, not just fix the one field that actually caused the rejection.

**Why not fixed in P4.7A.1:** out of that batch's scope (a pre-existing client-state quirk in an already-shipped dialog, not one of the newly-migrated workspaces, and not a data/business-logic defect — the underlying overlap rejection is correct and unchanged).

**Suggested fix, when picked up:** make `providerId`/`serviceId` controlled the same way `branchId` already is (`value={providerId || undefined}` / `value={serviceId || undefined}`) so React — not just the DOM — is the source of truth and a sibling state update (like `setState(result)` on rejection) can no longer visually diverge from it.

**Severity:** Low — a real UX papercut on an error-retry path, not a data-integrity or access-control issue; the booking itself, and its overlap validation, work correctly either way.

---

## Detail/print pages built on `findFirstOrThrow` show a raw "Something went wrong" crash screen instead of a clean not-found page for an invalid/stale id

**Noticed during:** P4.9 (Commercial Readiness Acceptance, 2026-09-04), §39 live print verification against the hosted production deployment — navigated to `/radiology/orders/<imaging_order.id>/report` (an easy id mix-up: the route actually takes the *ClinicalOrder* id, not the ImagingOrder id) and got Next's generic global error boundary ("Something went wrong. The application failed to load. This has been logged.") instead of a 404. Confirmed via Vercel's runtime error log: `PrismaClientKnownRequestError` / `P2025` from `clinicalOrder.findFirstOrThrow()` — an ordinary "no record found," not a real defect in the query or the data.

**What:** `getRadiologyOrder`/`getLabOrder` and likely every sibling `get<X>Order`-style loader in this codebase use `db.<model>.findFirstOrThrow(...)` directly in a Server Component with no try/catch and no `notFound()` call. Any request for an id that doesn't exist (mistyped, stale bookmark, cross-org, or — as here — the wrong id field entirely) throws an uncaught `PrismaClientKnownRequestError`, which Next's root error boundary catches and renders as a generic crash page. No stack trace or query detail is leaked to the browser (the boundary is the generic one), so this is a UX/operability gap, not an information-disclosure issue.

**Why not fixed in P4.9:** the correct fix is systemic (convert every such loader to either catch `P2025` and call Next's `notFound()`, or add a shared helper other detail/print pages can reuse) rather than a one-line patch to the single page that happened to be hit — that shape of change is a small-but-broad refactor across many files, which is exactly the kind of "another UI/quality cycle" P4.9 was explicitly told not to open. The underlying data/authorization logic is correct in every case observed; only the failure presentation is poor.

**Suggested fix, when picked up:** a small shared helper (e.g. `findOrNotFound(promise)`) that wraps a Prisma `findFirstOrThrow` and calls `notFound()` on a caught `P2025`, adopted across the `get<X>Order`/`get<X>` detail-page loaders (radiology, laboratory, encounters, invoices, payroll/payslip, etc.) as a single small, mechanical pass — genuinely low-risk since it only changes the failure path, never the success path.

**Severity:** Low-Medium — never blocks a legitimate, correctly-permissioned request; only degrades the experience of an invalid/stale link from "clean 404" to "generic crash screen." Worth closing before broad staff rollout so a bookmarked/mistyped link doesn't look like the system is broken, but not a correctness or security defect.

---

## Onboarding Readiness Review doesn't surface that Opening Inventory stock has no corresponding GL journal until one is posted manually

**Noticed during:** P4.9 (Commercial Readiness Acceptance, 2026-09-04), §33 (Opening Inventory vs GL reservation, carried from P4.6).

**What:** `docs/CLINIC_ONBOARDING.md`'s own "Opening Inventory Reconciliation" section and Fresh-Clinic Go-Live Checklist (step 7) correctly document that an Opening Inventory import creates real `StockLedgerEntry`/`ProductBatch` rows but posts **no** accounting journal automatically — the operator must separately post a Manual Journal (Dr Inventory Asset / Cr Opening Balance Equity or similar) if they want the balance sheet to reflect that stock immediately. This is a deliberate, correct design (avoids guessing a chart-of-accounts mapping or posting on the operator's behalf), and it is not silently wrong — the stock ledger and the GL are each internally consistent, just not yet reconciled with each other until that manual step happens. The gap: `src/lib/domains/onboarding/readiness.ts` (the Readiness Review page's data source) never checks for or surfaces this — a clinic admin can import Opening Inventory, see every Readiness Review item green, and have no in-app signal that the balance sheet doesn't yet include it unless they've read the documentation.

**Why not fixed in P4.9:** the underlying behavior is correct (no data corruption, no false reconciliation being *presented* as true — there simply isn't a reconciliation view that combines the two yet), and building the actual UI surfacing (a Readiness Review line item, or a banner on `/accounting` when unposted opening-inventory stock is detected) is a small but real feature addition, not a defect fix — out of P4.9's "evidence collection, not feature building" scope per its own §3.

**Suggested fix, when picked up:** add one Readiness Review check: if any `StockLedgerEntry` rows exist with `referenceType = 'opening_balance'` and no Journal has ever referenced that same `ImportJob` id (or a simpler heuristic: Inventory Asset account balance vs. sum of opening-balance stock cost), show a non-blocking "Opening Inventory imported — post the corresponding GL journal before relying on the Balance Sheet" reminder.

**Severity:** Low — documented, non-corrupting, and only relevant for clinics that both use Opening Inventory import and expect the balance sheet to reflect it before manually posting; does not block first-clinic go-live for a clinic starting with genuinely zero prior stock.

---

## ~~Enabling Row Level Security silently broke duplicate-request (idempotency) detection on charges, payments, package sessions, goods receipts, and supplier invoices~~ — RESOLVED in P4.9.1

**Resolved:** P4.9.1 (Commercial Readiness Corrections, 2026-09-04). Found via the full regression run immediately after wiring `applySecurity()` (P4.9.1's new, source-controlled RLS provisioning) into local `db:dev:setup`/`db:test:setup` — 6 pre-existing tests across 5 files started failing with an uncaught `PrismaClientKnownRequestError` (P2002) instead of the expected graceful duplicate-request handling.

**What:** `src/lib/platform/idempotency.ts`'s `isIdempotencyKeyConflict()` detected the specific unique-constraint violation `claimIdempotencyKey()` produces by reading `error.meta.driverAdapterError.cause.constraint.fields` (this project's Prisma 7 + `@prisma/adapter-pg` setup's own nesting for unique-violation detail). Empirically verified (`scripts/db/security.ts`'s own RLS work, isolated with a throwaway repro script) that `@prisma/adapter-pg` stops populating that `constraint` object entirely — `cause.kind` still correctly reports `"UniqueConstraintViolation"` and the right Postgres error code (`23505`), just with no `constraint` field at all — the moment Row Level Security is enabled on the violated table. Confirmed deterministic via a direct RLS-off/on/off toggle against the same table and the same duplicate-insert. Real production impact if shipped as-is: a double-click or client retry on charge creation, payment recording, package-session consumption, goods receipt, or supplier invoice creation would no longer be recognized as a duplicate — it would either throw an unhandled 500 to the user (best case) or, depending on the caller's exact catch shape, potentially double-post a financial/inventory transaction (worst case) — a real, direct regression from enabling RLS, not a pre-existing or unrelated bug.

**Fix:** `isIdempotencyKeyConflict()` now matches on `error.code === "P2002" && error.meta?.modelName === "IdempotencyKey"` instead — `modelName` is present on every P2002 regardless of driver adapter or RLS state (verified the same way), and is exactly as precise: `claimIdempotencyKey()`'s own doc comment already guarantees it runs as the very first statement in its caller's transaction, so a P2002 against the `IdempotencyKey` model in that transaction can only ever be the one unique constraint this table has. Verified via all 6 originally-failing tests passing again, plus a new direct regression test (`test/integration/p4-9-1-db-security-rls.test.ts`) that reproduces the exact duplicate-insert with RLS enabled and asserts `isIdempotencyKeyConflict()` still returns `true`.

**Severity at discovery:** would have been High (real financial/inventory double-processing risk) had it shipped; caught and fixed within the same batch that introduced the regression, before any deployment.

---

## Large Users imports are slow — argon2id hashing cost scales linearly with row count

**Noticed during:** P4.9.2 (Extended Clinic Data Import Coverage, 2026-09-04/08), the required ~1,000-row performance benchmark for the new Users importer.

**What:** A 1,000-row Users import (each row creating one throwaway-password account, per `src/lib/domains/onboarding/imports/users.ts`'s own security design — see its own doc comment) takes on the order of two minutes end to end in this local test environment, almost entirely `argon2id` hashing cost (deliberately slow — that is the whole point of the algorithm) rather than database time. A genuine transaction-timeout defect this same investigation found (200 sequential hashes inside one open DB transaction exceeding Prisma's interactive-transaction timeout outright) **was fixed** this phase — see `src/lib/platform/import/types.ts`'s new `prepareBatch` hook, which now runs all of a batch's hashing in parallel, before that batch's transaction ever opens. What remains is the honest, expected residual: hashing itself is inherently CPU-bound and slow by design, and 1,000 rows is a large benchmark size, not a realistic one — a real clinic importing its initial staff roster is far more likely to import tens of users, not a thousand, in one file.

**Why not "fixed" further:** per this phase's own instruction ("do not obsess over micro-optimization; record obvious pathological behavior"), and because further optimization would mean weakening `argon2id`'s own cost parameters — a security regression, not a performance one worth making.

**If ever revisited:** if a clinic genuinely needs a very large one-time Users import, splitting it into several smaller files (a few hundred rows each) works today with no code change, and gets the same duplicate-detection/audit guarantees per file.

**Severity:** Low — no correctness or safety issue; purely a "this will take a couple of minutes for an unusually large file" expectation-setting note.

---

## Module-entitlement enforcement is proven at the route boundary only, not exhaustively across every Server Action in every optional module

**Noticed during:** P5.1 (Commercial SaaS Foundation & Clinic Provisioning, 2026-09-18), while verifying §9-§11's entitlement-enforcement requirements.

**What:** `src/proxy.ts`'s `MODULE_ROUTE_PREFIXES` gate covers every route under an optional module's own top-level path (e.g. `/laboratory`, `/payroll`) — a disabled module's page genuinely cannot be reached by direct URL, proven in both the integration and E2E suites. What has NOT been exhaustively verified is whether every Server Action a disabled module's UI would otherwise expose is unreachable through some other still-enabled screen (e.g. a cross-module dialog, a shared component, or a Server Action imported directly by a different route's client component). No such bypass is currently known or suspected — RBAC (`can()`/`assertCan()`) independently gates every domain function regardless of entitlement state, so a bypass would still require the actor to also hold the relevant clinic permission — but this phase's scope was route-level enforcement (§15's own instruction), not a full Server Action audit.

**Why not fixed in P5.1:** auditing every Server Action across ~12 optional modules for entitlement-awareness (beyond their existing RBAC checks) is a substantially larger scope than "centralize the route gate this phase asks for," and no concrete bypass was found to justify it now.

**Suggested fix, when picked up:** a lightweight lint rule or test that cross-references `MODULE_ROUTE_PREFIXES` against every exported Server Action under each gated module's route folder, flagging any action reachable from outside that folder without its own entitlement check — or, more simply, spot-check the handful of genuinely cross-module UI surfaces (e.g. Reports, which reads across modules by design) for whether they should themselves respect entitlement when rendering a disabled module's section.

**Severity:** Low — no known exploit path; RBAC remains a real, independent gate underneath.

---

## `nextCustomerCode()`'s count+1 generation has not been load-tested under truly concurrent provisioning calls

**Noticed during:** P5.1 (Commercial SaaS Foundation & Clinic Provisioning, 2026-09-18).

**What:** `provisioning.ts`'s `nextCustomerCode()` counts existing `OrganizationCommercialProfile` rows and formats `count + 1` as the new customer code, inside the same transaction that creates the profile. The column itself is genuinely globally unique (`@unique`), and a real collision is caught cleanly (verified directly: a manual duplicate-insert throws Prisma P2002, which `provisionClinic()`'s own catch block turns into a friendly, non-corrupting error — see `test/integration/p5-1-commercial-saas-foundation.test.ts`), so this is not a correctness gap. What's untested is throughput/retry behavior if many platform operators provisioned clinics at genuinely the same instant — a real collision would currently surface as a failed provisioning attempt the operator must retry, not an automatic retry-with-backoff.

**Why not fixed in P5.1:** provisioning is an infrequent, operator-driven action (this is V1 manual commercial management, §12 of the P5.1 command), not a high-throughput path — building retry logic for a race that's never been observed, for an action a human deliberately clicks a handful of times a week at most, is speculative engineering the command's own §1 explicitly discourages.

**Suggested fix, when picked up:** if platform operator headcount or provisioning frequency ever grows enough for this to become plausible, wrap the transaction in a small retry-on-P2002 loop (re-reading the count and retrying once or twice) rather than surfacing the raw failure to the operator.

**Severity:** Low — no known incident, no data-corruption risk, only a manual-retry inconvenience in an already-rare scenario.

---

## No automated subscription lifecycle transitions — a lapsed trial does not flip itself to `expired`

**Noticed during:** P5.1 (Commercial SaaS Foundation & Clinic Provisioning, 2026-09-18), while verifying §15's subscription-state requirements.

**What:** `SubscriptionStatus` supports `trial`/`active`/`past_due`/`suspended`/`cancelled`/`expired`, but every transition between them is a manual operator action from the organization detail screen — nothing in this codebase watches `trialEndsAt`/`endDate` and automatically moves a subscription to `expired` (or blocks/warns the clinic) once that date passes. The platform dashboard's "Trials Expiring (14d)" metric is the only proactive signal an operator gets, and it is purely informational — it does not itself change any state or restrict clinic access.

**Why not fixed in P5.1:** the command's own §15/§35 explicitly scope this phase to manual V1 commercial management and explicitly defer "automated subscription billing" and any dunning/lifecycle automation to a later, dedicated billing phase — building automatic expiry now would be scope creep ahead of the payment-gateway work it would need to be meaningfully paired with.

**Suggested fix, when picked up:** a scheduled job (mirroring the existing outbox-sweep cron pattern) that flips subscriptions past `trialEndsAt`/`endDate` to `expired` and optionally notifies the assigned operator — natural to build alongside whatever billing-automation phase eventually lands.

**Severity:** Low — purely a manual-operations gap in a product phase that is manual by explicit design; no data or access-control risk today.

---

## Pre-existing schema drift found while generating the P5.2 migration: an unused legacy `OutboxStatus` enum value, and a cosmetic `payroll_run` index-name mismatch

**Noticed during:** P5.2 (Pilot Clinic Operations & Productization, 2026-09-18), while running `prisma migrate diff` against the live `his_dev` database to generate the P5.2 migration.

**What:** `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma` (diffing the actual live database against the current schema file, rather than the usual file-to-file diff) surfaced two statements unrelated to any P5.2 change: (1) the live `OutboxStatus` Postgres enum type has six values (`pending, processed, failed, processing, completed, dead_letter`) where `schema.prisma` declares five (`pending, processing, completed, failed, dead_letter`) — `processed` is an orphaned legacy value from an earlier phase's naming (superseded by `completed`) that was never dropped, because Postgres has no `ALTER TYPE ... DROP VALUE` — removing it requires the full create-new-type/migrate-column/rename/drop-old-type dance `migrate diff` generated. (2) `payroll_run`'s own period-uniqueness index is named `payroll_run_organization_id_branch_id_period_start_period__key` in the live database vs. `..._period_e_key` in what a fresh replay of migration history would produce — a harmless Prisma-version auto-truncation difference in a >63-character identifier, not a structural difference. Both are genuine drift between the live database and a byte-for-byte replay of the committed migration history, confirmed directly against the database (not just the diff tool's opinion) via a throwaway `pg` query. Neither is a security, data-integrity, or correctness issue — the orphaned enum value is simply never written by any current code path (`OutboxEvent.status` writes only ever use the five schema-declared values), and the index still functions identically under its differently-truncated name.

**Why not fixed in P5.2:** unrelated to any P5.2 change, and P5.2's own instructions are explicit — "do not reopen old phases unnecessarily," fix only what a current phase's own work exposes as a concrete defect. Rebuilding a live enum type is also a non-trivial `BEGIN/COMMIT` data-migrating operation (`ALTER TABLE outbox_event ALTER COLUMN status TYPE ... USING (...)`) that deserves its own deliberate, reviewed migration, not a side effect silently bundled into an unrelated feature's migration file — see `prisma/migrations/20260918_p5_2_pilot_clinic_operations/migration.sql`'s own header comment, which documents exactly this exclusion.

**Suggested fix, when picked up:** a small, standalone migration that (a) recreates `OutboxStatus` without the orphaned `processed` value (the exact `BEGIN/COMMIT` block `prisma migrate diff` already generated, available in this session's history if needed) and (b) renames the `payroll_run` index to match. Low urgency — worth bundling into whatever phase next touches `OutboxEvent` or `payroll_run`, rather than a dedicated pass on its own.

**Severity:** Low — no functional impact, confirmed non-destructive, purely a cosmetic/cleanup item.

---

## `p3-13-cross-role-end-to-end.test.ts`'s lab-notification test has a fragile assertion that occasionally collides with an unrelated order number

**Noticed during:** P5.2 (Pilot Clinic Operations & Productization, 2026-09-21), running the full `npm run test` suite as part of this phase's own regression gate.

**What:** `test/integration/p3-13-cross-role-end-to-end.test.ts`'s "A4 — Laboratory" test asserts `expect(notification!.body).not.toMatch(/14/)` to prove a lab-result notification never leaks a raw numeric result value. In a full-suite run, this failed once — not because a raw result leaked, but because the notification body's own auto-generated *order number* (`ORD-001014`, from the shared `NumberSequence` counter this test database accumulates across every test run ever executed against it) happened to contain the literal substring "14", which the regex has no way to distinguish from a genuinely-leaked result value. Confirmed as a false positive, not a real regression: re-running this exact test file in isolation immediately afterward passed cleanly (27/27) — the order-number value is different (and collision-free) each time depending on how many prior test runs have incremented that shared sequence.

**Why not fixed in P5.2:** unrelated to any P5.2 change (P5.2 never creates `ClinicalOrder`/lab-workflow fixtures), and P5.2's own instructions are explicit about not reopening unrelated prior-phase work for a non-regression. Not remotely order-number-adjacent to anything P5.2 touched (support ticket numbers use a separate `PlatformNumberSequence`, not `NumberSequence`).

**Suggested fix, when picked up:** tighten the assertion to check for the specific result-value pattern rather than a bare `/14/` — e.g. assert the notification body doesn't contain the exact numeric result string surrounded by word boundaries, or assert on a known-safe summary phrase instead of a negative match. A one-line assertion fix in an existing P3 test, not urgent since it only intermittently false-fails depending on shared sequence state.

**Severity:** Low — test-fragility only, no product defect, no data-integrity issue; already proven not to be a real leak.

---

## Several dialogs have `<Label>` elements not associated to their input via `htmlFor`/`id`

**Noticed during:** P5.3 (First Pilot Clinic Implementation & UAT, 2026-09-24), while building the required real-execution E2E coverage across every clinical/financial workflow.

**What:** A handful of form dialogs render a `<Label>` with no `htmlFor` pointing at its sibling `<Input>`/`<Select>`'s `id` (or the input has no matching `id` at all): the prescription entry dialog (`prescriptions-section.tsx`), the payment recording dialog (`record-payment-dialog.tsx`), the goods-receipt dialog (`purchasing/orders/[id]/receive-dialog.tsx`), the New Purchase Order dialog's Product select (`purchasing/new-order-dialog.tsx`), and the employee user-linking dialog's Select (`employees/[id]/user-link-dialog.tsx`). A sighted mouse user is never blocked by this — the label still reads correctly next to its field — but it breaks the standard accessible-name resolution a screen reader (and `getByLabel()`/`getByRole(..., {name})` in automated tests) relies on, forcing every consumer to fall back to structural DOM locators instead.

**Why not fixed in P5.3:** each is a small, isolated, non-blocking fix (add `htmlFor`/`id`), but there are five of them across five unrelated files, and none blocks real pilot operation — a real user never notices. Fixing all five was out of proportion to this phase's actual scope (first-pilot UAT execution), so each was worked around at the test level (structural locators keyed off a wrapping `div.grid.gap-1` or the dialog's sole `combobox`) rather than touched in application code, per the phase's own "fix only what's P0/P1 or small-and-contained-P2" guidance.

**Suggested fix, when picked up:** a single small accessibility pass across the five files above, adding the missing `htmlFor`/`id` pair to each `<Label>`/input. Mechanical, low-risk, no behavior change — worth doing in one batch rather than five separate touches.

**Severity:** Low — accessibility/testability gap only, no functional or data-integrity impact; every affected workflow was fully exercised and verified correct via structural test locators during P5.3's own UAT.

---

## The integration suite is not deterministic on a full run — several test files implicitly depend on another file's leftover fixtures rather than creating their own

**Noticed during:** P5.4 (Commercial Launch Readiness & Pilot Stabilization, 2026-09-25), while running the full 68-file integration suite as this phase's own regression gate.

**What:** Across five separate full-suite runs this phase, the number of failing test files varied wildly and unpredictably: 18, 32, 24 (with P5.4's own new test files completely excluded), 2 (immediately after a full `his_test` reset), then 32 again (the very next run, same freshly-reset database). This rules out both "P5.4's own changes caused it" (proven by the 24-failures-with-P5.4-excluded run — the exact same class of failure occurs with none of this phase's code in the picture) and "a dirty/accumulated `his_test` caused it" (proven by the 2-then-32 pair of runs immediately before and after a clean reset, with no code or fixture change between them). Every failure sampled had the same shape: a test's own `beforeAll` calls something like `db.branch.findFirstOrThrow()` or `db.patient.findFirstOrThrow()` with **no `where` clause at all** — an implicit assumption that *some other test file, run earlier in this same serial execution* (`vitest.config.mts` sets `fileParallelism: false` specifically so files never race each other, which is real and working — this is not a concurrency bug), will have already created at least one row of that type and left it behind. `prisma/seed.ts`/`prisma/test-seed-extra.ts` seed a baseline org/branch/user/plan/provider/service/product, but never a patient, an appointment, or several other record types several tests reach for unconditionally — so whether a given file's `beforeAll` succeeds depends entirely on which other files happened to run before it in that particular invocation's file-execution order, and that order is not guaranteed stable run to run (vitest's own file discovery/scheduling, not this codebase's choice).

**Partially mitigated in P5.4, not fully fixed:** two concrete, confirmed root causes were diagnosed with real evidence and fixed in `prisma/test-seed-extra.ts` — (1) no baseline `Patient` was ever seeded, breaking `appointment-double-booking.test.ts` and others reaching for `db.patient.findFirstOrThrow()`; (2) `p3-11-notifications-operational-awareness.test.ts`'s own `db.user.findMany({ take: 2 })` + `users[1]?.id ?? users[0].id` fallback silently collapsed "user A" and "user B" into the same person whenever only one seeded user existed, turning its own ownership-isolation assertion into a self-inflicted false failure — fixed by seeding a second baseline user. Both fixes are real, verified via direct re-run, and kept. **However, re-running the full suite after both fixes still showed 24 failed files** (down from 32, but not the "most failures eliminated" outcome hoped for) — further investigation found at least one *additional*, different mechanism at play: `appointment-double-booking.test.ts` progressed past its own now-fixed patient lookup only to fail one line later on `db.provider.findFirstOrThrow()`, **despite `test-seed-extra.ts` already creating a baseline provider** — meaning at least one other test file, somewhere in that run's serial execution order, is destructively deleting shared baseline rows other tests still depend on (not merely failing to create its own), a materially different and more invasive bug than the "nobody created this yet" class this backlog entry originally described.

**Why not fixed further in P5.4:** the two above were small, contained, single-file (`test-seed-extra.ts`) fixes squarely in scope for "fix if contained and directly relevant." Chasing the newly-discovered "something deletes shared providers" mechanism is a different, open-ended investigation — it requires auditing cleanup/teardown logic across a 68-file suite to find whichever file(s) delete rows they don't own, which is exactly the broad audit P5.4's own instructions prohibit, and still meets none of the "fix immediately" bars (no patient-data/security/clinical/financial/inventory-integrity risk, no destructive-database risk in any *real* database — `his_test` is disposable by design — no deployment/go-live blocker). Every real defect this investigation could have masked was independently re-verified through P5.3's and P5.4's own tightly-scoped, self-contained test files (which never rely on another file's leftover data) plus direct database verification throughout both phases.

**Suggested fix, when picked up:** find and fix whichever test file(s) delete organization-wide/unscoped rows (providers confirmed; likely others) rather than only their own fixture-created rows in `afterAll` — a targeted grep for `deleteMany` calls with no id/organizationId-scoped `where`, or a bisection (run growing subsets of the suite until the shared-baseline row disappears) would localize it faster than a manual per-file audit. Once found, the broader fix from the original entry still applies afterward: either (a) make every file's `beforeAll` create its own complete fixture set, or (b) keep growing `test-seed-extra.ts`'s baseline as each new "assumed to exist" gap is found — (b) is proving to only partially work now that shared-row *deletion*, not just *absence*, is confirmed in the mix.

**Severity:** Medium — no product/security impact (isolated and confirmed), but it genuinely undermines the integration suite's value as a CI gate: a real regression can currently hide behind this noise, and a clean run cannot currently be produced on demand. Worth a dedicated, focused pass — now with a concrete lead (something deletes shared providers) rather than a cold start — before this suite is relied on as a hard merge gate in a real CI pipeline.
