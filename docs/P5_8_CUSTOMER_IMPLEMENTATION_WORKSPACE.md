# P5.8 — Customer Implementation Workspace & Go-Live Management

## 1. Architecture — reused vs. added

P5.8 is an orchestration phase: it brings together the implementation journey Avant HIS already supports across P5.1–P5.7 into one coherent per-customer view (`getImplementationWorkspace()`, `src/lib/domains/commercial/implementation.ts`) and a cross-customer portfolio (`listImplementationPortfolio()`). It introduces **no second onboarding engine, no second go-live engine, no second UAT engine, and no second support-ticket system**.

| Capability | Source | Status |
|---|---|---|
| Implementation checklist | `OnboardingChecklistItem` / `onboarding-checklist.ts` | Reused directly |
| UAT | `PilotUat` / `PilotUatScenario` / `pilot-uat.ts` | Reused directly |
| Support issues | `SupportTicket` / `support-tickets.ts` | Reused directly |
| Go-live blockers | `getGoLiveBlockers()` (`organizations.ts`) | Reused directly — the one authoritative list |
| Go-live approval | `approveGoLive()` (`organizations.ts`) | Reused directly, via the existing `GoLiveApprovalCard` |
| Financial readiness | `getFinancialReadinessGaps()` (`accounting/posting-service.ts`) | Reused directly |
| Module entitlements | `getModuleEntitlements()` (`platform/entitlements.ts`) | Reused directly, drives every module-aware check |
| Country Pack / regulatory | `country-packs-shared.ts` / `regulatory.ts` (P5.7/P5.6) | Reused directly, displayed for context |
| Implementation owner | `OrganizationCommercialProfile.implementationOwner` (P5.1) | Reused directly — already existed, never a new field |
| Aggregate organization read | `getOrganizationCommercialDetail()` | Reused and extended (a handful of parallel reads added, not duplicated) |
| Training tracking | — | **Genuinely new** — `ImplementationTraining` (small, module-aware) |
| Implementation notes | — | **Genuinely new** — `ImplementationNote` (freeform timeline) |
| Target go-live date | — | **Genuinely new** — `OrganizationCommercialProfile.targetGoLiveDate` |
| Handover | — | **Genuinely new** — two additive fields + `completeHandover()` |

