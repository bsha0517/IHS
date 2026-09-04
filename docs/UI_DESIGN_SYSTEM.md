# Avant HIS — UI Design System

How the product looks and behaves, and the shared primitives that make it
one coherent product rather than 70 independently-styled screens —
P4.7A's own deliverable.

## Design Philosophy

**Clarity before decoration.** Important information should be obvious at a
glance — a status, a balance, a critical result — never buried under visual
noise or requiring the reader to decode a color.

**Workflow before aesthetics.** Visual hierarchy exists to help staff
complete a task faster, not to look impressive. A receptionist scanning the
queue and a doctor reading a lab result have different jobs; the layout
should serve the job.

**Consistency builds trust.** The same interaction looks and behaves the
same everywhere — a page header, a status badge, an empty table, a
destructive action. A user who has learned one screen has learned them all.

**Clinical information requires hierarchy.** Critical patient information —
allergies, critical lab flags, medication mismatches — must visually stand
apart from routine administrative metadata, and never rely on color alone.

**Dense where necessary.** Financial, inventory, and operational screens
stay information-dense while remaining readable — this is enterprise
healthcare software, not a marketing site. Converting every table into a
giant card grid would make the product slower to use, not better.

**Calm interface.** Neutral, light, predominantly gray — a single brand
accent used sparingly (primary actions, active navigation, selected
states), not painted across every card and button.

**Accessible by default.** Labels, focus states, keyboard navigation, and
contrast are not an afterthought — see Accessibility below.

## Colors

Defined as CSS custom properties in `src/app/globals.css`, consumed as
Tailwind utilities via the `@theme inline` block (`bg-primary`,
`text-success`, `border-warning-border`, ...) — never a hardcoded hex value
in a component.

| Token | Purpose |
|---|---|
| `background` / `foreground` | Page background / default text |
| `card` / `card-foreground` | An ordinary card at the page's own layer |
| `elevated` / `elevated-foreground` | A surface that visibly sits above the page (sticky bars, popover-like panels) |
| `border` / `input` | Default borders and form control borders |
| `muted` / `muted-foreground` | De-emphasized backgrounds and secondary text |
| `primary` / `primary-foreground` | The one brand accent — a calm clinical blue (`#1d4ed8`) |
| `destructive` / `destructive-surface` / `destructive-border` | Danger — void, cancel, delete, critical |
| `success` / `success-surface` / `success-border` | Completed, paid, verified, active |
| `warning` / `warning-surface` / `warning-border` | Pending, partial, low stock, attention required |
| `info` / `info-surface` / `info-border` | In progress, scheduled, checked in |
| `neutral-surface` / `neutral-border` | Draft, inactive, optional — no real signal either way |
| `ring` | Focus ring — matches `primary` |

The brand color is used **sparingly**: primary buttons, active sidebar
item, selected states, focus rings. Every card, table, and form stays
neutral gray. Semantic colors are reserved for status — never used
decoratively.

Dark mode tokens exist (`.dark` block) and are kept functional, but light
mode is the acceptance target for this phase — see §9 of the phase
command.

## Typography

Compact by design — operational software doesn't need marketing-site
headings that waste vertical space.

| Level | Class | Used for |
|---|---|---|
| Page title | `text-xl font-semibold tracking-tight` | `PageHeader`'s own title |
| Workspace title | `text-lg font-semibold tracking-tight` | `WorkspaceHeader` (dense operational screens) |
| Section title | `text-sm font-semibold` | `SectionHeader`, card titles |
| Body | `text-sm` | Table cells, form values, most copy |
| Supporting text | `text-sm text-muted-foreground` | Descriptions, helper text |
| Metric value | `text-2xl font-semibold tabular-nums` | `MetricCard`'s own number |
| Label | `text-xs font-medium text-muted-foreground` | Form labels, filter labels |
| Caption | `text-xs text-muted-foreground` | Timestamps, fine print |

`tabular-nums` on any numeric value that needs to align in a column
(amounts, quantities) — the system font already supports it.

## Spacing

A predictable rhythm, not arbitrary values:

