# P3.4 — Nursing / Vitals / Pre-Consultation Workflow Report

Executed against `p3-4.md` in full (41 sections), starting with the mandatory §3 step (the P3.3 `VitalSign.recordedBy` attribution backlog item) before any nursing-workflow work.

## Existing Workflow Reviewed

Inspected fresh: `/queue` (`listBranchQueue`, `listMyQueue`), the appointment state machine (`checkIn`, `callPatient`, `completeConsultation`), `startEncounter`'s appointment-linking and idempotency guard (P3.3), the encounter workspace and every section (header, sidebar, vitals, note, diagnoses, orders, prescriptions, follow-up), `VitalSign`'s schema and its one write path (`recordVitals`), the seeded Nurse role's actual permission set, and the `Provider`/`User`/`Employee` identity model.

What already worked and needed no change: `checkIn()` already transitions an appointment straight to `waiting` (recording `checked_in` only in status history, never as a live value) — confirmed the existing state machine already supports a nursing step operating on `waiting` patients with no enum change. `startEncounter`→`callPatient` already moves a waiting appointment to `in_consultation`, and `completeEncounter`→`completeConsultation` already moves it to `completed` — both already correct, unchanged. `Encounter.appointmentId`'s unique constraint and P3.3's idempotent-start handling already prevent duplicate encounters — reused, not rebuilt. `recordVitals` already always creates a new `VitalSign` row (never updates one in place) — vitals were already append-only. `BMI` computation already correctly handles missing height/weight and division-by-zero, and is already a genuinely derived value. The seeded Nurse role already had every permission this workflow needed (`patient.view`, `appointment.view`, `appointment.checkin`, `encounter.view`, `encounter.create`, `clinical_notes.view`, `vitals.record`) — no seed-role change was required at all.

## Nursing Model Decision

- **Nursing is optional, not mandatory.** Nothing added this batch requires a nurse to touch a patient's visit. A doctor can still click "Start encounter" directly from My Queue with zero nurse involvement — verified live (see Browser Verification, simple-clinic path).
- **Nursing reuses the existing queue exactly.** No second queue table or component. The Branch Queue card in `/queue` (already visible to anyone with `appointment.checkin`, which Receptionist and Nurse both hold) is the nurse/pre-consultation view — enriched with service, an alert indicator, and a vitals-recorded indicator, and (for whoever also holds `encounter.create`) an "Open Pre-Consultation"/"Open encounter" action. Reception-only staff see the same card unchanged, minus the encounter action they don't have permission for. No clinic-settings toggle exists anywhere — the two operational models simply fall out of which permissions a given signed-in user happens to hold.
- **Nursing opens/creates the exact same Encounter the doctor uses — never a second one.** `Encounter` genuinely represents "the physician consultation" (`providerId` is required, always a `Provider`), so a nurse's "Open Pre-Consultation" action calls the identical `startEncounter` used by the doctor's own queue, with `providerId` always set to **the appointment's own assigned provider** — never the nurse's identity (the nurse is not assumed to be a Provider, and none was fabricated). The nurse's own identity is attributed separately, only on the `VitalSign` rows she creates, via `recordedBy`. P3.3's unique `Encounter.appointmentId` guard and idempotent-start behavior (a race returns the existing encounter rather than erroring) apply identically regardless of who opens it first — verified directly (test + live browser) that a nurse opening first, then a doctor opening the same appointment, produces exactly one `Encounter` row and the doctor sees "Open encounter."
- **Handoff to the doctor is exactly the §18 minimum, no more.** The patient stays in the existing `waiting`/`in_consultation` appointment states (already correct, unchanged); vitals recorded by the nurse are immediately visible — same `VitalSign` table, no duplication — to the doctor via `getEncounter`, in the doctor's own My Queue (a real "Vitals recorded [time]" line, not a fabricated readiness flag), and in Patient 360. No new handoff protocol, no new status.

## Concrete Problems Found

