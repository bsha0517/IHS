# P3.10 — HR / Payroll / Employee UX

Scope: `Employees`, `Departments`/`Designations`, `HR profiles`, `employment status`, `Attendance`, `Shifts/Schedules`, `Leave`, `Payroll`, `Payslip`, HR permissions, and the existing Finance handoff. P3.1–P3.9 are closed and were not reopened except where this batch's own live walkthrough surfaced a direct regression risk (none did — no P1–P3.9 code needed touching). Per §4, this was not a whole-system audit; unrelated findings were routed to `BACKLOG.md`, and proactive fixes were reserved for realistic payroll/financial corruption, employee-data corruption, security/branch-isolation gaps, or destructive DB behavior.

---

## Existing HR Workflows Traced

**A. Employee lifecycle.** `User` (login/access) and `Employee` (HR/payroll master) are two separate, optionally-linked models — `Employee.userId` is a real, `@unique` FK, nullable both ways (an Employee need not have a User; a User need not have an Employee). `Employee` carries `branchId` (single primary branch, no multi-branch assignment support in the schema), `departmentId` (optional FK to `Department`), a free-text `designation` string (no separate Designation catalog), `employmentType` (`full_time`/`part_time`/`contract`/`intern`), `basicSalary`, `bankDetails`, and `status` (`active`/`on_leave`/`terminated`). `createEmployee`/`updateEmployee` are branch-gated via `assertCan(..., { branchId })`.

**B. Attendance.** One `AttendanceRecord` row per (employee, date) (`@@unique([employeeId, date])`) — manual check-in/check-out, not biometric, not schedule-generated. `checkIn` creates or updates today's row; `checkOut` computes `workingMinutes`/`lateMinutes`/`earlyDepartureMinutes`/`overtimeMinutes` server-side against the employee's assigned `Shift` (a named org-wide shift catalog — `Shift` has no `branchId` column, confirmed by schema read, so shifts are legitimately org-wide, not a bug). `adjustAttendance` lets HR correct a record's check-in/out/status/notes directly.