- Page-level vertical stack: `gap-6`
- Section-level stack: `gap-4`
- Card padding: `p-4` (compact) to `p-6` (a page's primary content card)
- Form field stack: `gap-4`
- Filter bar: `gap-3`
- Table cell padding: the shared `ui/table.tsx` default — not overridden per page

## Radius / Borders / Shadows

`--radius: 0.5rem` (tightened from shadcn's default 0.625rem — a slightly
crisper corner reads more enterprise, less consumer-app). Every
radius-based Tailwind utility (`rounded-md`, `rounded-lg`, ...) derives
from this one token via the existing `--radius-sm/md/lg/xl/...` chain — no
component hand-picks its own corner radius.

Borders: `border-border` (default) or `border-dashed` (empty states) — no
double borders, no card-inside-card nesting for its own sake.

Shadows: subtle, shadcn's own default elevation — this is enterprise
healthcare software, not a lifestyle app; no drop-shadow-heavy "floating
card" treatment.

## Application Shell

`src/app/(dashboard)/layout.tsx` + `AppSidebar` + `Topbar` (pre-existing,
refined this phase): a collapsible icon sidebar (`ui/sidebar.tsx`, shadcn's
own primitive), a topbar with sidebar trigger, branch switcher (shown only
when the session actually has more than one accessible branch), a
notification bell, and a user menu. Content area padding is `p-4 md:p-6`.

## Navigation

`src/components/layout/nav-config.ts` — ten logical groups (Home, Practice,
Clinical, Revenue, Resources, Workforce, Finance, Engagement, Intelligence,
Administration), each item gated on the viewer's actual permission (an
empty group after filtering never renders). Active route gets both a
background tint and the brand color on icon/text — never color alone
(§16's "do not rely only on text color").

## Page Headers

`src/components/ui/page-header.tsx` — three components, one per density:

- **`PageHeader`** — the default for every list/detail page: title,
  optional description, one `primaryAction` slot, an optional
  `secondaryActions` slot. Exactly one primary action is possible by
  construction — a page can't accidentally grow two competing "main"
  buttons.
- **`WorkspaceHeader`** — a denser variant for operational/queue screens
  (Reception, Appointments day view) where vertical space matters more
  than a page's own visual identity.
- **`SectionHeader`** — a heading *inside* a page (a dashboard section, a
  report section) — not the page's own title.

Migrated onto `PageHeader`/`WorkspaceHeader` this phase: Dashboard,
Reception, Patients, Patient 360, Appointments, Laboratory, Radiology,
Pharmacy, Purchasing, Inventory, Assets, Employees, Accounting, HR
Workspace, Settings, Clinic Onboarding, Encounters, Attendance, Leave,
Payroll, Claims, Payments, Invoices, Suppliers, Services, Providers,
Episodes, Orders, Queue, Payors, Commissions, Communications, Expenses,
Receivables, Payables, Packages, Users, Roles & Permissions — see the
phase report's own Files Changed section for the complete list.

## Cards

`ui/card.tsx` (shadcn, unchanged). Used for a genuinely meaningful group of
content — never nested (a Card inside a Card inside a Card). A table on a
page that already establishes its own structure doesn't need a decorative
outer card just for the sake of one.

## Metric Cards

`src/components/ui/metric-card.tsx` — the one KPI-tile design, replacing
whatever bespoke tile component each screen had built independently
(Dashboard's own `Tile`, Reception's inline summary cells, ...). Props:
`label`, `value`, optional `helper`, `icon`, `trend` (only ever a real
computed delta — never fabricated), and `tone` (`neutral` / `success` /
`warning` / `destructive`) for the rare metric that should visually stand
out (an outstanding balance, a low-stock count).

## Status Badges

`src/components/ui/status-badge.tsx` — **one** semantic status system for
the whole app. `statusTone(status)` maps any raw status string (from any
domain — appointment, invoice, refund, lab order, stock, import job, ...)
to one of five tones (`success` / `warning` / `info` / `destructive` /
`neutral`) via a curated explicit map plus a keyword-based fallback, so a
status this map doesn't yet know by name still renders sensibly rather than
unstyled. `<StatusBadge status="partially_paid" />` renders a soft-tone
pill with the humanized label; pass `label` to override the displayed text
while keeping the tone derived from the real status value.

Before this phase, "cancelled" could be `destructive` in one module and a
plain `outline` badge in another — this closes that gap for every screen
migrated onto it this phase (documented per-module in the phase report).

## Empty States

`src/components/ui/empty-state.tsx` — one "nothing here" pattern (icon,
title, optional description, optional action) instead of a bare line of
muted text or a blank table. Used inside a table's own body (`colSpan`
wrapping an `EmptyState` with `border-none`) so it reads naturally as part
of the table rather than a separate box.

