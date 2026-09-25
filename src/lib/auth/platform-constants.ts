// Deliberately dependency-free (no db, no next/headers) — same reasoning as
// constants.ts's SESSION_COOKIE_NAME and portal-constants.ts's
// PORTAL_SESSION_COOKIE_NAME: proxy.ts (Node runtime, but still the one
// place that must import this before anything heavier) needs the cookie
// name without pulling in the Prisma/pg bundle. A distinct cookie name from
// both staff and portal sessions is what actually keeps this a third,
// separate auth context — see PlatformOperator's own schema doc comment.
export const PLATFORM_SESSION_COOKIE_NAME = "his_platform_session"
