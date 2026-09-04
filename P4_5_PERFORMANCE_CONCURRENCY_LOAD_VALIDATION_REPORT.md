# P4.5 — Performance, Concurrency & Load Validation Report

**Phase objective** (verbatim from spec): measure the performance and
concurrency limits of the current HIS, identify real bottlenecks, fix only
demonstrated high-impact issues, and establish an evidence-based capacity
recommendation for commercial deployment. **Measure → Reproduce → Diagnose →
Optimize → Re-measure.** No speculative optimization, no architecture
redesign, no caching/Redis/read-replicas introduced without load evidence.

Durable reference document: [`docs/PERFORMANCE_CAPACITY.md`](docs/PERFORMANCE_CAPACITY.md)
(required sections; read that first for the condensed findings). This report
carries the full narrative, evidence, and the phase's acceptance decision.

> **Corrections (targeted commercial/safety backlog closure, item 12):**
> several statements below were revised after review — see
> `docs/PERFORMANCE_CAPACITY.md`'s own item-12A-G notes for the full
> reasoning on each: (A) the capacity-curve classification at concurrency
> 25/50 was overstated as "Healthy" — a multi-second p95 is degraded
> interactive performance even with 0% errors; correctness/stability and
> interactive usability are separate axes. (B) the 25→200 capacity curve is
> an HTTP **read/navigation** workload — it never included invoice/payment
> writes, which were validated separately, up to concurrency 25 only. (C)
> "CPU/event-loop contention" was the leading explanation for the local
> ceiling, not a conclusively isolated root cause — lock contention and
> pool saturation were positively ruled out by direct measurement; CPU
> utilization itself was not independently instrumented. (D) the Lab/
> Radiology `take:200` "before/after" originally compared against a
> `take:50` measurement, not an actual `take:200` query — and `take:200`
> itself has since been replaced by real pagination (targeted backlog
> closure, item 2), which is what §11 below and the durable doc now
> describe. (E) the soak test proves short-duration steady-state behavior
> only, not long-duration memory stability or leak absence. (F) "zero
> errors" throughout refers to the tested read/navigation HTTP scenarios,
> not to every operation being exercised identically over HTTP.

---

## 1. Test Environment

Single developer sandbox, 4 logical CPUs, Docker allocated ~4 CPU/8GB. A
dedicated `his_load_test` PostgreSQL database (never `his_dev`/`his_test`/
remote Supabase — guarded by `assertIsLoadTestDatabase`, mirroring the
existing `assertIsTestDatabase` fail-closed pattern). App server: a real
`next build` + `next start` production build, not `next dev`, on port 3105.
k6 was attempted (`choco install k6 -y`) and failed — no elevation, an
interactive prompt this session can't answer, confirmed no binary was
produced. Per the spec's own fallback allowance, a narrow custom Node.js HTTP
harness was built instead (`load-tests/lib/http-client.ts`).

## 2. Load Model & Data Volume

10,000 patients · 20,000 appointments · 9,648 encounters · 3,000 clinical
orders · 10,000 invoices / 20,056 charges+invoice-lines / 8,406
payments+allocations · 18,406 journals / 36,812 journal lines, verified
balanced (`SUM(debit)=SUM(credit)=7,339,934.99`, 0 unbalanced journals) ·
3,000 login-history rows · 5,000 outbox-history rows · 3 branches · 30
providers · 150 products (370 batches) · 250 staff users, 265 provisioned
sessions across 11 roles. Full generation logic:
[`load-tests/seed/generate-load-data.ts`](load-tests/seed/generate-load-data.ts).

Design decision, stated plainly: bulk historical data uses `createMany` for
speed, not real domain functions — correctness-critical write paths are
separately exercised through the real domain functions in
[`load-tests/concurrency/write-scenarios.ts`](load-tests/concurrency/write-scenarios.ts).
This is documented in the seed script's own header comment.

## 3. Scenario Results — Read-Path Baseline (concurrency 25 / 50)

All 11 named scenarios (Reception, Nursing, Doctor, Lab, Radiology, Pharmacy,
POS, Inventory, Accounting, HR, Dashboard). Zero errors at every level tested.

