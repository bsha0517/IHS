-- Local counterpart to p0-06-create-runtime-role.sql's table-level
-- GRANT/REVOKE — the same privilege model (full CRUD everywhere, UPDATE/
-- DELETE revoked specifically on audit_log/clinical_access_log), reused
-- rather than reinvented, so the security tests exercising it (see
-- test/integration/audit-log-immutability.test.ts) prove the same real
-- guarantee locally that they prove against Supabase.
--
-- Deliberately a separate file from local-init.sql: this must run AFTER
-- Prisma migrations have created the tables (`GRANT ... ON ALL TABLES`
-- only covers tables that exist at the moment it runs — the identical
-- "does not retroactively grant on later tables" caveat
-- p0-06-regrant-new-tables.sql already documents), and needs re-running
-- whenever a new migration adds a table. GRANT/REVOKE are naturally
-- idempotent in Postgres, so running this file again after a fresh
-- migration is always safe.
--
-- Run via scripts/db/dev-setup.ts / scripts/db/test-setup.ts (`npm run
-- db:dev:setup` / `npm run db:test:setup`) — connected to whichever target
-- database (his_dev or his_test) as the `postgres` owner role. No database
-- name is hardcoded here (unlike p0-06-create-runtime-role.sql's Supabase-
-- specific `GRANT CONNECT ON DATABASE postgres`) since this file already
-- runs while connected to the right database, and Postgres grants CONNECT
-- to PUBLIC by default on a plain local instance (no Supabase-style
-- restriction to work around locally).

GRANT USAGE ON SCHEMA public TO his_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO his_app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO his_app_runtime;

-- The actual immutability restriction under test by
-- test/integration/audit-log-immutability.test.ts.
REVOKE UPDATE, DELETE ON audit_log, clinical_access_log FROM his_app_runtime;
