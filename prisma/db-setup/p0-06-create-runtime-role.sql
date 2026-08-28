-- P0-06 (SYSTEM_AUDIT.md Critical #6 / SECURITY.md): a genuinely
-- restricted database role for the application's RUNTIME connection,
-- separate from the role migrations run as.
--
-- WHY THIS ISN'T A PRISMA MIGRATION: role/GRANT management is
-- database-cluster-level, not schema-level — it isn't something
-- `prisma migrate deploy` tracks or should track (a fresh environment
-- restoring from these migrations alone would have no password to use
-- here anyway). This file is a reference script, run once by hand per
-- environment (dev/staging/prod each need their own role + password).
--
-- THE ACTUAL FINDING THIS FIXES: the role this app has connected as since
-- Phase 1 (Supabase's project-owner "postgres" role) is the OWNER of every
-- table it created, including audit_log/clinical_access_log. In
-- PostgreSQL, a table owner's privileges are implicit and NOT removable by
-- REVOKE against that same role — `REVOKE UPDATE, DELETE ON audit_log FROM
-- postgres` would execute without error but have zero actual effect. A
-- role created here, which does NOT own any table, has no such implicit
-- privilege — REVOKE against it is real and was empirically verified to
-- work (see test/integration/audit-log-immutability.test.ts and
-- PROJECT_STATUS.md's Phase-P0 notes): UPDATE/DELETE against audit_log
-- genuinely fail for this role; SELECT/INSERT genuinely still work; every
-- other table's SELECT/INSERT/UPDATE/DELETE genuinely still works.
--
-- USAGE:
--   1. Replace __PASSWORD__ below with a freshly generated strong secret
--      (e.g. `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`)
--      — never reuse a password across environments.
--   2. Run this script once, connected as the existing admin/owner role
--      (the same one DATABASE_URL already uses for migrations).
--   3. This does NOT change what the running application connects as.
--      Cutting the live app over to this role is a separate, deliberate
--      deployment step (update DATABASE_URL — locally in .env, and in
--      Vercel's project environment variables for production — to
--      `postgresql://avant_app_runtime.<project-ref>:<password>@<pooler-host>/postgres`)
--      that this remediation pass deliberately does not perform
--      unilaterally; see P0_REMEDIATION_REPORT.md for why.
--   4. The admin/owner role must keep being used for `prisma migrate
--      deploy` — this new role cannot run migrations (no DDL rights),
--      by design.

CREATE ROLE "avant_app_runtime" WITH LOGIN PASSWORD '__PASSWORD__';

GRANT CONNECT ON DATABASE postgres TO "avant_app_runtime";
GRANT USAGE ON SCHEMA public TO "avant_app_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "avant_app_runtime";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "avant_app_runtime";

-- The actual immutability restriction (audit.ts's "insert-only by
-- convention" claim becomes a real, DB-enforced guarantee for this role).
REVOKE UPDATE, DELETE ON "audit_log", "clinical_access_log" FROM "avant_app_runtime";

-- If new tables are added in future phases, run
-- p0-06-regrant-new-tables.sql (idempotent) so the new role can access them
-- — Postgres does not retroactively grant privileges on tables created
-- after this script ran, only on tables that existed at the time. Use that
-- file, not a bare copy of this script's own GRANT ALL TABLES lines above —
-- see its header comment for the real regression (P1 Batch 8) that came
-- from copying only half of this script.
