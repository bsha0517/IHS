import { NextResponse, type NextRequest } from "next/server"
import { processPendingOutboxEvents } from "@/lib/platform/outbox"

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
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Invalid or missing bearer token." } }, { status: 401 })
  }

  const result = await processPendingOutboxEvents()
  return NextResponse.json({ ok: true, ...result })
}
