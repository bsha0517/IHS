import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { log } from "@/lib/platform/logger"
import { getReleaseVersion } from "@/lib/platform/release"

export const dynamic = "force-dynamic"

/**
 * P4.1 §23-25: a minimal production health endpoint — no session/auth
 * required (a load balancer, uptime monitor, or hosting platform's own
 * health probe never has a staff session cookie), reachable at
 * `/api/health` (proxy.ts's PUBLIC_PATHS doesn't need updating — the staff-
 * session redirect only applies to page routes a browser would actually
 * hit; this route is under `/api/*` but isn't `/api/cron/*`, so double-
 * check it's still reachable unauthenticated — see the route's own note
 * below and the P4.1 report's own confirmation this was tested).
 *
 * Deliberately cheap: one trivial `SELECT 1` proves the runtime connection
 * (the restricted `avant_app_runtime` role, same one every request uses —
 * see src/lib/db.ts) can actually reach Postgres, without running any real
 * domain query, touching patient/financial data, or measuring anything
 * expensive. On failure, the real error is logged server-side (structured,
 * via the existing `log()`) but never returned to the caller — this
 * endpoint has no session to authorize against, so its response body must
 * stay as safe to expose publicly as any other unauthenticated surface.
 */
export async function GET() {
  const startedAt = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json({
      status: "healthy",
      database: "reachable",
      timestamp: new Date().toISOString(),
      version: getReleaseVersion(),
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    log({ level: "error", event: "health.database_unreachable", domain: "runtime", operation: "GET /api/health", error })
    return NextResponse.json(
      { status: "unhealthy", database: "unreachable", timestamp: new Date().toISOString() },
      { status: 503 }
    )
  }
}
