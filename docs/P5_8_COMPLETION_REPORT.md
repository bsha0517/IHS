# P5.8 — Customer Implementation Workspace & Go-Live Management

## Status

**Complete.** Inspected every existing capability listed in the phase brief before writing any code (onboarding checklist, PilotUat, support tickets, go-live blockers/approval, financial readiness, module entitlements, Country Packs, commercial audit, `implementationOwner`) and confirmed the RLS/grant model. Implemented only the genuine orchestration gap plus two small new persistence needs (training, notes) and three additive fields (target go-live date, handover). No existing onboarding/UAT/support/go-live engine was duplicated.

### Inspection

- **Existing capabilities reused**: onboarding checklist (`OnboardingChecklistItem`/`onboarding-checklist.ts`), UAT (`PilotUat`/`PilotUatScenario`/`pilot-uat.ts`), support tickets (`SupportTicket`/`support-tickets.ts`), go-live blockers/approval (`getGoLiveBlockers()`/`approveGoLive()`), financial readiness (`getFinancialReadinessGaps()`), module entitlements (`getModuleEntitlements()`), Country Packs/regulatory (P5.6/P5.7, unchanged), the aggregate organization read (`getOrganizationCommercialDetail()`), and the already-existing free-text `implementationOwner` field (P5.1) — none of these were re-implemented.
- **Genuine gaps found**: no training tracking existed anywhere (confirmed by exhaustive grep); no target/actual go-live date field existed (only the approval-event `goLiveApprovedAt`); no handover concept existed; no consolidated cross-domain blocker view existed; no per-customer or portfolio implementation view existed.

## Delivered

- **Implementation portfolio**: `/platform/implementations` — every customer implementation, filterable by lifecycle/country/owner/blocked-only, blocking count per row, reused `getGoLiveBlockers()` per organization.
- **Customer workspace**: `/platform/organizations/[id]/implementation` — one page answering who this customer is, what stage they're in, what's complete, what's blocked, and what to do next.
- **Implementation stages**: 10 stages (Provisioning → Organization Configuration → Master Data → Staff & Providers → Opening Data → Training → UAT → Go-Live Readiness → Go-Live Approval → Handover), each status derived live, never persisted separately.
- **Master-data readiness**: module-aware — a disabled module's item renders "Not applicable — module disabled," never a false gap.
- **Staff/provider readiness**: onboarding checklist `users` category plus a module-aware "clinical enabled, zero providers" check.
- **Opening-data readiness**: Chart of Accounts + opening-inventory checklist items, `getFinancialReadinessGaps()` output, and an explicit, truthful reminder about the opening-inventory/GL-journal caveat.
- **Financial readiness**: `getFinancialReadinessGaps()` reused directly, unmodified.
- **Training**: new, lightweight `ImplementationTraining` model — 11 module-gated areas, 4 statuses, no LMS features.
- **UAT integration**: `PilotUat`/`PilotUatScenario` surfaced directly; a failed cycle marks the UAT stage blocked and adds a warning (never a second blocking definition).
- **Support integration**: open/high-priority tickets surfaced, aggregated, linking to the existing ticket list.
- **Consolidated blockers**: one list composing go-live blockers (Blocking), UAT/training/ticket/provider gaps (Warning), optional-item gaps (Information) — no numeric score anywhere.
- **Next actions**: every blocker carries a specific message and, where applicable, a direct link to the existing page that resolves it.
- **Go-live readiness/approval**: `getGoLiveBlockers()`/`approveGoLive()`/`GoLiveApprovalCard` reused unchanged and embedded directly in the workspace.
- **Target/actual go-live**: new `targetGoLiveDate` field (planned); "actual" reuses the existing `goLiveApprovedAt` rather than a duplicate column.
- **Implementation ownership**: reuses the pre-existing `implementationOwner` field, edited from the workspace via the existing `updateCommercialProfile()`.
- **Notes**: new, small `ImplementationNote` freeform timeline, no PHI.
- **Handover**: new `completeHandover()` — re-checks live status and blockers server-side before recording.
- **Audit**: every new mutation (`platform.implementation_training.updated`, `platform.implementation_note.created`, `platform.implementation.target_go_live_updated`, `platform.implementation.handover_completed`) follows the existing `platform.<entity>.<verb>` convention and reuses `writeAuditLog()` unchanged.
- **Security**: every new function self-guards via `requirePlatformOperator()`; verified a no-session caller is rejected.

