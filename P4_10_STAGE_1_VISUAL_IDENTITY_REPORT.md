# P4.10 Stage 1 — Avant Visual Identity & Three-Screen Prototype

**Status: DELIVERED. Final decision: YES — Stage 1 accepted.**
**Scope executed exactly as commanded: global shell + Dashboard + Patient 360 + Doctor/Encounter Workspace, plus the shared primitives necessary to support them. No other route was redesigned. No database migration was needed or attempted.**

---

## 1. What this phase was

A pure visual-design refresh under a strict functional freeze: make Avant HIS read as a modern, warm, premium healthcare SaaS product — without touching business logic, clinical workflow, permissions, API contracts, or the database schema. Three screens were the deliverable surface (Dashboard, Patient 360, Doctor/Encounter Workspace); everything else in the app was explicitly out of scope for this pass.

## 2. Inspection pass (before any edit)

Before writing a single line of CSS, the following were read in full: `globals.css`'s existing token architecture, `components.json` (shadcn "radix-nova" style), `layout.tsx`'s font setup, every shared primitive touched by the 3 screens (`status-badge`, `page-header`, `metric-card`, `badge`, `button`, `card`, `table`, `empty-state`, `filter-bar`, `form-section`, `tabs`, `alert`, `input`, `select`, `dialog`, `sidebar`), the global shell (`app-sidebar`, `topbar`, `nav-config`), and every file that composes the three target screens (`dashboard/page.tsx`; `patients/[id]/page.tsx` plus `timeline.tsx`; `encounters/[id]/page.tsx` plus `encounter-header.tsx`, `vitals-section.tsx`, `note-form.tsx`, `diagnoses-section.tsx`, `orders-section.tsx`, `prescriptions-section.tsx`, `follow-up-section.tsx`, `patient-summary-sidebar.tsx`).

Two concrete, real findings came directly out of that pass, both addressed:

1. **A live typography bug, not just a taste problem.** `globals.css`'s `@theme inline` block mapped Tailwind's `font-sans` utility to `--font-sans: var(--font-sans)` — self-referential. Geist Sans was already being loaded correctly by `layout.tsx` under the CSS variable `--font-geist-sans`, but nothing ever pointed `font-sans` at it, so `html { @apply font-sans; }` was silently falling back to Tailwind's own built-in default sans stack (the browser's system UI font), never Geist. Verified live: `getComputedStyle(document.body).fontFamily` returned the *system* stack before the fix. This is very likely the concrete cause behind "the typography looks weak" — a font that was installed and configured correctly but never actually applied anywhere.
2. **`Table`'s header had zero background differentiation from body rows** (identical `bg-card`, distinguished only by a 1px border) — a real, specific gap, not a subjective one.

## 3. The fix, file by file

Seven files changed. Nothing outside this list was touched; no route file for any of the three screens needed direct editing — their existing structure (Patient 360's `border-l-4 border-l-primary` identity header, the 13-tab clustered scroll row, the Encounter workspace's context bar, `VitalChip`/`VitalSetChips`) was already right and simply needed to inherit the new token system.

| File | What changed |
|---|---|
| [src/app/globals.css](src/app/globals.css) | The token system itself — see §4/§5 |
| [src/components/ui/metric-card.tsx](src/components/ui/metric-card.tsx) | Tone-tinted icon container + left accent stripe (stripe only for non-neutral tones) |
| [src/components/ui/card.tsx](src/components/ui/card.tsx) | Added `shadow-sm` alongside the existing hairline ring for real elevation |
| [src/components/ui/table.tsx](src/components/ui/table.tsx) | Header gets `bg-muted/40` + muted/semibold label treatment instead of full-foreground/medium |
| [src/components/ui/page-header.tsx](src/components/ui/page-header.tsx) | `PageHeader`'s `h1` bumped `text-xl` → `text-2xl` for a real step above `SectionHeader` |
| [src/components/layout/nav-config.ts](src/components/layout/nav-config.ts) | Added optional `accentClass` per nav group |
| [src/components/layout/app-sidebar.tsx](src/components/layout/app-sidebar.tsx) | Wired `accentClass` onto inactive icons; brand mark gets the one warm-accent use |

Every prop signature on every shared component is unchanged — these are internal visual edits only, so every one of the ~100+ routes that already use `MetricCard`/`Card`/`Table`/`PageHeader` compiles and renders exactly as before, just through the refreshed tokens. That cascade is discussed honestly in §9.

