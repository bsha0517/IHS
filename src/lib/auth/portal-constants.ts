// Deliberately dependency-free (no db, no next/headers) so proxy.ts (Edge-ish
// runtime) can import the cookie name without pulling in the Prisma/pg bundle
// — same reasoning as constants.ts's staff SESSION_COOKIE_NAME. A distinct
// cookie name (not shared with staff sessions) is what actually keeps the two
// auth contexts separate — see PatientPortalSession's own doc comment.
export const PORTAL_SESSION_COOKIE_NAME = "his_portal_session"