Only two new tables and three new columns were added, after inspection confirmed nothing existing could represent them cleanly (see the schema's own P5.8 doc comment for the full reasoning on each).

## 2. Implementation Journey

The workspace (`/platform/organizations/[id]/implementation`) presents ten implementation-management stages, in order: **Provisioning → Organization Configuration → Master Data → Staff & Providers → Opening Data → Training → UAT → Go-Live Readiness → Go-Live Approval → Handover**. These are management stages, not new clinical workflow statuses — they never touch or gate any clinical route.

## 3. Stage Derivation

Every stage status (`not_started | in_progress | blocked | ready | complete`) is **derived**, not persisted — there is no `ImplementationStage` table. Each stage composes existing signals:

- **Provisioning**: derived from whether the commercial profile, subscription, branch, admin, onboarding checklist, and go-live conditions exist (they always do together, since `provisionClinic()` creates them atomically).
- **Organization Configuration**: the onboarding checklist's own `organization`/`branches` categories.
- **Master Data**: the onboarding checklist's `operational_configuration` category, module-filtered (see §4).
- **Staff & Providers**: the onboarding checklist's `users` category, plus a module-aware provider-existence check (informational — see §4).
- **Opening Data**: the `chart_of_accounts_configured`/`opening_inventory_imported` checklist items plus `getFinancialReadinessGaps()`'s own output, with the opening-inventory/GL caveat made explicit (§7).
- **Training**: the new `ImplementationTraining` rows for this organization's currently-applicable areas.
- **UAT**: `PilotUat` cycles and their scenarios/signoff.
- **Go-Live Readiness**: `getGoLiveBlockers()` directly — the identical list `approveGoLive()` itself would reject on.
- **Go-Live Approval**: `commercialLifecycle === "live"`.
- **Handover**: `handoverCompletedAt` on the commercial profile.

## 4. Module Awareness

Every stage that has module-gated requirements respects the organization's real entitlements (`getModuleEntitlements()`), never a hardcoded "every module is mandatory" list:

- A disabled module's Master Data item renders **"Not applicable — module disabled"** (and counts as satisfied, never as an incomplete gap) rather than being silently omitted — the onboarding checklist itself never seeds a row for a disabled module's item, so this is reconstructed for display from the same catalog (`ONBOARDING_CHECKLIST_ITEMS`) the checklist already uses.
- Training areas are seeded only for currently-enabled modules (`ensureImplementationTraining()`), mirroring `ensureOnboardingChecklist()`'s own lazy, self-healing seed pattern exactly.
- The Staff & Providers check ("Doctor/Clinical module is enabled but no provider record exists yet") only fires when the `clinical` module is actually enabled.

## 5. Country Awareness

The workspace header shows the organization's Country Pack (currency/timezone/regulatory-surface pointer, reused from P5.7 unchanged) alongside its regulatory status (reused from P5.6/P5.5-Z unchanged — ZATCA capped at "sandbox/demo capability," FBR/DHA-NABIDH always "not implemented," never a compliance/certification claim). Country regulatory readiness and Avant's own operational go-live readiness remain conceptually distinct: a missing FBR/DHA integration is never treated as a go-live blocker, since no existing business rule links them — `getGoLiveBlockers()` was not changed by this phase and does not check regulatory status at all.

## 6. Training

`ImplementationTraining` (new model) tracks exactly one row per (organization, applicable area), status `not_scheduled | scheduled | completed | not_applicable`. Eleven fixed areas exist (`IMPLEMENTATION_TRAINING_AREAS` in `implementation.ts`): Reception, Doctors/Clinical, Nursing, Laboratory, Radiology, Pharmacy, Billing/POS, Inventory, Finance, HR, Administration — each gated to a module key except Administration, which always applies. This is deliberately not an LMS: no certificates, exams, quizzes, videos, or courses — just a status, an optional scheduled date, and notes, updated through a single confirmation-free dialog (training carries no safety implication the way an entitlement toggle does, so no extra confirmation step was added).

## 7. Opening Data & the Accounting Caveat

The Opening Data stage surfaces the Chart of Accounts and opening-inventory checklist items plus every unmet `AccountMapping` gap `getFinancialReadinessGaps()` reports. The known P4.6 caveat is carried forward and made explicit here: importing opening inventory creates `ProductBatch`/`StockLedgerEntry` rows through the real `receiveStock()` primitive but **never posts an accounting journal**. Once that checklist item is marked complete, the workspace shows the reminder: *"Opening inventory import creates stock records only — confirm the corresponding opening GL journal (Dr Inventory Asset / Cr Opening Balance Equity) has been posted via Accounting → Manual Journal."* This is a truthful nudge, not a verified fact — the workspace has no way to confirm a manual journal was actually posted, and never claims otherwise.

## 8. UAT

UAT is presented directly from `PilotUat`/`PilotUatScenario` (P5.2, unchanged) — cycle label, tester, pass/fail scenario counts, signoff state. No `ImplementationUat` or second UAT concept was created. A failed cycle with no later signed-off pass marks the UAT stage `blocked` and surfaces a **warning**-severity item in the consolidated blockers list — deliberately not `blocking`, since the actual go-live gate for UAT is the existing `clinic_uat_signoff` `GoLiveCondition`, which an operator marks complete once satisfied using the PilotUat data as supporting evidence. No patient-identifying field exists anywhere in UAT tracking, unchanged from P5.2.

## 9. Blockers — Consolidated, Not Duplicated

`getImplementationWorkspace()` composes one `blockers` array from every existing readiness source, tagged with a severity:

- **Blocking** — every reason `getGoLiveBlockers()` itself reports (go-live conditions, onboarding checklist required items, financial gaps, subscription/lifecycle state), verbatim. The workspace never re-derives or second-guesses this list.
- **Warning** — a failed UAT cycle, incomplete training areas, open high/critical-priority support tickets (aggregated into one line, not one row per ticket), a clinical-module-enabled-but-no-provider gap.
- **Information** — incomplete optional (non-required) onboarding items.

No numeric readiness score exists anywhere — every signal is an explicit condition with a message, never a percentage.

One filtering rule exists at the display layer only: `getGoLiveBlockers()` correctly reports "Organization is already live"/"Organization is closed" as blockers for its own purpose (rejecting a second approval attempt) — surfacing that same string as an implementation *gap* once an org is expected to already be live would be misleading, so `filterLifecycleSelfBlockers()` removes exactly those two strings before display and before the handover check. `getGoLiveBlockers()` itself is never modified.

## 10. Go-Live

The workspace embeds the existing `GoLiveApprovalCard` unchanged — there is no second "Approve" button and no second definition of readiness. `approveGoLive()` re-validates every blocker server-side regardless of what the workspace shows, exactly as before this phase.

A `targetGoLiveDate` (new, nullable `Date` on `OrganizationCommercialProfile`) is a planned date an operator sets — it is never validated against readiness and never influences `getGoLiveBlockers()`. "Actual go-live" is deliberately **not** a second new column: `goLiveApprovedAt` (P5.2, unchanged) already records exactly that moment, and the workspace's own summary reads it directly rather than duplicating it.

## 11. Handover

Once an organization is live, `completeHandover()` re-checks `commercialLifecycle === "live"` and re-runs `getGoLiveBlockers()` (filtered per §9) before recording `handoverCompletedAt`/`handoverCompletedByOperatorId` — the same "recompute server-side, never trust the UI" discipline `approveGoLive()` already established. Handover cannot be completed twice, and cannot be completed before go-live approval. No Customer Success CRM, no resource planning, no second project-tracking system was built around it.

## 12. Security

Every new/extended function self-guards via the existing, unchanged `requirePlatformOperator()` — `getImplementationWorkspace()`, `listImplementationPortfolio()`, `listImplementationOwners()` all call it directly; the mutation functions (`updateImplementationTraining`, `addImplementationNote`, `updateTargetGoLiveDate`, `completeHandover`) follow the established P5.2 pattern of taking an explicit `operatorId` resolved by their Server Action caller. Clinic sessions have no path into `/platform/*` at all — unchanged. Directly verified: a caller with no platform session cannot load the workspace (`PlatformForbiddenError`).

## 13. Tenant Isolation

Both new tables (`implementation_training`, `implementation_note`) carry a required `organizationId` and are covered by the existing, fully dynamic RLS mechanism (`prisma/db-setup/apply-rls.sql` enumerates every `public`-schema table at apply time — no per-table policy SQL was written for this phase; `npm run db:security:apply` was simply re-run after the migration). Directly verified: an organization's own implementation note never appears in another organization's workspace.

## 14. Known Limitations

- Master Data / Opening Data / Staff & Providers gap detection reuses the *existing, manually-tracked* onboarding checklist (P5.2's own deliberate design — "has the human process marked this done," not "does the database currently contain the configuration"). A genuinely live, DB-derived master-data completeness check (e.g. `db.service.count()`) was considered and rejected in favor of reuse, per this phase's own "do not create a second readiness engine" instruction — this means a checklist item can show incomplete even if the underlying data already exists, until an operator explicitly marks it, exactly as P5.2 already behaves everywhere else in the app.
- The opening-inventory/GL-journal reminder is a truthful nudge, not a verification — the workspace cannot confirm a manual journal was actually posted.
- The implementation portfolio (`/platform/implementations`) computes each row's blocking count via `getGoLiveBlockers()` per organization (the same per-org depth the existing organization-detail page already uses) — bounded by normal pagination-scale usage, not optimized for a very large portfolio.
- Training has no attendance tracking, certificates, or LMS features, by explicit design.
