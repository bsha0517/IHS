# Release Versioning

P4.8 §37/§57/§58 — the pragmatic versioning and release-identification convention this project uses. Kept simple; not a process document in its own right — see [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) and [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) for the release process this feeds into.

## Convention

`MAJOR.MINOR.PATCH`, pre-1.0 (`0.x.y`) — this product has not yet had a first commercial production deployment, so every release stays under `1.0.0` until that milestone, per common semver practice for pre-release software (a `0.x` major version signals "the public contract may still change," which is accurate for this project today).

- **PATCH** (`0.1.0` → `0.1.1`): a safe fix with no schema change and no behavior change a user would need to know about — a bug fix, a copy correction, an internal refactor.
- **MINOR** (`0.1.0` → `0.2.0`): a backwards-compatible feature or an additive database migration — new functionality, a new report, a new nullable column, a new table. The overwhelming majority of this project's releases so far (every P-numbered phase) have been MINOR-shaped: real functional growth, never breaking what already worked.
- **MAJOR** (bumped even pre-1.0, e.g. `0.9.0` → `0.10.0` is still a MINOR bump under this convention — a MAJOR bump pre-1.0 is reserved for a deliberately breaking change): an intentionally breaking product/schema/API change — a destructive migration with no compatibility window, a removed feature, an incompatible Server Action/route contract change. See [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md)'s Migration Classification for what makes a database change "destructive" specifically.

Once this project reaches its first real commercial production deployment, `1.0.0` marks that milestone — not a specific feature set, a specific promise: "this version is running real clinics' data, and breaking it has real consequences."

## Where the Version Lives

`package.json`'s own `"version"` field is the source of truth for the current release's semantic version. Bump it as part of the release (a small, deliberate commit — not automated by this phase, per §58's own "do not automate pushing tags without explicit operator action").

## Release Identification at Runtime

The **running application** identifies its own release via `getReleaseVersion()` (`src/lib/platform/release.ts`), used identically by:

- `/api/health`'s `version` field
- every structured log line's `release` field (`src/lib/platform/logger.ts`)

Resolution order:

1. `VERCEL_GIT_COMMIT_SHA` (first 12 chars) — set automatically by Vercel for every deployment; the most useful value in production, since "did failures start after commit X?" is directly answerable by grepping logs.
2. `RELEASE_VERSION` — an optional explicit override, for a non-Vercel host or a deliberately-named release distinct from a raw commit hash (e.g. `v0.9.0`). Never required.
3. `npm_package_version` — `package.json`'s own version, present whenever the app runs via `npm run`/`npm start`.
4. `"unknown"` — never a boot failure; a missing identifier is a degraded-but-safe state, consistent with `/api/health`'s own "never block on this" philosophy.

This means production logs and the health endpoint always show *which commit* is actually live, independent of whether the semver in `package.json` was bumped for that specific deploy — both facts (semver + commit SHA) are useful, for different questions ("what changed since the last release" vs. "is this exact code running").

## Git Tagging

Recommended, not automated: tag the commit a release actually ships from, e.g.:

```bash
git tag -a v0.9.0 -m "v0.9.0 — see docs/releases/2026-09-04-v0.9.0.md"
git push origin v0.9.0
```

Tagging is a deliberate, manual operator action (§58) — no script in this repository pushes a tag on its own. A tag gives "what code did release X actually run" a permanent, unambiguous answer independent of `main`'s later history, and pairs with that release's own notes file (`docs/releases/`, see [RELEASE_TEMPLATE.md](releases/RELEASE_TEMPLATE.md)).

## What a Release Candidate Actually Is

Per §57 — reproducible from source control, not a floating "whatever's on someone's machine":

- A specific **Git commit** (tagged, per above, once released).
- The **migration set** in `prisma/migrations/` as of that commit — immutable once applied anywhere (see [DATABASE_MIGRATION_SAFETY.md](DATABASE_MIGRATION_SAFETY.md)'s "Never Edit an Applied Migration").
- The **build** produced by `npm run build` from that commit — never a hand-modified or locally-patched build deployed to production.
- The **environment configuration** that commit's code expects (see [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)'s Environment Variable Changes section) — a release candidate is only complete once its target environment's variables are confirmed to match what the code reads.
- That release's own **release notes** (`docs/releases/YYYY-MM-DD-vX.Y.Z.md`).

Anyone should be able to reconstruct exactly what a given release was by checking out its tag and reading its own notes file — nothing about a release should live only in one engineer's memory or terminal history.
