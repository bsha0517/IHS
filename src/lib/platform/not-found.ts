import "server-only"
import { notFound } from "next/navigation"
import { Prisma } from "@/generated/prisma/client"
import { ForbiddenError } from "@/lib/platform/permissions-core"

/**
 * Targeted backlog closure, item 4 (BACKLOG.md's long-standing "Appointment/
 * patient 'wrong branch' and 'not found' errors fall through to the fully
 * generic error boundary" entry): every `[id]` detail page's `getX(session,
 * id)` call throws either a Prisma "record not found" (`P2025` — a stale
 * id, or a real id belonging to a different organization) or a
 * `ForbiddenError` (most commonly `assertBranchAccess`'s "branch.access" —
 * a real record the session's own branch scope doesn't cover) with no
 * try/catch anywhere, so both fall through to the generic route-level
 * `(dashboard)/error.tsx` ("Something went wrong... this has been logged")
 * instead of the already-existing, already-correctly-worded
 * `(dashboard)/not-found.tsx` ("doesn't exist, or you no longer have
 * access to it").
 *
 * Deliberately does NOT distinguish "not found" from "forbidden" in what it
 * shows — doing so would let a wrong-branch/wrong-org id reveal that a
 * record with that id genuinely exists, which is exactly the leak this
 * helper exists to avoid. Anything else (a real bug, a database error) is
 * re-thrown unchanged so it still reaches the error boundary and gets
 * logged as the genuine failure it is — this only reclassifies the two
 * specific, expected "no access, however you slice it" cases.
 *
 * Usage: `const record = await loadOrNotFound(() => getAppointment(session, id))`
 */
export async function loadOrNotFound<T>(fetch: () => Promise<T>): Promise<T> {
  try {
    return await fetch()
  } catch (error) {
    if (isNotFoundOrForbidden(error)) notFound()
    throw error
  }
}

function isNotFoundOrForbidden(error: unknown): boolean {
  if (error instanceof ForbiddenError) return true
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return true
  return false
}
