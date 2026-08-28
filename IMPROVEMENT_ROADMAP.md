# IMPROVEMENT_ROADMAP.md

Derived from SYSTEM_AUDIT.md and FAKE_OR_INCOMPLETE_FUNCTIONALITY.md. Ordered within each tier per Audit.md §17: data loss risk > security > clinical integrity > financial integrity > inventory integrity > broken workflows > authorization > performance > UX > new features. This is a roadmap, not an implementation — nothing here has been built yet; it awaits explicit approval per Audit.md §16/§18.

---

## P0 — Critical (fix before anything else touches this codebase)

1. **Enforce branch isolation server-side on every read path**, not just the write paths that already do it. Derive the effective branch scope from `session.branchIds` inside `listInvoices`, `getInvoice`, `listAppointments`, `getPatient`, and any other list/get function found to have the same gap, rather than trusting an optional caller-supplied filter.
2. **Fix the outbox retry mechanism** so a `"failed"` event is actually retried (per its own doc comment's claim), and add a minimal admin-visible surface (even just a `/admin` list of failed events) so a silently-broken GL posting or commission accrual is discoverable instead of invisible.
3. **Exclude expired batches from FEFO allocation** in `listAvailableBatchesInternal`/`allocateFefo` — a one-line filter change with an outsized integrity payoff.
4. **Fix or genuinely remove the password-reset flow.** Either wire it end-to-end through a real delivery adapter (mirroring the honest `Null*Adapter` pattern already used for communications) with a real "Forgot password?" entry point, or explicitly document that staff-side reset is admin-only-by-design (matching the portal's own documented design) and remove the dead, half-built pieces.
5. **Resolve the cascading-delete exposure** on the Encounter-rooted clinical cluster, the Patient-rooted safety cluster (allergies/conditions/medication history), and the Journal/Invoice/Payment ledger-detail cluster — change `onDelete: Cascade` to `Restrict` (or `SetNull` where a `LoginHistory`-style pattern fits better) to match what the code's own comments already claim is true.
6. **Land the DB-level audit-log immutability** that SECURITY.md's own text already claims exists — add the `REVOKE UPDATE, DELETE` grants for the application's runtime role against `audit_log` and `clinical_access_log`.

## P1 — Must Fix (before real clinic deployment)

7. Fix the refund double-completion race — check requested amount against paid-minus-already-requested-or-authorized-refunds, not just paid-minus-completed.
8. Give POS ad-hoc product charges a real `productId` and wire them through `consumeStock`, or explicitly restrict `sourceType: "product"` charges to services-only until that's built.
9. Close the standalone-supplier-invoice AP gap — either require a PO/goods-receipt link, or post a real AP-crediting journal entry when one is created without one.
10. Add GL posting for asset purchases and inventory adjustments/write-offs; add a COGS posting at the point of sale so revenue and cost are recognized together.
11. Add server-side status guards to lab specimen reject/receive and result entry, matching the enter/verify guard pattern already used consistently everywhere else.
12. Enforce leave balance at request/approval time, not just display it.
13. Wire the sidebar's "Episodes"/"Encounters"/"Orders" links to the real encounter workspace (or remove them and route users through Patient 360/Queue as the real entry points) — this is the single highest-visibility UX defect found.
14. Wire `rescheduleAppointmentAction` and `updateProviderAction` into the UI; either wire or remove the nine dead deactivate actions.
15. Surface send failures at the point of the click in Communications (a toast reading the real return value already available), and build a minimal notification viewer for the `Notification` rows already being written.
16. Fix the report provider-filter gap across the five tabs that currently ignore it, or remove the filter control from those tabs until it's wired.
17. Write automated tests for the areas this audit independently flagged as highest-risk with zero current coverage: invoice-total calculation, payment/refund guards, RBAC boundary checks (especially branch isolation once fixed), payroll gross-to-net, and clinical finalization/amendment immutability.
18. Add the missing FK relations on actor/attribution fields, or explicitly revise DATABASE.md's stated convention if the team decides string-only is an acceptable, permanent tradeoff.

## P2 — Important (schedule soon, not blocking a first real deployment)

19. Add the missing indexes on `Invoice.issuedAt`, `Payment.receivedAt`, `Charge.createdAt`.
20. Fix the commission-accrual N+1 (batch-load applicable commission rules and existing-accrual checks once per invoice/payment instead of once per line).
21. Fix the batch-blind adjustment gap by adding a batch selector to the write-off dialog.
22. Give accounting postings their own `audit_log` entries independent of the triggering business event; build a viewer UI for `clinical_access_log`.
23. Add pagination to Reports, the Invoices list, and the Stock Ledger tab; add a lower-priority Excel/PDF export option alongside the existing CSV.
24. Add `AccountMapping.intent` as a real enum matching its own documentation; add uniqueness constraints on `User.username` and `Provider.licenseNumber`; add `updatedAt` to `Invoice`/`Charge`/`Payment`.
25. Reconcile the `VitalSign`/`ClinicalOrder` vs. `Diagnosis`/`ClinicalNote`/`Prescription` branch-column inconsistency.
26. Either wire `ProcedureCompleted` for real or correct ARCHITECTURE.md's event table and workflow diagram to stop implying it's live.
27. Add a minimal structured server-side logging layer (even just leveled console output with request context) so production issues are diagnosable without a database query.

## P3 — Enhancement

28. Build a real payslip document/view distinct from the payroll-run ledger table.
29. Introduce a materialized/cached-balance mechanism for cash position, income statement, and inventory on-hand — one shared pattern, applied to all three, ahead of the volume where the current recompute-from-history approach becomes a real bottleneck.
30. Remove the confirmed dead code (`listPatientMedicationHistory`, unused `"processing"` lab status, unused `SESSION_SECRET`, unused dashboard `branchId` param) or wire it if it turns out to be wanted after all.
31. Split the largest markup-heavy page components (`accounting/page.tsx`, `patients/[id]/page.tsx`) into subcomponents per tab for maintainability.
32. Batch the per-line `getTaxRate` lookup in invoice generation into a single load.
33. A full live, role-by-role UI/UX walkthrough (Receptionist, Doctor, Nurse, Cashier, Clinic Manager, Inventory Manager, HR Manager, Accountant) — this audit's UX findings came from a mix of live spot-checks and code review, not an exhaustive per-role session.

## P4 — Future

34. CRM/Lead management (already scoped out of the original build with a documented, deliberate rationale).
35. Live SMS/WhatsApp/email provider integration to replace the honest `Null*Adapter`s.
36. A genuinely lower-privileged runtime DB role, separate from the migration-running role, with UPDATE/DELETE revoked on audit tables at minimum and ideally scoped more broadly.
37. `PatientStatus` merged/duplicate-record handling; a distinct life-threatening allergy severity tier.
38. A DB-level cycle guard on `ChartOfAccount.parentAccountId`; a shared enum for `Room.roomType`/`Service.requiredRoomType` instead of free-text convention.