| Scenario | Concurrency | RPS | p50 | p90 | p95 | p99 | Max | Error % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| reception | 25 | 9.8 | 2712ms | 3040ms | 3209ms | 3260ms | 3267ms | 0.00% |
| reception | 50 | 8.6 | 5413ms | 7460ms | 8055ms | 8202ms | 8355ms | 0.00% |
| nursing | 25 | 11.3 | 1972ms | 3083ms | 3098ms | 3110ms | 3124ms | 0.00% |
| nursing | 50 | 9.7 | 4579ms | 6638ms | 6808ms | 6957ms | 6980ms | 0.00% |
| doctor | 25 | 6.2 | 3875ms | 5558ms | 5603ms | 5651ms | 5662ms | 0.00% |
| doctor | 50 | 6.1 | 7902ms | 8784ms | 8828ms | 9050ms | 9186ms | 0.00% |
| lab | 25 | 2.1 | 9645ms | 18672ms | 20986ms | 21071ms | 21078ms | 0.00% |
| lab | 50 | 2.1 | 21063ms | 38649ms | 42456ms | 42619ms | 42680ms | 0.00% |
| radiology | 25 | 3.3 | 6341ms | 12873ms | 14124ms | 15281ms | 15297ms | 0.00% |
| radiology | 50 | 3.8 | 12415ms | 18623ms | 19637ms | 19791ms | 19970ms | 0.00% |
| pharmacy | 25 | 14.3 | 1721ms | 1873ms | 1883ms | 1889ms | 1905ms | 0.00% |
| pharmacy | 50 | 13.6 | 3635ms | 4037ms | 4053ms | 4172ms | 4178ms | 0.00% |
| pos | 25 | 11.8 | 2222ms | 2419ms | 2454ms | 2467ms | 2468ms | 0.00% |
| pos | 50 | 11.5 | 4451ms | 4803ms | 4816ms | 4843ms | 4875ms | 0.00% |
| inventory | 25 | 4.9 | 4268ms | 7984ms | 8660ms | 8937ms | 8951ms | 0.00% |
| inventory | 50 | 5.2 | 8168ms | 13633ms | 14240ms | 14538ms | 14821ms | 0.00% |
| accounting | 25 | 6.2 | 3890ms | 4808ms | 4850ms | 4873ms | 4952ms | 0.00% |
| accounting | 50 | 6.1 | 7677ms | 9054ms | 9667ms | 9704ms | 9705ms | 0.00% |
| hr | 25 | 11.6 | 2081ms | 2341ms | 2370ms | 2516ms | 2580ms | 0.00% |
| hr | 50 | 11.8 | 4149ms | 4547ms | 4749ms | 5199ms | 5252ms | 0.00% |
| dashboard | 25 | 6.8 | 3382ms | 4257ms | 4300ms | 4325ms | 4549ms | 0.00% |
| dashboard | 50 | 7.0 | 6563ms | 7998ms | 8114ms | 8456ms | 8750ms | 0.00% |

**Design notes on scenario construction** (real findings made while building
these, not bugs left in place):
- Each scenario picks ONE session and fetches sample record IDs scoped to
  that session's own branch — an earlier design that mixed a random session
  with globally-random record IDs produced real, *correct* branch-isolation
  500s (`P2025`), confirming branch scoping is enforced server-side exactly
  as intended.