1. **The Vitals form was unusable by a Nurse.** `VitalsSection`'s edit permission was tied to `clinical_notes.edit` (the doctor's note-editing permission), which Nurse does not hold — a nurse opening the encounter workspace to record pre-consultation vitals would have seen the Vitals section as fully read-only, with no way to actually record anything, despite already holding the underlying `vitals.record` permission the domain layer accepts.
2. **"Complete encounter" was gated on `encounter.create`, which Nurse also holds** — before this batch, only Doctor/Nurse could reach the encounter workspace at all, and only Doctor's own queue linked into it, so this never mattered in practice. Now that a nurse legitimately and routinely opens the same workspace for pre-consultation vitals, an unguarded "Complete encounter" button risked a nurse prematurely locking the consultation and flipping the linked appointment to `completed` before the doctor had even seen the patient.
3. **`VitalSign.recordedBy` had no relation to `User` at all** (the P3.3 backlog item) — every other actor field in this schema has one; this one didn't, so no surface could ever show who recorded a set of vitals.
4. **The doctor's own queue (My Queue) had no visibility into whether nursing had already happened** — `listMyQueue`'s include had no vitals/encounter-vitals signal at all, so a doctor had to open every encounter individually to know whether a nurse had already recorded vitals.
5. **The encounter workspace showed no "why is the patient here" context** — the appointment's own service and notes were fetched (`appointment: true`) but never surfaced anywhere in the workspace.
6. Confirmed clean, not a problem: re-checked `/queue`, `/reception`, and `/appointments` for the P3.3 `branch.view`-vs-`listAccessibleBranches` fix — no further gap of that shape remained anywhere in this batch's scope.

## Improvements Implemented

- **§20/§23 — Vitals section decoupled from the doctor's note-edit permission.** `encounters/[id]/page.tsx` now computes a separate `canRecordVitals = can(session, "vitals.record") && status !== "finalized"` and passes it to `VitalsSection` instead of the shared `canEdit`. Diagnoses/Orders/Prescriptions/Follow-up/Note stay correctly gated on `clinical_notes.edit` (Nurse still can't add diagnoses, orders, prescriptions, or write the doctor's note — unchanged, correct).
- **§20/§23 — "Complete encounter" gated on `canFinalize`** (the same prop already gating "Finalize"), so only a Doctor-permission-holder can complete/lock the encounter; a Nurse now sees only "Cancel" while the encounter is active.
- **§3/§24 — `VitalSign.recordedBy` now has a real `User` relation** (`recordedByUser`, `onDelete: Restrict`) — see Vitals Attribution below for the full migration reasoning. Wired into the encounter workspace's Vitals list, Patient 360's Vitals tab, and `getNoteHistory`-adjacent includes where relevant.
- **§9/§16 — appointment context surfaced in the encounter header**: "Booked for: [service]" and the appointment's own free-text note (this schema has no separate `reason` field), shown as read-only context — never copied into the doctor's `chiefComplaint`.
- **§5/§29 — Branch Queue enriched, not replaced**: `listBranchQueue`'s include gained `service`, an alert signal (`patient.allergies`/`conditions` where `isAlert`), and an encounter/vitals-recorded signal — all resolved inside the same single query (nested includes, not a per-row fetch). The card now shows an alert icon, "Vitals recorded [time]"/"Vitals not recorded" (only to viewers who hold `vitals.record`, so Receptionist doesn't see a nursing-specific line that means nothing to their role), and an Open Pre-Consultation/Open encounter action for whoever holds `encounter.create`.
- **§18/§19 — My Queue enriched**: `listMyQueue`'s include narrowed from the full `encounter` relation to exactly `{id, vitalSigns: latest}`, and now shows "Vitals recorded [time]" / "Vitals not recorded" to the doctor directly in the queue — real persisted data, never a fabricated "ready" flag.
- **§31 — honest empty state added**: "No vitals have been recorded for this encounter." (previously the section silently rendered nothing when empty).
- **`StartEncounterForm` exported and given a `label` prop** so the exact same `startEncounterAction` call (same idempotency, same guard) is reused verbatim by the queue's nursing action with contextually appropriate wording ("Open Pre-Consultation"), instead of being duplicated.

## Vitals Attribution

