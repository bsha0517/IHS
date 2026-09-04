<!--
P4.8 §35/§36 — template for one release's own notes file.
Copy this file to docs/releases/YYYY-MM-DD-vX.Y.Z.md for each real release
and fill it in. Do not generate one of these for every historical commit —
only for an actual release, going forward from P4.8. See
docs/RELEASE_VERSIONING.md for the versioning convention and
docs/RELEASE_CHECKLIST.md / docs/RELEASE_RUNBOOK.md for the process this
documents the result of.
-->

# Release vX.Y.Z — YYYY-MM-DD

**Risk level:** LOW / MEDIUM / HIGH (see `docs/RELEASE_CHECKLIST.md`'s Release Risk Levels)
**Release Owner:** <name>

## Summary

One or two sentences: what does this release do, for whom.

## User-Visible Changes

- Change classified as **Feature** / **Fix** / **Security** / **Database** / **Operational** / **UI/UX** / **Breaking Change** — one line each, plain language, no internal jargon a clinic operator wouldn't understand.

## Schema Migrations

- `prisma/migrations/<timestamp>_<name>/` — classification (Additive / Transitional / Destructive, see `docs/DATABASE_MIGRATION_SAFETY.md`) and a one-sentence description of what it does.
- If Transitional/Destructive: which Expand/Migrate/Contract stage this release represents, and what release(s) come before/after it.

## Data Migrations

- Any backfill script run as part of this release, what it does, and its validation query's result.
- "None" if there isn't one — say so explicitly rather than leaving this section blank.

## Environment Changes

- New/changed environment variable(s): name, required/optional, secret/non-secret, and whether it needed to exist in the target platform before this release deployed (see `docs/DATABASE_MIGRATION_SAFETY.md`'s Environment Variable Changes).
- "None" if there aren't any.

## Deployment Order

- The actual sequence this release was deployed in (usually the Default Release Sequence in `docs/RELEASE_RUNBOOK.md` — note here only if this release needed a different order, and why).

## Rollback Considerations

- Is the previous application version still compatible with the new schema (if any)? If not, explain why and what the actual recovery plan is.
- Anything about this specific release that makes rollback non-trivial.

## Known Issues

- Anything shipped with a known, accepted limitation — link the relevant `BACKLOG.md` entry if one exists.

## Post-Release Validation

- What was actually checked after this release went live (health, smoke, reconciliation — see `docs/RELEASE_CHECKLIST.md`'s Post-Release section) and the result.