- `/laboratory?status=pending` and `/radiology?status=pending` 500 for a real
  reason: `status` is passed unvalidated into a Prisma `ClinicalOrderStatus`
  filter and "pending" isn't a member of that enum (real values: draft/
  ordered/acknowledged/in_progress/completed/cancelled). This is a genuine
  input-validation bug, flagged via `spawn_task` ("Validate status query
  param on /laboratory and /radiology") rather than fixed here — it's a
  correctness/input-validation concern, out of this phase's performance-only
  scope. Scenarios use the valid `?status=ordered` instead.
- `/reports` was removed from the Accountant scenario: it throws a real,
  correct `ForbiddenError: Missing permission: branch.view` for the seeded
  Accountant role — confirmed as correct authorization behavior, not a bug.

**Doctor/Patient 360** (flagged by the spec as an especially important heavy
read surface): 6.1-6.2 RPS, p50 3875-7902ms — not the worst scenario, and its
prior documented shape (25 bounded parallel queries across the page + 3 tabs,
`PERFORMANCE_BASELINE.md`) holds up under load; it scales with the same
general concurrency ceiling as every other scenario, not a Patient-360-
specific defect.

**Lab and Radiology were the two worst-performing scenarios by a wide
margin** — investigated in §11.

## 4. Capacity Curve (POS scenario, representative)

POS was chosen as the representative scenario for the full curve because
both reads and writes converge on it in production. **This specific curve,
however, is an HTTP read/navigation workload only** (`GET /pos`, `/invoices`,
`/invoices/[id]`) — it does not include `generateInvoice`/`recordPayment`
writes, which were validated separately (§7) up to concurrency 25, not
through this curve and not up to 200. See the correction notice at the top
of this report (item 12B).

| Concurrency | RPS | p50 | p95 | Error % | Classification |
|---:|---:|---:|---:|---:|---|
| 25 | 11.8 | 2222ms | 2454ms | 0.00% | Acceptable / Mildly Degraded |
| 50 | 11.5 | 4451ms | 4816ms | 0.00% | Degraded |
| 100 | 8.4 | 11354ms | 14996ms | 0.00% | Severely Degraded |
| 150 | 8.7-9.6 | 15421-17689ms | 18015-19908ms | 0.00% | Severely Degraded |
| 200 | 10.2 | 19885ms | 21017ms | 0.00% | Unsustainable for normal interactive use |

(Revised per item 12A — a multi-second p95 at any concurrency, including 25,
is not "Healthy" even at 0% errors; see the correction notice.)

**No request failed at any concurrency level tested, up to 200** — the system
degrades gracefully (rising latency, flattening RPS) rather than error-storming
under load, in this environment.

## 5. Connection Pool Findings

`DB_POOL_MAX` env-var support was added to `src/lib/db.ts` (default stays 3,
production-unchanged) specifically to run this comparison without hand-editing
the file between runs.

| Pool max | Scenario | RPS | p50 | p95 |
|---|---|---:|---:|---:|
| 3 (default) | reception@50 | 8.6 | 5413ms | 8055ms |
| 5 | reception@50 | 5.0 | 9683ms | 13955ms |
| 3 (default) | lab@50 | 2.1 | 21063ms | 42456ms |
| 5 | lab@50 | 2.2 | 20065ms | 36075ms |

**Pool=5 did not outperform pool=3** — reception was measurably *worse*, lab
was a wash. This was re-run (cold then warm) specifically to rule out a
one-off before accepting it as a real result. §6 explains why via direct
`pg_stat_activity` evidence: the app's pool never actually saturated even at
150-way HTTP concurrency, ruling out "not enough DB connections" as the local
bottleneck. **Recommendation: keep the production default `max: 3`
unchanged** — no local evidence justifies raising it, and this sandbox cannot
separate "pool size" from "shared-CPU confound" cleanly enough to prove a
higher value would help even without that confound. Raising it without new
evidence from a separately-resourced staging host risks hitting a shared
connection-pooler's cap for no proven benefit (see `src/lib/db.ts`'s own
pre-existing comment on the Supabase transaction-mode pooler).

## 6. Long Transaction & Lock/Deadlock Findings

`pg_stat_activity`/`pg_locks` were polled every 2s across a 16s window during
a sudden 150-concurrency POS HTTP burst (the same burst used as the spike
test, §13):

```
[t=0s]  total_conns=1  waiting_locks=0
[t=2s]  total_conns=4  waiting_locks=0   (3 idle, wait_event_type=Client)
[t=4s]  total_conns=4  waiting_locks=0
[t=6s]  total_conns=4  waiting_locks=0
[t=8s]  total_conns=4  waiting_locks=0
[t=10s] total_conns=4  waiting_locks=0
[t=12s] total_conns=4  waiting_locks=0
[t=14s] total_conns=4  waiting_locks=0
```