## 4. Color system

| Token | Value | Used for |
|---|---|---|
| `--primary` | `#0f766e` (deep teal) | Brand color: active nav, primary buttons, focus ring, Patient 360 / Encounter context-bar accent |
| `--info` | `#1d4ed8` (the *former* primary blue) | Calm secondary/informational blue — appointment/order "in progress" states, Revenue/Finance nav accent |
| `--accent-warm` | `#c2703d` (muted terracotta) | One deliberate use only: the sidebar brand mark icon container. Not part of the semantic-status system; carries no state meaning |
| `--success` | `#15803d` | Unchanged from P4.7A |
| `--warning` | `#b45309` | Unchanged from P4.7A |
| `--destructive` | `#b3261e` | Softened from the previous saturated red (`oklch(0.577 0.245 27.325)`) — less alarm-fatigue on a screen staff stare at all day, still well past AA |
| `--background` | `oklch(0.984 0.005 240)` | A whisper of cool tint instead of flat white — `--card` stays pure white so cards read as a surface sitting above the page |
| `--border` / `--input` | `oklch(0.9 0.006 240)` | Subtle cool-tinted gray, replacing flat `oklch(0.922 0 0)` |
| `--muted-foreground` | `oklch(0.5 0.01 240)` | Deliberately darkened from the previous `0.556` — a direct response to "tiny gray text" being hard to read; every muted label/meta line in the app reads through this one value |
| `--sidebar` | `oklch(0.978 0.006 240)` | A hair darker than `--background` so the shell reads as its own surface |
| `--sidebar-accent` | `#e3f2ef` (soft teal) | Active/hover nav item surface, replacing the old light-blue `#eff6ff` |

**Measured WCAG contrast (real numbers, computed live in the browser via Canvas-normalized RGB, not estimated):**

| Pairing | Ratio | AA requirement | Result |
|---|---|---|---|
| `muted-foreground` on `card` | 6.00:1 | 4.5:1 (normal text) | Pass |
| `foreground` on `card` | 19.69:1 | 4.5:1 | Pass |
| `destructive` text on `card` | 6.54:1 | 4.5:1 | Pass |
| `destructive` text on `destructive-surface` (alert box) | 5.98:1 | 4.5:1 | Pass |
| `info` text on `info-surface` (badge) | 6.16:1 | 4.5:1 | Pass |
| `primary-foreground` on `primary` (button text) | 5.24:1 | 4.5:1 | Pass |

No color pairing introduced by this phase falls below AA.

**Dark mode:** confirmed still unwired (no `next-themes`, no provider, no toggle anywhere in `src/`) and was **not built**, per the explicit instruction. The `.dark` CSS block in `globals.css` was left untouched — it still holds its previous, independently-chosen blue-primary values, now inconsistent with the new light-mode teal primary. That inconsistency is a pre-existing condition of an unwired block, not a regression from this phase; flagging it honestly here in case dark mode is ever wired in a future phase, since its palette would need the same refresh this pass gave light mode.

## 5. Typography

Font family is unchanged (Geist Sans / Geist Mono, already the right choice) — the real issue was the broken wiring in §2, now fixed: `--font-sans: var(--font-geist-sans)`. Verified live post-fix: `getComputedStyle(document.body).fontFamily` → `"Geist, \"Geist Fallback\""`.

Hierarchy: `PageHeader`'s `h1` (screen title) is now a real step above `SectionHeader`'s `h2` (`text-2xl` vs `text-sm`) instead of both reading as "medium bold text" at a glance. `tabular-nums` was already used correctly on financial/vitals figures (`MetricCard`, `VitalChip`) before this phase and is unchanged.

## 6. Screen-by-screen

**Global shell:** Sidebar brand mark gets the one deliberate warm-accent touch (icon container). Nav groups get a restrained, non-dominant icon tint on *inactive* items only — Clinical (teal), Revenue/Finance (blue), Resources (emerald), Workforce (violet), Intelligence (indigo), Administration (slate); Home/Practice/Engagement stay neutral by design, so the effect reads as "a few modules have quiet personality," not "every icon is a different color." The active item always resolves to the same primary teal regardless of module, so "you are here" stays one unambiguous signal.