## Data Model

- **New tables**: `implementation_training`, `implementation_note` (both organization-scoped, RLS-covered via the existing dynamic apply-rls.sql mechanism — no per-table policy SQL required).
- **New fields**: `OrganizationCommercialProfile.targetGoLiveDate`, `.handoverCompletedAt`, `.handoverCompletedByOperatorId` — all additive/nullable.
- **Migration**: `20260926_p5_8_implementation_workspace`, generated via `prisma migrate diff` against the live dev database (the standard `migrate dev` shadow-database path was blocked by a pre-existing, unrelated P5.5-Z migration-folder ordering artifact — documented below, not touched) and applied via `prisma migrate deploy` + the project's own `npm run db:dev:setup` / `db:test:setup` (migrate + grant + RLS) to both `his_dev` and `his_test`.
- **RLS**: `npm run db:security:check` reports all 136 `public`-schema tables protected, including both new ones.

## Verification

- **P5.8 tests**: `test/integration/p5-8-implementation-workspace.test.ts` — **20/20 passing**. Covers: authorized workspace load, organization scoping (a note never leaks across orgs), no-session rejection, provisioning-stage completeness, module-aware Master Data ("Not applicable" for disabled modules, never a false gap), module-aware training seeding, training completion + audit, consolidated blockers matching `getGoLiveBlockers()` verbatim, provider-gap warning (added/removed correctly), failed-UAT warning, aggregated support-ticket warning, financial-gap absence when no relevant module is enabled, target-go-live-date persistence + audit, handover rejected before approval, full lifecycle (satisfy blockers → approve → handover → stage reads Complete), handover-cannot-repeat, notes CRUD + audit, and portfolio listing/filtering.
- **Regression**: 103/103 passing — P5.1 (29), P5.1.1 (1), P5.2 (25), P5.4 communication templates (5), P5.4 financial readiness (4), P5.6 (11), P5.7 (15), branch isolation (13).
- **Combined total**: **123/123 passing**.
- **Typecheck**: `npx tsc --noEmit` — clean.
- **Lint**: `eslint` — clean (only 6 pre-existing, unrelated warnings in P5.3 Playwright specs).
- **Build**: `npm run build` — compiles cleanly; both new routes (`/platform/implementations`, `/platform/organizations/[id]/implementation`) present.
- **Security/RLS**: `npm run db:security:check` — 136/136 tables protected.
- **Responsive 1440**: PASS — summary grid, blockers card, stage cards, training rows all render cleanly, no overflow.
- **Responsive 1024**: PASS — summary grid reflows correctly, no clipping.
- **Responsive 768**: PASS — single-column stacking, no horizontal scroll.
- **Responsive 390**: PASS — verified with live DOM measurement (`document.documentElement.scrollWidth === window.innerWidth` throughout, including the deepest scroll position), not screenshot inspection alone, since screenshots at this width visually suggested clipping near the right edge that DOM measurement disproved as a rendering/scaling artifact of the screenshot tool itself, not real overflow. The portfolio table's 8 columns scroll within their own contained `overflow-x-auto` region (the same established pattern already used by the Organizations and Tickets lists) without widening the page.

## Defects Found (and fixed before completion)

