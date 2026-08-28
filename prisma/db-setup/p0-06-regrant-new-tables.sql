-- Companion to p0-06-create-runtime-role.sql — run this (connected as the
-- owner role, e.g. via `prisma db execute`) whenever a migration adds new
-- tables, so "avant_app_runtime" (the restricted runtime role) can access
-- them. Postgres does not retroactively grant privileges on tables created
-- after the role's own grants last ran.
--
-- WHY THIS FILE EXISTS, NOT JUST "re-run the two GRANT lines from the main
-- script": P1 Batch 8 (2026-08-27) did exactly that — copied only the
-- `GRANT ... ALL TABLES` / `GRANT ... ALL SEQUENCES` lines out of
-- p0-06-create-runtime-role.sql to give the role access to two new tables
-- — and broke P0-06's own audit-log immutability guarantee for real: `GRANT
-- ... ALL TABLES` re-grants UPDATE/DELETE on EVERY table, including
-- `audit_log`/`clinical_access_log`, silently undoing the REVOKE the main
-- script applies right after its own copy of that same GRANT. Caught by
-- `test/integration/audit-log-immutability.test.ts` failing in that
-- batch's own full-suite run — not a hypothetical, a real regression that
-- shipped to the shared dev database until that test caught it. This file
-- bundles the GRANT and the REVOKE together in one script specifically so
-- that mistake can't be repeated by copying only half of it.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "avant_app_runtime";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "avant_app_runtime";

-- MUST run in the same script as the GRANT above, every time — see this
-- file's own header comment for why "just the GRANT lines" is unsafe.
REVOKE UPDATE, DELETE ON "audit_log", "clinical_access_log" FROM "avant_app_runtime";
