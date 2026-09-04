import "server-only"

/**
 * P4.8 §8 — the single release/version identifier the running application
 * exposes, used by both the structured logger (`logger.ts`'s `release`
 * field on every log line) and `/api/health`'s `version` field, so "which
 * release is this" is answered identically everywhere instead of two
 * independent derivations that could silently drift apart (they computed
 * the same expression separately before this — consolidated here, not a
 * behavior change).
 *
 * Resolution order, most specific first:
 *   1. `VERCEL_GIT_COMMIT_SHA` (first 12 chars) — the actual deployed
 *      commit on Vercel, automatically set by the platform for every
 *      deployment. The most useful value in production: unambiguous, and
 *      "did failures start after commit X?" is directly answerable by
 *      grepping logs for it.
 *   2. `RELEASE_VERSION` — an optional explicit override for any other
 *      hosting platform that doesn't set its own commit-SHA env var, or for
 *      a deliberately-named release (e.g. "v0.9.0") distinct from a raw
 *      commit hash. Never required — see docs/RELEASE_VERSIONING.md.
 *   3. `npm_package_version` — `package.json`'s own `"version"` field,
 *      always present when running via `npm run`/`npm start`. The fallback
 *      for local development and any environment that sets neither of the
 *      above.
 *   4. `"unknown"` — never thrown; a missing release identifier is a
 *      degraded-but-safe state (§9's own health-endpoint philosophy), not a
 *      boot failure.
 *
 * Never a secret, never logged/exposed beyond what it already is (a public
 * commit SHA prefix or a semver string) — safe to return from the
 * unauthenticated `/api/health` endpoint (§9's own "do not expose sensitive
 * internals").
 */
export function getReleaseVersion(): string {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
    process.env.RELEASE_VERSION ??
    process.env.npm_package_version ??
    "unknown"
  )
}
