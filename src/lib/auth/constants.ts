// Deliberately dependency-free (no db, no next/headers) so middleware.ts (Edge
// runtime) can import the cookie name without pulling in the Prisma/pg bundle.
export const SESSION_COOKIE_NAME = "his_session"
