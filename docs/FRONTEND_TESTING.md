# Frontend Testing

P4.6 and P4.7 each found a real, production-affecting frontend bug that a
583-test, server-only integration suite could not see — a green backend
suite was never proof the user interface actually worked. This document
covers the frontend testing layer P4.7A adds to close that gap: what each
layer is for, how to run it, and what it deliberately does not cover.

## Three Layers, Three Jobs

| Layer | Tool | Question it answers | Lives in |
|---|---|---|---|
| Integration (pre-existing) | Vitest + real Postgres | Is the domain/business logic correct? | `test/integration/*.test.ts` |
| Component (new) | Vitest + jsdom + React Testing Library | Does this one component wire its interactions correctly? | `test/components/*.test.tsx` |
| Browser smoke (new) | Playwright | Does the real, rendered page load and respond for a signed-in user? | `test/e2e/*.spec.ts` |

None of the three substitutes for another. The integration suite proves
`commitImportAction` correctly commits a validated CSV; nothing in it could
have caught that the *button* calling it was wired to a stale ref and never
fired at all (P4.6's real bug) or that a Server Component silently
overwrote one report field with another (P4.7's real bug) — both were
caught only by rendering the real thing.

## Component Tests

**Setup:** a deliberately separate Vitest config
(`vitest.components.config.mts`), not merged into the main
`vitest.config.mts`. Component tests need a `jsdom` environment and must
never go through `test/setup-test-database.ts` (they touch no database at
all) — a separate config keeps that boundary structural rather than
relying on every test file to remember not to import the wrong thing.
`test/setup-component-tests.ts` wires `@testing-library/jest-dom` matchers
and calls `cleanup()` after each test.

**Run:**

```bash
npm run test:components
```

**What belongs here:** interaction wiring — does clicking a button actually
call the action it's supposed to; does a multi-step dialog carry state
correctly across its own steps; does a pending mutation disable its own
submit button; does an error render. `test/components/import-dialog.test.tsx`
is the reference example — a direct regression test for P4.6's own
Commit-button bug, reproduced through the real component (not a
reimplementation of its logic).

**A real jsdom limitation, documented so it isn't rediscovered:** a
synthetic `userEvent.click()` on a `<button type="submit">` does not
reliably trigger a native `submit` event in this jsdom/React 19 combination
(real browsers do this correctly — confirmed independently via this same
form's own live browser verification in P4.6/P4.7). Use
`fireEvent.submit(formElement)` directly when testing a React 19
`<form action={fn}>` handler. Similarly, `new FormData(formElement)`
constructed from a real `<input type="file">` in jsdom does not reliably
preserve the uploaded File's name/size — assert that a File instance was
received and that the *other* form fields carried through correctly,
rather than asserting exact file-identity round-trip.

**What does not belong here:** anything that needs a real database, a real
session, or exercises more than one component's own wiring — that's what
the integration suite or a browser smoke test is for. Do not test Tailwind
class strings.

## Browser Smoke Tests

**Setup:** `playwright.config.ts` — Chromium only, one worker (deterministic,
not parallelized), against the real `next dev` server on `his_dev` (local
Postgres — never production, never remote Supabase). The config's own
`webServer` block starts `npm run dev` automatically if nothing is already
listening on port 3000, or reuses an already-running one.

**Run:**

```bash
npm run test:e2e
```

**What it covers** (`test/e2e/smoke.spec.ts`): login, then for each of 13
representative routes (Dashboard, Reception, Patients, Appointments,
Encounters, Laboratory, Radiology, Pharmacy, POS, Inventory, Accounting,
Reports, Onboarding) — the page responds with a non-error status, its own
heading renders, and the browser console logged no real error (two known,
harmless dev-only noise sources are explicitly filtered: Next.js HMR
websocket reconnects, and React's own dev-mode `eval()` call being blocked
by this app's real CSP, which explicitly omits `unsafe-eval` per P4.3
hardening and never uses `eval()` in production). Plus: the branch
switcher/patient search/sidebar-navigation each get one representative
interaction test.

**What it deliberately does not do:** duplicate a real clinical/financial
workflow (that's the integration suite's job), assert pixel-perfect visual
output (no screenshot-diffing was introduced — a small, fragile
maintenance burden this phase's own scope explicitly avoided), or cover
every one of the ~70 routes. 13 routes were chosen as genuinely
representative of the product's major modules, matching the phase
command's own suggested list almost exactly.

## Fixture Assumptions

Both the component and browser-smoke layers assume:
- Local Postgres (`his_dev`) is running and seeded (`npm run db:dev:setup`).
- The seeded Super Admin login (`admin@avant.local` / `ChangeMe123!`) is
  available — the same fixture every manual browser-verification pass in
  this engagement has used.
- Component tests need no database at all — every domain call is mocked
  (`vi.mock`) at the module boundary.

## Known Limitations

- Only Chromium is exercised — no cross-browser matrix. A small, focused
  suite testing real UI wiring doesn't need one; if a genuine
  browser-specific bug is ever found, add a targeted regression test for
  it, not a full cross-browser expansion.
- No visual regression/screenshot-diffing — deliberately not built this
  phase (§70's own "do not build a complex screenshot-diff infrastructure
  unless straightforward — only key screens, no fragile pixel-perfect
  tests across 70 routes"; even the smaller version was judged not worth
  the ongoing maintenance cost for this phase's actual goal).
- Component test coverage is intentionally narrow — the two tests in
  `import-dialog.test.tsx` are a regression guard for one specific,
  previously-real bug and a template for adding more, not an attempt at
  broad component coverage across the app's ~30+ dialogs. Expanding this
  is real, valuable future work — see the phase report's Deferred UX
  Backlog.
- The Playwright suite runs serially (`workers: 1`) against one shared dev
  server — fine for 16 tests taking a couple of minutes; a much larger
  suite would need parallelization.

## Re-running Everything

```bash
npx prisma validate
npx prisma migrate status
npm run typecheck
npm run lint
npm run test              # full integration suite (his_test)
npm run test:components   # component tests (no database)
npm run test:e2e          # browser smoke suite (his_dev, starts next dev if needed)
npm run build
```
