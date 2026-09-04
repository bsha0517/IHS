# P3.2 — Patient 360 & Front-Desk Patient Journey Report

## Scope note

Unlike P3.1, p3.md contains no detailed §-by-§ specification for P3.2 — only its one-line name in §3's batch list. Per p3.md §2's own working method ("For each batch: inspect → identify concrete gaps → implement → test → verify → report → stop") and §1's general P3 objectives (workflow continuity, reducing unnecessary clicks, making existing capabilities reachable, eliminating workflow dead ends), this batch was self-scoped by directly inspecting Patient 360 and its front-desk-relevant surfaces (not the clinical tabs — those belong to P3.3+), finding concrete, verified gaps, and fixing only those. No whole-system audit was performed; no redesign; no architecture change.

## Current Workflow Reviewed

Inspected: `patients/[id]/page.tsx` (header, all tab wiring), `billing-tabs.tsx` (Packages/Invoices/Payments/Statement), `insurance-tabs.tsx`, `timeline.tsx`, `portal-access-card.tsx`, `patient-status-control.tsx`, the patient list (`patients/page.tsx`), registration (`registration-form.tsx`, already touched in P3.1), and `patient-picker.tsx` (the shared search combobox). Also inspected `/pos/page.tsx` for its existing `?patientId=` pre-selection support and `new-appointment-dialog.tsx` for its `defaultPatientId`/`defaultPatientLabel` props.

What already existed and worked correctly: real per-tab data (no fake figures anywhere), a working duplicate-detection flow (P3.1), branch-scoped patient visibility (P0/P2), a genuinely reconciled billing statement with running balance, a working insurance coverage/prior-authorization flow, and a working patient-portal account management card.

## Problems Found

1. **`NewAppointmentDialog` already had `defaultPatientId`/`defaultPatientLabel` props with zero callers anywhere in the app** (confirmed by a repo-wide grep) — a receptionist viewing a patient's profile had no way to book a new appointment for them without leaving the page and re-searching for the same patient at Reception or `/appointments`.
2. **`/pos` already supported pre-selecting a patient via `?patientId=`**, but nothing on Patient 360 linked to it — seeing "this patient owes 50.00" on the Statement tab had no path to actually collect it without leaving the page and re-searching the same patient at POS.
3. **`PatientPicker`'s default-selection display would have rendered a visible bug** (`"Amina Yousef  ()"` — a trailing double space and empty parens) the moment anything actually used `defaultPatientId`/`defaultPatientLabel`, since it always assumed a real `mrn` was present. Found while implementing #1, before it ever shipped.
4. **The patient list's table rows carried a `cursor-pointer` class implying the whole row was clickable, but only the MRN/Name cells actually were** — a small, real click-target mismatch.

## Improvements Implemented

- **"Book appointment" quick action on Patient 360**: wires up the previously-dead `defaultPatientId`/`defaultPatientLabel` props — no new dialog, no new domain logic, the exact same `bookAppointment`/real-slot-availability flow P3.1 already built and verified. Defaults the branch to the patient's own registration branch. Gated on `appointment.create`, matching every other call site.
- **"Collect payment" link on the Statement tab**: shown only when `statement.outstandingBalance > 0` and the session can create invoices (`invoice.create`); links to the pre-existing `/pos?patientId=` pre-selection, not a new capability.
- **Fixed `PatientPicker`'s display formatting** so a partial default selection (name only, no MRN) renders cleanly instead of with a broken trailing `" ()"` — a small, backward-compatible fix (identical output whenever a real MRN is present, which is every other existing caller).
- **Removed the patient list's misleading `cursor-pointer`** rather than inventing a new whole-row-clickable pattern used nowhere else in the app.

## Files Changed

- `src/app/(dashboard)/patients/[id]/page.tsx` (branches/providers/services fetch gated on `appointment.create`; "Book appointment" quick action in the header)
- `src/app/(dashboard)/patients/[id]/billing-tabs.tsx` ("Collect payment" link on the Statement tab)
- `src/components/domain/patient-picker.tsx` (display-formatting fix for a partial default selection)
- `src/app/(dashboard)/patients/page.tsx` (removed misleading `cursor-pointer`)

No schema/migration changes. No new domain functions, server actions, or business logic — this batch exclusively wired up existing, already-tested capabilities into new, reachable entry points.

## Tests Added/Updated

**None**, deliberately — consistent with P3.1's own established testing philosophy ("add targeted tests only for changed business behavior... no tests for cosmetic/layout details"). Every change this batch is UI wiring of already-existing, already-tested domain functions (`bookAppointment`, the real slot-availability picker, and the pre-existing `/pos?patientId=` param) — zero new business logic was introduced. The full existing suite (273 + 5 P3.1 tests = 278) was re-run to confirm no regression; the count is unchanged from P3.1 because nothing in this batch needed a new test.

## Browser Verification

Live, against `his_dev`:

1. Registered a new patient ("Farah Ibrahim") via `/patients/new` — landed on her real Patient 360, which now showed a **"Book appointment"** button in the header (previously absent).
2. Clicked it — the dialog opened with **"Farah Ibrahim" already selected in the Patient field** (confirmed via the hidden `patientId` input holding her real id) and **Branch pre-set to "Main Branch"** (her registration branch) — proving the previously-dead props now work correctly, and that the `PatientPicker` display fix renders cleanly (no broken `" ()"`).
3. Opened her **Statement** tab with no billing activity — confirmed **no "Collect payment" link appears** when the outstanding balance is 0.00 (the negative case).
4. Created a real 50.00 charge + invoice for her directly via the actual `createAdHocCharge`/`generateInvoice` domain functions (equivalent to a receptionist entering an ad-hoc charge at POS) — reloaded the Statement tab and confirmed **"Outstanding balance: 50.00"** now shows a **"Collect payment"** button linking to exactly `/pos?patientId=<her-id>`.
5. Followed that link — landed on `/pos`, correctly showing the pre-existing "Open a cashier register" screen (no open register existed in this session) — confirming the link itself routes correctly; full patient pre-selection is exercised once a register is open, which is unrelated, already-existing POS behavior this batch didn't need to re-verify.
6. **Cleanup**: the test invoice/charge, the patient, and all dependent rows (queue/status-history/comm-message/clinical-access-log) were removed via a script using the same owner/runtime connection split established in P3.1, and `/patients` was re-verified back to "0 registered patient(s)" before finishing.

## Remaining Backlog

Identified but out of this batch's bounded scope, not logged to `BACKLOG.md` since none are new findings beyond what P3.1 already recorded there (no global branch switcher; the generic error boundary for wrong-branch/not-found `[id]` pages) — both apply equally to Patient 360 and were already captured.

## Regression Status

| Check | Result |
|---|---|
| `prisma validate` | Schema valid (unchanged from P3.1 — no schema change) |
| `prisma migrate status` | 32/32 migrations, up to date |
| TypeScript typecheck | Clean, zero errors |
| Lint | Clean, zero errors (one unused-import warning found and fixed during this batch) |
| Integration test suite | **43 files, 278 tests — all passed, zero failures** (unchanged count — no new business behavior to test) |
| Production build | Clean, all 55 routes compiled |

**Integration test database:**
```
Host:            localhost
Port:             5433 (local Docker Postgres)
Database:        his_test
Remote Supabase: NOT USED
```
No password recorded anywhere in this report.

---

**Stopping per the same P3 discipline p3.md §30 established for P3.1.** P3.3 (Doctor / Encounter Workflow) is not started. No P4 or compliance work was touched.
