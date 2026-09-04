import "server-only"
import { getReleaseVersion } from "@/lib/platform/release"

/**
 * P2 §16: the centralized structured logger this codebase didn't have —
 * lightweight, deliberately, per P2.md §16's own "do not add a huge
 * observability platform" instruction. Structured JSON to stdout/stderr,
 * nothing more, with clear extension points documented at the bottom of
 * this file for wiring in a real provider (Sentry, Datadog, etc.) later
 * without touching any call site.
 *
 * USE THIS FOR (P2.md §16's own list): unexpected domain failures, failed
 * outbox processing, dead-letter events, accounting posting failures,
 * integration/provider failures, authorization anomalies, database/
 * runtime errors.
 *
 * DO NOT use this for routine CRUD — every domain write already has its
 * own audit trail (`audit_log` via `auditFromSession`, `clinical_access_log`
 * via `writeClinicalAccessLog`), which is the correct record of "what
 * happened," not this. This logger is for *operational* events — things an
 * engineer troubleshooting a production incident needs to see — not a
 * second audit trail and not a performance-monitoring tool (see
 * PERFORMANCE_BASELINE.md/PERFORMANCE_NOTES.md for that instead).
 *
 * NEVER pass any of the following as a field value, in `reference`, or
 * folded into `error` (P2.md §16's own list): passwords, reset tokens,
 * session tokens, full clinical note content, more patient detail than the
 * `entityId` needed to locate the record, card data, secrets, or
 * `DATABASE_URL`/any connection string. The typed field shape below is
 * deliberately narrow (short identifier strings, not a generic free-text
 * `context: Record<string, unknown>` blob) specifically to make it harder
 * to accidentally log something that shouldn't be logged — but this
 * logger does not scan or redact field values itself (that would be the
 * "huge observability platform" P2.md §16 says not to build); the
 * discipline is on each call site, the same way `auditFromSession`'s own
 * "never log a full clinical note" discipline already works elsewhere in
 * this codebase.
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * P4.4 §12: a small, fixed classification of PRODUCTION FAILURE TYPE —
 * deliberately not "an enormous error taxonomy" (§12's own instruction),
 * just enough for operations to filter/search log aggregation by "what kind
 * of thing broke" independent of `domain` (which subsystem it happened in).
 * A DATABASE failure can occur in the `auth` domain just as easily as the
 * `billing` one; this field answers a different question than `domain`
 * does, not a redundant one.
 */
export type ErrorCategory =
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "VALIDATION"
  | "DATABASE"
  | "OUTBOX"
  | "ACCOUNTING_POSTING"
  | "BACKUP"
  | "EXTERNAL_PROVIDER"
  | "INTERNAL"

export type LogFields = {
  /** Required. Always required — pick deliberately, this is not "error unless told otherwise." */
  level: LogLevel
  /** Required. A short, stable, dot-namespaced event name — e.g. "outbox.dead_letter", "accounting.posting_failed", "auth.branch_access_denied". Grep-able and stable across a refactor, unlike a free-text message. */
  event: string
  /** Which domain module this event is about — e.g. "outbox", "accounting", "auth", "billing". */
  domain?: string
  /** Which function/action was running — e.g. "dispatchBatch", "postJournal", "assertBranchAccess". */
  operation?: string
  /** Per-request correlation id, when available — see `getCorrelationId()` below. Falls back to a session id when no per-request id exists in the current context (e.g. a background job) — still useful for tying a handful of related log lines together, just coarser than a true per-request id. */
  correlationId?: string
  /** P4.4 §60/§41: the deployed release identifier, when known — the same value `/api/health`'s `version` field reports (VERCEL_GIT_COMMIT_SHA, truncated). Lets "did failures start after release X?" be answered by grepping logs, not just by comparing deploy timestamps. */
  release?: string
  organizationId?: string
  branchId?: string
  userId?: string
  /** The specific record this event is about, if any — an id, not a description. */
  entityId?: string
  /** A short, non-sensitive label for what entityId refers to — e.g. "invoice", "outbox_event", "clinical_order". Never patient name/DOB/note content. */
  reference?: string
  /** P4.4 §12 — see ErrorCategory's own doc comment. Optional: most log lines are informational lifecycle events, not failures, and don't need one. */
  errorCategory?: ErrorCategory
  /** P4.4 §16/§17: how long the operation took, when timing it is cheap and useful — logged at "warn" alongside a slow-operation threshold breach, not measured for every call site (see SLOW_OPERATION_THRESHOLD_MS in this file). */
  durationMs?: number
  /** The error that triggered this log line, if any — normalized to {name, message, stack} via `normalizeError`, never logged as a raw unknown value. */
  error?: unknown
}

