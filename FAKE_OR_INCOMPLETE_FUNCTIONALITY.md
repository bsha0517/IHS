# FAKE_OR_INCOMPLETE_FUNCTIONALITY.md

Produced by a full read-only audit against Audit.md §3. Every item below was verified by opening the actual file(s) cited — not inferred from route/component/model names. Items are grouped by severity: how likely each is to mislead clinic staff into believing something worked when it silently didn't.

**What this document is not**: a list of missing features. Audit.md §3 asks specifically for *fake* functionality — placeholders, dead handlers, hardcoded data, non-persisting forms. The good news, stated up front: **no hardcoded dashboard statistics, no mock data arrays standing in for real queries, no fake charts, and no forms that silently fail to persist were found anywhere in the codebase.** Every number on every dashboard and report traces to a real Prisma aggregate. The problems here are narrower and more specific: real backend features with no way to reach them from the UI, and features that appear to succeed but don't actually deliver anything.

---

## Critical

### 1. Password reset is both unreachable and non-functional
- `src/lib/auth/service.ts:116-118` — `requestPasswordReset()` does `console.log(`[password-reset] token for ${email}: ${token}`)`. No email/SMS is ever sent to the user.
- `src/app/login/actions.ts:44` — `requestPasswordResetAction` is defined but never imported anywhere in the app.
- `src/app/login/login-form.tsx` / `src/app/login/page.tsx` — no "Forgot password?" link exists at all.
- **Effect**: a locked-out or forgetful staff member has zero self-service recovery path, staff-side. (The patient portal shares this design — portal password reset is staff-relayed only, which is a documented, deliberate scope cut, not a bug — see PROJECT_STATUS.md Known Issues.)
- Honestly flagged in-code: `src/lib/auth/service.ts:116` carries the codebase's only real `TODO` comment: `TODO(Phase 12): route through the communications adapter`.

## High

### 2. Notifications are write-only — nothing ever reads them
- `src/lib/platform/event-handlers.ts:205,234,257` creates real `Notification` rows for lab-result-ready, imaging-result-ready, and patient-waiting events.
- Grep across `src/app` confirms `db.notification.findMany`/`.count` is **never called** in application code, and `src/components/layout/topbar.tsx` has no bell icon, badge, or `/notifications` route.
- **Effect**: a doctor is never actually alerted that a lab result is ready or a patient is waiting, despite the system doing the work to say so. The data exists; no human ever sees it.

### 3. Communications never deliver anything, and failure is invisible at the point of action
- `src/lib/domains/communications/adapters/{email,sms,whatsapp}-adapter.ts` are `Null*Adapter`s that always return `{status: "failed"}` — honestly recorded in `CommMessage.status` and shown on the History tab.
- But `src/app/(dashboard)/communications/send-buttons.tsx:29-34` ignores the action's return value — no toast/error appears when staff click "Send reminder." They'd have to separately open the History tab to discover it failed.
- **Effect**: in production today, zero appointment reminders, payment reminders, or birthday messages are ever actually delivered, and the person who clicked "Send" has no immediate indication of that.

### 4. Fully-built actions with no UI entry point (dead code, not dead intent)
Each of the following is a real, working, permission-gated server action with no button/dialog/link anywhere that calls it:
- `rescheduleAppointmentAction` (`src/app/(dashboard)/appointments/actions.ts:50-68`) — staff must cancel and rebook instead of rescheduling; only a `rescheduled` status *badge color* exists in the UI.
- `updateProviderAction` (`src/app/(dashboard)/providers/actions.ts:52-75`) — providers can be created but never edited.
- `deactivateCommissionRuleAction`, `deactivateImagingServiceAction`, `deactivateInsurancePlanAction`/`deactivatePayorAction`/`deactivatePolicyAction`, `deactivateLabPanelAction`/`deactivateLabTestAction`, `deactivateTemplateAction` — nine catalog-management "retire this record" actions across commissions, radiology, payors, laboratory, and communications, none wired to any button. Staff can create these records but never retire them in-app.
- `adjustAttendanceAction` (`src/app/(dashboard)/attendance/actions.ts:48`), `updateAssetStatusAction` (`src/app/(dashboard)/assets/actions.ts:65`) — same pattern.

### 5. Primary clinical nav links lead to placeholder dead ends
- `src/components/layout/nav-config.ts:76-78` — the sidebar's "Episodes," "Encounters," and "Orders" items (permission-gated to `encounter.view`, meaning Doctor and Nurse roles see them) point to `/episodes`, `/encounters`, `/orders`.
- Verified live in-browser: all three render the literal text **"Scheduled in a later build phase — see PROJECT_STATUS.md."**
- The *real* encounter workspace exists and is fully functional — but only at `/encounters/[id]`, reached exclusively via Patient 360 or the Queue's "Start encounter" action, never via these top-level nav links.
- **Effect**: a Doctor clicking their own primary "Encounters" nav item — the single most central clinical workflow in the system — hits a dead end. This is a genuine, confusing, easily-hit navigation defect, not a deep edge case.