1. **Missing table grants on the two new tables** — the restricted `his_app_runtime`/`his_test` runtime role lacked SELECT/INSERT/UPDATE/DELETE on `implementation_training`/`implementation_note` after the migration (RLS alone does not grant table access). Fixed by re-running the project's own `npm run db:dev:setup` / `db:test:setup`, which applies migrations, re-grants the runtime role, and re-applies RLS — exactly the documented "safe to re-run after any new migration" workflow, not a new mechanism.
2. **`completeHandover()`/consolidated blockers incorrectly treated "Organization is already live" as a real blocker** — `getGoLiveBlockers()` correctly reports that string for its own purpose (rejecting a second go-live approval), but reusing it unfiltered made handover permanently impossible and left a nonsensical "Blocking: Organization is already live" entry on every live organization's blocker list. Fixed with a display-layer filter (`filterLifecycleSelfBlockers()`) that removes exactly that self-referential reason (and "Organization is closed") before use in handover and the consolidated blockers list — `getGoLiveBlockers()` itself was never modified. Caught by the P5.8 test suite's own full-lifecycle test, then confirmed fixed via live browser walkthrough across 36 real historical organizations (every already-live organization now correctly shows "None" blockers).

Both defects were caught before this report was written; neither reached the completion state uncorrected.

## Known Limitations

- Master Data/Organization Configuration/Staff & Providers/Opening Data stage completeness is only as current as the onboarding checklist's own manually-tracked status — by P5.2's own deliberate design, not derived from live database state. A stage can show incomplete even when the underlying configuration already exists, until an operator explicitly marks the checklist item — exactly how the existing onboarding workspace already behaves everywhere else in the app.
- The opening-inventory/GL-journal reminder is a truthful nudge, not a verified fact — nothing in this codebase can confirm a manual journal was actually posted.
- Training has no attendance tracking, certificates, exams, or LMS features — by explicit design (§17).
- The implementation portfolio computes per-organization blocking counts via the same per-org query depth the existing organization-detail page already uses; not optimized for very large portfolios.
- The pre-existing `/platform/plans` mobile table-overflow issue (flagged during the P5.7 release) remains unfixed, per this phase's own explicit instruction not to touch it.
- A separate, unrelated pre-existing issue was discovered (not fixed, out of scope): three P5.5-Z-era migration folders sharing the same date prefix (`20260925_p5_5_z_zatca_cascade_delete`/`_einvoicing`/`_nullable_fields`) sort alphabetically in an order that does not match their actual historical apply order, which breaks `prisma migrate dev`'s shadow-database replay for any future migration. This phase's own migration was generated and applied via `prisma migrate diff` + `migrate deploy` (which do not require shadow-database replay) specifically to avoid touching that historical migration history. Recorded here for visibility; a future phase should consider renaming those three folders with a corrected chronological prefix if the shadow-database workflow is needed again.

## Final Decision

**P5.8 ACCEPTED.**

All 28 acceptance criteria are met: one coherent per-customer workspace exists and composes (never duplicates) every existing P5.1–P5.7 readiness engine; stages are module-aware and never fabricate a gap for a disabled module; master-data, staff/provider, and opening-data readiness are all visible; financial readiness is reused unmodified; lightweight training tracking now exists where it was genuinely missing; UAT and support tickets are integrated by reference, not duplicated; blockers are consolidated with real severities and no numeric score; every blocker names a next action; `getGoLiveBlockers()`/`approveGoLive()` remain the sole authority, re-checked server-side; target/actual go-live dates and implementation ownership are tracked (the latter via the pre-existing field); handover can be recorded and is audited; the Platform Operator security boundary and tenant isolation are both intact and directly verified; no regulatory compliance claim was introduced; focused tests (20/20) and full regression (103/103) both pass; typecheck/lint/build are clean; the new tables are migrated and RLS-protected; and responsive behavior was verified honestly, with DOM measurement used to correct an initial screenshot-based false positive at 390px rather than either ignoring it or reporting it uncritically. Per this phase's own explicit stop condition: **not deployed to production**, **P5.9 not started**, and **no FBR/DHA/NABIDH/additional-ZATCA/payment-gateway work was implemented**.
