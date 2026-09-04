import { timingSafeEqual } from "node:crypto"
import { NextResponse, type NextRequest } from "next/server"
import { processPendingOutboxEvents } from "@/lib/platform/outbox"
import { recordJobAttempt } from "@/lib/platform/operational-state"
import { log, SLOW_OPERATION_THRESHOLD_MS } from "@/lib/platform/logger"

/**
 * P4.3 §47: a plain `!==` string comparison is technically vulnerable to a
 * timing side-channel (each mismatched byte can return marginally faster
 * than a full-length scan) — low-severity over a real network given HTTP's
 * own jitter, but a free, standard fix. `timingSafeEqual` requires equal-
 * length buffers or it throws; a length mismatch is itself decided first
 * and short-circuits to "not equal" — the token's length isn't the
 * sensitive part, its content is, so this doesn't reintroduce the leak it
 * fixes.
 */
function safeTokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * P1 §4's cron entry point for the periodic outbox sweep. Vercel Cron Jobs
 * (vercel.json's "crons" array) issue a GET request to the configured path
 * and, when CRON_SECRET is set in the project's environment variables,
 * automatically attach it as `Authorization: Bearer <CRON_SECRET>` — the
 * documented Vercel convention this route checks against, not a bespoke
 * scheme. No session cookie exists for a cron-triggered request (there's no
 * logged-in user), so this route is excluded from proxy.ts's staff-session
 * gate (see PUBLIC_PATHS there) and is instead the one place in this
 * codebase whose *only* authorization is the shared-secret check below —
 * every other route re-derives authorization from a real session. See
 * DEPLOYMENT.md's "Outbox Sweep Scheduling" for setup and for what happens
 * if CRON_SECRET is left unset (the route refuses every request, rather
 * than silently running unauthenticated).
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: { code: "not_configured", message: "CRON_SECRET is not set — refusing to run the sweep unauthenticated." } },
      { status: 503 }
    )
  }

  const authHeader = request.headers.get("authorization")
  if (!authHeader || !safeTokenEquals(authHeader, `Bearer ${secret}`)) {
    // P4.3 §47: the response never echoes back the submitted token or any
    // event payload — a wrong-token response and a right-token response
    // reveal nothing to each other beyond "did this run."
    return NextResponse.json({ error: { code: "unauthorized", message: "Invalid or missing bearer token." } }, { status: 401 })
  }

  // P4.4 §19: the durable heartbeat — a 200 response alone doesn't prove the
  // NEXT scheduled invocation ever happens; this row is what operations
  // actually reads to answer "is the scheduler stale?" (see
  // src/lib/platform/operational-health.ts). Recorded for both outcomes —
  // "the scheduler fired but the sweep itself failed" is exactly the kind
  // of thing this heartbeat must not silently miss.
  const startedAt = Date.now()
  try {
    const result = await processPendingOutboxEvents()
    const durationMs = Date.now() - startedAt
    await recordJobAttempt("outbox_sweep", { success: true, metadata: { recovered: result.recovered, processed: result.processed } })
    if (durationMs > SLOW_OPERATION_THRESHOLD_MS) {
      log({ level: "warn", event: "outbox.sweep_slow", domain: "outbox", operation: "cron_sweep", durationMs, reference: "outbox_sweep" })
    }
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await recordJobAttempt("outbox_sweep", { success: false, error: message }).catch(() => {
      // The heartbeat write itself failing (e.g. the DB is what's actually
      // down) must never mask the real failure below — logged either way.
    })
    log({ level: "error", event: "outbox.sweep_failed", domain: "outbox", operation: "cron_sweep", errorCategory: "OUTBOX", error })
    return NextResponse.json(
      { error: { code: "sweep_failed", message: "The outbox sweep failed — see server logs." } },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    )
  }
}