**Zero waiting locks at every sample.** Total connections never exceeded 4 (3
app-pool + 1 poller) — the pool=3 cap held exactly, and those 3 connections
were frequently *idle*, not busy, even while 150 concurrent HTTP requests were
in flight. This is the direct evidence behind §5's conclusion: the local
bottleneck is compute (Node.js/event-loop/CPU scheduling in a shared 4-core
sandbox), not database locks or connection availability. No deadlock, no long-
transaction pileup, no lock wait was observed in any test run this phase.

## 7. Stock / Invoice / Payment Concurrency (Correctness Proofs)

Real domain-function calls (not HTTP), racing genuinely contended state.

**Stock — never negative** (`recordAdjustment` racing a near-empty batch,
concurrency=25): `succeeded=20 failed=5 finalBalance=0` — ✅ never negative.
A concurrency=1 uncontended control run: `recordAdjustment`=**330ms**,
`succeeded=1 failed=0 finalBalance=0`.

> A first concurrency=1 control attempt produced `finalBalance=-4` and an
> incorrect "NEGATIVE STOCK" flag. Root-caused to the test script's own
> fixture math (`quantity: concurrency - 5` evaluates to a nonsensical `-4`
> receive-quantity when concurrency is small) — confirmed via
> `reference_type='p4_5_load'` provenance tagging on the stray row; not a
> real application defect. Fixed in
> [`load-tests/concurrency/write-scenarios.ts`](load-tests/concurrency/write-scenarios.ts)
> with `Math.max(1, concurrency - 5)`; re-run above is clean. The one stray
> negative-balance row this produced remains in `his_load_test` (a disposable
> database, recreated by `db:load-test:setup`) — reconciliation output below
> shows it and this note explains its provenance.

**Invoice — exactly one valid ownership path per Charge** (`generateInvoice`
racing the SAME Charges, concurrency=25): `succeeded=1 failed=24
invoiceLinesForCharge=1` — ✅. Uncontended control (concurrency=1):
`generateInvoice`=**861ms**.

**Payment — no overpayment, idempotent posting, allocations reconcile**
(`recordPayment` racing the same outstanding balance, concurrency=25):
`succeeded=1 failed=24 totalAmount=100 paidAmount=100 allocationSum=100` — ✅.
Uncontended control (concurrency=1): `recordPayment`=**342ms**.

**Refund — no double reversal** (`completeRefund` racing the same refund,
concurrency=10): `succeeded=1 failed=9 finalStatus=completed` — ✅ exactly one
completion, no double reversal. (Required its own dedicated cashier user,
separate from the payment scenario's — `openSession()` correctly rejects a
second concurrent register for the same user; a real, correct behavior that
broke an earlier version of this script sharing one session across scenarios.)

**Uncontended vs. 25-way-contended latency** — the ~10s p50 seen for
`generateInvoice`/`recordPayment`/`completeRefund` at concurrency 25 is
**almost entirely queueing/contention cost, not intrinsic operation cost**:
861ms → ~10,000ms (invoice), 342ms → ~10,000ms (payment) is an ~11-30x
increase purely from 25-way contention on the same rows/pool, not from the
operations themselves being slow.

## 8. Outbox Under Load

All four write scenarios dispatch their Outbox event **inline** (existing
P4.4 model, no background worker). Live (non-seed) outbox events created
during this phase's scenario runs:

```
completed=34, failed=0, dead_letter=0, pending=0, processing=0
```

Zero backlog, zero failures, zero stuck-processing rows across every write
scenario, including under 25-way concurrent `generateInvoice`/`recordPayment`
calls. The pre-existing "failed=78, dead_letter=25" counts visible in a raw
status query are **synthetic seed history** (`payload.loadTestSeed: true`,
`lastError: "Load-test seed synthetic failure"`, injected by
`generate-load-data.ts` for a realistic operations-dashboard starting point) —
confirmed by provenance tag, not real failures from this phase. Inline-
dispatch latency cost is captured directly in §7's uncontended numbers (861ms/
342ms/330ms are inclusive of the full inline dispatch chain, e.g. accounting
posting for invoice/payment) — sub-second per write including dispatch is not
a demonstrated performance problem at this data volume.

## 9. Accounting / Financial / Inventory Reconciliation (Post-Load)

