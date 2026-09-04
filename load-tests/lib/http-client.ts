// P4.5 §9: a small, purpose-built HTTP load harness — used in place of k6.
//
// HONEST NOTE (also in P4_5_PERFORMANCE_CONCURRENCY_LOAD_VALIDATION_REPORT.md's
// own "Load Tool / Scripts" section): k6 was the preferred tool per §9, but
// is not installable in this sandboxed session (no admin rights for a
// system package manager, no network path to fetch a prebuilt binary
// outside the allowed package sources). This harness is the documented
// fallback — "another lightweight tool already compatible with the
// environment" — built narrowly for exactly what this phase needs
// (concurrent authenticated GETs against real Next.js page routes, with
// p50/p90/p95/p99/max latency and error-rate reporting), not a general
// load-testing framework. It is not a k6 reimplementation.

export type RequestResult = { status: number; durationMs: number; ok: boolean; error?: string }

export async function timedGet(url: string, cookie: string): Promise<RequestResult> {
  const startedAt = performance.now()
  try {
    const response = await fetch(url, { headers: { Cookie: cookie }, redirect: "manual" })
    // Consume the body so the connection is genuinely released back to the
    // pool before the next request in this worker's sequence — a half-read
    // response can otherwise understate real server-side completion time.
    await response.arrayBuffer()
    const durationMs = performance.now() - startedAt
    return { status: response.status, durationMs, ok: response.status >= 200 && response.status < 400 }
  } catch (err) {
    const durationMs = performance.now() - startedAt
    return { status: 0, durationMs, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type Stats = {
  count: number
  errors: number
  errorRate: number
  rps: number
  p50: number
  p90: number
  p95: number
  p99: number
  max: number
  mean: number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

export function computeStats(results: RequestResult[], wallClockMs: number): Stats {
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b)
  const errors = results.filter((r) => !r.ok).length
  return {
    count: results.length,
    errors,
    errorRate: results.length > 0 ? errors / results.length : 0,
    rps: wallClockMs > 0 ? results.length / (wallClockMs / 1000) : 0,
    p50: percentile(durations, 50),
    p90: percentile(durations, 90),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations[durations.length - 1] ?? 0,
    mean: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
  }
}

/**
 * Runs `totalRequests` GETs against `urls` (cycled), holding `concurrency`
 * requests in flight at once — a bounded worker-pool pattern, not
 * `Promise.all` over everything at once (which would just fire all
 * requests simultaneously regardless of the requested concurrency level).
 */
export async function runLoad(opts: {
  urls: string[]
  cookie: string
  concurrency: number
  totalRequests: number
}): Promise<{ results: RequestResult[]; wallClockMs: number }> {
  const results: RequestResult[] = []
  const startedAt = performance.now()
  let nextIndex = 0

  async function worker() {
    while (nextIndex < opts.totalRequests) {
      const i = nextIndex++
      const url = opts.urls[i % opts.urls.length]
      results.push(await timedGet(url, opts.cookie))
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()))
  const wallClockMs = performance.now() - startedAt
  return { results, wallClockMs }
}

/** Runs `runLoad` for a fixed WALL-CLOCK duration instead of a fixed request count — used for soak/sustained scenarios. */
export async function runLoadForDuration(opts: {
  urls: string[]
  cookie: string
  concurrency: number
  durationMs: number
}): Promise<{ results: RequestResult[]; wallClockMs: number }> {
  const results: RequestResult[] = []
  const startedAt = performance.now()
  const deadline = startedAt + opts.durationMs

  async function worker() {
    let i = 0
    while (performance.now() < deadline) {
      const url = opts.urls[i++ % opts.urls.length]
      results.push(await timedGet(url, opts.cookie))
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()))
  const wallClockMs = performance.now() - startedAt
  return { results, wallClockMs }
}

export function printStatsTable(rows: { scenario: string; concurrency: number; stats: Stats }[]): void {
  console.log("\n| Scenario | Concurrency | Requests | RPS | p50 | p90 | p95 | p99 | Max | Error % |")
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
  for (const row of rows) {
    const s = row.stats
    console.log(
      `| ${row.scenario} | ${row.concurrency} | ${s.count} | ${s.rps.toFixed(1)} | ${s.p50.toFixed(0)}ms | ${s.p90.toFixed(0)}ms | ${s.p95.toFixed(0)}ms | ${s.p99.toFixed(0)}ms | ${s.max.toFixed(0)}ms | ${(s.errorRate * 100).toFixed(2)}% |`
    )
  }
}
