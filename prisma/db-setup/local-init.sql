-- Local Docker Postgres bootstrap — runs exactly once, automatically, the
-- first time the `postgres` container starts against a fresh volume
-- (mounted into /docker-entrypoint-initdb.d by docker-compose.yml). Not run
-- again on later container restarts, and not run at all against Supabase.
--
-- Creates the two local databases (LOCAL_DATABASE_SETUP.md) and the
-- restricted runtime role, reusing the exact same privilege model
-- prisma/db-setup/p0-06-create-runtime-role.sql already established for
-- Supabase — see local-grant-runtime-role.sql, which applies the
-- table-level GRANT/REVOKE half of that model (deferred to a later step
-- since no tables exist yet at container-init time; Prisma migrations
-- create them).
--
-- Password below is a fixed, local-only, non-secret default — this role
-- only ever exists inside a container listening on 127.0.0.1, never
-- reachable outside the developer's own machine. Never reuse it anywhere
-- real (see p0-06-create-runtime-role.sql for the real-environment version,
-- which requires a freshly generated secret).

CREATE DATABASE his_dev;
CREATE DATABASE his_test;

CREATE ROLE his_app_runtime WITH LOGIN PASSWORD 'his_app_runtime_dev_only';