Run via [`load-tests/lib/reconcile.ts`](load-tests/lib/reconcile.ts) after all
scenario runs (read-only, checks invariants directly against the database
rather than relying on HTTP success rate):

```
[Accounting] Overall: debit=7339934.99 credit=7339934.99 ✅ trial balance balanced
[Accounting] Unbalanced journals: 0 ✅
[Financial] Invoices where paidAmount != sum(allocations) − sum(completed refunds): 0 ✅
[Financial] Overpaid invoices: 0 ✅
[Financial] Charges owned by >1 InvoiceLine: 0 ✅
[Inventory] Batches with negative balance: 1 ⚠️  — the single stray row explained in §7, test-fixture provenance confirmed, not a live invariant violation
[Outbox] Rows stuck in 'processing' > 10min: 0 ✅
```

The reconciliation query itself required one fix during this phase: a
completed `Refund` reduces `Invoice.paidAmount` but deliberately does not
delete/mutate the original `PaymentAllocation` row (this codebase's "never
delete to reverse a mistake, a reversal is a Refund against it" discipline) —
an earlier version of the reconciliation query compared `paidAmount` to a bare
allocation sum and flagged a false positive on a correctly-refunded invoice.
Fixed to compare against `sum(allocations) − sum(completed refunds)`.

## 10. Horizontal Scaling / Statelessness Confirmation

Sessions, login rate-limiting, the Outbox, and the operational-job scheduler
heartbeat are already DB-backed per P4.3/P4.4 — confirmed again this phase by
inspection (no new singleton state was introduced by any P4.5 change). One
module-level `Map` exists in `src/lib/platform/outbox.ts`
(`const handlers = new Map<...>()`) — this is a code-level handler-type
registry populated identically by every process at startup, not shared
mutable request state, and is not a horizontal-scaling concern.

**Scheduler duplicate-invocation proof**: already covered by existing
coverage in
[`test/integration/outbox-concurrency.test.ts`](test/integration/outbox-concurrency.test.ts) —
"two concurrent periodic-sweep calls never both run the handler for the same
batch of events" and "two concurrent sweeps recovering the same stuck event
only ever run its handler once." Not duplicated here per the spec's own
"reuse existing coverage if it already proves this" allowance.

## 11. Query Profiling

The two worst-performing scenarios (Lab, Radiology) were investigated
directly rather than EXPLAIN-ANALYZE'd blindly across the whole app, per the
spec's "only investigate measured bottlenecks" instruction.

**Finding: it is not the query.** Direct Prisma-level timing of
`listLabQueue`'s underlying query (478 realistic rows, 5 joined relations —
patient, labDetail, labOrderTests, orderingProvider, branch) measured
**76-267ms warm**, nowhere near the multi-second page latencies seen under
load. An isolated, uncontended (concurrency=1) HTTP request to `/laboratory`
measured **p50=326ms** — closely matching the raw query cost. This confirms
the multi-second latencies seen at concurrency 25-50 are almost entirely
concurrency/queueing cost (§6's shared-CPU-sandbox ceiling), not an
intrinsically slow endpoint.

**Fix made at the time of P4.5** (narrow, low-risk, evidence-adjacent even if
not the dominant cause): both `listLabQueue`
([`src/lib/domains/laboratory/orders.ts`](src/lib/domains/laboratory/orders.ts))
and `listRadiologyQueue`
([`src/lib/domains/radiology/orders.ts`](src/lib/domains/radiology/orders.ts))
had **no `take` limit at all** — an unbounded `findMany` that will keep
growing with order volume for as long as the system runs. Current data
(478-520 rows/branch) doesn't make this the dominant cost today, but it is a
real, unbounded-growth risk for a multi-year production system. P4.5 added
`take: 200` to both, with an inline comment explaining this was a forward-
looking safety bound, not a fix for the measured latency. Its own
"before/after" table below compared unbounded rows against a *hypothetical*
`take:50` timing, never an actually-measured `take:200` query — flagged in
this correction, not left uncorrected (item 12D).

| | Before | After (as measured at P4.5 time) |
|---|---:|---:|
| Rows returned | 478 (unbounded) | ≤200 |
| Query time (warm) | 76-267ms | 69-120ms (an equivalent `take:50` query — not an actual `take:200` measurement) |

**Superseded**: the targeted commercial/safety backlog closure batch
replaced this `take: 200` safety cap with real `page`/`pageSize` pagination
— a fixed cap on a clinical operational queue silently hides order 201+
with no way to reach it, which was judged unacceptable. See
`TARGETED_COMMERCIAL_SAFETY_BACKLOG_CLOSURE_REPORT.md` (item 2) for the
replacement and its own directly-measured before/after evidence.

No other query showed evidence of needing an index or N+1 fix. Patient 360,
the Management Dashboard, and the Reports page all performed in line with
their pre-existing documented shape (`PERFORMANCE_BASELINE.md`), scaling with
the same general concurrency ceiling as everything else — no targeted fix was
made to any of them, per the spec's "fix only demonstrated high-impact
issues" instruction.

## 12. Optimizations Made — Summary

| # | Change | File | Evidence | Severity |
|---|---|---|---|---|
| 1 | `DB_POOL_MAX` env-var support (infra for the pool experiment, default unchanged) | [`src/lib/db.ts`](src/lib/db.ts) | Required to run §5's comparison | N/A (infra) |
| 2 | `take: 200` bound added to the lab queue query | [`src/lib/domains/laboratory/orders.ts`](src/lib/domains/laboratory/orders.ts) | §11 — worst-performing scenario, unbounded growth risk | MEDIUM (forward-looking, not the measured cause) |
| 3 | `take: 200` bound added to the radiology queue query | [`src/lib/domains/radiology/orders.ts`](src/lib/domains/radiology/orders.ts) | §11 — same as above | MEDIUM |

**No BLOCKER-severity issue was found.** No correctness guarantee
(transactions, idempotency, branch/org isolation, accounting balance, stock
protection, audit immutability, clinical locks) was weakened for speed, and
no database constraint was removed or loosened. No caching, Redis, read
replica, or background worker was introduced — none was shown necessary by
load evidence; this decision is recorded, not silently skipped.

## 13. Spike Test

A sudden jump from idle directly to 150 concurrent POS requests (no ramp):

| | RPS | p50 | p95 | Error % |
|---|---:|---:|---:|---:|
| Spike @150 | 9.6 | 15421ms | 18015ms | 0.00% |

**Zero errors during the spike.** The system did not crash, did not error-
storm, and the connection pool held its configured cap throughout (§6). This
is a genuinely positive finding for graceful-degradation behavior. Immediate
post-spike recovery could not be cleanly isolated: a follow-up concurrency=25
check was run while the soak test (§14) was already generating concurrent
load in the background, so its elevated latency reflects combined load, not
a clean recovery measurement — noted here rather than mis-reported as a
recovery finding.

## 14. Soak Test

**HONEST SCOPE NOTE**: the spec's target is 60-90 minutes at realistic
concurrency. This session's real time budget does not support that; per the
spec's own explicit allowance ("If environment limitations make this
impractical, perform the longest meaningful test possible and report the
limitation honestly"), a shorter window was run instead. See
[`load-tests/soak/soak-test.ts`](load-tests/soak/soak-test.ts) — the script
itself is unchanged for a longer run; re-invoke with a larger duration
argument for a fuller soak.

**Stated plainly (item 12E): this short run validates short-duration
steady-state behavior only.** It does NOT prove long-duration memory
stability, the absence of a slow leak, or genuine 60-90 minute endurance —
none of those can be concluded from 6 minutes. A proper staging soak at the
original target duration remains a required step before any endurance claim
is made (§16).

**Run performed**: 6 minutes, concurrency 20 (5 per role), a mixed-workday
blend of Reception + Doctor + Cashier + Pharmacist read traffic (all read-
path — this soak did not include write scenarios, so the Outbox counts below
are expected to be unchanged, not evidence of dispatch stalling):

| Role | Requests | RPS | p50 | p90 | p95 | p99 | Max | Error % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Receptionist | 818 | 2.3 | 2072ms | 2903ms | 3294ms | 4228ms | 4702ms | 0.00% |
| Doctor | 853 | 2.4 | 2019ms | 2786ms | 3192ms | 3968ms | 4307ms | 0.00% |
| Cashier | 895 | 2.5 | 1916ms | 2646ms | 3065ms | 3658ms | 4063ms | 0.00% |
| Pharmacist | 875 | 2.4 | 1970ms | 2632ms | 3002ms | 3796ms | 4256ms | 0.00% |

3,441 total requests over 6 minutes, **zero errors**, latency stable and
consistent across all four roles the entire window (no growth/drift observed
in aggregate p50-p99 — the numbers above are steady-state, not a decaying
trend). Outbox status was queried before, immediately after, and 15s after
the run: unchanged in all three (`failed=78, completed=4931, dead_letter=25`
throughout — the pre-existing synthetic-seed counts from §8, consistent with
a read-only soak generating no new outbox events). No connection growth or
resource exhaustion was observed at this concurrency over this window. A
longer run (60-90min, per the original spec target) and a higher concurrency
that also exercises writes are recommended for the staging validation pass
(§15-16), not repeated here given the session time budget.

## 15. Local vs. Production/Cloud Capacity — Required Honesty Statement

**This phase validates local architectural and concurrency correctness. It
does NOT establish a production capacity number.** Explicitly, per the
spec's own required wording: it is forbidden to claim "supports 200 users in
production" from this evidence. What can honestly be said (item 12F's exact
framing): **zero HTTP errors in the tested read/navigation scenarios up to
concurrency 200, and no correctness failures in separately executed
contended write scenarios (up to concurrency 25) — not that every operation
was exercised identically over HTTP up to 200. A staging/cloud load test
against production-equivalent infrastructure remains a required step before
any concurrency capacity claim is made to a customer or used in a go-live
decision.**

