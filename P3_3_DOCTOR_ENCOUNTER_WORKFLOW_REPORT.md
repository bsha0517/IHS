# P3.3 — Doctor / Encounter Workflow Report

Executed against `p3.3.md` in full (44 sections), starting with the mandatory §4 step (closing the bounded P3.2 `branch.view` regression) before any Doctor-workflow work.

## Existing Workflow Reviewed

Inspected fresh: the provider queue (`/queue`), `/encounters/[id]` and every section (`encounter-header.tsx`, `patient-summary-sidebar.tsx`, `note-form.tsx`, `vitals-section.tsx`, `diagnoses-section.tsx`, `orders-section.tsx`, `prescriptions-section.tsx`, `follow-up-section.tsx`), the appointment→encounter transition (`startEncounter`, `AppointmentStatusActions`'s `StartEncounterForm`), and every clinical domain function behind them (`clinical/encounters.ts`, `vitals.ts`, `diagnoses.ts`, `orders.ts`, `prescriptions.ts`, `follow-ups.ts`, `notes.ts`).

What already worked correctly and needed no change: `AppointmentStatusActions` already showed "Open encounter" (not "Start Encounter") once one exists; `Encounter.appointmentId` already carries a real DB-level `@unique` constraint; `startEncounter`→`callPatient` already transitions a waiting appointment to `in_consultation`; `completeEncounter`→`completeConsultation` already transitions it to `completed` (and `finalizeEncounter` correctly does *not* touch appointment status — the exact two-stage design §31 asks to verify, not invent); the ClinicalOrder architecture already correctly separates a doctor's free-text CPOE order from the later lab/radiology-staff "assignment" step (P3.5 territory, not a broken integration); Prescription is already fully separate from ClinicalOrder as designed; the consultation note already has real draft/finalize/amendment behavior with `isCurrent`/`amendsId` chaining; no `ProcedureCompleted` exists anywhere, and no automatic billing/inventory consumption happens from order creation.

## Concrete Problems Found

1. **§4 (mandatory first step): the seeded Receptionist role lacks `branch.view`, crashing `/reception` and `/appointments`.** Confirmed the root cause precisely: both pages called the org-wide, `branch.view`-gated `listBranches` unconditionally, merely to populate the New Appointment dialog's branch select — they never actually needed the *whole org's* branch list, only the branches the signed-in session can operate at.
2. **The exact same bug, more severe, on `/queue` itself.** `canCheckin = can(session, "appointment.checkin")` is true for Doctor (My Queue's own primary user), and `/queue` also called `listBranches` unconditionally when `canCheckin` — so **Doctor could not open the provider queue at all**, before any Doctor-workflow feature work was even reachable. Not named in the P3.2 backlog note (only Reception/Appointments were), found by applying the same root-cause check to this batch's own central entry point.
3. **`startEncounter`'s appointment lookup had no organizationId filter and no branch check at all** — `db.appointment.findFirstOrThrow({ where: { id: input.appointmentId } })` — even though `assertCan` just above only verifies the session is authorized for the separately-supplied `input.branchId`. Nothing tied the two together; a crafted request could name an authorized branch while pointing `appointmentId` at a different org's or branch's appointment entirely.
4. **Every encounter-scoped clinical write had no branch check on the write path itself** — `recordVitals`, `addDiagnosis`, `createOrder`, `createPrescription`, `recommendFollowUp`, `saveNote`, `createAmendment`, and the encounter lifecycle actions (`completeEncounter`, `finalizeEncounter`, `cancelEncounter`, `markEncounterEnteredInError`), plus `updateDiagnosisStatus`/`cancelOrder`/`updateOrderStatus`/`cancelPrescription`/`dismissFollowUp`. Each fetched its target by `{id, organizationId}` only — the read side (`getEncounter`, list functions) was already correctly branch-scoped, but every write function trusted a caller-supplied id without re-checking branch access, exactly the class of leak §34 warns against reintroducing (P2's original prescription/follow-up fix was read-side only; the write side had apparently never been closed).
5. **`listMyQueue`'s include was missing `service` entirely**, so the provider queue could never have shown it, despite p3.3.md §6 explicitly naming "service" as a field the queue should display.
6. **The encounter workspace had no way back to the queue or out to the source appointment** — no "Back to Queue," no "Appointment Detail" link anywhere on the page (§29).
7. **`getNoteHistory` already existed (used elsewhere for admin/access-log purposes) but was never wired into the encounter workspace** — a doctor finalizing then amending a note had no way to see the original content, author, or amendment chain from `/encounters/[id]` at all (§25/§26).
8. **Raw Prisma error messages could leak to the doctor for a stale/invalid encounter id** (§33) — found live during this batch's own browser walkthrough (see Browser Verification) — `findFirstOrThrow`'s message ("Invalid `db.encounter.findFirstOrThrow()` invocation... No record was found") is not a message a domain layer should ever hand a user.
9. **`EncounterHeader`'s Complete/Finalize/Cancel/Entered-in-error actions had no client-side error handling at all** — a rejected transition became an unhandled promise rejection, surfacing only the generic route-level error boundary instead of the specific, actionable message the domain layer already throws (§33's own named examples: "encounter already finalized," "invalid transition").
10. **`/encounters/[id]`'s `listProviders` call (for the referral-order provider picker) was unconditional** — Nurse holds `encounter.view` and can reach this page, but not `provider.view`, so the whole encounter workspace would have crashed for Nurse.

## Improvements Implemented

- **§4 fix:** `reception/page.tsx`, `appointments/page.tsx`, and `queue/page.tsx` now call `listAccessibleBranches` (`billing/cashier.ts` — already existed for the identical "which branches can this session act at" need at POS, no permission requirement beyond an authenticated session with `branchIds`) instead of `listBranches`. No permission was granted to Receptionist to suppress the error — the pages simply never needed the org-wide list they were requesting.
- **Branch-write gap closed (§34) across 15 functions**: every encounter-scoped write and lifecycle action now calls `assertBranchAccess(getAuthorizedBranchScope(session), <branch>)` right after fetching its target, mirroring `getEncounter`'s own established pattern. `startEncounter`'s appointment lookup is now org- and branch-checked too.
- **`startEncounter` is now idempotent under a real race** (§7): the DB-level unique constraint on `Encounter.appointmentId` is the actual guard; a caught `P2002` now looks up and returns the existing encounter instead of surfacing the raw constraint-violation message — a double-submitted "Start encounter" resolves to the same encounter, not an error.
- **Raw-error leaks fixed (§33)** on the six primary encounter lookups (`recordVitals`, `addDiagnosis`, `createOrder`, `createPrescription`, `recommendFollowUp`, `saveNote`): `findFirstOrThrow` → `findFirst` + a friendly thrown message. `EncounterHeader`'s Complete/Finalize/Cancel/Entered-in-error actions now catch and display the domain layer's real message inline instead of falling through to the generic error boundary.
- **Provider queue now shows service (§6)**: `listMyQueue`'s include gained `service`, rendered in My Queue.
- **Encounter workspace navigation (§29)**: "← Back to Queue" and, when the encounter has one, "📅 Appointment" links added to the header.
- **Note amendment history wired in (§25/§26)**: `getNoteHistory` (pre-existing, already access-logged) is now called from the encounter page when a current note exists; `NoteForm` gained an "Amended" badge and a "History (N)" dialog showing every version — original vs. each amendment, author, date, and content — using only existing records, no new table.
- **`listProviders` permission-gated (§7/§34)**: `/encounters/[id]` now checks `provider.view` before calling it, matching the defensive pattern P3.2 already established, so Nurse no longer crashes the page.

## Appointment → Encounter Behavior

Duplicate prevention is layered, not invented this batch: `Encounter.appointmentId` carries a real DB-level `@unique` constraint (the actual source of truth), `AppointmentStatusActions` already renders "Open encounter" instead of "Start Encounter" once `a.encounter?.id` is present (so the normal UI path never even attempts a second start), and `startEncounter` now additionally catches the constraint violation on the rare race (e.g. a genuine double-submit) and transparently returns the existing encounter rather than erroring — verified directly with a concurrent `Promise.all([startEncounter(...), startEncounter(...)])` test asserting both calls resolve to the same encounter id and exactly one row exists afterward. A finalized encounter is never silently reopened — `AppointmentStatusActions` only ever offers "Open encounter" (read-only once inside, per the note-form's `isLocked` check), never a fresh "Start."

## Consultation Documentation

Draft/finalize/amend behavior is exactly the pre-existing architecture, made visible rather than changed: a note is freely editable in place while in `draft` status (`saveNote` updates the same row); `completeEncounter` locks the encounter's clinical content (status → `completed`, and `finalizeEncounter`'s bulk sweep flips every draft note to `finalized`); once finalized, `saveNote` throws ("This note is finalized. Create an amendment to correct it.") — verified directly, not assumed; `createAmendment` creates a new row (`amendsId` pointing at the original, `isCurrent` flipped on the original), and the original's content is provably untouched (asserted directly against the DB in this batch's new test). The encounter workspace now surfaces this chain via the new History dialog — the original is labelled "Original / Superseded," the correction "Amendment 1 / Current," each with its real author and timestamp.

## Diagnoses / Orders / Prescriptions / Follow-up

No changes to the diagnosis-entry UI, the Lab/Imaging/Procedure/Referral order dialog, the multi-item prescription builder, or the follow-up recommendation form — all already matched their respective sections (§14–§22) on inspection: ICD search with free-text fallback, no duplicate order mechanism, no `ProcedureCompleted`/auto-billing/auto-stock-consumption, Prescription kept architecturally separate from ClinicalOrder, "Recommend follow-up" labeled as a recommendation (confirmed `recommendFollowUp` never books an appointment). The only changes to these four domain functions this batch were the branch-access and raw-error fixes described above — no UI or business-logic change.

## Queue / Appointment State

No new synchronization rules were invented, per §31/§32's own instruction — the existing behavior was inspected and confirmed correct, then verified live: starting an encounter from a "waiting" appointment moves it to `in_consultation` via the existing `callPatient` transition (both an automated test and the live browser walkthrough confirm the queue empties immediately); completing an encounter moves the appointment to `completed` via the existing `completeConsultation` call inside `completeEncounter`, and the queue (filtered to `status: in ["waiting", "in_consultation"]`) correctly stops showing it. Finalization deliberately does not touch appointment status, matching §31's own caution against inventing that link. No changes were made to any status-transition logic — only the branch-access hardening described above.

## Security / Branch Scoping

This is the batch's largest substantive change. P0/P2/P3.2's read-side branch scoping was already correct and is unchanged. The write-side gap (§34, Concrete Problems #4) is now closed across every encounter-scoped clinical write and lifecycle action, plus the appointment lookup inside `startEncounter` itself (previously not even organization-scoped). No page queries Prisma directly to bypass a domain service — every fix was added inside the existing domain functions themselves, in the same place `getEncounter`'s own branch check already lives. Verified with 5 new branch-isolation assertions (a Branch-A-only session rejected on vitals/diagnosis/order/prescription/follow-up/note writes and on encounter completion/finalization against a Branch-B encounter, with the equivalent same-branch write proven to still succeed) plus a same-org cross-branch appointment check.

## Performance

`getEncounter`'s query shape (one `findFirstOrThrow` with a single deep `include` covering patient/allergies/conditions/medication-history/episode/appointment/provider/department/vitals/notes/diagnoses/orders/prescriptions/follow-ups) was already the "prioritize immediate encounter context in one round trip" pattern §36 asks for — not a Patient-360-style fan-out — and was not changed. The only additions this batch made to the page's query set: `getNoteHistory` (§25/§26 — a tiny, bounded chain query, only fetched when a current note exists) and gating `listProviders` behind a permission check (a removal, not an addition, for the common case where it isn't needed). No query behavior was materially changed, so no before/after query-count measurement was taken, per §36's own condition ("if query behavior changes materially, measure").

## Files Changed

- `src/app/(dashboard)/reception/page.tsx`, `appointments/page.tsx`, `queue/page.tsx` — `listBranches` → `listAccessibleBranches` (§4 fix); `queue/page.tsx` also renders the new `service` field.
- `src/lib/domains/appointments/queue.ts` — `listMyQueue`'s include gained `service`.
- `src/lib/domains/clinical/encounters.ts` — branch-access checks on `startEncounter`'s appointment lookup and all four lifecycle actions; org/branch-scoped, friendly-error appointment lookup; idempotent duplicate-encounter handling on `startEncounter`.
- `src/lib/domains/clinical/vitals.ts`, `diagnoses.ts`, `orders.ts`, `prescriptions.ts`, `follow-ups.ts`, `notes.ts` — branch-access checks on every write/lifecycle function; `findFirstOrThrow` → `findFirst` + friendly error on the primary encounter lookup; `getNoteHistory` now includes `authoredByUser`/`finalizedByUser` names.
- `src/app/(dashboard)/encounters/[id]/page.tsx` — `listProviders` permission-gated; `getNoteHistory` wired in.
- `src/app/(dashboard)/encounters/[id]/encounter-header.tsx` — Back to Queue/Appointment nav links; inline error handling for Complete/Finalize/Cancel/Entered-in-error.
- `src/app/(dashboard)/encounters/[id]/note-form.tsx` — "Amended" badge, History dialog.
- `test/integration/p3-1-reception-workflow.test.ts` — 1 new test (§4 regression).
- `test/integration/p3-3-doctor-encounter-workflow.test.ts` — new (7 tests).
- `BACKLOG.md` — 4 new entries.

## Tests

**New:** 1 test in `p3-1-reception-workflow.test.ts` (§4 closure — pins that `listBranches` genuinely throws for the seeded Receptionist shape and `listAccessibleBranches` is the correct, unblocked replacement) + 7 tests in the new `p3-3-doctor-encounter-workflow.test.ts` (waiting-appointment→`in_consultation` transition with the new `service` field; idempotent double-start race; existing-encounter reuse; branch isolation across every clinical write; branch isolation on complete/finalize; draft save/update-in-place, finalization lock, amendment-preserves-original via `getNoteHistory`; `getEncounter`'s pre-existing branch check unaffected). No CSS/layout tests. No existing P0–P3.2 assertion was weakened — all 281 pre-existing tests still pass unchanged.

**Total: 45 test files, 289 tests, 289/289 passing** (281 baseline + 1 + 7).

## Browser Verification

Performed the full 21-step walkthrough against `his_dev`, logged in as a real seeded-role Doctor account created for this walkthrough (role `Doctor`, linked `Provider`, single-branch `UserBranchAccess`):

1–2. Logged in, opened `/queue` — **confirmed this page, previously broken for Doctor (Concrete Problems #2), now renders** with My Queue showing token/patient/MRN/time/service/waiting-duration and Start encounter/Call patient actions.
3–5. Selected the waiting patient, clicked "Start encounter" — landed directly in `/encounters/[id]`; header showed patient name/MRN/age/gender/encounter number/type/provider/start time/status, the Penicillin allergy alert, and the new Back-to-Queue/Appointment nav links.
6. Clicked through to Patient 360 and back — confirmed Patient 360's own Overview "Current Status" card (P3.2) correctly showed "In consultation... Encounter ENC-000005 (active)," a live cross-feature integration check.
7–8. Recorded vitals (170cm/68kg/76bpm) — BMI computed correctly (23.5), shown immediately in both the Vitals section and the sidebar's Recent Vitals, no tab switch needed. Entered and saved a draft consultation note.
9. Added a diagnosis ("Seasonal allergic rhinitis") via the existing ICD-search dialog.
10–11. Placed a Laboratory order ("CBC with differential") and an Imaging order ("Chest X-Ray") — both appeared immediately in the encounter's Orders list with number/priority/status, no Patient 360 detour needed.
12. Created a multi-item prescription (Cetirizine) — appeared with RX number, item summary, status.
13. Added a follow-up recommendation (date + reason) — appeared with status "open."
14. Confirmed all of the above were visible together in the encounter workspace.
15–16. Clicked "Complete encounter" (status → Completed, appointment/queue confirmed empty — see below), then "Finalize" (status → Finalized) — the consultation note's structured fields became read-only immediately, showing the saved content.
17–18. Clicked "Amend," entered a corrected assessment, submitted — the note badge changed to "Amended," a "History (2)" button appeared. Opened it: **"Original / Superseded"** showing the untouched original chief complaint and assessment, and **"Amendment 1 / Current"** showing the corrected assessment — confirmed the original was not overwritten.
19. Checked `/queue` after completion — both My Queue and Branch Queue correctly emptied (no active waiting/in-consultation entry), confirming the appointment's status transition.
20. Order/result navigation: both orders show `ordered` status inline; no verified result exists yet for either (none was entered — that's P3.5 scope), so no dead link was exercised or needed — the honest current state was verified.
21. Unauthorized branch/role scenario — covered by the automated branch-isolation tests above (5 assertions across every clinical write plus encounter completion/finalization), per §40's own "via browser or automated test."

One real bug (Concrete Problems #8, the raw-error leak) was found live during this walkthrough — not anticipated beforehand — when a test-methodology mistake (a corrupted `encounterId` in a scripted form fill) surfaced Prisma's raw message inside the "Recommend follow-up" dialog, exposing the underlying gap the fix above closes.

All walkthrough data (the fixture patient, encounter, appointment, vitals, diagnosis, both orders, prescription, follow-up, the auto-generated consultation charge, and the throwaway Doctor user/provider/role/branch-access rows) was cleaned up afterward via a script using the established owner/runtime-connection split, verified back to 0 matching patients.

## Remaining Doctor Workflow Backlog

Logged to `BACKLOG.md` (not fixed here, per §3/§41's routing rule):
- Void-returning section actions (Diagnoses "Mark resolved", Orders cancel, Prescriptions cancel, Follow-up dismiss) still lack the inline error handling `EncounterHeader` got this batch.
- Vitals don't show "recorded by" — `VitalSign` has no `User` relation for its `recordedBy` scalar (a schema change, out of this batch's "do not rebuild Vitals" boundary).
- The five secondary "fetch before update" lookups (`updateDiagnosisStatus`, `cancelOrder`/`updateOrderStatus`, `cancelPrescription`, `dismissFollowUp`, `createAmendment`) still use `findFirstOrThrow` and could leak a raw message for a stale id — same fix pattern, lower priority/lower risk than the six primary lookups already fixed.
- No "result destination" link from an encounter's lab/imaging order to its eventual result — genuinely blocked on Patient 360 not supporting tab deep-linking yet (a P3.2-adjacent, not P3.3, gap).

Out of scope and not investigated further, per §41: nursing/triage (P3.4), lab/radiology operational processing (P3.5), pharmacy dispensing (P3.6), billing/POS (P3.7), and all later phases.

## Regression Status

| Check | Result |
|---|---|
| `prisma validate` | Schema valid (unchanged — no schema/migration change this batch) |
| `prisma migrate status` | 32/32 migrations, up to date |
| TypeScript typecheck | Clean, zero errors |
| Lint | Clean, zero errors |
| Integration test suite | **45 files, 289 tests — all passed, zero failures** (281 baseline + 8 new) |
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

**Stopping per §44.** P3.4 (Nursing/Triage), Lab/Radiology operational changes (P3.5), Pharmacy (P3.6), Billing/POS (P3.7), P4, and regulatory integrations are all untouched. Returning this report for review.
