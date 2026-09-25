import { NextResponse, type NextRequest } from "next/server"
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants"
import { getSessionContext } from "@/lib/auth/session"
import { PORTAL_SESSION_COOKIE_NAME } from "@/lib/auth/portal-constants"
import { getPortalSessionContext } from "@/lib/auth/portal-session"
import { PLATFORM_SESSION_COOKIE_NAME } from "@/lib/auth/platform-constants"
import { getPlatformSessionContext } from "@/lib/auth/platform-session"
import { isModuleEnabled, isRouteEnforceable, type ModuleKey } from "@/lib/platform/entitlements"

// Next.js 16 Proxy defaults to the Node.js runtime (unlike the deprecated
// Edge-only middleware convention), so the authoritative, DB-backed session
// check can live here directly — this is the first of the layered
// authorization checks described in ARCHITECTURE.md §15; the dashboard layout
// re-checks (defense in depth, cheap indexed lookup) and every service
// function re-checks permissions again via can()/assertCan(). No layer trusts
// the layer above it.
//
// Four route classes as of P5.1, not three: fully public (no auth check at
// all — the online booking flow, spec.md §58, and both login pages),
// portal-authenticated (a genuinely separate auth context from staff — see
// PatientPortalSession's doc comment), platform-authenticated (P5.1 — a
// THIRD, fully separate auth context again; see PlatformOperator's doc
// comment), and staff-authenticated (unchanged from every prior phase).
const PUBLIC_PATHS = ["/login", "/reset-password", "/book", "/portal/login", "/platform/login"]

/**
 * P5.1 §15: the centralized, non-bypassable module-entitlement enforcement
 * point — every request under a gated prefix is checked here, once, before
 * the route ever renders; there is no way to reach a gated page by direct
 * URL that skips this. Deliberately does NOT cover `reception`/`patients`/
 * `appointments`/`clinical`/`nursing` routes — see `entitlements.ts`'s own
 * `isRouteEnforceable`/`CORE_MODULES` doc comment for the clinical-safety
 * reasoning (§16).
 */
const MODULE_ROUTE_PREFIXES: [string, ModuleKey][] = [
  ["/laboratory", "laboratory"],
  ["/radiology", "radiology"],
  ["/pharmacy", "pharmacy"],
  ["/inventory", "inventory"],
  ["/purchasing", "procurement"],
  ["/accounting", "finance"],
  ["/receivables", "finance"],
  ["/payables", "finance"],
  ["/expenses", "finance"],
  ["/hr", "hr"],
  ["/employees", "hr"],
  ["/attendance", "hr"],
  ["/leave", "hr"],
  ["/commissions", "hr"],
  ["/payroll", "payroll"],
  ["/assets", "assets"],
  ["/reports", "reports"],
  ["/admin/onboarding", "imports_onboarding"],
  ["/pos", "pos_billing"],
  ["/invoices", "pos_billing"],
  ["/payments", "pos_billing"],
  ["/payors", "pos_billing"],
  ["/claims", "pos_billing"],
]

function moduleForRoute(pathname: string): ModuleKey | null {
  const match = MODULE_ROUTE_PREFIXES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  return match ? match[1] : null
}

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

  // P5.1 §20/§21/§84: a fully separate auth context again — `PlatformSession`
  // only, never `Session`/`PatientPortalSession`. A clinic Super Admin's
  // staff session cookie is simply the wrong cookie for this branch to look
  // at, so there is no code path from a clinic session into `/platform`.
  if (pathname.startsWith("/platform")) {
    const platformToken = request.cookies.get(PLATFORM_SESSION_COOKIE_NAME)?.value
    const platformSession = await getPlatformSessionContext(platformToken)
    if (!platformSession) {
      return NextResponse.redirect(new URL("/platform/login", request.url))
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

  // P5.1 §15/§16: module entitlement — checked only for the route prefixes
  // this phase deliberately made enforceable (never the core clinical
  // spine; see MODULE_ROUTE_PREFIXES/isRouteEnforceable's own doc comments).
  // A disabled module redirects to /dashboard rather than a raw 404/403, the
  // same "don't confuse the visitor with a bare error" choice this app
  // already makes for an unauthenticated request above.
  //
  // P5.2 §9/§10: a Server Action POST carries a `next-action` header and is
  // exempted from this redirect — a raw HTTP redirect is not a Server
  // Action's response contract (the client expects either the action's own
  // Flight-encoded result or Next's own `x-action-redirect` header set via
  // `redirect()` *inside* the action). Redirecting the POST itself sends the
  // browser's fetch to `/dashboard`'s own unrelated action handler, which
  // returns a response the caller can't parse ("An unexpected response was
  // received from the server"), crashing the page instead of showing a
  // message. Every module-gated action already calls `assertModuleEnabled()`
  // itself (see entitlements.ts) and returns a graceful `{ error }` — that is
  // the authoritative check for actions; this middleware redirect exists for
  // page navigation only.
  const gatingModule = moduleForRoute(pathname)
  if (gatingModule && isRouteEnforceable(gatingModule) && !request.headers.get("next-action")) {
    const enabled = await isModuleEnabled(session.user.organizationId, gatingModule)
    if (!enabled) {
      return NextResponse.redirect(new URL("/dashboard", request.url))
    }
  }

  return withCorrelationId(request, (headers) => NextResponse.next({ request: { headers } }))
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