The observed local ceiling (RPS plateauing ~8-12, latency climbing steeply
past concurrency 50-100) is a property of sharing 4 CPU cores between
Postgres, the app server, and the load-generator client simultaneously — not
necessarily a property of a properly-resourced, separately-provisioned
production host. §5-6's evidence (idle DB connections even at 150-way
concurrency, no lock contention, pool=5 not outperforming pool=3) positively
rules out DB-lock and DB-connection-pool exhaustion as the local bottleneck.
Shared compute/CPU scheduling is the leading remaining explanation, not a
conclusively isolated root cause (item 12C — CPU utilization itself was not
independently instrumented) — but it is exactly the kind of constraint
horizontal scaling (more instances, each with their own small pool) is
designed to relieve, consistent with this system's already-confirmed
stateless design (§10).

## 16. Recommended Production Capacity

No production concurrency number is recommended by this phase — see §15.
**Recommended next step**: run the same committed `load-tests/` scripts
against a staging environment matching the intended production
infrastructure (real serverless function instances, a real managed Postgres
instance/pooler, realistic network latency) before setting any customer-
facing capacity number.

## 17. Scale-Up Triggers

Signals that would indicate the current architecture needs revisiting
(none were observed in this phase — recorded for future monitoring):
- Outbox backlog (`pending`/`processing` count) growing faster than the
  dispatch rate can drain it in production.
