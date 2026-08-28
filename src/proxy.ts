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
    pathname.startsWith("/_next")
  ) {
    return NextResponse.next()
  }

  if (pathname.startsWith("/portal")) {
    const portalToken = request.cookies.get(PORTAL_SESSION_COOKIE_NAME)?.value
    const portalSession = await getPortalSessionContext(portalToken)
    if (!portalSession) {
      return NextResponse.redirect(new URL("/portal/login", request.url))
    }
    return NextResponse.next()
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value
  const session = await getSessionContext(token)

  if (!session) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("from", pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