**C. Leave.** `Employee → LeaveRequest (requested) → approveLeave/rejectLeave → approved absence`. Real configured `LeaveType` enum (`annual`/`sick`/`unpaid`/`emergency`/`other`) — no hardcoded jurisdictional rules. `LeaveBalance` (allocatedDays only; `usedDays`/`remainingDays` always derived live from approved `LeaveRequest.days`, never a stored running total) is checked at approval time for every leave type except `unpaid`, with an explicit `allowOverride` escape hatch (P1 §25, unchanged this batch). Approving a request for an employee linked to a `Provider` creates a matching `ProviderLeaveBlock` and flags any already-booked conflicting appointments to admins (P1's hardened interaction — verified still intact, live, this batch).

**D. Payroll.** `Employee → PayrollRun (draft → review → approved → paid) → PayrollRunLine`. `createPayrollRun` creates one line per active (non-`terminated`) employee in a branch, pulling `basicSalary` from `Employee` and any pending `CommissionAccrual` total for employees linked to a `Provider` (marking those accruals `included_in_payroll` so a second run can't double-count them). `updatePayrollLine` lets HR add allowances/overtime/bonus/advances/unpaid-leave-deduction/other-deductions while still `draft`/`review`; `netSalary = basicSalary + allowances + overtime + commission + bonus − advances − unpaidLeaveDeduction − otherDeductions` is always recomputed server-side (never trusted from the client — `payrollLineSchema` doesn't even accept a `netSalary` field). Once `approved`/`paid`, `updatePayrollLine` refuses further edits — the stored `netSalary` becomes a frozen historical fact.

**E. Payslip.** No separate payslip table ever existed by design — `PayrollRunLine` **is** its own payslip data source (the schema's own doc comment says so explicitly), matching how `Invoice`/`Payment` are already their own printable documents. Before this batch, nothing ever read it for that purpose — see "Payslip Review" below.

---

## Employee Model / User Relationship

Confirmed via schema and code trace: `Employee` and `User` are independent, optionally-linked one-to-one records. Before this batch, that link was **invisible everywhere** (no UI showed whether an employee had a login) and **silently destroyable** — see the first item below. This batch makes the link visible (read-only) and stops the silent-wipe bug; it does not build a way to *set* the link through the UI, per §9's "never auto-create a login unless current architecture explicitly does so" and the general instruction not to invent UI beyond what's needed — see `BACKLOG.md`'s "Employee<->User linking has no UI to create or change it" for the deferred create/change path.

---

## Concrete Problems Found

Ordered roughly by severity. All were fixed this batch except where noted as deferred to `BACKLOG.md`.

1. **`updateEmployee` silently wiped any existing `Employee.userId` link on every routine edit.** The employee form never exposed a `userId` field, so `formData.get("userId")` was always `null`; `updateEmployee`'s `data` object unconditionally set `userId: input.userId ?? null`, meaning any HR/DB-set login link vanished the moment someone corrected a typo in an employee's name. Fixed by dropping `userId` from the update payload entirely (create-time behavior is unaffected and correct as-is).

2. **No branch check on the employee's CURRENT branch in `updateEmployee`.** Only the *new* `branchId` being submitted was authorized (via `assertCan`'s `branchId` option); a caller scoped to Branch A could edit any employee actually belonging to Branch B, as long as they set `branchId: A` in the form. Fixed by adding `assertBranchAccess` against the employee's existing branch.

3. **No branch check at all in six other HR/payroll mutation paths**, all of which fetch a record by id+org and then act on it with zero branch-scope verification afterward — the exact "never trust client-provided branch IDs" gap §50 asks to inspect explicitly:
   - `updateEmployeeStatus`, `addEmployeeDocument`, `setLeaveBalance` (hr/employees.ts, hr/leave.ts)
   - `approveLeave`, `rejectLeave` (hr/leave.ts) — the requesting **employee's** branch was never checked at all, only the caller's general `leave.approve` permission
   - `movePayrollToReview`, `approvePayrollRun`, `markPayrollPaid`, `updatePayrollLine` (payroll/payroll.ts)
   All eight now call `assertBranchAccess` against the actual owning record's branch, matching the pattern `getEmployee`/`getPayrollRun` already used correctly for reads.

4. **`checkIn` trusted a client-supplied `branchId` for both authorization and the stored record**, rather than deriving it from the employee's real branch. A crafted call could record attendance for an employee against a branch they don't belong to. Fixed: `checkIn` now fetches the `Employee` row first and uses `employee.branchId` as the sole source of truth for both the permission check and the created record.

5. **No payroll duplicate-run protection at all — a real double-pay risk.** Nothing prevented two `PayrollRun` rows from being created for the same organization/branch/period; `PayrollRunLine`'s own `@@unique([payrollRunId, employeeId])` only prevents one employee appearing twice *within* one run, not two separate runs (each independently approvable and payable) for the same period. Fixed with a real DB-level `@@unique([organizationId, branchId, periodStart, periodEnd])` on `PayrollRun` (migration `20260901_p3_10_payroll_run_period_unique`, verified no existing duplicates in `his_dev`/`his_test` before applying), plus a friendly error translating the resulting constraint violation and a regression test proving a genuine concurrent-create race still results in exactly one run.

6. **`checkIn`'s shift auto-assignment silently picked the wrong shift once a second shift existed.** The roster always passed `shifts[0]?.id` (alphabetically first), regardless of which shift the employee actually works — harmless with one shift configured, silently wrong with two or more (corrupting `checkOut`'s late/overtime computation). Fixed: a real shift selector appears once more than one shift is configured; a single shift still auto-assigns.

7. **Two check-in race**: two simultaneous check-ins for the same employee/date would let Postgres's raw unique-constraint violation surface to the user. Fixed with a translated, friendly error (same discipline already used for `Encounter.appointmentId`'s own race) and a regression test proving exactly one record survives.

