# P3.2 — Patient 360 & Front-Desk Patient Journey Report

Executed against `p3.2.md` in full (40 sections). This supersedes and substantially expands the earlier, self-scoped `P3_2_PATIENT_360_FRONT_DESK_REPORT.md` (written before `p3.2.md` was found/read in this session) — that report's four small wiring fixes (Book appointment quick action, Collect payment link, PatientPicker display fix, patient-list cursor fix) are still in the codebase and are reflected below, not redone.

## Current Patient 360 Reviewed

Inspected fresh against the full spec: `patients/[id]/page.tsx` (header, tab wiring, Overview), `clinical-tabs.tsx` (Episodes/Encounters/Vitals/Diagnoses/Prescriptions/Orders), `medical-profile-tab.tsx` (allergies/conditions/medication history + alerts), `timeline.tsx`, `billing-tabs.tsx` (Packages/Invoices/Payments/Statement), `insurance-tabs.tsx`, `portal-access-card.tsx`, the patient list, and the domain service functions behind every one of those tabs (`listPatientAppointments`, `listPatientEpisodes`/`Encounters`/`Vitals`/`Diagnoses`/`Prescriptions`/`Orders`, `listPatientLabResults`/`ImagingResults`, `listPatientPackages`/`Invoices`/`Payments`, `getPatientStatement`, `listPatientCoverage`/`Authorizations`).

What already worked correctly: real per-tab data everywhere (no fake figures), a genuinely reconciled billing statement with running balance (P1 §36), branch-scoped patient visibility (P0/P2), a working duplicate-detection/registration flow, the P3.1 appointment-detail integration (reschedule chains, real slot availability), the P3.1 shared appointment-status label/variant utility, honest empty-state copy on every table, and the two live clinical workspaces (`/encounters/[id]`, `/orders`, `/episodes`) that Patient 360 links out to rather than duplicating.

## Concrete Problems Found

1. **Patient 360 crashed entirely for most non-admin roles.** `ClinicalTabs` called all six `listPatient*` clinical functions unconditionally — every one asserts `encounter.view`, which only Doctor, Nurse, and the two admin roles hold in the seeded permission sets (`prisma/seed.ts`). `BillingTabs` called `listPatientPackages`/`Invoices`/`Payments`/`getPatientStatement` unconditionally — these need `service.view`/`invoice.view`/`payment.view`, which Doctor, Nurse, Laboratory Technician, Pharmacist, and Radiology Technician all lack. The top-level page itself called `listPatientAppointments` unconditionally, needing `appointment.view`, which Cashier, Laboratory Technician, Pharmacist, and Radiology Technician lack. None of these calls were wrapped in a try/catch, so the thrown `ForbiddenError` propagated out of the Server Component tree and hit the generic dashboard error boundary — **the entire page failed**, not just one tab, for every seeded role except Doctor, Nurse, Super Admin, and Organization Administrator. Confirmed by reading the seeded role permission lists directly (not assumed) and pinned with a new regression test (see Tests).
2. `listBranches`/`listProviders` inside `ClinicalTabs` (populating the New Episode/Encounter dialogs) and `listBranches`/`listProviders`/`listServices` at the top of `page.tsx` (populating the Book Appointment dialog) were gated only on the *create* permission (`encounter.create`/`appointment.create`), not on the separate *view* permissions (`branch.view`/`provider.view`/`service.view`) those list functions actually assert — Doctor has `encounter.create` but not `branch.view`, so opening the Encounters tab as a Doctor would also have crashed.
3. `listPatientImagingResults` fetched the full radiology report body (`reportText`, a potentially long free-text narrative), `externalImageUrl`, `notes`, and every actor id via an unqualified `include`, just to render one impression line in Patient 360's summary table — real sensitive content pulled into the RSC payload with no UI use for it. `listPatientLabResults` had the same shape of over-fetch (unused `notes`, unused full `LabPanel` relation).
4. The Overview tab had no "current operational context" at all — no way to see today's appointment, queue token, in-progress encounter, or outstanding balance without opening a different tab, contradicting the five-question design principle's "what's happening now" / "what should I do next."
5. Patient 360's Timeline rendered every entry as plain text — no entry linked anywhere, even appointment events with a real, existing destination (`/appointments/[id]`).
6. Diagnoses, Prescriptions, and Orders rows had no way back to the encounter that produced them, even though `/encounters/[id]` already exists and already shows exactly that record in context.
7. Patient 360's `TabsList` used the same `className="flex-wrap"` convention as 4 other pages in the app, which — confirmed live in the browser — visibly overlaps the tab row's wrapped rows on top of the Overview tab's own content once the row actually wraps to 2+ lines (19 tabs on this page, the worst case in the app). Logged for the other 4 pages in `BACKLOG.md`; fixed locally on Patient 360 (see below).
8. Patient 360's Appointments tab didn't show which branch each past appointment happened at, despite `p3.2.md` §12 explicitly listing "branch" among the columns worth showing.

