# Load Tests

P4.5 (Performance / Concurrency / Load Validation). Full findings and results live in [P4_5_PERFORMANCE_CONCURRENCY_LOAD_VALIDATION_REPORT.md](../P4_5_PERFORMANCE_CONCURRENCY_LOAD_VALIDATION_REPORT.md) and [docs/PERFORMANCE_CAPACITY.md](../docs/PERFORMANCE_CAPACITY.md) — this file is just "how to reproduce it."

## Tooling note

k6 (this project's preferred load tool) is not installable in the sandboxed session this batch was built in — no admin rights for a system package manager, no path to a prebuilt binary outside the CDN/package sources this environment allows. `load-tests/lib/http-client.ts` is the documented fallback: a small, purpose-built Node harness (bounded-concurrency worker pool over `fetch`, p50/p90/p95/p99 latency, error-rate reporting) — not a k6 reimplementation, just enough for what this phase needs. If k6 becomes available in a future environment, these scripts' *scenarios* (the URL lists, the role/session model) translate directly into a k6 script; the harness is the only piece that would be swapped.

Write-path concurrency scenarios (`load-tests/concurrency/`) call the real domain functions directly (not HTTP) — see that file's own header comment for why (Next.js Server Actions carry a build-specific action-reference encoding that isn't a stable target for a load tool without reverse-engineering it per build; calling the same domain functions the Server Actions themselves call exercises the exact same transactions/locks/constraints against the exact same database).

## One-time setup

```bash
npm run db:load-test:setup                      # creates/migrates/grants his_load_test, seeds the system/catalog baseline
npx tsx load-tests/seed/generate-load-data.ts    # bulk synthetic volume — takes a few minutes
npx tsx load-tests/lib/provision-sessions.ts     # pre-provisions real session tokens for the 250+ synthetic staff users
```

Never run any of these against `his_dev`/`his_test`/production — every script fails closed (`assertIsLoadTestDatabase`) if `LOAD_TEST_DATABASE_URL`/`LOAD_TEST_DIRECT_DATABASE_URL` don't resolve to a database literally named `his_load_test`. Set both in `.env` (see `.env.example`) before running anything here.

`npm run db:load-test:setup` always drops and recreates `his_load_test` clean — every full setup run starts from the same deterministic empty state, so a future engineer can rerun the exact same benchmark.

## Running a production build against `his_load_test`

```bash
npm run build
DATABASE_URL="postgresql://his_app_runtime:<password>@localhost:5433/his_load_test?schema=public" \
  CRON_SECRET="<any value>" PORT=3105 npm run start
```

## Read-path HTTP scenarios

```bash
LOAD_TEST_BASE_URL="http://localhost:3105" npx tsx load-tests/http/read-scenarios.ts [scenario] [concurrency]
```

- `scenario`: one of `reception`, `nursing`, `doctor`, `lab`, `radiology`, `pharmacy`, `pos`, `inventory`, `accounting`, `hr`, `dashboard`, or `all` (default).
- `concurrency`: a single level to run, or omit for the default sweep (25/50). Higher levels (100/150/200, used for the capacity curve in the report) must be passed explicitly — a full 25/50/100/150/200 sweep across all 11 scenarios takes too long for routine use.
- `LOAD_TEST_MULTIPLIER` (env, default 4): requests per scenario/level = `multiplier × concurrency`. Raise it for a longer, more statistically stable run; lower it for a quick smoke check.

## Write-path concurrency scenarios

```bash
npx tsx load-tests/concurrency/write-scenarios.ts [scenario] [concurrency]
```

- `scenario`: `stock`, `invoice`, `payment`, `refund`, or `all` (default).
- `concurrency`: concurrent operations to fire (default 25; refund is capped at 10 regardless — §23's own "do not make refunds dominate the normal workload").

Each scenario prints its own latency summary AND explicitly checks its correctness invariant (no negative stock, exactly one invoice owns a given Charge, no overpayment/allocation mismatch, no duplicate refund completion) — a violated invariant throws and exits non-zero, it is never just a log line.

## Soak test

```bash
npx tsx load-tests/soak/soak-test.ts [durationMinutes] [concurrency]
```

Defaults to 6 minutes at concurrency 20, a mixed-workday blend of Reception +
Doctor + Cashier + Pharmacist read traffic, with Outbox status snapshotted
before/immediately-after/+15s. Shorter than the spec's 60-90 minute target —
a deliberate, disclosed reduction for this session's time budget (see the
report's Soak Test section); the mechanism is unchanged, so pass a larger
`durationMinutes` for a fuller run.

## Reconciliation after any scenario

```bash
npx tsx load-tests/lib/reconcile.ts
```

Prints the same class of check P4.2's own drill and P4.5's report both rely on: overall trial balance, per-journal balance, stock ledger vs. batch quantities, invoice totals vs. payment allocations — safe to run at any time against `his_load_test`, read-only.

## Cleaning up

`npm run db:load-test:setup` (rerun) resets everything. There is no separate teardown script — the whole database is disposable by design.

## Committed vs. not committed

Committed: every script here, this README, the seed generator, the harness. **Not** committed (gitignored): `load-tests/results/` — session tokens (meaningless outside a local `his_load_test`, but kept out of git on principle) and any raw per-run output. Concise benchmark summaries belong in the committed report/docs instead, per §76.
