// Shared helpers for the local-Postgres dev/test database scripts
// (scripts/db/*.ts). Deliberately plain Node + the `pg` package this repo
// already depends on — no new dependency, and every script here is invoked
// via `tsx` the same way `prisma/seed.ts` already is (see package.json).
//
// Why these exist as real .ts scripts instead of shell one-liners in
// package.json: cross-database orchestration (his_dev vs. his_test, owner
// vs. runtime role) needs different env values passed to the Prisma CLI and
// to `pg` per step, and `$VAR`/`%VAR%` env-var substitution is not portable
// across the bash/cmd.exe/PowerShell shells this project's contributors may
// run `npm run` under. Reading `process.env` directly in Node sidesteps that
// entirely.

import { Client } from "pg"
import { spawn } from "node:child_process"

/** Known hosted-Postgres host fragments — a URL containing any of these is
 * refused as a local dev/test target. This is a blocklist, not an allowlist,
 * deliberately: the point is to catch an accidental copy-paste of a real
 * remote connection string into TEST_DATABASE_URL/TEST_DIRECT_DATABASE_URL,
 * not to whitelist every possible local hostname a contributor might use. */
const REMOTE_HOST_MARKERS = [
  "supabase.co",
  "supabase.com",
  "supabase.io",
  "pooler.supabase",
  "amazonaws.com",
  "neon.tech",
  "render.com",
  "railway.app",
  "azure.com",
  "cockroachlabs.cloud",
]

export function parseDatabaseUrl(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw new Error(`Not a valid database connection URL: "${url}"`)
  }
}

/** Refuses a connection string that looks like a real hosted/shared database.
 * Used by both the test bootstrap (test/setup-test-database.ts) and the
 * test-reset script — a single source of truth for "does this look remote"
 * so the two can never silently drift apart. */
export function assertNotRemoteHost(url: string, label: string): void {
  const lower = url.toLowerCase()
  const hit = REMOTE_HOST_MARKERS.find((marker) => lower.includes(marker))
  if (hit) {
    throw new Error(
      `${label} looks like it points at a hosted/shared database (matched "${hit}") — refusing to use it for local dev/tests. ` +
        `${label} must point at the local Docker Postgres instance (see LOCAL_DATABASE_SETUP.md). ` +
        `Supabase stays reserved for staging/production only.`
    )
  }
}

/** Requires the connection string's own database name to equal exactly
 * `his_test` — the safety marker section 6 of this task asks for, checked
 * before any destructive reset operation. Rejects anything else, including
 * `his_dev`, so a reset can never fire against the wrong local database
 * either, not just against a remote one. */