## Loading / Error States

Loading: `ui/skeleton.tsx` (shadcn, pre-existing) remains the pattern where
used; no new loading-state component was introduced this phase (§37 — "do
not over-engineer").

Error: unchanged from P4.5A's own operational not-found/error handling
(`src/lib/platform/not-found.ts`, the global error boundary) — this phase
did not touch it, only confirmed it still renders correctly (see the phase
report's Frontend Bugs section for the one real bug found in a *different*
area this phase).

## Filters

`src/components/ui/filter-bar.tsx` — `FilterBar` (the shared
`<form className="flex flex-wrap items-end gap-3">` shell every filter
form in this app already converged on independently) and `FilterField`
(one label+control pair). Built this phase as the formal primitive; not
yet retrofitted onto every existing filter form (Reports, Inventory ledger,
Accounting journals, Purchasing, ...) — see the phase report's Deferred UX
Backlog.

## Forms

`src/components/ui/form-section.tsx` — `FormSection` (a `<fieldset>` with a
real `<legend>`, grouping a large form into labeled sections, 2-column on
desktop / 1-column on mobile by default) and `FormFieldFull` (a field that
should span the full row even inside a 2-column section — a long narrative
field, an address). Not yet retrofitted onto the large existing forms
(Patient registration, Employee, Provider, Organization settings) — see
Deferred UX Backlog.

## Dialogs

`ui/dialog.tsx` (shadcn/Radix, unchanged) — title, optional description,
footer with Cancel + primary action, already the established pattern
across this app's ~30+ dialogs. Radix handles focus trapping, restore-on-close,
and Escape-to-close correctly out of the box; this phase did not need to
touch the primitive itself.

## Destructive Actions

Unchanged domain-level confirmation flows (void, cancel, refund,
deactivate) — this phase did not alter any confirmation behavior. Visual
treatment: the `destructive` Button variant (already shadcn's own
convention) and the `destructive` StatusBadge tone, both reserved
specifically for actions/states that reverse or remove something real.

## Clinical & Financial Safety States

Never color alone (§77/§78): every `StatusBadge` always renders the status
*word*, never a bare colored dot. Patient 360's clinical-alert block (real,
schema-modeled allergies/conditions only — never invented) pairs an icon,
destructive-toned text, and the alert's own description. The Pharmacy
medication-mismatch confirmation (P4.5A) was not touched — its own
confirmation behavior and visibility remain exactly as built.

## Responsive Behavior

Verified at 1440/1280/1024/768/390px for the migrated flagship screens
(Dashboard, Patients, Patient 360, Reports) — see the phase report's
Responsive Design section. The sidebar collapses to icon-only on narrow
viewports (shadcn's own `Sidebar` behavior, unchanged); dense financial
tables (Trial Balance, General Ledger) are not expected to reflow into a
mobile-friendly card view — they scroll horizontally within their own
container, which is the correct trade-off for genuinely wide tabular data
per §58/§59's own explicit instruction.

## Accessibility

- Every form control has a real `<label>` (via `FilterField`, `FormSection`,
  or an explicit `<label htmlFor>`) — never a placeholder standing in for a
  label.
- Icon-only buttons (sidebar trigger, pagination chevrons) carry an
  accessible name via `aria-hidden` icons + visible/`sr-only` text where
  the shadcn primitive already provides it.
- Focus rings use the `ring` token (matches the brand color) and are never
  suppressed.
- Dialogs trap and restore focus correctly (Radix's own behavior,
  unchanged).
- No claim of formal WCAG certification is made — this is a
  sensibly-WCAG-aligned implementation, per the phase's own explicit
  instruction not to overclaim.

## Component Usage

Small, purposeful primitives — not one component with forty props. Each
new primitive (`PageHeader`, `StatusBadge`, `EmptyState`, `MetricCard`,
`FilterBar`, `FormSection`) does exactly one job and composes with the
existing shadcn primitives rather than wrapping/hiding them.