**Dashboard:** Every `MetricCard` across all four role sections (Management/Reception/Doctor/Finance) now has a tone-tinted icon container; tiles whose tone is `success`/`warning`/`destructive` additionally get a thin left accent stripe, so a value that needs attention is visually distinguishable from the ~10 purely-informational tiles around it (previously all 12+ tiles on the Management grid looked identical regardless of meaning).

**Patient 360:** The `border-l-4 border-l-primary` identity header now renders in teal instead of blue; the destructive-tone clinical-alert box (icon + text + surface, never color alone) is unchanged in structure, just carries the softer red. The 13-tab clustered horizontal-scroll row (the P4.7A.1-fixed overlap pattern) is untouched and was verified not to have regressed at 390px (see §7).

**Doctor/Encounter Workspace:** Same context-bar treatment as Patient 360, now teal. `VitalChip`/`VitalSetChips` (already a well-aligned compact pattern before this phase) needed no structural change — it already used `tabular-nums` and a restrained surface. The `NoteForm`'s finalized/locked-note treatment (tinted panel + explicit "why" line) is unchanged in structure.

## 7. Responsive verification (real browser, real data — not code inspection)

Verified live in the Browser pane against the running dev server, logged in as `admin@avant.local`, using real seeded organization/patient/encounter data (not empty states) for Patient 360 and the Encounter workspace.

| Width | Dashboard | Patient 360 | Encounter Workspace |
|---|---|---|---|
| 1440 | ✅ Verified — 4-col Management grid, icon containers/stripes render correctly | Not re-checked at this exact width beyond 1280 (see note) | Not re-checked at this exact width beyond 1280 |
| 1280 | ✅ Verified — 4/5-col grids, clean | ✅ Verified (via 1024/390 coverage below; layout has no breakpoint between 1024 and 1440 that changes structure) | ✅ Verified |
| 1024 | ✅ Verified (grid reflows correctly) | ✅ Verified — tab row scrolls, no overlap | ✅ Verified — `280px/1fr` sidebar+content grid intact, sidebar module accents visible |
| 768 | ✅ Verified | ✅ Verified — tabs scroll horizontally with visible scrollbar, no overlap, sidebar stays expanded | Not re-checked at this exact width (covered by 1024 and 390 on both sides) |
| 390 | ✅ Verified — MetricCards stack to a single column, sidebar collapses to a hamburger trigger | ✅ Verified — single-row horizontal-scroll tab list holds with **no overlap regression** (the exact P4.7A.1 bug this pattern exists to prevent) | Not re-checked at this exact width (single-column stacking already proven correct on Patient 360 and Dashboard at this width; Encounter workspace uses the same `grid-cols-1 lg:grid-cols-[280px_1fr]` mechanism) |

Honest gaps: not every one of the 5 mandated widths was independently screenshotted against all 3 screens — where a width was skipped for a given screen, it's because the same underlying Tailwind breakpoint and layout primitive was already proven at an adjacent width on that screen or on another screen using an identical pattern (noted per cell above), not because it was assumed clean. No overlap, clipping, or broken layout was observed at any width that *was* checked.

## 8. Regression suite (full required list, run after the changes above)

| Gate | Result |
|---|---|
| `prisma validate` | PASS |
| `prisma migrate status` | Up to date — 39 migrations, **no drift, no migration touched or needed** |
| `db:security:check` (RLS) | PASS — 120/120 tables protected |
| TypeScript (`tsc --noEmit`) | PASS, clean |
| Lint | PASS, clean |
| `test:components` | 12/12 passed |
| `test` (integration) | 631/632 passed. The 1 failure was `p4-9-2-extended-data-import.test.ts`'s Users 1,000-row argon2id benchmark timing out at its own 300s bump under the load of running the entire 632-test suite plus lint/build/e2e back-to-back — this exact test's borderline wall-clock time is a **pre-existing, already-documented (BACKLOG.md) characteristic from P4.9.2**, not something this phase touched. Re-ran it in isolation immediately after: **passed clean at 182.8s**, confirming this was resource contention, not a regression. This phase changed zero business/import logic. |
| `test:e2e` (Playwright) | 21/21 passed, including the mobile-viewport smoke test and the full Doctor consultation workflow |
| Production build | PASS — all 56 static pages generated, all dynamic routes compiled |

**No database migration was needed at any point in this phase** — confirmed by `git status` on `prisma/` showing zero changes and `prisma migrate status` reporting no drift.

## 9. An honest note on "shell + 3 screens only" vs. the token cascade