**Yes — `recordedBy` now has a real FK to `User`.** Reviewed before implementing: `recordedBy` is written in exactly one place in the entire codebase (`clinical/vitals.ts`'s `recordVitals`), always set to `session.user.id` — a real, live user id at write time, with no code path that ever sets it to null, a system placeholder, or anything else. There is no user hard-delete path in this system (deactivation is a status flip). A direct check against both `his_dev` and `his_test` before writing the migration found zero existing `VitalSign` rows with a null `recordedBy` and zero orphaned values (no row whose `recordedBy` didn't match a real `user.id`) — **no backfill was needed**.

- **Migration**: `prisma/migrations/20260831_p3_4_vital_sign_recorder_fk/migration.sql` — a single `ALTER TABLE vital_sign ADD CONSTRAINT ... FOREIGN KEY (recorded_by) REFERENCES "user"(id) ON DELETE RESTRICT ON UPDATE CASCADE` on the *existing* `recorded_by` column. No new column, no data migration, no `recordedByUserId` rename — the P3.3 backlog note's "potential direction" suggested a new column, but since the existing scalar already only ever held valid `User` ids, adding the relation directly on it was safe and simpler.
- **Delete behavior**: `onDelete: Restrict`, matching every other clinical-authorship actor FK already in this schema (`ClinicalNote.authoredByUser`/`finalizedByUser`, `ImagingOrder.performedByUser`, etc.) — a vital sign's recorder must survive that user's account being deactivated.
- **Tests**: covered indirectly by every new P3.4 test that records vitals and asserts `vitals.recordedBy` / `vitals.recordedByUser.firstName` — not a dedicated migration-only test, since the behavior is exercised end-to-end by the real workflow tests instead.
- Applied to both `his_dev` and `his_test` via `prisma migrate deploy` (owner connection) before running any tests; `prisma migrate status` confirms 33/33 applied cleanly with no drift from this change.
- One pre-existing, unrelated schema drift was found and deliberately **not touched**: the live `OutboxStatus` enum carries an extra `processed` value with no corresponding migration (predates this session entirely, confirmed via direct query against the live enum). Included in `migrate diff`'s raw output but excluded from the actual migration file written — this migration touches only `vital_sign`.

## Vitals History / Correction Behavior

**History**: append-only, confirmed as the *existing* behavior (not changed) — `recordVitals` always does `db.vitalSign.create`, never an update. A second recording during the same encounter creates a second, independently-timestamped row; both remain visible in the encounter's Vitals list and in Patient 360, each with its own recorder. Verified directly (test + live browser: nurse records Pulse 88 at 19:22, doctor later records Pulse 92 at 19:24 in the same encounter — both rows present afterward, the original unchanged).

**Correction/editing**: vitals cannot currently be edited — there is no update path anywhere in the codebase and no UI for it. This is the existing V1 behavior, left exactly as-is per §27's own instruction ("preserve existing behavior unless clearly unsafe... do not invent a full amendment mechanism for vitals"). If a genuine future correction/auditing need arises, it belongs in a dedicated batch, not implied here.

## Queue / Handoff Behavior