## Improvements Implemented

- **Fixed the crash (§7/§13/§21).** `ClinicalTabs`, `BillingTabs`, and the top-level `page.tsx` fetch now each check `can(session, ...)` before calling any permission-gated domain function, mirroring the defensive pattern `InsuranceTabs` already used for `coverage.manage`. A session lacking a given permission now sees a plain "You don't have permission to view X" message on that specific tab instead of the whole page failing. The dialog-population calls (`listBranches`/`listProviders`/`listServices`) are now gated on their actual view permission, not just the adjacent create permission.
- **Lightened Lab Results/Imaging queries (§20).** Both now use an explicit `select` matching exactly what Patient 360's summary tables render (id, verified date, value/impression, order number) instead of `include`-ing the full record — the radiology report's full narrative text in particular is no longer pulled into Patient 360's payload at all. The real report still lives on `/radiology/orders/[id]`, which the tab already links out to.
- **Overview tab now has a "Current Status" section (§3/§6/§9).** Today's appointment (with status, queue token, and linked in-progress encounter if any), the next upcoming appointment, and — only for users with `invoice.view`+`payment.view` — a financial snapshot (outstanding balance, reconciliation flag). Built entirely from data already fetched for other tabs (`appointments`, the billing statement) — no new query was added to load it (see Performance).
- **Timeline now links to real destinations (§10/§11).** Appointment-derived entries link to `/appointments/[id]`; new invoice-derived entries (sourced from the same statement lines the Statement tab already renders, for users with financial permission) link to `/invoices/[id]`. Payment/registration entries stay plain text — there's no standalone payment or "patient record" detail page to send them to, so no dead links were added.
- **Cross-record linking on clinical tabs (§13).** Diagnoses and Orders rows now show an "Open →" link to their originating encounter; Prescriptions rows now have an "Encounter" button alongside the existing "Print" one. All three use the record's own `encounterId` scalar, already present on every row with no additional query.
- **Appointments tab now shows Branch (§12).**
- **Fixed the TabsList overlap on Patient 360 (§32).** Switched from the app-wide `flex-wrap` convention (which doesn't actually work once a tab row wraps — see Concrete Problems #7) to a horizontally-scrollable single row (`overflow-x-auto`), verified live to scroll and select correctly with no overlap.
- Retained from the earlier self-scoped pass: the "Book appointment" quick action in the header, "Collect payment" link on the Statement tab, the `PatientPicker` display fix, and the patient-list `cursor-pointer` removal.

## Live vs Future Tabs

Verified from actual code, not from PROJECT_STATUS.md wording:

**Live** (real data, real domain functions, real write paths where applicable): Overview, Timeline, Medical Profile, Appointments, Episodes, Encounters, Vitals, Diagnoses, Prescriptions, Orders, Lab Results, Imaging, Packages, Invoices, Payments, Statement, Insurance, Communications (event-driven SMS/message log — genuinely sends/logs, currently shows real `failed` rows in dev because no SMS provider is configured, which is itself honestly labeled: "No SMS provider configured — message logged only, not transmitted").

**Genuinely future:** Documents only. Confirmed by grep — there is no document-storage domain module anywhere in `src/lib/domains`. It already renders through the shared `ComingSoon` component with an honest label rather than a fake empty table, which is correct as-is; not changed this batch (no WhatsApp/SMS or document-storage work is in scope here).

No tab was hidden — all 19 remain reachable, consistent with `p3.2.md` §25's "consider hiding a tab entirely if it adds no navigational value yet" being a judgment call, not a mandate: every live tab has real content or a real empty state, and Documents' honest future-state label already tells the user what it is without needing to be hidden.

## Performance

- **Previous baseline (P2, `PERFORMANCE_BASELINE.md`):** ~25 DB round trips for a full Patient 360 load (a broad fan-out across every tab's data, not an N+1).
- **This batch's query-shape changes:** two queries were *narrowed* (`select` instead of `include` on Lab Results/Imaging — fewer columns and no more full-relation joins, same round-trip count), one query gained two extra `select`ed fields on an existing include (`listPatientAppointments`'s `branch`/`encounter`), and the billing statement fetch was *moved* from inside `BillingTabs` up to the top-level page (so the new Overview financial snapshot could reuse it) rather than duplicated — a net-zero change in round-trip count, not an addition. No tab's data-loading behavior was changed from eager to lazy (or vice versa) this batch — the fetch-everything-on-page-load structure established in earlier phases is unchanged, so a new full before/after query-count measurement using the `PERFORMANCE_BASELINE.md` methodology was not required by §28/§35's own condition ("if you change loading behavior, measure real query counts before/after") and was not taken. The round-trip *count* is effectively unchanged from the ~25 baseline; per-row payload size decreased for Lab Results/Imaging.
- No caching layer, new API layer, or speculative optimization was added, per §28's explicit instruction.
- Genuine lazy-loading (splitting tab data behind separate fetches so only the active tab's data loads) was considered for the eight clinical tabs and Timeline, but implementing it would mean restructuring `ClinicalTabs`/`BillingTabs` from server-rendered-with-the-page components into a client/search-param-driven fetch pattern — a larger architectural change than this batch's "improve navigation, readability, empty states, and cross-record relationships... without touching the clinical data model" scope, and risked the "no speculative optimization" instruction. Left as a documented option, not implemented.

## Security / Role Awareness

- Every clinical/billing/appointment query on Patient 360 already went through its proper domain service (`listPatient*` functions with their own `assertCan`/branch-scope checks) — no page-level code queries Prisma directly, and none was introduced. §29's branch-visibility guarantees (registration-branch OR authorized-branch-appointment visibility, with per-encounter branch scoping preserved) were not touched and remain exactly as P0/P2 established them.
- The core fix this batch (§7) is entirely about *not crashing* when a role lacks a permission a given tab needs — no new permission was invented, no existing permission's meaning changed, and no role's permission grants were edited (the actual root-cause fix — e.g. deciding whether Receptionist should hold `branch.view` — is a role/seed-data policy decision, logged to `BACKLOG.md` rather than made unilaterally here).
- Clinical access logging (§30) was not modified — `writeClinicalAccessLog` calls inside `listPatientLabResults`/`ImagingResults`/`Diagnoses`/etc. are unchanged; the lightened `select`s only removed unused columns from the *returned* data, not from what's logged (logging already only ever recorded metadata, never content).
- Error handling (§31): the existing dashboard-level `error.tsx`/`not-found.tsx` boundaries (pre-existing, not new) already never leak a raw Prisma/PostgreSQL message — confirmed by reading them. This batch's own fix reduces how often that boundary is even reached (most previously-crashing cases now render a specific "You don't have permission to view X" message on the relevant tab instead of falling through to the generic boundary at all).

## Files Changed

- `src/app/(dashboard)/patients/[id]/page.tsx` — permission-gated `listPatientAppointments`/`listBranches`/`listProviders`/`listServices`; lifted `getPatientStatement` fetch; new Overview "Current Status" card (today/upcoming appointment, financial snapshot); Appointments tab Branch column + permission-gated rendering; `TabsList` overflow fix.
- `src/app/(dashboard)/patients/[id]/clinical-tabs.tsx` — permission-gated all six clinical fetches + dialog-option fetches; encounter cross-links on Diagnoses/Prescriptions/Orders.
- `src/app/(dashboard)/patients/[id]/billing-tabs.tsx` — permission-gated Packages/Invoices/Payments/Statement; now receives `statement`/`canViewStatement` as props instead of fetching internally.
- `src/app/(dashboard)/patients/[id]/timeline.tsx` — appointment/invoice event links; new invoice/payment event types sourced from statement lines.
- `src/lib/domains/appointments/service.ts` — `listPatientAppointments` include extended with `branch`/`encounter`.
- `src/lib/domains/clinical/diagnoses.ts` — dropped an unused full `encounter: true` include.
- `src/lib/domains/laboratory/results.ts` — `listPatientLabResults` narrowed to a `select`.
- `src/lib/domains/radiology/results.ts` — `listPatientImagingResults` narrowed to a `select`.
- `test/integration/p3-2-patient-360-role-visibility.test.ts` — new (see Tests).
- `BACKLOG.md` — 3 new entries (Receptionist missing `branch.view`, shared `TabsList` multi-row overflow, missing `/episodes/[id]`).

Not changed this batch: `medical-profile-tab.tsx`, `insurance-tabs.tsx`, `portal-access-card.tsx` — reviewed, already correct against the spec (RBAC-appropriate, honest empty states, no direct Prisma queries), no concrete gap found worth a code change.

## Tests

**New:** `test/integration/p3-2-patient-360-role-visibility.test.ts` (3 tests) — pins the exact permission preconditions the crash-fix above depends on: a Doctor-shaped session can view clinical tabs but is correctly refused billing data (was previously an unhandled crash); a Laboratory-Technician-shaped session is correctly refused appointments and clinical tabs while still being able to view lab results; `listPatientAppointments`'s extended include resolves correctly for a Receptionist-shaped session. No CSS/layout tests were added, and no existing security or integrity assertion was weakened.

**Total: 44 test files, 281 tests, 281/281 passing** (278 existing + 3 new; the earlier self-scoped-P3.2 pass added 0 tests, so this is +3 from the 278 baseline this session started with).

## Browser Verification

Against `his_dev`, logged in as Super Admin, using a real patient created via real domain functions (registration, `bookAppointment`+`checkIn` for today, a second future `bookAppointment`, `startEncounter`+`addDiagnosis`+`recordVitals`+`createPrescription`+`createOrder`, `createAdHocCharge`+`generateInvoice`+`recordPayment` for a partial payment):

- **Overview:** header shows name/MRN/status/age/DOB/gender/phone; new Current Status card correctly showed today's checked-in appointment with its real queue token, the same appointment also as "Upcoming" (correct — it was the soonest one relative to the render-time clock), and Financial snapshot showing the real outstanding balance (100.00 on a 150.00 charge with a 50.00 payment applied).
- **Timeline:** showed patient-registration, appointment-scheduled/checked-in/queued, invoice, and payment events in order; confirmed via the DOM that only the appointment and invoice entries are real links (to `/appointments/[id]` and `/invoices/[id]` respectively) — payment/registration entries are correctly plain text.
- **Appointments:** Branch column present and correct.
- **Diagnoses/Prescriptions/Orders:** each row's new encounter link correctly navigates to `/encounters/[id]`, which itself renders the same diagnosis/order/prescription/vitals in full context — confirmed the destination is real, not a dead link.
- **Encounters/Episodes/Vitals:** rendered correctly (Episodes showed the honest "No episodes yet." empty state, since none were created).
- **Lab Results/Insurance:** rendered the honest empty states ("No verified lab results yet." / "No insurance coverage on file.") — no seed payor exists in `his_dev`, so the negative/empty path is what's genuinely exercised here.
- **Statement:** outstanding balance, reconciliation flag, and the "Collect payment" link all correct; ledger showed the invoice/payment lines with the correct running balance.
- **Communications:** showed real (if `failed`, since no SMS provider is configured in dev) event-driven messages with an honest reason string, not a fake success.
- **Documents:** rendered the honest future-phase label.
- **TabsList fix:** confirmed visually (screenshot) that the previous 3-row wrap genuinely overlapped the Overview card underneath it, and that the horizontal-scroll fix resolves it cleanly with working scroll and tab selection.
- **Restricted/unauthorized scenario (§36's "automated test or second role"):** covered by the new automated test above (a Doctor-shaped session correctly refused billing data; a Lab-Tech-shaped session correctly refused appointments/clinical tabs) rather than a second live browser login, per the spec's own "automated test **or** second role" wording.

All walkthrough data (the fixture patient and every dependent row, plus an open cashier session opened to test payment collection) was cleaned up afterward via a script using the established owner/runtime-connection split (clinical_access_log requires the owner connection to delete), verified back to 0 matching patients.

One real, in-scope bug was found and fixed *during* this walkthrough, not before it: the TabsList overlap (Concrete Problems #7) was only visible once actually rendered in the browser at the pane's width — this is exactly the kind of finding the required walkthrough step exists to catch.

## Remaining Patient 360 Backlog

Logged to `BACKLOG.md` (not fixed here, per §2/§37's routing rule):

- Receptionist role missing `branch.view` — crashes `/reception` and `/appointments` (P3.1 pages, not Patient 360, but the identical bug class this batch fixed on Patient 360 itself). **High severity, flagged with urgency.**
- Shared `ui/tabs.tsx` `TabsList` doesn't genuinely support multi-row wrapping — affects 4 other pages beyond Patient 360 that use the same `flex-wrap` convention.
- No `/episodes/[id]` detail page — blocks an episode↔encounter cross-link Patient 360 could otherwise add.

Also out of scope and intentionally not investigated further, per §37: any doctor-documentation, nursing/triage, lab/radiology operational workflow, pharmacy workflow, or billing/POS workflow gap encountered only in passing while verifying Patient 360's own links out to those areas.

## Regression Status

| Check | Result |
|---|---|
| `prisma validate` | Schema valid (unchanged — no schema/migration change this batch) |
| `prisma migrate status` | 32/32 migrations, up to date |
| TypeScript typecheck | Clean, zero errors |
| Lint | Clean, zero errors |
| Integration test suite | **44 files, 281 tests — all passed, zero failures** (278 baseline + 3 new) |
| Production build | Clean, all routes compiled |

**Integration test database:**
```
Host:            localhost
Port:             5433 (local Docker Postgres)
Database:        his_test
Remote Supabase: NOT USED
```
No credentials recorded anywhere in this report.

---

**Stopping per §40.** P3.3 (Doctor/Encounter Workflow), Nursing, Lab/Radiology workflow changes, Billing workflow changes, P4, and regulatory implementation are all untouched. Returning this report for review.