type LogRecord = {
  timestamp: string
  level: LogLevel
  event: string
  domain?: string
  operation?: string
  correlationId?: string
  release?: string
  organizationId?: string
  branchId?: string
  userId?: string
  entityId?: string
  reference?: string
  errorCategory?: ErrorCategory
  durationMs?: number
  error?: { name: string; message: string; stack?: string }
}

function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { name: "UnknownError", message: typeof error === "string" ? error : JSON.stringify(error) }
}

/** P4.8 §8: the same shared derivation `/api/health`'s `version` field uses (`release.ts`) — computed once per process, not per call. */
const RELEASE = getReleaseVersion()

/**
 * P4.4 §17: a shared threshold for "unusually slow" — not a performance
 * budget (P4.5's own scope), just enough signal to notice severe production
 * degradation. Callers that already measure a duration (the health check,
 * the outbox sweep, the operational-health assembly) compare against this
 * and log at "warn" when it's exceeded, rather than this file measuring
 * every call site itself.
 */
export const SLOW_OPERATION_THRESHOLD_MS = 5000

/**
 * The one function every call site uses. Structured JSON, one line per
 * call, routed to `console.error`/`console.warn`/`console.log` by level so
 * stdout/stderr splits the way most log aggregators (including Vercel's
 * own) expect. Never throws — a logging call must never be the reason a
 * real operation fails.
 */
export function log(fields: LogFields): void {
  try {
    const { error, ...rest } = fields
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      release: RELEASE,
      ...rest,
      ...(error !== undefined ? { error: normalizeError(error) } : {}),
    }
    const line = JSON.stringify(record)
    if (fields.level === "error") console.error(line)
    else if (fields.level === "warn") console.warn(line)
    else console.log(line)
  } catch {
    // A logging call must never throw into the caller's own error handling
    // — if JSON.stringify itself fails (e.g. a circular reference slipped
    // into a field somehow), fall back to the plainest possible line
    // rather than lose the event entirely or crash the real operation.
    try {
      console.error(`[logger] failed to serialize a log record for event "${fields.event}"`)
    } catch {
      // Genuinely nothing more this function can safely do.
    }
  }
}

/**
 * Reads the per-request correlation id `src/proxy.ts` attaches to every
 * request (`x-correlation-id`, a random id generated once per incoming
 * request — see that file's own comment). Only callable from a
 * request-scoped context (Server Components, Server Actions, Route
 * Handlers) — `next/headers`'s `headers()` throws outside one. Returns
 * `undefined` rather than throwing when called from a context with no
 * active request (a background job, a script, a test) — callers should
 * treat a missing correlation id as normal, not an error, exactly per
 * P2.md §16's own "where available" wording.
 */
export async function getCorrelationId(): Promise<string | undefined> {
  try {
    const { headers } = await import("next/headers")
    const headerList = await headers()
    return headerList.get("x-correlation-id") ?? undefined
  } catch {
    return undefined
  }
}

/**
 * EXTENSION POINTS for a future real observability provider (Sentry,
 * Datadog, etc.) — deliberately not integrated now, per P2.md §16's own
 * "without integrating a vendor now" instruction:
 *
 * 1. **This file** (`log()` above) is the single chokepoint every call
 *    site already goes through — swap the `console.*` calls for a
 *    provider SDK call (e.g. `Sentry.captureException`/a Datadog logger
 *    transport) in one place, and every existing call site upgrades with
 *    no changes elsewhere. This is the primary reason a centralized
 *    abstraction exists at all rather than ad hoc `console.error` calls
 *    scattered per file (the state this batch found and closed).
 * 2. **`src/instrumentation.ts`**'s `onRequestError` hook is the
 *    Next.js-native integration point for a provider that wants every
 *    unhandled server error, framework-wide (Server Components, Route
 *    Handlers, Server Actions) — see that file's own comment. Most
 *    provider SDKs (Sentry's Next.js SDK in particular) wire into exactly
 *    this hook.
 * 3. **`src/proxy.ts`**'s correlation id generation is where a provider's
 *    own distributed-tracing header (e.g. `sentry-trace`, `traceparent`)
 *    would be generated/propagated instead of (or alongside) the plain
 *    `x-correlation-id` this batch adds — the request-header-forwarding
 *    mechanism is already in place, only the header name/value generation
 *    would change.
 */
