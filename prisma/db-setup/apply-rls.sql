-- P4.9.1 Issue A: source-controlled, reproducible Row Level Security
-- provisioning for every environment this app runs in (local Postgres,
-- Supabase). Companion to p0-06-create-runtime-role.sql (which creates the
-- restricted runtime role and its table-level GRANT/REVOKE) — that script
-- protects the app's OWN restricted role from itself (no UPDATE/DELETE on
-- audit_log/clinical_access_log); this script protects every table from
-- anything OTHER than that role, specifically Supabase's own Data API
-- (PostgREST), which serves the `anon`/`authenticated` client roles and
-- completely bypasses this app's Prisma-based session/RBAC layer. A table
-- with RLS disabled is fully readable/writable via that API by anyone
-- holding the project's public anon key, regardless of what this
-- application's own auth does. RLS here is defense-in-depth, not a second
-- authorization system — see docs/DATABASE.md's "Row Level Security" section
-- for the full reasoning, and section 30 of P4_9_1's own report for why the
-- runtime-role policy below is deliberately permissive (the whole backend
-- runs under one controlled server-side role; organization/branch isolation
-- remains entirely the application's job, enforced in
-- src/lib/platform/branch-scope.ts and every domain service, not by a
-- row-level predicate here).
--
-- WHY A DYNAMIC PL/pgSQL BLOCK, NOT A HARDCODED TABLE LIST: a hardcoded list
-- of ~116 `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` statements (which is
-- literally what P4.9 ran by hand against the hosted database) goes stale
-- the moment the next Prisma migration adds a table — Postgres does not
-- retroactively protect a new table just because its siblings are
-- protected, the exact "future table" problem P4.9.1 was asked to solve.
-- This block instead enumerates whatever ordinary tables actually exist in
-- the `public` schema at the moment it runs, so re-running it after any
-- migration (including one from a future, unwritten phase) picks up new
-- tables automatically. `npm run db:security:apply` is the supported way to
-- run this file — see scripts/db/security.ts for the runtime-role-name
-- substitution and connection-safety checks it applies before doing so.
--
-- IDEMPOTENT: `ENABLE ROW LEVEL SECURITY` is already a no-op if already
-- enabled. `CREATE POLICY` has no `IF NOT EXISTS` form in PostgreSQL, so
-- each iteration drops-then-creates the one named policy this script owns —
-- safe to re-run any number of times, and safe to re-run after a table
-- already has unrelated policies (only the exact policy name below is ever
-- touched).
--
-- The __RUNTIME_ROLE__ placeholder is substituted by scripts/db/security.ts
-- before this file is executed — the same convention
-- p0-06-create-runtime-role.sql already uses for __PASSWORD__ — because the
-- restricted role's actual name differs per environment (his_app_runtime
-- locally, avant_app_runtime on the hosted Supabase project used in this
-- engagement; a different clinic's own Supabase project could reasonably
-- choose a different name again).

DO $$
DECLARE
  tbl RECORD;
  policy_name CONSTANT text := 'app_runtime_full_access';
  runtime_role CONSTANT text := '__RUNTIME_ROLE__';
BEGIN
  FOR tbl IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r' -- ordinary tables only (not views, not sequences)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl.table_name);

    -- Deliberately NOT `TO public` (section 6) — a permissive `TO public`
    -- policy would grant Supabase's `anon`/`authenticated` API roles the
    -- exact same blanket access this whole script exists to deny them.
    -- Scoped to the named runtime role only.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, tbl.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO %I USING (true) WITH CHECK (true)',
      policy_name, tbl.table_name, runtime_role
    );
  END LOOP;
END $$;