export function assertIsTestDatabase(url: string, label: string): void {
  const parsed = parseDatabaseUrl(url)
  const dbName = parsed.pathname.replace(/^\//, "")
  if (dbName !== "his_test") {
    throw new Error(
      `${label} resolves to database "${dbName}", not "his_test" — refusing to run a destructive reset. ` +
        `This safety check exists specifically so a reset script can never accidentally target production, staging, or his_dev.`
    )
  }
}

/** P4.5 §11/§12: the load-test database safety guard — the same fail-closed
 * pattern as `assertIsTestDatabase` above, for the dedicated
 * `his_load_test` database (never `his_dev`/`his_test`/production). Every
 * load-test seed/reset/run script that touches a database at all calls this
 * first. No force-production override exists — see `load-tests/lib/`'s own
 * scripts for where this is actually invoked. */
export function assertIsLoadTestDatabase(url: string, label: string): void {
  const parsed = parseDatabaseUrl(url)
  const dbName = parsed.pathname.replace(/^\//, "")
  if (dbName !== "his_load_test") {
    throw new Error(
      `${label} resolves to database "${dbName}", not "his_load_test" — refusing to run a load-test operation. ` +
        `This safety check exists specifically so a load-test seed/reset/run script can never accidentally target ` +
        `production, staging, his_dev, or his_test. There is no override.`
    )
  }
}

/** P4.2 §14: the restore-target safety guard. A logical restore is
 * destructive to whatever database it targets (the target is dropped and
 * recreated from scratch — see restore.ts) — this must never be able to
 * fire against `his_dev`, `his_test`, or anything that could plausibly be a
 * real/staging/production database. Fail closed: only a name that literally
 * starts with `his_restore_test` (optionally suffixed, e.g.
 * `his_restore_test_20260901`) is accepted. Deliberately has no override
 * flag/env var — P4.2's own instruction is "allow only a clearly named
 * restore-test DB," not "allow anything if someone insists." A real
 * incident restore into production/staging is a distinct, deliberate,
 * out-of-band operational procedure (see docs/BACKUP_DISASTER_RECOVERY.md's
 * Disaster Scenarios), not something this automated guard is meant to
 * accommodate. */
const SAFE_RESTORE_TARGET_PATTERN = /^his_restore_test(_[a-z0-9_]+)?$/
const EXPLICITLY_FORBIDDEN_TARGETS = new Set(["his_dev", "his_test", "postgres", "template0", "template1"])

export function assertIsSafeRestoreTarget(databaseUrl: string, label: string): string {
  const parsed = parseDatabaseUrl(databaseUrl)
  const dbName = parsed.pathname.replace(/^\//, "")
  if (EXPLICITLY_FORBIDDEN_TARGETS.has(dbName.toLowerCase()) || dbName.toLowerCase().includes("prod")) {
    throw new Error(
      `${label} resolves to database "${dbName}" — refusing to restore into it. This name is explicitly blocked regardless ` +
        `of any other check, precisely because it's the kind of name a restore must never accidentally target.`
    )
  }
  if (!SAFE_RESTORE_TARGET_PATTERN.test(dbName)) {
    throw new Error(
      `${label} resolves to database "${dbName}", which doesn't match the required "his_restore_test" (optionally ` +
        `suffixed) naming pattern — refusing to restore into it. A restore drops and recreates its target database; ` +
        `this guard exists specifically so an automated restore can never land on the wrong one. There is no override — ` +
        `see docs/BACKUP_DISASTER_RECOVERY.md for the deliberate, out-of-band procedure a real incident restore uses instead.`
    )
  }
  return dbName
}

/** Also refuses the transaction-pooler connection for backup/restore
 * operations (P4.2 §9: "Do NOT use the transaction pooler for backup
 * operations") — pg_dump/pg_restore need a plain, long-lived direct
 * connection; Supavisor's transaction-mode pooler (`:6543`,
 * `?pgbouncer=true`) multiplexes connections in a way that doesn't support
 * pg_dump's session-level requirements (e.g. its use of exported
 * snapshots). */
export function assertNotPooledConnection(databaseUrl: string, label: string): void {
  const lower = databaseUrl.toLowerCase()
  if (lower.includes("pgbouncer=true") || lower.includes(":6543")) {
    throw new Error(
      `${label} looks like a pooled (transaction-mode) connection — refusing to use it for a backup/restore operation. ` +
        `pg_dump/pg_restore require a direct connection (DIRECT_DATABASE_URL), never the pooler.`
    )
  }
}

/** Connects and runs `SELECT 1` with a short timeout, retrying a few times —
 * covers the container still starting up (db:local:start) and gives a clear,
 * actionable error instead of a raw ECONNREFUSED stack if Postgres genuinely
 * isn't reachable (the test bootstrap's own required failure mode). */
export async function waitForReachable(
  url: string,
  label: string,
  { attempts = 20, delayMs = 1000 }: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  let lastError: unknown
  for (let i = 1; i <= attempts; i++) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 })
    try {
      await client.connect()
      await client.query("SELECT 1")
      await client.end()
      return
    } catch (err) {
      lastError = err
      await client.end().catch(() => {})
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  const code = (lastError as { code?: string } | undefined)?.code
  const message = lastError instanceof Error ? lastError.message : undefined
  const reason = [code, message].filter(Boolean).join(": ") || "connection refused or timed out"
  throw new Error(
    `${label} is not reachable after ${attempts} attempts (${reason}). ` +
      `Is the local Postgres container running? Try: npm run db:local:start`
  )
}

/** Runs a multi-statement SQL string against the given connection, once,
 * with no retry — used for the grant/revoke script and migrate-adjacent
 * one-shot statements where the caller already knows the DB is up. */
export async function runSql(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

/** Spawns a child process with an explicit env object (never string-interpolated
 * shell env-var syntax, for the cross-platform reason in this file's header
 * comment), inheriting stdio so the developer sees real Prisma CLI/seed output. */
export function runStep(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`))
    })
  })
}

/** Reads a required env var or throws a clear, specific error — used instead
 * of a silent `undefined` reaching `new URL(undefined)` or a fallback to a
 * different variable, per this task's own "do not silently fall back" rule. */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. See .env.example and LOCAL_DATABASE_SETUP.md — local dev/test needs ` +
        `DATABASE_URL/DIRECT_DATABASE_URL (his_dev) and TEST_DATABASE_URL/TEST_DIRECT_DATABASE_URL (his_test) all set.`
    )
  }
  return value
}
