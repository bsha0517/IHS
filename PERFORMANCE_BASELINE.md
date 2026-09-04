# PERFORMANCE_BASELINE.md

P2 Batch 7 (§22): a lightweight performance baseline against real dev/test data, measured directly — not estimated from reading code and not fabricated. See "Methodology" for exactly how these numbers were produced and their limits.

## Methodology

A one-off instrumented script (not committed — it wrapped `db`'s common Prisma methods in place, counting real calls, then imported and ran the actual domain functions each screen below calls, against the real shared dev/staging Supabase database this whole P0-P2 engagement has used) measured, for each named operation:

- **query count** — real Prisma/`$queryRaw` round trips, counted by wrapping the methods every domain function already calls (`findMany`, `findFirst(OrThrow)`, `findUnique(OrThrow)`, `count`, `aggregate`, `groupBy`, `$queryRaw`) on the live `db` singleton every real function imports — not a mock, not a guess from reading source.
- **duration** — wall-clock `performance.now()` around each call, against the real network-hop-away Supabase Postgres instance this whole engagement's test suite already runs against.
- **row count** — the length of the real array returned, where the operation returns one.

**On duration numbers specifically**: this environment has real, substantial, variable network latency to its Postgres instance — documented repeatedly throughout this engagement's own test runs (a single trivial `SELECT` has been observed anywhere from ~200ms to 8+ seconds depending on load). The absolute millisecond figures below are real measurements from one specific run, not fabricated, but should be read as **query-count and query-shape findings with an illustrative timing order-of-magnitude**, not a guarantee of production latency — a single measurement on a shared dev database is not a load-tested benchmark. Where query count/shape is the meaningful signal (which is most of what follows), that's what to trust; where a duration looks like an outlier, it most likely is network/pooler variance, not a data-volume problem, given the dataset sizes below.

**Dataset size** (this dev/test database, at measurement time — real counts, not representative of a mature production org):

| Table | Row count |
|---|---|
| `patient` | 50 |
| `appointment` | 7 |
| `encounter` | 12 |
| `invoice` | 17 |
| `payment` | 10 |
| `charge` | 34 |
| `stock_ledger_entry` | 59 |
| `journal` | 194 |
| `journal_line` | 397 |
| `product` | 24 |
| `provider` | 10 |
| `employee` | 7 |
| `clinical_order` | 6 |
| `diagnosis` | 3 |
| `prescription` | 9 |
| `vital_sign` | 3 |
| `clinical_note` | 3 |
| `branch` | 2 |

This is a small, early-stage dataset (accumulated test/seed data across this whole engagement, not a real clinic's operating history) — every finding below is a **query-shape** finding (does this scale with row count? does it make N calls where it could make 1?), not a claim that any of these screens are currently slow in absolute terms at this data volume. They aren't.

---

## Results

| # | Operation | Queries | Duration | Rows returned | Notes |
|---|---|---|---|---|---|
| 1 | Patient search (no search term) | 2 | 1217ms | — | `findMany` + `count`, both indexed |
| 1b | Patient search (with search term) | 2 | 387ms | — | Same shape; the `contains`/`insensitive` filter still hits the indexed columns named in DATABASE.md's §3 review |
| 2 | Appointment day view (today) | 1 | 2345ms | 0 | Single `findMany`, date-range + branch bounded. 0 rows today in this dataset — duration here is pure network round-trip, not query work |
| 3 | Patient 360 (full page: main + Clinical/Billing/Insurance tabs) | **25** | 7849ms | — | See "Patient 360" below — the heaviest screen measured, by a wide margin |
| 4 | Encounter load | 1 | 2376ms | — | Single `findFirstOrThrow` with a wide `include` (encounter + nested clinical relations in one query, not N+1) |
| 5 | POS pending charges | 1 | 447ms | 5 | Single `findMany`, patient-scoped |
| 6 | Invoice list (page 1) | 2 | 528ms | 17 | `findMany` + `count` — P2 Batch 6's pagination shape |
| 7 | Stock ledger (page 1) | 2 | 526ms | 36 | Same pagination shape as Invoices |
| 8 | Inventory report (current month) | 11 | 1238ms | — | See "Inventory report" below — a real, if small-scale, N+1 |
| 9 | Journal list (page 1) | 2 | 1619ms | 50 | `findMany` + `count` — P2 Batch 6's pagination shape; `findMany` includes every line + account per journal in one query (not N+1) |
| 10 | Trial Balance | **1** | 507ms | — | The single raw-SQL `LEFT JOIN`/`GROUP BY` (`accountBalances`, accounting/reports.ts) — confirms P2 Batch 7's §9 dedup fix in a real measured run, not just by reading the diff |
| 11 | Management dashboard | 23 | 2808ms | — | 17 parallel aggregate/count/groupBy calls + 1 parallel batch of name-lookups = the 20 documented in PERFORMANCE_NOTES.md, plus a few more from the two `listLowStock`/`listNearExpiryBatches`/`listMaintenanceDue` helper calls it also fetches |
| 12 | Reports (`/reports`, all 7 categories, current month) | 46 | 5720ms | 7 (report objects) | All 7 categories run in parallel; the raw-SQL account-balance query appears **once** (`getFinancialReport` → `getFinancialStatements`), not twice — the same §9 dedup fix, confirmed again here |

### Patient 360 (operation 3) — the heaviest screen measured

25 real round trips for one page load: the main page's own 5 queries (patient, appointments, lab results, imaging results, message history — `patient` shows as 2 because `getPatient`'s own permission/branch-visibility check does a preliminary read before the full fetch), then three sibling tab components — **all rendered eagerly, not lazily, on every page load regardless of which tab the user is actually looking at** — each running their own `Promise.all`: Clinical (8 queries: episodes, encounters, vitals, diagnoses, prescriptions, orders, branches, providers), Billing (7: packages, invoices, payments, package catalog, patient statement, refund lookup inside the statement, plus one more), Insurance (3: coverage, prior authorizations, payors).

No individual query here is an N+1 — every one is a single bounded `findMany`/`findFirst` scoped to the one patient. The 25-query count is a **fan-out** pattern (many small, correct, parallel queries), not a correctness bug, and every one of the underlying functions is already reviewed and branch/permission-scoped correctly by earlier P0/P1/P2 batches. At this dataset's row counts it's fast enough. Flagged in PERFORMANCE_NOTES.md/the §23 write-up as the single highest-round-trip-count screen in the app — worth knowing before assuming "the dashboard" is the heaviest page (it measured lighter, at 23).

### Inventory report (operation 8) — a real, small-scale N+1

`stockLedgerEntry: 7` for a dataset with only a handful of near-expiry/expired batches: `listNearExpiryBatches` and `listExpiredBatches` (`inventory/stock.ts`) each call `getBalance` once **per batch found**, via `Promise.all(batches.map(async (batch) => ...))` — parallelized (so it doesn't cost N sequential round trips' worth of *latency*), but it is genuinely N+1 in query *count*, bounded today by "however many batches are near-expiry or already expired," which is small at any realistic scale (expiry-tracked SKUs times a short window, not the whole catalog). Not fixed this batch — P2.md §9 named specific reports to optimize and this one wasn't on that list, and at the row counts this pattern is actually bounded by (near-expiry batches, not total inventory), it isn't the "recompute large history" pattern §9 was written for. Noted here per §22's own "record obvious N+1 behavior" instruction, and cross-referenced in PERFORMANCE_NOTES.md.

---

## Summary

- **No screen measured is unbounded or scales with total table size** in a way that would explain a real slowdown at V1 scale — every list is either paginated (P2 Batch 6) or bounded by a sensible filter (date range, patient, branch).
- **The two heaviest screens by query count** are Patient 360 (25) and the combined `/reports` page (46, but that's 7 independent report categories running in parallel, not one operation — each category alone is 5-10 queries, in line with the rest of this table). Both are fan-out-of-small-bounded-queries patterns, not N+1 or full-table-scan patterns.
- **The one real, if small, N+1** found is in the Inventory report's near-expiry/expired batch balance lookups — documented above and in PERFORMANCE_NOTES.md, not fixed (out of named §9 scope, and bounded by a naturally small row count).
- **This batch's own §9 optimization work is independently confirmed here**: Trial Balance is 1 query (not the 2-3 it would have been calling `incomeStatement`/`balanceSheet` separately before this batch), and the Reports page's Financial category shows the same raw-SQL account-balance query running once, not twice.
- Absolute durations are dominated by this environment's own network/pooler round-trip cost (visible in how `2. Appointment day view`, a single simple indexed query with 0 matching rows, still took 2.3 seconds) — not by query count or data volume at this dataset's size. See §23's assessment (PRODUCTION_READINESS.md) for what that latency characteristic means for connection usage and concurrency at higher user counts.