Reused P3.1's `formatWaitingMinutes` directly — no second timer. Both queue views (`listBranchQueue`, `listMyQueue`) already filtered correctly to `status: {waiting, in_consultation}` scoped to today's check-ins; no filtering logic was changed, only the data each query's single `include` carries. Handoff is entirely state-driven, not protocol-driven: a nurse recording vitals doesn't move the appointment anywhere (it's already `waiting`/`in_consultation` from check-in/encounter-start); the doctor simply sees the same real signal (`vitalSigns[0]`) the nurse's own action produced.

## Security / Branch Scoping

P3.3's write-side branch hardening (`assertBranchAccess` on every encounter-scoped write) applies identically regardless of caller role — no nursing-specific bypass was added or needed, since `recordVitals`/`startEncounter`/`getEncounter` don't distinguish caller role at all, only permission + branch. Verified directly with a Nurse-shaped session authorized only for Branch A: rejected on `recordVitals` against a Branch B encounter, rejected on `getEncounter` for that same encounter, and rejected on `startEncounter` for a Branch B appointment — all three `ForbiddenError`. No direct Prisma queries were added anywhere in the new queue/UI code — every read/write goes through the existing domain functions (`listBranchQueue`, `listMyQueue`, `startEncounter`, `recordVitals`, `getEncounter`, `listPatientVitals`).

## Performance

`listBranchQueue` and `listMyQueue` each remain a single `findMany` call — the new alert/vitals-recorded signals were added as nested `include`s on that same query (patient→allergies/conditions filtered `isAlert`, encounter→latest vitalSign), not a per-row follow-up fetch. This costs a handful of additional batched SQL statements at the *query-shape* level (proportional to nesting depth, the same pattern already accepted for `getEncounter`'s own deep include in P3.3), not one extra round trip per patient row — satisfying §35's explicit "avoid N+1" requirement. Not measured with the `PERFORMANCE_BASELINE.md` instrumented-count methodology, since neither queue page's overall shape changed (still one query per card, as before) — only what that one query returns.

## Files Changed

- `prisma/schema.prisma` — `VitalSign.recordedByUser` relation + `User.vitalSignsRecorded` back-relation.
- `prisma/migrations/20260831_p3_4_vital_sign_recorder_fk/migration.sql` — new.
- `src/lib/domains/clinical/vitals.ts` — `listPatientVitals` now includes `recordedByUser`.
- `src/lib/domains/clinical/encounters.ts` — `ENCOUNTER_WORKSPACE_INCLUDE`'s `vitalSigns` now includes `recordedByUser`; `appointment` now includes `service`.
- `src/lib/domains/appointments/queue.ts` — `listBranchQueue` enriched (service, alert signal, encounter/vitals signal); `listMyQueue`'s `encounter` include narrowed and vitals-aware.
- `src/app/(dashboard)/queue/page.tsx` — Branch Queue card: alert icon, vitals-recorded line, Open Pre-Consultation/Open encounter action; My Queue: vitals-recorded line.
- `src/app/(dashboard)/appointments/status-actions.tsx` — `StartEncounterForm` exported, gained `label`/`pendingLabel` props.
- `src/app/(dashboard)/encounters/[id]/page.tsx` — `canRecordVitals` computed separately from `canEdit`.
- `src/app/(dashboard)/encounters/[id]/vitals-section.tsx` — shows recorder name; honest empty state.
- `src/app/(dashboard)/encounters/[id]/encounter-header.tsx` — "Complete encounter" gated on `canFinalize`; appointment service/notes context line.
- `src/app/(dashboard)/patients/[id]/clinical-tabs.tsx` — Vitals tab gained a "Recorded by" column.
- `test/integration/p3-4-nursing-vitals-workflow.test.ts` — new (6 tests).
- `BACKLOG.md` — 3 new entries (a flaky, unrelated pre-existing test found while regression-testing; no pain-score field; both documented as deliberate non-fixes).

## Tests

**New:** 6 tests in `p3-4-nursing-vitals-workflow.test.ts` — a Nurse-shaped session has no Provider record (confirms the test setup matches the real §24 constraint); a nurse opens a pre-consultation encounter using the appointment's own provider and records vitals attributed to herself, visible to the doctor via `getEncounter` and to Patient 360 via `listPatientVitals`; a doctor opening the same appointment after the nurse reuses the identical encounter (zero duplicates); a second vitals recording during the same encounter appends rather than overwrites; a Branch-A-only nurse session is rejected on vitals writes, `getEncounter`, and `startEncounter` against a Branch B encounter/appointment; both queue functions resolve their new vitals/alert signals from a single query. No CSS/layout tests. No existing P0–P3.3 assertion was weakened — all 289 pre-existing tests still pass unchanged, including P3.3's own appointment→encounter idempotency tests (re-run and confirmed passing).

**Total: 46 test files, 295 tests, 295/295 passing** (289 baseline + 6 new).

## Browser Verification

Performed the full 20-step walkthrough against `his_dev`, using two real seeded-role accounts created for this walkthrough (a `Nurse` — deliberately with no linked `Provider` record, to directly verify §24 — and a `Doctor` with a linked `Provider`):

1–4. Prepared two checked-in/waiting patients via real domain calls (Patient A for the nursing path, Patient B for the simple-clinic path). Logged in as Nurse, opened `/queue` — **Branch Queue rendered correctly with no "My Queue" section** (confirms a Nurse with no Provider record is correctly excluded from the doctor-only queue, not crashed) — both patients shown with service, waiting duration, an alert icon (Patient A's Latex allergy), and "Vitals not recorded" / "Open Pre-Consultation."
5–6. Clicked "Open Pre-Consultation" for Patient A — landed in a real encounter (`ENC-000006`, "consultation with Dr. P34Doctor" — **the appointment's own provider, not the nurse**), showing "Booked for: Walkthrough Consultation," the Latex alert prominently, and — critically — **no "Complete encounter" button** (only Cancel/Entered-in-error), confirming the new physician-only gate.
7–9. Recorded vitals (Pulse 88, Temp 37.1°C, SpO2 98%) — confirmed plain values shown with units, no auto-interpretation ("SpO2 98%," not "Normal"). Saved successfully.
10. Confirmed recorder/time: the Vitals list showed **"31 Aug 2026, 19:22 · Nadia P34Nurse"** — real attribution, live.
11–12. Returned to `/queue` — Branch Queue now showed **"Vitals recorded 31 Aug 2026, 19:22"** and the button changed to **"Open encounter"** (status now `in_consultation`); Patient B untouched ("Vitals not recorded," still "Waiting").
13–15. Logged in as Doctor — **My Queue showed both patients**, Patient A with the same "Vitals recorded" line and "Open encounter" (both My Queue's and Branch Queue's links resolved to the identical encounter id — confirmed no duplicate). Opened it: same `ENC-000006`, now showing "Complete encounter" (Doctor holds `encounter.finalize`).
16. **Confirmed the nurse-recorded vitals appear inside the doctor's own encounter view**, attributed to Nadia P34Nurse.
17. Confirmed the same vitals appear in **Patient 360's Vitals tab**, with a "Recorded by" column showing "Nadia P34Nurse."
18. Recorded a second set of vitals as the doctor (Pulse 92) — **both entries now shown, most recent first, each with its own correct recorder and timestamp** — verified in both the encounter workspace and Patient 360.
19. Cross-branch nursing write denial — covered by the automated tests above (rejected on `recordVitals`, `getEncounter`, and `startEncounter` for a Branch A nurse against a Branch B encounter/appointment), per §37's own "via browser or automated test."
20. **Confirmed the simple-clinic path**: as Doctor, clicked "Start encounter" directly on Patient B (no nurse ever touched this patient) — landed in a fresh encounter (`ENC-000007`) with an honest "None recorded"/"No vitals have been recorded for this encounter" state, ready for the doctor to proceed unaided.

All walkthrough data (both patients, their appointments/encounters/vitals/allergy, and the throwaway Nurse/Doctor users + the doctor's Provider record) was cleaned up afterward via a script using the established owner/runtime-connection split, verified back to 0 matching patients.

## Remaining Nursing Backlog

Logged to `BACKLOG.md` (not fixed here, per §2/§38's routing rule):
- No pain-score field on `VitalSign` — a common nursing measurement, judged not essential for a working V1 (every other field already sufficed).
- `report-reconciliation.test.ts` (accounting/revenue reporting — zero overlap with this batch) is flaky, a floating-point epsilon in a `toBe` assertion, not a real reconciliation break — found only because the full suite was run twice during this batch's own regression testing.

Out of scope and not investigated further, per §38: Lab/Radiology (P3.5), Pharmacy (P3.6), Billing/POS (P3.7), and all later phases; no clinical decision support, NEWS/EWS scoring, or workflow engine was built.

## Regression Status

| Check | Result |
|---|---|
| `prisma validate` | Schema valid |
| `prisma migrate status` | 33/33 migrations, up to date (32 baseline + 1 new: `20260831_p3_4_vital_sign_recorder_fk`) |
| TypeScript typecheck | Clean, zero errors |
| Lint | Clean, zero errors |
| Integration test suite | **46 files, 295 tests — all passed, zero failures** (289 baseline + 6 new) |
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

**Stopping per §41.** P3.5 (Lab/Radiology operational workflow), Pharmacy (P3.6), Billing/POS (P3.7), P4, and compliance/integration work are all untouched. Returning this report for review.