### 6. Report provider filter is silently ignored on 5 of 7 tabs
- `src/app/(dashboard)/reports/page.tsx` shows one shared Branch/Provider filter above all seven tabs (Practice, Clinical, Financial, Revenue-Cycle, Inventory, HR, Assets).
- `filters.providerId` is only actually applied in `reports/practice.ts` and `reports/clinical.ts`. It is silently ignored in `financial.ts`, `revenue-cycle.ts`, `inventory.ts`, `hr.ts`, and `assets.ts`.
- **Effect**: a user filters by provider, views Financial or Revenue-Cycle, and sees unfiltered org-wide totals with no indication the filter didn't apply — a genuinely misleading report, not a missing feature.

## Medium

### 7. Reports: no pagination, CSV-only export
- All seven report tabs render full unbounded result sets with no page controls — fine today, will not stay fine.
- The single export route (`src/app/api/reports/export/route.ts`) is real and correct, but CSV-only — no Excel or PDF anywhere in the codebase (grep for xlsx/pdf/jspdf/exceljs across `src/` returns zero hits), narrower than "CSV/Excel/PDF" implies.

### 8. Invoices list and Stock Ledger: hard-capped with no way to reach older records
- `src/app/(dashboard)/invoices/page.tsx` shows the most recent 100 invoices (`take: 100` in `listInvoices`) with **no pagination UI, no date filter, no search** — every invoice beyond the most recent 100 is permanently unreachable through this screen.
- `stock.ts:124-135` `listLedgerEntries` (`take: 200`) has the identical gap in the Inventory module's Ledger tab.
- Not a database-scale risk (both are hard-capped queries), but a real, present-day usability gap: this doesn't need 1,000,000 invoices to bite, just more than 100.

### 9. Dashboard's branch filter is dead
- `getManagementDashboard`/`getReceptionDashboard`/`getFinanceDashboard` (`src/lib/domains/analytics/dashboards.ts`) all accept a `branchId` filter parameter — `src/app/(dashboard)/dashboard/page.tsx` never passes it, and there's no branch selector in the dashboard UI. Harmless (defaults to org-wide) but unused capability.

### 10. `listPatientMedicationHistory` (pharmacy domain) is dead code
- Exported from `src/lib/domains/pharmacy/dispensing.ts:195-201` with zero callers anywhere in `src/`. The underlying data *is* correctly surfaced to the EMR, just via a different query path (`patients/service.ts`'s `getPatient`) — so this is orphaned code, not a real data gap.

### 11. Lab result "processing" status is modeled but never set
- `LabOrderTest.status` includes a `"processing"` enum value and the result-entry UI gates on it (`laboratory/orders/[id]/page.tsx:158`) — but no service function anywhere in the codebase ever actually transitions a line into that state. It exists only as an unused intermediate step.

## Low

### 12. `SESSION_SECRET` environment variable is validated but never consumed
- Required and Zod-validated at boot (`src/lib/env.ts`) but session/reset tokens are plain `crypto.randomBytes(32)` hashed with SHA-256 for DB lookup — no HMAC signing anywhere uses this secret. Not a vulnerability (opaque random tokens verified against a DB don't need signing), just dead configuration that implies a security property the code doesn't actually use.

---

## What was checked and found genuinely real (for balance)

- **Every dashboard and report figure** — traced to a live Prisma `count`/`aggregate`/`groupBy`, correctly scoped by organization/branch/date. No hardcoded numbers found anywhere.
- **Print views** — prescription, invoice, lab report, and radiology report print pages all render genuine per-record data pulled from the database. (Two agents initially disagreed on whether the lab/radiology report links were broken; verified directly — they work. Both routes live outside the `(dashboard)` route group, at `src/app/laboratory/orders/[id]/report/page.tsx` and `src/app/radiology/orders/[id]/report/page.tsx`, and Next.js route groups don't add a URL segment, so the order-detail pages' links to them resolve correctly.)
- **Public booking** and **patient portal** — both fully functional, real slot computation, real DB-transaction-safe booking, correctly scoped/gated data.
- **Settings** — only two settings exist in the whole app (`pharmacy_enabled`, `portal_clinical_release_enabled`), and both genuinely gate real behavior. No orphaned settings found.
- **CRM (Leads)** — confirmed MISSING, but handled honestly: the nav item routes to a real "Coming Soon" component, not a broken link or fake data.