8. **`adjustAttendance` and `updateEmployeeStatus` existed and were fully implemented server-side but had no UI anywhere calling them** — HR had no way to correct a wrong check-in/out or mark an employee terminated/on-leave/active except by editing the general employee form (which doesn't expose status). Both wired this batch (see below).

9. **No employee search/filter UI** despite `listEmployees` already supporting branch/status filters — the page just listed everyone, paginated. Added free-text search (number/name/designation) plus branch/department/status filters.

10. **The Leave Requests table omitted reason, requested time, and approver** despite all three existing on `LeaveRequest`. Added.

None of these were financial-posting or accounting-architecture changes — the existing centralized posting service, `postPayrollApproved`/`postPayrollPaid`, and the outbox mechanism were verified unchanged and working correctly (see "Payroll" and "Browser Verification" below).

---

## Improvements Implemented

- **New HR Workspace landing page** (`/hr`) — see below.
- **Employee list**: search + branch/department/status filters (`employee-filters.tsx`), pagination preserved.
- **Employee detail**: new "Linked user" row, new "Attendance (last 30 days)" and "Payroll / payslips" sections (bulk-queried, not per-employee), a "Change status" action wired to the pre-existing `updateEmployeeStatus`.
- **Attendance**: real shift selection on check-in, a wired "Adjust" dialog on History rows, friendly duplicate/race error, branch/inactive-employee guards.
- **Leave**: Reason/Requested/Decided-by columns; branch-scoped approval/rejection.
- **Payroll**: DB-level duplicate-run protection with a friendly error; branch isolation on every mutating action; a "Payslip" link per line on the run detail page and on the employee detail page.
- **Payslip**: new, reachable, printable output — see next section.

---

## Employee Workspace

**Employee list** (`/employees`): number, name, designation, branch, department, employment type, status, edit action — all real fields, no invented ones. New filters: free-text search (number/name/designation, case-insensitive `contains`) plus branch/department/status dropdowns, all as GET query params (same pattern P3.8's `LedgerFilters` established), pagination preserved (`EMPLOYEE_LIST_PAGE_SIZE = 50`, unchanged from P2).

**Employee detail** (`/employees/[id]`): Details (branch, department, manager, employment type, joining date, **basic salary**, provider-profile link, **system login link** [new], status), Leave balances, Attendance (last 30 days, new), Payroll/payslips (new), Documents. The whole page — and every section on it, including compensation — is gated on `payroll.view` at the route level (`if (!can(session, "payroll.view")) redirect(...)`), so there is no code path where compensation is shown to a session that can see the Employee record but not its salary (see "Security / Compensation Access" below for why this is structurally guaranteed, not just page-level).

---

## Departments / Designations

`Department` (branch-scoped, `name`/`code`/`status: active|inactive`) is a real model with a fully-implemented domain layer (`listDepartments`/`createDepartment`/`updateDepartment`), but **no page anywhere calls `createDepartment`/`updateDepartment`** — confirmed by a full route search. This is consistent with current intent, not an oversight this batch should paper over: `department.manage` is granted to no operational role in `prisma/seed.ts` (even HR Manager only holds `department.view`) — only Super Admin/Org Admin can manage departments today, and that pairs it with `branch.manage`/`settings.edit` as Admin/Settings-shaped functionality, explicitly out of this batch's scope per the stop condition. The Employee create/edit form's department picker correctly shows existing departments read-only. Documented in `BACKLOG.md` as a future Admin/Settings item, not built here.

`Designation` has no separate catalog model — it's a free-text string on `Employee`, matching §11's "use actual schema, no org-chart modeling."

---

## Attendance

**Model**: one `AttendanceRecord` row per (employee, date), manual check-in/check-out with server-computed `workingMinutes`/`lateMinutes`/`earlyDepartureMinutes`/`overtimeMinutes` against an assigned `Shift`'s `HH:MM` times — not biometric, not schedule-generated.

**Duplicate protection**: enforced at the DB level (`@@unique([employeeId, date])`); the domain layer now also translates the resulting P2002 into `"This employee has already checked in today."` instead of a raw Postgres message.

**Concurrency**: verified with a real `Promise.allSettled` race in the new test suite — two simultaneous check-in calls for the same employee/date always leave exactly one `AttendanceRecord`, with the loser receiving the same friendly message, never a raw constraint error.

**Branch behavior**: `checkIn` now derives `branchId` from the employee's own record (never a client-supplied value); `checkOut`/`adjustAttendance` now verify the record's branch is in the caller's authorized scope (previously absent — see Concrete Problems #3/#4).

---

## Leave

**Lifecycle**: `requested → approved | rejected` (or `cancelled`, not currently exercised by any UI action). `requestLeave` computes `days` server-side; `approveLeave` checks the employee's `LeaveBalance` entitlement (except `unpaid`) with a row-locked, transaction-safe check against concurrent approvals of the same balance, and an explicit `allowOverride` escape hatch for an authorized override — unchanged P1 §25 behavior, re-verified this batch.

**Approval separation**: `leave.request` and `leave.approve` are separate permissions; only HR Manager and Clinic Manager hold `leave.approve` in the seeded roles, and neither Doctor/Nurse/Receptionist/Cashier/Pharmacist holds it. Branch-scoped approval was **entirely absent before this batch** (Concrete Problems #3) — fixed: `approveLeave`/`rejectLeave` now verify the requesting employee's branch is in the approver's authorized scope, tested live via a `ForbiddenError` case.

**Provider-availability interaction**: re-verified live this batch, unchanged from P1 — approving a leave request for an employee linked to a `Provider` creates a matching `ProviderLeaveBlock` spanning the leave's dates and flags any already-booked conflicting appointments to Super Admin/Org Admin. Confirmed via a new automated test (`ProviderLeaveBlock` created, dates match) and live in the browser walkthrough (employee record fields verified, though this walkthrough's fixture employee was not itself Provider-linked — the automated test is the one exercising the Provider path directly, since creating a real clinical Provider fixture live would have touched unrelated clinical scheduling data unnecessarily).

**Leave/attendance consistency**: approved leave flips `Employee.status` to `on_leave` but does **not** create or mark an `AttendanceRecord` — confirmed both by code trace and live in this batch's own walkthrough (approving leave for an employee who had already checked in that day left their attendance record's status untouched at `present`). This means an employee on approved leave silently disappears from `/attendance`'s "Today's Roster" (which only lists `status: active` employees) rather than showing as "on leave." Per §25's explicit "do not build automatic attendance generation unless already supported," this was **not** built this batch — documented in `BACKLOG.md` with two candidate fixes for a future batch.

**Overlapping leave**: not prevented server-side — two overlapping requests for the same employee can both be approved independently, gated only by the balance check. Per §23, documented rather than fixed (no corruption risk — see `BACKLOG.md`).

**Balances**: `LeaveBalance` (allocated only) exists and is surfaced on the employee detail page and the Leave page's Balances tab; `usedDays`/`remainingDays` always derived live from approved `LeaveRequest.days`, never stored.

---

## Payroll

**Actual model**: `PayrollRun` (`draft → review → approved → paid`, real enum, no invented states) with one `PayrollRunLine` per included employee. `paidVia` (a `PaymentMethod`) plus `approvedBy`/`approvedAt`/`paidAt` are the real approval/payment record — there is no separate `PayrollPayment` table, and the UI never claims "Paid" without this real transition having occurred (`markPayrollPaid` is the only path that sets it, and only from `approved`).

**Calculation behavior**: `createPayrollRun` pulls `basicSalary` from `Employee` and any pending `CommissionAccrual` for Provider-linked employees (marking them `included_in_payroll`, closing off double-counting on a later run) — this **is** the existing doctor-commission architecture (`payroll/commissions.ts`), consumed, never duplicated. `updatePayrollLine` recomputes `netSalary` server-side from the spec's own formula; the client-facing schema doesn't even accept a `netSalary` field, so there is no path for a submitted total to be trusted.

**Status lifecycle**: real enum only; UI actions (`Move to review`/`Approve run`/`Mark paid`) only appear when valid per the current status, matching the domain layer's own guards.

**Duplicate/concurrency protection**: fixed this batch — see Concrete Problems #5. Verified with both a same-request-twice test and a genuine `Promise.allSettled` concurrent-create race (exactly one run survives, the loser gets the friendly message, confirmed via a direct DB count).

**Accounting handoff**: already fully built (P1 §32/§33), re-verified unchanged this batch — `approvePayrollRun`/`markPayrollPaid` write their status change and a `PayrollApproved`/`PayrollPaid` outbox event in one transaction, dispatched through the same outbox mechanism every other financial event uses. The registered handlers call `postPayrollApproved` (Dr Salary Expense / Cr Payroll Payable) and `postPayrollPaid` (Dr Payroll Payable / Cr the resolved `paidVia` tender account) via the central posting service — no direct `Journal` row creation anywhere in the HR/payroll domain. Confirmed live in the browser walkthrough: after Approve + Mark Paid, both journals existed with exactly the traced Dr/Cr lines, debits equal to credits.

---

## Payslip Review

**Case B — payroll existed, payslip output was missing.** Fully traced before writing anything: `PayrollRun`/`PayrollRunLine` already had a complete, correct, server-authoritative data model — the schema's own doc comment on `PayrollRunLine` states it explicitly ("Also serves as the payslip's data source — no separate payslip table"). Nothing in the codebase ever read it for that purpose; there was no payslip route, component, or link anywhere.

**Implemented**: `getPayrollLinePayslip` (payroll/payroll.ts) — a permission-gated, branch-checked read of one `PayrollRunLine` joined to its `PayrollRun` and the employee's `branch`/`department` — and a new printable page at `/payslips/[id]/print` (`[id]` = the `PayrollRunLine` id), deliberately outside the `(dashboard)` route group, matching every other printable document in this codebase (prescriptions/lab/radiology/invoice/payment receipt).

**Data source and historical integrity (§43)**: every figure on the payslip comes straight from the stored `PayrollRunLine` row — organization display name (via `getOrganizationIdentity`), employee name/number/designation, branch/department, payroll period, basic salary, allowances, overtime, commission, bonus, itemized deductions (advances/unpaid-leave/other), computed gross pay, stored net pay, and payroll/payment status. Because `updatePayrollLine` already refuses edits once a run is `approved`/`paid` (pre-existing P1 behavior), a finalized payslip is a genuinely frozen historical fact, not something that could drift if `Employee.basicSalary` changes later — verified with a regression test that approves a run, confirms a further edit attempt is rejected, and re-reads the payslip to confirm it's unchanged. A still-`draft`/`review` payslip legitimately reflects current in-progress figures; the page shows an explicit "DRAFT — not yet finalized" banner in that case (confirmed live).

**Print access (§41/§49)**: gated on `payroll.view` alone — the exact same permission that already gates seeing this employee's compensation anywhere else in the app — never `settings.view`, reusing the narrow `getOrganizationIdentity` helper already established for prescriptions/lab/radiology/invoices/payment receipts. Verified live: the HR Manager test session (which holds `payroll.view` but not `settings.view`) could open and would be able to print every payslip without incident.

**Employee self-service (§42)**: not built. No employee self-service login/portal concept exists in this codebase at all (confirmed by code trace); HR/Admin print/download through the operational workflow (`/payroll/[id]` and the employee detail page each carry a "Payslip" link per line). Documented as future work in `BACKLOG.md` with a concrete design sketch (a `resourceOwnerId`-gated read scoped to `session.user.id === employee.userId`).

---

## Security / Compensation Access

Reviewed seeded roles directly (`prisma/seed.ts`): `payroll.view` is held by **HR Manager** and **Clinic Manager** only — no clinical, front-desk, pharmacy, or inventory role holds it. Critically, `payroll.view` is also the **same** permission that gates seeing an `Employee` record at all (`listEmployees`/`getEmployee` both call `assertCan(session, "payroll.view")`) — there is no code path in this app where a session can see an Employee record without also being able to see that employee's compensation, so §29/§49's "an employee viewer must not automatically see salary just because they can view an Employee" is structurally satisfied by construction, not by an extra per-field check that could be forgotten. This was true before this batch and remains true after it; the new payslip read reuses the exact same `payroll.view` gate for the same reason.

Confirmed live and by automated test: a session holding no HR/payroll permission at all (a `patient.view`-only "Receptionist" test session) is rejected with `ForbiddenError` when attempting `getPayrollLinePayslip`, matching the same denial every other HR/payroll read already produces for such a session.

HR Manager's seeded permission set was reviewed and found already correctly narrow — it does **not** hold `inventory.adjust`, `prescription.dispense`, `accounting.post`, or any clinical-record-edit permission, per §48's "HR users should not automatically receive clinical editing / pharmacy / inventory / accounting configuration just to operate HR." No permission changes were needed this batch.

---

## Branch Scoping

Explicitly inspected every branch-sensitive HR/payroll write path per §50 and found — then fixed — eight previously-unguarded mutation functions (Concrete Problems #2–#4). All now verified with live `ForbiddenError` assertions in the automated test suite: employee update/status/document-add, attendance check-in/check-out/adjust, leave approve/reject, and every payroll lifecycle transition (move-to-review/approve/mark-paid/update-line). `Shift` and `AccountingPeriod`-style org-wide models were confirmed to have no `branchId` column in the schema — legitimately org-wide by design, not a gap to force-fit branch scoping onto.

---

## Performance

No per-employee queries were added. The new HR Workspace summary (`getHrWorkspaceSummary`) uses six bounded queries total regardless of employee count (`count`/`groupBy`/small `take: 5` lists), run in parallel via `Promise.all` — not one query per employee. The new employee-detail sections (Attendance last-30-days, Payroll/payslips) are each a single bounded query per section, appropriate for a single-employee detail page. Existing `Employee`/`PayrollRun` list pagination was preserved unchanged. No caching/Redis was introduced.

---

## Files Changed

**Schema/migration**
- `prisma/schema.prisma` — `PayrollRun` gained `@@unique([organizationId, branchId, periodStart, periodEnd])`
- `prisma/migrations/20260901_p3_10_payroll_run_period_unique/migration.sql` — new, applied to both `his_dev` and `his_test`

**Domain**
- `src/lib/domains/hr/employees.ts` — branch checks, `userId`-preservation fix, `user` include, search/department filters
- `src/lib/domains/hr/attendance.ts` — employee-derived branch, terminated-employee guard, race-safe friendly error, branch checks on checkOut/adjust
- `src/lib/domains/hr/leave.ts` — branch-scoped approve/reject/setLeaveBalance, `decidedByUser` include
- `src/lib/domains/hr/workspace.ts` — new, HR Workspace summary
- `src/lib/domains/payroll/payroll.ts` — branch checks on every mutating action, duplicate-run guard + friendly error, period-order validation, `getPayrollLinePayslip`, `listPayrollLinesForEmployee`

**UI**
- `src/app/(dashboard)/hr/page.tsx` — new HR Workspace landing page
- `src/app/(dashboard)/employees/page.tsx`, `employee-filters.tsx` (new), `actions.ts`, `[id]/page.tsx`, `[id]/status-dialog.tsx` (new)
- `src/app/(dashboard)/attendance/page.tsx`, `roster-actions.tsx`, `adjust-dialog.tsx` (new)
- `src/app/(dashboard)/leave/page.tsx`
- `src/app/(dashboard)/payroll/[id]/page.tsx`
- `src/app/payslips/[id]/print/page.tsx` — new
- `src/components/layout/nav-config.ts` — new "HR Workspace" entry

**Tests**
- `test/integration/p3-10-hr-payroll-employee-ux.test.ts` — new, 12 tests
- `test/integration/payroll-lifecycle-integrity.test.ts` — fixed a pre-existing test helper that hardcoded the same period across every call, which the new `PayrollRun` uniqueness constraint correctly rejected; each call now gets its own distinct period, no assertions changed or weakened

**Docs**
- `BACKLOG.md` — 6 new entries (see below)

No P1–P3.9 domain/UI files needed changes beyond the one pre-existing test fixture collision above.

---

## Tests

**New**: 12 (`test/integration/p3-10-hr-payroll-employee-ux.test.ts`), covering: employee branch isolation + userId preservation, employee status lifecycle (active→on_leave→terminated→active, no delete), employee search, attendance branch-derivation + terminated-employee rejection, duplicate/concurrent check-in protection, checkOut/adjustAttendance branch checks, branch-scoped leave approval/rejection, provider-availability interaction, duplicate/concurrent payroll-run protection, terminated-employee exclusion from payroll + full branch isolation across the payroll lifecycle + accounting handoff verification, and payslip historical-snapshot integrity + permission/branch gating.

**Fixed** (not new, not weakened): 1 pre-existing test file (`payroll-lifecycle-integrity.test.ts`) whose helper collided with the new uniqueness constraint — corrected to generate distinct periods per call; all 8 of its original assertions unchanged.

**Total**: 52 test files, **362 tests, 362/362 passing** (350 baseline + 12 new).

---

## Browser Verification

Ran against `his_dev` with a temporary HR Manager fixture user + two fixture employees + two fixture leave requests (created via a temporary setup script, fully removed via a matching cleanup script afterward — confirmed via `git status --porcelain scripts/` showing only the pre-existing untracked `scripts/db/` files remaining).

1. Logged in as the HR Manager fixture — dashboard loaded cleanly.
2. `/hr` (new): active-employee count, checked-in-today, pending-leave count, current-payroll-run status, and both list sections all rendered correct live data.
3. `/employees`: list, new search/branch/department/status filters, and pagination controls all rendered; opened an employee's detail page — Details (including basic salary, gated by the page's own `payroll.view` requirement), new "System login: Not linked" row, Attendance/Payroll sections, Documents all correct.
4. "Change status" dialog opened and rendered correctly (not submitted, to preserve the fixture for later steps).
5. `/attendance`: checked in a fixture employee — record appeared with a live-computed check-in time and "present" status; History tab showed the new "Adjust" action, dialog opened pre-filled correctly.
6. `/leave`: submitted-via-fixture requests showed Reason/Requested/Decided-by columns correctly; approved one (status flipped to `approved`, "Decided by" showed the actor); rejected the other with a reason (shown inline under the status badge).
7. `/payroll`: created a new run (2 employees, correct total net); attempting a second run for the identical branch+period surfaced the exact friendly error `"A payroll run already exists for this branch and period. Open the existing run instead of creating a new one."` and created zero extra rows (confirmed via direct DB query).
8. Ran the run through Move to review → Approve → Mark paid (bank); status transitioned correctly at each step.
9. Verified via direct DB query that both accounting journals posted with the exact traced Dr/Cr lines (Salary Expense/Payroll Payable on approval; Payroll Payable/Bank on payment), debits equal to credits.
10. Opened both payslips: the draft-state payslip showed the "DRAFT — not yet finalized" banner; after Mark Paid, the same payslip showed "Paid / Bank / 01 Sept 2026" with no draft banner — confirmed the historical-snapshot behavior live, not just via the automated test.
11. Confirmed no application chrome (sidebar/topbar) on the payslip print page, matching every other printable document.

Security/branch-isolation/concurrency assertions (§56 steps 28–31) were verified via the automated `ForbiddenError`/`Promise.allSettled` tests described above rather than re-driven manually in the browser — the spec's own §56 phrasing designates the concurrency items (30/31) as automated-test verifications, and the unauthorized-read/cross-branch items (28/29) are covered exhaustively (every mutating HR/payroll path, not just a sample) by the same suite.

---

## Remaining HR / Payroll Backlog

Recorded in `BACKLOG.md`, six new entries this batch:
1. Approved leave is not reflected on the Attendance roster or any "on leave today" reporting (Low).
2. Overlapping leave requests are not prevented server-side (Low).
3. Employee<->User linking has no UI to create or change it — only to see it (Low).
4. Department management has no UI — belongs to a future Admin/Settings batch (Low).
5. Employee self-service (own payslip/leave/attendance) does not exist — explicitly deferred per §42 (Low, by design for V1).
6. Payroll/HR core is jurisdiction-neutral by construction but has no `CountryProfile`/adapter scaffold yet (Informational, per §57).

---

## Regression Status

- **Prisma validate**: clean (`his_dev`)
- **Migration status**: clean, 34/34 migrations applied on both `his_dev` and `his_test`, no pending migrations
- **TypeScript**: clean (`tsc --noEmit`)
- **Lint**: clean (`eslint`, confirmed via direct exit-code check)
- **Integration tests**: **52 files, 362/362 passing**
  - Host: `localhost`
  - Port: `5433`
  - Database: `his_test`
  - Remote Supabase: **NOT USED**
- **Production build**: clean (`next build`), all 63 routes generated including the two new ones (`/hr`, `/payslips/[id]/print`)

Per §60: stopping here. Not beginning P3.11, Notifications/Tasks, Admin/Settings, P4, or any country-specific labor/payroll regulation work. Awaiting review and explicit instruction to continue.
