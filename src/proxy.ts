import { NextResponse, type NextRequest } from "next/server"
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants"
import { getSessionContext } from "@/lib/auth/session"
import { PORTAL_SESSION_COOKIE_NAME } from "@/lib/auth/portal-constants"
import { getPortalSessionContext } from "@/lib/auth/portal-session"

// Next.js 16 Proxy defaults to the Node.js runtime (unlike the deprecated
// Edge-only middleware convention), so the authoritative, DB-backed session
// check can live here directly — this is the first of the layered
// authorization checks described in ARCHITECTURE.md §15; the dashboard layout
// re-checks (defense in depth, cheap indexed lookup) and every service
// function re-checks permissions again via can()/assertCan(). No layer trusts
// the layer above it.
//
// Three route classes as of Phase 12 (spec.md §57/§58), not two: fully
// public (no auth check at all — the online booking flow, spec.md §58, and
// the portal's own login page), portal-authenticated (a genuinely separate
// auth context from staff — see PatientPortalSession's doc comment), and
// staff-authenticated (unchanged from every prior phase).
const PUBLIC_PATHS = ["/login", "/reset-password", "/book", "/portal/login"]

// P2 §16: a per-request correlation id, generated once here (the one place
// that sees every request) and forwarded as a request header so any
// server-side code downstream — Server Components, Server Actions, Route
// Handlers — can read it back via `next/headers`'s `headers()` and attach
// it to a structured log line (`platform/logger.ts`'s `getCorrelationId`).
// Not a distributed trace id (no external system participates), just
// enough to tie together the handful of log lines one request produces —
// P2.md §16 asks for a correlation id "where available," not a full
// tracing system. `NextResponse.next({ request: { headers } })` (not
// `NextResponse.next({ headers })`) is what makes a header visible to the
// request handler rather than only the client — see Next's own proxy docs.
function withCorrelationId(request: NextRequest, response: (requestHeaders: Headers) => NextResponse): NextResponse {
  const requestHeaders = new Headers(request.headers)
  const correlationId = requestHeaders.get("x-correlation-id") ?? crypto.randomUUID()
  requestHeaders.set("x-correlation-id", correlationId)
  const res = response(requestHeaders)
  res.headers.set("x-correlation-id", correlationId)
  return res
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (
    PUBLIC_PATHS.some((path) => pathname.startsWith(path)) ||
    pathname.startsWith("/api/auth") ||
    // Cron-triggered — no session cookie exists for a scheduled request.
    // This route's only authorization is its own CRON_SECRET bearer-token
    // check (see src/app/api/cron/outbox-sweep/route.ts) — every other
    // route under /api/* still goes through the staff-session check below.
    pathname.startsWith("/api/cron") ||
    // P4.1 §23: a load balancer / uptime monitor / hosting platform health
    // probe never carries a staff session cookie — without this exclusion
    // it would be redirected to /login (a 307, not the 200/503 JSON a
    // health check expects) instead of ever reaching the route handler.
    // The route itself returns no patient/secret data, so this is safe to
    // leave reachable without a session, the same reasoning as /api/cron.
    pathname === "/api/health" ||
    pathname.startsWith("/_next")
  ) {
    return withCorrelationId(request, (headers) => NextResponse.next({ request: { headers } }))
  }

  if (pathname.startsWith("/portal")) {
    const portalToken = request.cookies.get(PORTAL_SESSION_COOKIE_NAME)?.value
    const portalSession = await getPortalSessionContext(portalToken)
    if (!portalSession) {
      return NextResponse.redirect(new URL("/portal/login", request.url))
    }
    return withCorrelationId(request, (headers) => NextResponse.next({ request: { headers } }))
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value
  const session = await getSessionContext(token)

  if (!session) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("from", pathname)
    return NextResponse.redirect(loginUrl)
  }

  return withCorrelationId(request, (headers) => NextResponse.next({ request: { headers } }))
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