- `pg_stat_activity` showing sustained, non-idle, saturated connections (this
  phase's local evidence showed idle connections even under 150-way load —
  the opposite signal; a real production saturation signal would look
  different and should be re-measured on real infrastructure).
- Lock wait counts becoming non-zero under real concurrent write traffic.
- Lab/Radiology row counts growing past the new `take: 200` cap in a way that
  hides orders from the queue — at that point, real pagination (not just a
  safety cap) becomes necessary.

## 18. Files Changed

- [`src/lib/db.ts`](src/lib/db.ts) — `DB_POOL_MAX` env-var support (default
  unchanged).
- [`src/lib/domains/laboratory/orders.ts`](src/lib/domains/laboratory/orders.ts) —
  `take: 200` added to `listLabQueue`.
- [`src/lib/domains/radiology/orders.ts`](src/lib/domains/radiology/orders.ts) —
  `take: 200` added to `listRadiologyQueue`.
- [`scripts/db/lib.ts`](scripts/db/lib.ts) — `assertIsLoadTestDatabase` added.
- `.env.example` / `.env` — `LOAD_TEST_DATABASE_URL` / `LOAD_TEST_DIRECT_DATABASE_URL` added.
- [`package.json`](package.json) — `db:load-test:setup` script added.
- [`.gitignore`](.gitignore) — `/load-tests/results/` ignored.

