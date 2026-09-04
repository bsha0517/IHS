// P4.9.1 Issue A: shared logic behind `npm run db:security:apply` and
// `npm run db:security:check` — reproducible Row Level Security provisioning
// and verification, usable against any environment (local Postgres or
// Supabase) since both ultimately just need an owner-level connection string
// and the runtime role's own name. See prisma/db-setup/apply-rls.sql for the
// actual SQL and the full reasoning, and DATABASE.md's "Row Level Security"
// section for the summary.

import { readFileSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"
import { assertNotPooledConnection, parseDatabaseUrl } from "./lib"

const APPLY_RLS_SQL_PATH = path.resolve(import.meta.dirname, "../../prisma/db-setup/apply-rls.sql")
const POLICY_NAME = "app_runtime_full_access"

/** The runtime role's own name is never hardcoded or duplicated into a new
 * env var — it's read directly out of the runtime connection string
 * (DATABASE_URL) that already names it, the same source of truth every
 * other script in this repo trusts. Works for `his_app_runtime` (local) and
 * `avant_app_runtime` (this engagement's hosted Supabase project) alike —
 * and for whatever name a different clinic's own Supabase project chooses,
 * without this script needing to know it in advance. */
export function deriveRuntimeRoleName(runtimeUrl: string): string {
  const parsed = parseDatabaseUrl(runtimeUrl)
  if (!parsed.username) {
    throw new Error(`Could not read a role name out of the runtime connection string — expected "postgresql://<role>:...".`)
  }
  return parsed.username
}

/** Requires the connection used to apply/check security to be the
 * owner/direct connection, not the pooled runtime connection — the same
 * guard backup/restore already applies for the same underlying reason
 * (section 10: "reject pooled/runtime-only connection where appropriate").
 * `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` are DDL;
 * the restricted runtime role has no DDL rights at all, by design. */
function assertOwnerConnection(directUrl: string, label: string): void {
  assertNotPooledConnection(directUrl, label)
}

/** `npm run db:security:apply` — idempotent. Connects with the owner/direct
 * connection, substitutes the actual runtime role name into
 * apply-rls.sql, and runs it. Never destructive: only ever enables RLS
 * (already effectively a no-op if enabled) and replaces the one named policy
 * this script owns. */
export async function applySecurity({ directUrl, runtimeUrl, label }: { directUrl: string; runtimeUrl: string; label: string }): Promise<void> {
  assertOwnerConnection(directUrl, `${label} owner/direct connection`)
  const runtimeRole = deriveRuntimeRoleName(runtimeUrl)
  const template = readFileSync(APPLY_RLS_SQL_PATH, "utf8")
  const sql = template.replaceAll("__RUNTIME_ROLE__", runtimeRole)

  const client = new Client({ connectionString: directUrl })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

export type SecurityCheckResult = {
  ok: boolean
  tablesChecked: number
  tablesWithoutRls: string[]
  tablesWithoutPolicy: string[]
}

/** `npm run db:security:check` — read-only, safe to run in production
 * (including as a release-gate step). Reports every `public` schema
 * ordinary table that either has RLS disabled, or is missing the expected
 * runtime-role policy — both are real gaps a future migration could
 * silently introduce if `db:security:apply` isn't re-run after it. Never
 * prints connection strings or any credential. */
export async function checkSecurity({ directUrl, runtimeUrl, label }: { directUrl: string; runtimeUrl: string; label: string }): Promise<SecurityCheckResult> {
  assertOwnerConnection(directUrl, `${label} owner/direct connection`)
  const runtimeRole = deriveRuntimeRoleName(runtimeUrl)

  const client = new Client({ connectionString: directUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ table_name: string; rls_enabled: boolean; has_policy: boolean }>(
      `
      SELECT
        c.relname AS table_name,
        c.relrowsecurity AS rls_enabled,
        EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = c.relname
            AND p.policyname = $1 AND $2 = ANY(p.roles::text[])
        ) AS has_policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
      `,
      [POLICY_NAME, runtimeRole]
    )

    const tablesWithoutRls = rows.filter((r) => !r.rls_enabled).map((r) => r.table_name)
    const tablesWithoutPolicy = rows.filter((r) => r.rls_enabled && !r.has_policy).map((r) => r.table_name)

    return {
      ok: tablesWithoutRls.length === 0 && tablesWithoutPolicy.length === 0,
      tablesChecked: rows.length,
      tablesWithoutRls,
      tablesWithoutPolicy,
    }
  } finally {
    await client.end()
  }
}
