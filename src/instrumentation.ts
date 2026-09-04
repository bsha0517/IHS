/**
 * P2 §16: the last-resort, framework-wide safety net for "database/runtime
 * errors" — Next's own `onRequestError` hook fires for any uncaught error
 * from Server Component rendering, Route Handlers, or Server Actions,
 * across the whole app, without needing to add a try/catch to every
 * individual action file (this codebase has dozens; each already has its
 * own local try/catch for *expected* failures — invalid input, a business
 * rule rejection — and returns a friendly `{ error }` to the caller, per
 * spec.md §92's "never leak a raw DB/internal error" discipline. This hook
 * is specifically for the *unexpected* ones that escape that handling).
 *
 * This is not a substitute for logging at the point of failure with real
 * domain context (organizationId, branchId, entityId, ...) — see
 * `outbox.ts`'s dead-letter/failed-processing logging and
 * `posting-service.ts`'s `postJournal` for that. This hook doesn't have
 * access to the signed-in session (Next only hands it `request`/`context`,
 * not cookies parsed into a session), so it logs what it can — the route,
 * method, and error — as the final catch-all for whatever falls through
 * every more specific log point above it.
 *
 * See `platform/logger.ts`'s own "EXTENSION POINTS" comment for where a
 * real observability provider (Sentry, Datadog, ...) would plug in here
 * instead of this hook calling the local `log()` — not done now, per
 * P2.md §16's own "without integrating a vendor now" instruction.
 */
/**
 * P4.1 §7: Next's own documented "run once when the server process starts"
 * hook — the correct place for fail-fast environment validation, since it
 * runs for both `next start` (production) and `next dev`, but never for
 * `next build` (a build with no live `.env` shouldn't fail) and never for
 * the vitest integration suite (which doesn't load this file at all). Only
 * the Node.js runtime needs this — there's no edge-runtime code path in
 * this app that reads `env.ts`'s validated values.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv } = await import("@/lib/env")
    validateEnv()
  }
}

export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[]> },
  context: { routerKind: string; routePath: string; routeType: string }
) {
  const { log } = await import("@/lib/platform/logger")
  const correlationHeader = request.headers["x-correlation-id"]
  log({
    level: "error",
    event: "runtime.unhandled_request_error",
    domain: "runtime",
    operation: context.routeType,
    correlationId: Array.isArray(correlationHeader) ? correlationHeader[0] : correlationHeader,
    reference: context.routePath,
    entityId: request.method,
    error,
  })
}