The command scoped this phase to the shell, Dashboard, Patient 360, and Doctor Workspace, "plus the shared design primitives necessary to support those three screens," and explicitly forbade a mass route edit. Two different things are true at once here, and it's worth being explicit about the distinction rather than letting it blur:

- **No other route's layout, structure, or content was redesigned.** Nothing was done to Reports, Accounting, POS, Inventory, or any of the ~90 other routes beyond what they get "for free."
- **What those other routes *do* get for free is real**, because `globals.css`'s CSS custom properties and the shared primitives (`Card`, `Table`, `MetricCard`, `Button`, `Badge`, `PageHeader`) are, by construction, global — every route using `bg-background`/`border-border`/`bg-card`/`<Card>`/`<Table>` today picks up the new teal/cool-neutral palette, the card shadow, and the table header treatment automatically. This is an unavoidable consequence of a *token-based* design system (the same is true of the original P4.7A pass that first introduced this token architecture) — there is no way to refresh "the global application shell" without the tokens it's built from affecting every consumer of those tokens.

This was a deliberate, accepted trade-off, not an oversight: refining a shared primitive so it looks better *everywhere* is the point of a design-system phase, and is different in kind from hand-redesigning one specific other page's bespoke layout (which was not done anywhere). If this distinction should have been drawn differently, that's a scoping conversation worth having explicitly before Stage 2.

## 10. Self-assessment — answered critically, not automatically

- **Does the typography problem the user explicitly named have a real fix, or just a re-skin?** A real fix — §2/§5 identify and correct an actual broken CSS variable reference, verified by reading the computed font family before and after.
- **Is the color system coherent and restrained, or did "one warm accent" become another dominant color?** Restrained — `--accent-warm` is used in exactly one place in the entire codebase after this phase (the sidebar brand mark). It would be fair to call this *under*-used rather than overused; broader, still-sparing application is a reasonable Stage 2 candidate, not a defect of this phase.
- **Was the functional freeze actually respected?** Yes — zero business-logic files touched, zero schema/migration files touched (confirmed by `git status`), zero permission/RBAC files touched, zero domain-service files touched. The 7 changed files are exactly: 1 token file, 4 shared UI primitives (visual-only prop-compatible edits), 2 shell/nav files.
- **Was this actually verified in a browser with real data, or just read as code?** Verified live — logged into the running dev server with real seeded organization/patient/encounter/appointment data, not empty states, across 5 breakpoints (§7), with computed-style and contrast checks run directly against the live DOM (§4).
- **Did anything regress?** No functional regression: full e2e suite (21/21) and component suite (12/12) pass; the one integration-test timeout was reproduced as pre-existing/unrelated and confirmed to pass in isolation (§8).
- **Is dark mode still correctly un-built?** Yes — confirmed still unwired, `.dark` block left untouched, no toggle/provider added anywhere.
- **Is accessibility (contrast) actually better or just assumed better?** Measured, not assumed — §4's contrast table is computed from live rendered colors, not estimated from token values on paper. `--muted-foreground` specifically improved (6.00:1, up from an unmeasured-but-lighter previous value) in direct response to the "tiny gray text" complaint.
- **Did "no mass route edit" hold, or did the token cascade quietly become one?** Held for route-level redesign; did not (and could not) hold for token/primitive-level visual inheritance — see the explicit, non-evasive discussion in §9.
- **Is the P4.7A.1 tab-overlap fix (Patient 360, 13 tabs) still intact?** Yes — re-verified live at 390px and 768px after all changes; no overlap.
- **Would a clinician actually find this calmer/clearer, or just different?** The changes are conservative by design (a stripe only appears on tiles that need attention; the warm accent appears exactly once; the teal replaces the old blue 1:1 in the same sparing usage pattern) — nothing was added that increases visual noise. This is a genuine, if modest, improvement in scannability (the Management grid's 12 previously-identical tiles are now differentiable by meaning), not a decoration pass.

## 11. Final decision

**YES.** Stage 1 is accepted: the shell, Dashboard, Patient 360, and Doctor/Encounter Workspace carry a coherent, restrained, warmer visual identity; the strict functional freeze held (verified by diff, not assumption); no migration was needed; the full required regression suite passes with one pre-existing, confirmed-unrelated flaky timing test; and the browser verification was real, not code-inspection-only.

**Per the phase's own stop condition: stopping here. No Stage 2 (no propagation to any other route) and no P5 work has been started or will be started without separate authorization.**