## 19. Load-Test Infrastructure Added (new files)

- `scripts/db/load-test-setup.ts` — creates/migrates/seeds `his_load_test`.
- `load-tests/seed/generate-load-data.ts` — bulk synthetic data at scale.
- `load-tests/lib/provision-sessions.ts` — real session provisioning.
- `load-tests/lib/http-client.ts` — the load-generation harness (k6 substitute).
- `load-tests/http/read-scenarios.ts` — 11 read-path scenarios.
- `load-tests/lib/reconcile.ts` — post-load invariant checker.
- `load-tests/concurrency/write-scenarios.ts` — 4 write-path concurrency proofs.
- `load-tests/soak/soak-test.ts` — sustained mixed-workday soak test.
- `load-tests/README.md` — full reproduction instructions.

## 20. Tests Added/Updated

No changes were made to `test/integration/*` — load/performance testing is
deliberately kept under `load-tests/`, separate from the ordinary integration
suite, per the spec's own instruction. `test/integration/outbox-concurrency.test.ts`
was read and cited (§10) but not modified — its existing coverage already
proves the scheduler-duplicate-invocation requirement.

## 21. P3.12/P3.13 Test-Hygiene Assessment

Previously flagged (P4.3) test-hygiene issues were assessed for impact on
P4.5 load-test repeatability. **Conclusion: no impact.** `his_load_test` is a
fully separate, dedicated, always-recreated database, entirely independent of
`his_test` — nothing about the earlier hygiene findings touches load-test
repeatability. No fix was made here; this is a documentation-only
confirmation, per the spec's own "document as infrastructure hygiene, don't
launch a refactor" instruction.

## 22. Regression Status

Full regression suite re-run after all P4.5 changes (against `his_dev`/
`his_test` — never `his_load_test`):

| Check | Result |
|---|---|
| `npx prisma validate` | ✅ schema valid |
| `npx prisma migrate status` | ✅ up to date, 36 migrations, no drift |
| `npm run typecheck` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 0 warnings (one unused-var warning in the new seed script was fixed) |
| `npm run test` (full integration suite, `his_test`) | ✅ 59 files / 518 tests passed |
| `npm run build` | ✅ production build succeeded, all 70 routes compiled |

No regression introduced by any P4.5 change.

## 23. Remaining Performance Backlog

- A real staging/cloud load test (§15-16) — the single most important
  outstanding item before any customer-facing capacity claim.
- A full 60-90 minute soak test on a non-shared-CPU environment (§14).
- The `/laboratory`/`/radiology` `?status=pending` input-validation 500 (§3) —
  flagged via `spawn_task`, not a performance item.
- If/when Lab or Radiology order volume grows past the new `take: 200` cap,
  real pagination (not just a safety bound) will be needed (§17).

## 24. P4.5 Acceptance Decision

**Can P4.5 be closed? YES.**

All required deliverables are complete: a dedicated, guarded `his_load_test`
database; realistic data at the required scale; committed, reproducible
load scripts under `load-tests/`; baseline measurements for all 11 named
scenarios before any optimization; a capacity curve to concurrency 200; a
connection-pool investigation with a documented recommendation; lock/
transaction evidence via `pg_stat_activity`; concurrency-correctness proofs
for stock/invoice/payment/refund; Outbox-under-load measurement; post-load
accounting/financial/inventory reconciliation; targeted query profiling with
a before/after table; two narrow, evidence-adjacent fixes with no correctness
guarantees weakened; a spike test; a soak test (honestly scoped down, with
the reduction disclosed); horizontal-scaling statelessness confirmation;
scheduler-duplicate-invocation proof by citation; the mandatory local-vs-
cloud honesty statement; and a staging-validation requirement recorded for
the future. No BLOCKER or unaddressed HIGH-severity finding remains open.

**Per §81, this phase stops here.** P4.6, onboarding/data-import, reporting/
export work, the release/migration phase, regulatory work, or another
whole-project audit are explicitly out of scope until the next explicit
instruction.
