# P3.1 — Reception & Appointment Workflow Report

Scope: p3.md §4-§29 only. No P3.2+ work, no audit, no architecture change, no regulatory/CRM work — per p3.md §1/§2/§30.

---

## Current Workflow Reviewed

Inspected (read, not rebuilt) before changing anything: the Reception workspace (`reception/page.tsx`), the Appointments list/calendar (`appointments/page.tsx`), appointment booking/status-transition logic (`appointments/service.ts`, `schemas.ts`, `actions.ts`, `status-actions.tsx`, `new-appointment-dialog.tsx`, `reschedule-dialog.tsx`), the provider/branch queue (`queue/page.tsx`, `appointments/queue.ts`), patient search/registration and duplicate detection (`patients/service.ts`, `patient-picker.tsx`, `registration-form.tsx`), provider schedules/leave (`providers/service.ts`), the public-booking slot-availability engine (`booking/service.ts`'s `listAvailableSlots`), Patient 360's Appointments tab, and the Prisma schema for `Appointment`/`AppointmentStatusHistory`/`QueueEntry` (including the existing `rescheduledFromId` relation).

What already existed and worked correctly, confirmed by direct inspection: the full `APPOINTMENT_TRANSITIONS` state machine (server-side authoritative, P1 §27); the DB exclusion constraints preventing double-booking (Phase 2) with `translateBookingError` already turning them into readable messages; reschedule via a new linked row (`rescheduledFromId`), never an in-place edit; cancellation requiring a reason, preserving history, never deleting; the duplicate-patient warn-not-block flow with an audited override reason; branch-scoped visibility (`getAuthorizedBranchScope`/`assertBranchAccess`, P0-01/P2 §13); a real, schedule/leave/conflict-aware slot-availability algorithm (`listAvailableSlots`) — already used by the *public* booking wizard but never by staff-facing dialogs.

## Problems Found

Concrete gaps only, each verified by reading the actual code, not assumed:

1. **No appointment detail page existed at all** (`/appointments/[id]`). `AppointmentStatusHistory` and the `rescheduledFrom`/`rescheduledTo` relations were already fetched in places but never rendered anywhere — "View Appointment History" (§8) had nowhere to go, and the reschedule chain (§14) was invisible.
2. **Reception's "Today's activity" only showed Waiting/Expected-today counts**, not the full real status breakdown §5 names (scheduled/confirmed/arrived/checked_in/waiting/in_consultation/completed/cancelled/no_show) — and even those two cards were derived from an *already status-filtered* query, so completed/cancelled/no-show appointments were invisible to the page entirely.
3. **Reception and Queue never passed `canReschedule`/`providers` to `AppointmentStatusActions`** — Reschedule was only reachable from the separate `/appointments` page, contradicting the batch's own stated goal ("primarily from one coherent workspace").
4. **No walk-in-specific entry point** — `bookAppointment` already supported `bookingSource: "walk_in"`, but nothing in the UI defaulted to it or prefilled "now."
5. **Staff appointment creation/reschedule had zero connection to real availability** — a bare `datetime-local` input, no use of the already-correct `listAvailableSlots` algorithm that the public booking wizard already had.
6. **No-show had no confirmation dialog** (Cancel did) and was offered for any scheduled/confirmed appointment regardless of whether its time had actually passed — contradicting §16's "identify appointments whose scheduled time has passed."
7. **No derived waiting-duration display anywhere** — `QueueEntry.checkedInAt` was fetched but never turned into "Waiting N min."
8. **Patient search didn't match national ID**, though the field exists and is already used for duplicate detection.
9. **The duplicate-patient dialog had no way to open an existing candidate's record** — only "Register anyway."
10. **Three different, inconsistent status badge/label mappings** existed across Reception, Appointments, and Queue (Queue had none at all).
11. **Cancel's dialog had no `DialogDescription`** (an accessibility gap, §25).
12. Branch Queue's own page had no page-level statement of which branch was active, only inside its own card.

## Improvements Implemented

- **New `/appointments/[id]` detail page**: full appointment info, a reschedule-chain banner in both directions ("Rescheduled from APT-x" / "see APT-y for the new time"), queue timestamps with derived waiting duration, and the real `AppointmentStatusHistory` timeline (status + actor + timestamp + reason) — reusing `AppointmentStatusActions`, not duplicating any transition logic.
- **Reception workspace**: real per-status counts (§5) computed from one unfiltered same-day fetch (no new query — derived in memory); the Waiting card now shows MRN, provider, service, room, and derived waiting duration; `canReschedule`/`providers`/`canCancel` now wired through so Reschedule/No-show/Cancel/History work directly from Reception.
- **Walk-in quick action**: `NewAppointmentDialog` gained a `walkIn` mode (reusing the identical `Appointment` model and `bookAppointment` function — no parallel model) that defaults `bookingSource` to `walk_in` and prefills "now," while remaining fully editable.
- **Real slot availability in both booking dialogs**: new `AvailableSlotsPicker` component, backed by a new `listStaffAvailableSlots` (thin permission/branch-checked wrapper around the existing `listAvailableSlots` — zero duplicated scheduling logic) and `listAvailableSlotsAction`. Click-to-fill, not a replacement for the real date/time field — the DB exclusion constraint stays authoritative.
- **No-show**: now gated to appointments whose start time has passed, and requires confirmation via a new dialog (mirroring Cancel's).
- **Derived waiting-duration display**: new `formatWaitingMinutes(since, until?)` in `dates.ts` — a server-rendered snapshot, never a stored/ticking value — used on Reception, Queue (both My Queue and Branch Queue), and the new detail page.
- **Patient search** now also matches national ID.
- **Duplicate-patient dialog**: each candidate now has an "Open record" link (opens in a new tab so the in-progress registration form is never lost).
- **One shared `APPOINTMENT_STATUS_LABEL`/`APPOINTMENT_STATUS_VARIANT` map** (`src/lib/utils/appointment-status.ts`) replacing three inconsistent inline copies.
- **Patient 360's Appointments tab** now links to the real detail page and shows the reschedule-chain indicator inline.
- **Accessibility**: added `DialogDescription` to the Cancel dialog (and the new No-show dialog), `aria-label`s on the reason input and History link, `role="group"`/`aria-label` on the slot picker.
- **Queue page**: both queues now show MRN, service/provider, and waiting duration; the page-level subtitle states the active branch explicitly.

No confirmation dialogs were added to Confirm/Mark arrived/Check in/Call patient/Complete — those remain single-click, per §23.

## Files Changed

New:
- `src/app/(dashboard)/appointments/[id]/page.tsx`
- `src/components/domain/available-slots-picker.tsx`
- `src/lib/utils/appointment-status.ts`
- `test/integration/p3-1-reception-workflow.test.ts`

Modified:
- `src/lib/domains/appointments/service.ts` (`listStaffAvailableSlots`; `getAppointment`/`listPatientAppointments` includes extended — `branch`, `encounter`, `rescheduledFrom`/`rescheduledTo`, `changedByUser`)
- `src/lib/domains/patients/service.ts` (search now matches `nationalId`)
- `src/lib/utils/dates.ts` (`formatWaitingMinutes`)
- `src/app/(dashboard)/appointments/actions.ts` (`listAvailableSlotsAction`)
- `src/app/(dashboard)/appointments/new-appointment-dialog.tsx`
- `src/app/(dashboard)/appointments/reschedule-dialog.tsx`
- `src/app/(dashboard)/appointments/status-actions.tsx`
- `src/app/(dashboard)/appointments/page.tsx`
- `src/app/(dashboard)/reception/page.tsx`
- `src/app/(dashboard)/queue/page.tsx`
- `src/app/(dashboard)/patients/[id]/page.tsx`
- `src/app/(dashboard)/patients/new/registration-form.tsx`
- `BACKLOG.md` (3 new deferred-item entries — see below)

No schema/migration changes.

## Tests Added/Updated

`test/integration/p3-1-reception-workflow.test.ts` — **5 new tests**, targeting only changed business behavior (no cosmetic/layout tests), run against real `his_test` data:

1. Patient search matches national ID.
2. A walk-in booking (`bookingSource: "walk_in"`) flows through the real `Appointment` model end-to-end — booked → checked in → visible in `listBranchQueue` — proving no parallel model was introduced.
3. `getAppointment` shows the reschedule chain correctly in both directions after a real reschedule, and the original lands in `rescheduled` (a terminal, non-active status).
4. `listStaffAvailableSlots` throws `ForbiddenError` for a branch the session isn't authorized for.
5. `listStaffAvailableSlots` returns no slots with no schedule configured, returns real schedule-derived slots once one exists, and correctly excludes a slot taken by a genuinely conflicting appointment.

No existing test was modified or weakened. `appointment-double-booking.test.ts` (the DB exclusion-constraint proof) was re-run as part of the full suite and passed unchanged.

## Browser Verification

Full realistic front-desk scenario, run live against `his_dev` (local Docker Postgres) as the seeded Super Admin:

1. Registered a new patient ("Amina Yousef") via `/patients/new` — duplicate check ran (no candidates, correctly, since no prior patient existed), landed on her real Patient 360.
2. Created 4 real appointments for her against a provider (seeded for this walkthrough, since `his_dev` starts with none) via the actual `bookAppointment` domain function — the same function the "Book appointment"/"Walk-in" dialogs call — to work around this specific Browser-pane environment's well-documented, pre-existing inability to reliably drive Radix `Select` components (see PROJECT_STATUS.md's many "Browser-automation note" entries from Phases 3-6; confirmed again here: `aria-expanded` toggling was observed but option content never mounted, across both native computer-tool clicks and direct trusted-key dispatch). This affected only *opening a Select dropdown*; every plain button, dialog, input, and the new slot-picker's own click-to-fill buttons worked correctly via the browser throughout.
3. Reception correctly showed **"4 appointment(s) today," 4 real Scheduled, 0 everywhere else** — confirmed real, non-fake counts.
4. Clicked **Confirm** → count moved 3 Scheduled/1 Confirmed live.
5. Clicked **Check in** → moved straight to Waiting (per the existing checkIn() design) with a real token (Q-001); the Waiting card showed MRN, provider, and **"Waiting Just now"** (later **"2 min"**, **"3 min"**, **"4 min"**, **"5 min"** as time passed across later steps) — confirming the derived, non-fake waiting-duration display.
6. Opened the new `/appointments/[id]` detail page for that appointment — confirmed the full real status-history timeline (Scheduled → Confirmed → Checked in → Waiting, each with real timestamp + "Super Admin") and the queue card's "Waited before being called: Just now."
7. **Rescheduled** a different (still-scheduled) appointment: the dialog's `AvailableSlotsPicker` showed real computed slots (08:00 through 17:30, matching the seeded 08:00-18:00 schedule); clicking "10:00" correctly filled the date/time field with the exact local value (`2026-08-31T10:00`); submitted with a reason. Confirmed: the original disappeared from the active schedule table (moved to `rescheduled`, not double-counted), a new appointment (APT-000005) appeared as Scheduled, and total count correctly became 5. Verified **both directions** of the chain live: the original's detail page showed *"This appointment was rescheduled — see APT-000005 for the new time,"* the new one showed *"Rescheduled from APT-000002 (originally 31 Aug 2026, 03:58)."*
8. **Cancelled** a third appointment — the reason field is required (button stayed disabled until filled); confirmed it moved to Cancelled and left the active schedule.
9. **Marked no-show** on the appointment whose time had already passed — confirmed the No-show button is only offered once the scheduled time has passed (not shown on the three future appointments), the new confirmation dialog appeared with the exact intended copy, and confirming moved it to No-show and out of the active table.
10. Verified **Patient 360's Appointments tab**: all 5 appointments listed with correct statuses, and the reschedule indicator (*"Rescheduled → APT-000005"*) rendered inline exactly as implemented.
11. **Unauthorized-branch behavior**: not exercised via a second live login in this single-admin-session walkthrough (impractical without provisioning a second real branch-scoped user mid-session); instead verified via the automated suite, which covers this exact case directly and extensively — the new `listStaffAvailableSlots` branch-denial test added this batch, plus the pre-existing `branch-isolation.test.ts` (13 tests covering `getAppointment`/`listAppointments` specifically) — all passing.
12. **Cleanup**: all manually-created test data (the patient, 5 appointments, their status-history/queue-entry/comm-message/clinical-access-log rows, and the walkthrough-only provider/schedule) was removed via a script using the same owner/runtime connection split this project's own test suite uses, and Reception was re-verified back to a genuine "0 appointments today" empty state before finishing.

## Remaining Reception Backlog

Logged to `BACKLOG.md`, not fixed here (out of P3.1's scope, none rose to the "fix immediately" bar of patient/clinical/financial corruption, security/privacy breach, or destructive DB behavior):

- **No global branch-switcher UI** — `session.activeBranchId` is fixed per session; multi-branch staff have no in-app way to change it mid-session.
- **Duplicate-registration override reason isn't required** before "Register anyway" proceeds — preserved as-is per this batch's explicit "preserve the warn-not-block design" instruction, but flagged as a real, small UX gap.
- **Wrong-branch/not-found appointment access falls through to the fully generic dashboard error boundary** — safe (never leaks a raw error) but not specific, consistent with every other `[id]` page in the app, not new to this batch.

## Regression Status

| Check | Result |
|---|---|
| `prisma validate` | Schema valid |
| `prisma migrate status` | 32/32 migrations, up to date (no schema change this batch) |
| TypeScript typecheck | Clean, zero errors |
| Lint | Clean, zero errors (including two real React-purity issues found and fixed during this batch — an impure `Date.now()` render-time call, and a synchronous `setState` inside an effect body) |
| Integration test suite | **43 files, 278 tests — all passed, zero failures** (273 pre-existing + 5 new P3.1 tests) |
| Production build | Clean, all 55 routes compiled (54 pre-existing + the new `/appointments/[id]`) |

**Integration test database:**
```
Host:            localhost
Port:             5433 (local Docker Postgres, not Supabase's default 5432)
Database:        his_test
Remote Supabase: NOT USED
```
No password is recorded anywhere in this report or in the test suite's own configuration (see `.env`/`.env.example`, gitignored/placeholder respectively).

---

**Stopping per §30.** P3.2 (Patient 360 & Front-Desk Patient Journey) and all later P3 batches are not started. No P4 or compliance work was touched.
